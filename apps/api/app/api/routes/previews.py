"""Official previews with shared discovery eligibility and ordered collection playback."""
from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.services.tmdb import TmdbConfigurationError, fetch_title_videos


router = APIRouter()


class PreviewVideoResponse(BaseModel):
    provider: str
    external_key: str
    type: str
    name: str
    official: bool


class PreviewReasonResponse(BaseModel):
    type: str
    label: str


class PreviewFeedItemResponse(BaseModel):
    feed_item_id: str
    title_id: UUID
    tmdb_id: int
    media_type: str
    title: str
    year: int | None
    poster_url: str | None
    backdrop_url: str | None
    overview: str | None
    video: PreviewVideoResponse
    reason: PreviewReasonResponse


class PreviewFeedResponse(BaseModel):
    session_id: str
    items: list[PreviewFeedItemResponse]
    # Sep-22 brief §4 continuation contract. `next_cursor` is opaque
    # server-side session state the client passes back on the next
    # fetch; `has_more` is whether continuation is possible (NOT an
    # alias for "this page was full"); `status` distinguishes "ready
    # to serve more", "pending" (a batch had to be split for latency),
    # and "exhausted" (the eligible pool is genuinely drained).
    next_cursor: str | None = None
    has_more: bool = True
    status: str = "ready"  # ready | pending | exhausted


class PreviewsForTitlesResponse(BaseModel):
    session_id: str
    items: list[PreviewFeedItemResponse]
    skipped_title_ids: list[UUID]  # titles with no eligible video


@router.get("/for-titles", response_model=PreviewsForTitlesResponse)
def get_previews_for_titles(
    current_user: CurrentUser,
    db: DbSession,
    ids: str = Query(..., max_length=4000, description="Ordered title UUIDs, at most 100 per page"),
) -> PreviewsForTitlesResponse:
    """Resolve a bounded page in supplied order; failures never masquerade as no video."""
    from concurrent.futures import ThreadPoolExecutor
    import httpx
    from app.services.discovery_feed import _video
    raw_ids = [value.strip() for value in ids.split(",") if value.strip()]
    if len(raw_ids) > 100:
        raise HTTPException(status_code=400, detail="Request at most 100 titles per page.")
    try:
        title_ids = list(dict.fromkeys(UUID(value) for value in raw_ids))
    except ValueError:
        raise HTTPException(status_code=400, detail="Each title must have a valid title ID.")
    rows = {row.id: row for row in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(title_ids))).all()}
    videos = {}
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {tid: pool.submit(_video, row) for tid, row in rows.items()}
        for tid, future in futures.items():
            try:
                videos[tid] = future.result()
            except (httpx.HTTPError, TmdbConfigurationError):
                raise HTTPException(status_code=503, detail="Couldn't load previews right now. Retry this page.")
    items, skipped = [], []
    for tid in title_ids:
        row, video = rows.get(tid), videos.get(tid)
        if row is None or video is None:
            skipped.append(tid)
            continue
        items.append(PreviewFeedItemResponse(
            feed_item_id=f"pfi-list-{tid}", title_id=tid, tmdb_id=row.tmdb_id,
            media_type=row.content_type, title=row.title,
            year=row.release_date.year if row.release_date else None,
            poster_url=row.poster_url, backdrop_url=row.backdrop_url, overview=row.overview,
            video=PreviewVideoResponse(**video),
            reason=PreviewReasonResponse(type="list_order", label="From this collection"),
        ))
    return PreviewsForTitlesResponse(session_id=f"pvlist-{current_user.id}", items=items, skipped_title_ids=skipped)


@router.get("/feed")
def get_previews_feed(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=15, ge=1, le=30),
    preferred_type: str | None = Query(default=None, pattern="^(movie|show)$"),
    genre: str | None = Query(default=None, max_length=40),
    cursor: str | None = Query(default=None, max_length=128),
    session_id: str | None = Query(default=None, max_length=80),
    mode: str = Query(default="streaming", pattern="^(streaming|all)$"),
) -> dict:
    from app.services.discovery_feed import get_feed
    return get_feed(db, current_user.id, preferred_type=preferred_type, genre=genre,
                    cursor=cursor, limit=limit, surface="preview", mode=mode)
