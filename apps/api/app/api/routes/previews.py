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


@router.get("/feed", response_model=PreviewFeedResponse)
def get_previews_feed(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=15, ge=1, le=30),
    session_id: str | None = Query(default=None, max_length=80),
) -> PreviewFeedResponse:
    """Personalized Previews feed. Fetches candidates via the shared
    recommendation engine, then tries to pull an official teaser/trailer
    for each. Returns up to `limit` items that have a playable video."""
    # Over-fetch recommendations because many candidates won't have an
    # eligible YouTube teaser/trailer — spec §21 Phase 0 flags exactly
    # this coverage risk. 3x oversample is a reasonable MVP heuristic.
    candidates = get_social_recommendations(
        db,
        current_user.id,
        limit=min(limit * 3, 60),
        session_id=session_id,
    )

    used_title_ids: set[UUID] = set()
    items: list[PreviewFeedItemResponse] = []
    for rec in candidates:
        if len(items) >= limit:
            break
        title_id = rec.title.id
        if title_id in used_title_ids:
            continue
        # Fetch the ContentTitle row so we have the raw tmdb_id +
        # backdrop_url that the client renders behind the video.
        title_row = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
        if title_row is None:
            continue
        try:
            videos = fetch_title_videos(title_row)
        except TmdbConfigurationError:
            break  # TMDB not configured — no point retrying per candidate
        except Exception:
            continue  # per-title lookup failure shouldn't kill the whole feed
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
    return PreviewFeedResponse(session_id=session_id or f"pv-{current_user.id}", items=items)
