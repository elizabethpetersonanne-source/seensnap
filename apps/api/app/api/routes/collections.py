"""Collection library endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import Collection, ContentTitle
from app.schemas.content import TitleResponse
from app.services.collections import (
    get_active_collections,
    get_collection_by_slug,
    resolve_collection_titles,
)

router = APIRouter()


class CollectionSummaryResponse(BaseModel):
    slug: str
    title: str
    subtitle: str | None
    thesis: str | None
    collection_type: str
    media_scope: str
    editorial_rank: int
    poster_urls: list[str]
    item_count: int | None = None


class CollectionDetailResponse(BaseModel):
    slug: str
    title: str
    subtitle: str | None
    thesis: str | None
    collection_type: str
    media_scope: str
    refresh_policy: str
    cached_at: str | None
    items: list[TitleResponse]


def _to_title_response(t: ContentTitle) -> TitleResponse:
    return TitleResponse(
        id=t.id,
        tmdb_id=t.tmdb_id,
        content_type=t.content_type,
        title=t.title,
        overview=t.overview,
        poster_url=t.poster_url,
        backdrop_url=t.backdrop_url,
        genres=t.genres or [],
        release_date=t.release_date,
        runtime_minutes=t.runtime_minutes,
        season_count=t.season_count,
        tmdb_rating=float(t.tmdb_vote_average) if t.tmdb_vote_average else None,
        language=t.metadata_raw.get("original_language") if t.metadata_raw else None,
    )


def _to_summary(coll: Collection, poster_urls: list[str] | None = None) -> CollectionSummaryResponse:
    if poster_urls is None:
        # Use cached if available, don't resolve
        ids = coll.cached_title_ids or []
        poster_urls = []  # Will be empty until first resolution; caller should pre-populate
    return CollectionSummaryResponse(
        slug=coll.slug,
        title=coll.title,
        subtitle=coll.subtitle,
        thesis=coll.thesis,
        collection_type=coll.collection_type,
        media_scope=coll.media_scope,
        editorial_rank=coll.editorial_rank,
        poster_urls=poster_urls,
        item_count=len(coll.cached_title_ids or []) or None,
    )


@router.get("", response_model=list[CollectionSummaryResponse])
def list_collections(
    db: DbSession,
    _user: CurrentUser,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[CollectionSummaryResponse]:
    colls = get_active_collections(db)
    page = colls[offset: offset + limit]
    results = []
    for coll in page:
        poster_urls: list[str] = []
        if coll.cached_title_ids:
            from app.services.collections import _load_titles_by_uuid_ids
            titles = _load_titles_by_uuid_ids(db, coll.cached_title_ids[:4])
            poster_urls = [t.poster_url for t in titles if t.poster_url]
        results.append(_to_summary(coll, poster_urls))
    return results


@router.get("/{slug}", response_model=CollectionDetailResponse)
def get_collection(
    slug: str,
    db: DbSession,
    _user: CurrentUser,
    limit: int = Query(default=20, ge=4, le=30),
) -> CollectionDetailResponse:
    coll = get_collection_by_slug(db, slug)
    if coll is None or coll.status != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Collection not found")

    titles = resolve_collection_titles(db, coll, limit=limit)
    cached_at_str = coll.cached_at.isoformat() if coll.cached_at else None

    return CollectionDetailResponse(
        slug=coll.slug,
        title=coll.title,
        subtitle=coll.subtitle,
        thesis=coll.thesis,
        collection_type=coll.collection_type,
        media_scope=coll.media_scope,
        refresh_policy=coll.refresh_policy,
        cached_at=cached_at_str,
        items=[_to_title_response(t) for t in titles],
    )
