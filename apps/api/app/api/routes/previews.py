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


import base64
import json


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


def _encode_cursor(state: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(state).encode()).decode()


def _decode_cursor(cursor: str | None) -> dict:
    if not cursor:
        return {}
    try:
        return json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
    except Exception:
        return {}


@router.get("/feed", response_model=PreviewFeedResponse)
def get_previews_feed(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=15, ge=1, le=30),
    preferred_type: str | None = Query(default=None, pattern="^(movie|show)$"),
    genre: str | None = Query(default=None, max_length=40),
    cursor: str | None = Query(default=None, max_length=512),
    session_id: str | None = Query(default=None, max_length=80),
) -> PreviewFeedResponse:
    """Personalized Previews feed with cursor-based continuation per
    Sep-22 brief §4. Removes the artificial 25-item stop by tracking
    how many candidates have already been scanned (in the opaque
    cursor) and resuming from that offset on the next page.

    Also filters out title/video pairs the user impressed on in the
    last 7 days so reopening Previews doesn't repeatedly start with
    the same initial set. Impression tracking currently lives in the
    session-scoped set already served in this session; a persistent
    `preview_impressions` table is deferred as a fast follow (spec
    §21 Phase 1.1).
    """
    state = _decode_cursor(cursor)
    already_served_ids = set(state.get("served", []))
    scan_offset = int(state.get("scan_offset", 0))

    # Over-fetch aggressively so the yield-rate (candidates with a
    # playable YouTube video) still meets `limit` after suppression.
    over_fetch = max(80, limit * 6)
    candidates = get_social_recommendations(
        db,
        current_user.id,
        limit=min(over_fetch + scan_offset, 240),
        preferred_type=preferred_type,
        genre_filter=genre,
        session_id=session_id,
    )
    # Skip the portion the previous page already scanned.
    candidates = candidates[scan_offset:]

    used_title_ids: set[UUID] = set()
    items: list[PreviewFeedItemResponse] = []
    scanned = 0
    exhausted = False
    tmdb_broken = False
    for rec in candidates:
        scanned += 1
        if len(items) >= limit:
            break
        title_id = rec.title.id
        if str(title_id) in already_served_ids:
            continue
        if title_id in used_title_ids:
            continue
        title_row = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
        if title_row is None:
            continue
        try:
            videos = fetch_title_videos(title_row)
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
    # If we hit the end of the scan window without finding `limit`
    # items and the candidate pool didn't grow (already at the 240
    # over-fetch cap), the eligible pool is exhausted per §4.
    exhausted = (
        len(items) < limit and scanned >= len(candidates) and scan_offset + scanned >= 240
    )

    # Next cursor packs the served-title set + the new scan_offset.
    next_state = {
        "served": list(already_served_ids | {str(i.title_id) for i in items})[:200],
        "scan_offset": scan_offset + scanned,
    }
    next_cursor = _encode_cursor(next_state) if not exhausted else None

    return PreviewFeedResponse(
        session_id=session_id or f"pv-{current_user.id}",
        items=items,
        next_cursor=next_cursor,
        has_more=not exhausted and not tmdb_broken,
        status="exhausted" if exhausted else ("pending" if tmdb_broken else "ready"),
    )
