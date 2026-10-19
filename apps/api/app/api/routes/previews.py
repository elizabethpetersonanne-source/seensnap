"""Previews feed — MVP surface for the Previews product spec.

Assembles a personalized feed of official teasers and trailers by:
  1. Reusing the existing recommendation engine to pick candidate titles
     (SceneDNA + saves + climbing + social — same mix the Swipe tab uses).
  2. For each candidate, calling TMDB /movie|tv/{id}/videos to find an
     eligible official Teaser or Trailer (Teaser-first per spec §8.2).
  3. Returning the ranked, deduplicated list.

Deferred to later phases (see spec §21):
  - Persistent `media_videos` inventory table with health-check history.
  - Background ingestion / freshness refresh job (this route fetches
    videos synchronously per request; fine at MVP volume, needs caching
    before scale).
  - Structured `preview_events` analytics table (clients POST to the
    existing /events endpoint for now).
  - Admin console kill switches.
  - Regional locale routing beyond en-US.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.preview_session import PreviewSession
from app.services.taste import get_social_recommendations
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


def _pick_video(videos: list[dict[str, str]]) -> dict[str, str] | None:
    """Teaser-first, then Trailer, official-only. Spec §8.2 launch policy."""
    official = [v for v in videos if str(v.get("official")) == "True" and v.get("key")]
    for wanted in ("Teaser", "Trailer"):
        for v in official:
            if v.get("type") == wanted:
                return v
    return None


def _reason_from_recommendation(rec: Any) -> PreviewReasonResponse:
    """Translate the existing recommendation's evidence into a Previews
    reason label. Reuses the same wording family the Swipe card uses."""
    # RecommendationResponse (Pydantic) has `reason` — a rendered string.
    # For MVP we route through it directly; a Phase-2 refactor could
    # expose structured evidence and let the client re-render per spec §10.4.
    reason_text = getattr(rec, "reason", None) or "A fresh pick for you"
    reason_type = getattr(rec, "reason_type", None) or "personalized"
    return PreviewReasonResponse(type=str(reason_type), label=str(reason_text))


class PreviewsForTitlesResponse(BaseModel):
    session_id: str
    items: list[PreviewFeedItemResponse]
    skipped_title_ids: list[UUID]  # titles with no eligible video


@router.get("/for-titles", response_model=PreviewsForTitlesResponse)
def get_previews_for_titles(
    current_user: CurrentUser,
    db: DbSession,
    ids: str = Query(..., description="Comma-separated ordered title UUIDs, up to 100"),
) -> PreviewsForTitlesResponse:
    """Sep-22 brief §14 "Watch previews for a ranked list". Resolves a
    playable Preview item per title in the SUPPLIED ORDER — no
    personalization / re-ranking / diversity pass. Titles with no
    eligible video are skipped and returned in `skipped_title_ids`
    so the client can annotate them ("this title had no preview")."""
    raw_ids = [x.strip() for x in ids.split(",") if x.strip()][:100]
    title_uuids: list[UUID] = []
    for raw in raw_ids:
        try:
            title_uuids.append(UUID(raw))
        except ValueError:
            continue
    title_rows = {t.id: t for t in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(title_uuids))).all()}
    items: list[PreviewFeedItemResponse] = []
    skipped: list[UUID] = []
    for tid in title_uuids:
        row = title_rows.get(tid)
        if row is None:
            skipped.append(tid)
            continue
        try:
            videos = fetch_title_videos(row)
        except TmdbConfigurationError:
            break
        except Exception:
            skipped.append(tid)
            continue
        picked = _pick_video(videos)
        if picked is None:
            skipped.append(tid)
            continue
        items.append(
            PreviewFeedItemResponse(
                feed_item_id=f"pfi-list-{tid}",
                title_id=tid,
                tmdb_id=row.tmdb_id,
                media_type=row.content_type,
                title=row.title,
                year=row.release_date.year if row.release_date else None,
                poster_url=row.poster_url,
                backdrop_url=row.backdrop_url,
                overview=row.overview,
                video=PreviewVideoResponse(
                    provider=picked.get("site", "YouTube"),
                    external_key=picked["key"],
                    type=picked.get("type", "Trailer"),
                    name=picked.get("name", ""),
                    official=str(picked.get("official")) == "True",
                ),
                reason=PreviewReasonResponse(
                    type="ranked_list_order",
                    label="From this ranked list",
                ),
            )
        )
    return PreviewsForTitlesResponse(
        session_id=f"pvlist-{current_user.id}",
        items=items,
        skipped_title_ids=skipped,
    )


import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4


def _filter_fingerprint(preferred_type: str | None, genre: str | None) -> str:
    """Stable hash of the filter dimensions so filter changes
    invalidate the cursor. Short-but-collision-safe."""
    key = f"mt={preferred_type or ''}|g={(genre or '').lower()}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


# Previews candidates expand in waves to find enough with eligible
# TMDB videos. The maximum scan ceiling guards against unbounded TMDB
# fanout for a cold-start user whose rec pool is thin. Bumped from 400
# to 1200 so users who exhaust a 25-item session can keep scrolling
# instead of hitting a hard wall at the first page.
_MAX_CANDIDATE_SCAN = 1200


@router.get("/feed", response_model=PreviewFeedResponse)
def get_previews_feed(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=15, ge=1, le=30),
    preferred_type: str | None = Query(default=None, pattern="^(movie|show)$"),
    genre: str | None = Query(default=None, max_length=40),
    cursor: str | None = Query(default=None, max_length=128),
    session_id: str | None = Query(default=None, max_length=80),
) -> PreviewFeedResponse:
    """Oct-18 build brief §3 fix 2: bounded opaque cursor backed by a
    stable server-side session snapshot. The client sees `cursor` as
    an opaque `<session_uuid>:<offset>` string that never grows with
    served-item count. Served IDs + scan offset live in preview_sessions.

    Filter changes invalidate the cursor via filter_fingerprint, so
    rapidly flipping Comedy → Horror can't surface late Comedy results
    inside the Horror queue.
    """
    fingerprint = _filter_fingerprint(preferred_type, genre)

    # Load session state (if any) and verify it matches the current filter.
    pv_session: PreviewSession | None = None
    if cursor:
        try:
            sid, _, offset_str = cursor.partition(":")
            sid_uuid = UUID(sid)
            pv_session = db.scalar(
                select(PreviewSession).where(
                    PreviewSession.id == sid_uuid,
                    PreviewSession.user_id == current_user.id,
                    PreviewSession.filter_fingerprint == fingerprint,
                )
            )
        except (ValueError, TypeError):
            pv_session = None
    if pv_session is None:
        # Fresh session (or filter changed / stale cursor).
        pv_session = PreviewSession(
            id=uuid4(),
            user_id=current_user.id,
            filter_fingerprint=fingerprint,
            served_title_ids=[],
            scan_offset=0,
            exhausted=False,
        )
        db.add(pv_session)
        db.flush()

    already_served_ids: set[UUID] = set(pv_session.served_title_ids or [])
    scan_offset = pv_session.scan_offset or 0

    # Progressive candidate retrieval. Request `scan_offset + over_fetch`
    # so the engine can skip past the previously-scanned portion
    # without us re-executing TMDB calls on titles we already decided
    # had no video.
    over_fetch = max(80, limit * 6)
    requested = min(scan_offset + over_fetch, _MAX_CANDIDATE_SCAN)
    candidates = get_social_recommendations(
        db,
        current_user.id,
        limit=requested,
        preferred_type=preferred_type,
        genre_filter=genre,
        session_id=session_id,
    )
    candidates = candidates[scan_offset:]

    used_title_ids: set[UUID] = set()
    items: list[PreviewFeedItemResponse] = []
    scanned = 0
    tmdb_broken = False
    # Share a single httpx client across the loop so TMDB calls reuse
    # a single connection pool instead of opening/closing a connection
    # per candidate (previously ~N×TLS handshakes per request).
    import httpx as _httpx  # local import to avoid broadening the module imports
    from app.core.config import settings as _settings
    from app.services.tmdb import _tmdb_headers as _hdrs
    tmdb_client = _httpx.Client(base_url=_settings.tmdb_base_url, headers=_hdrs(), timeout=10)
    try:
      for rec in candidates:
        scanned += 1
        if len(items) >= limit:
            break
        title_id = rec.title.id
        if title_id in already_served_ids or title_id in used_title_ids:
            continue
        title_row = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
        if title_row is None:
            continue
        try:
            videos = fetch_title_videos(title_row, client=tmdb_client)
        except TmdbConfigurationError:
            tmdb_broken = True
            break
        except Exception:
            continue
        picked = _pick_video(videos)
        if picked is None:
            continue
        used_title_ids.add(title_id)
        items.append(
            PreviewFeedItemResponse(
                feed_item_id=f"pfi-{title_id}",
                title_id=title_id,
                tmdb_id=title_row.tmdb_id,
                media_type=title_row.content_type,
                title=title_row.title,
                year=title_row.release_date.year if title_row.release_date else None,
                poster_url=title_row.poster_url,
                backdrop_url=title_row.backdrop_url,
                overview=title_row.overview,
                video=PreviewVideoResponse(
                    provider=picked.get("site", "YouTube"),
                    external_key=picked["key"],
                    type=picked.get("type", "Trailer"),
                    name=picked.get("name", ""),
                    official=str(picked.get("official")) == "True",
                ),
                reason=_reason_from_recommendation(rec),
            )
        )
    finally:
        tmdb_client.close()

    # Session state: scan_offset advances by what we actually scanned.
    # served_title_ids grows but stays bounded because it's server-side
    # and the client never sees it.
    new_offset = scan_offset + scanned
    new_served_ids = list(already_served_ids | {i.title_id for i in items})
    # Truthful exhaustion: we requested the max candidate scan ceiling
    # and either consumed every candidate without finding `limit` or
    # we found fewer than requested and have no room to grow.
    exhausted = (
        len(items) < limit
        and scanned >= len(candidates)
        and new_offset >= _MAX_CANDIDATE_SCAN
    )
    pv_session.scan_offset = new_offset
    # Bound stored served IDs to the most recent 500 to protect
    # row width in extreme sessions. The service will never remind
    # the client of titles it saw before this truncation window.
    pv_session.served_title_ids = new_served_ids[-500:]
    pv_session.exhausted = exhausted
    pv_session.updated_at = datetime.now(timezone.utc)
    db.commit()

    next_cursor = None if exhausted else f"{pv_session.id}:{new_offset}"

    return PreviewFeedResponse(
        session_id=session_id or str(pv_session.id),
        items=items,
        next_cursor=next_cursor,
        has_more=not exhausted and not tmdb_broken,
        status="exhausted" if exhausted else ("pending" if tmdb_broken else "ready"),
    )
