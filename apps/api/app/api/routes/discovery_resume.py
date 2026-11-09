"""Revalidate an owner-held discovery queue before showing it after a restart."""

import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.discovery import DiscoverySession, DiscoveryDecision
from app.models.user import UserProfile
from app.services import discovery_feed as feed
from app.services.discovery_decisions import excluded_title_ids
from app.services.title_compatibility import scorer_for_user
from app.services.tmdb import TmdbConfigurationError

router = APIRouter()


class ResumeRequest(BaseModel):
    cursor: str = Field(max_length=128)
    title_ids: list[UUID] = Field(max_length=100)
    surface: Literal["swipe", "preview"]
    preferred_type: Literal["movie", "show"] | None = None
    genre: str | None = Field(None, max_length=40)
    mode: Literal["streaming", "all"] = "streaming"


@router.post("")
def resume_discovery(payload: ResumeRequest, current_user: CurrentUser, db: DbSession):
    from app.api.routes.titles import _to_title_response

    try:
        sid, raw_version = payload.cursor.split(":")
        sid = UUID(sid)
        version = int(raw_version)
    except (ValueError, TypeError):
        raise HTTPException(409, detail="Refresh your picks to continue.")
    session = db.scalar(
        select(DiscoverySession)
        .where(DiscoverySession.id == sid, DiscoverySession.user_id == current_user.id)
        .with_for_update()
    )
    now = datetime.now(timezone.utc)
    profile = db.get(UserProfile, current_user.id)
    region = ((profile.country_code if profile else None) or "US").upper()
    genre = (payload.genre or "").strip().casefold() or None
    expected = feed.fingerprint(
        payload.preferred_type, genre, region, payload.mode, payload.surface
    )
    if (
        session is None
        or session.fingerprint != expected
        or now - session.created_at.replace(tzinfo=timezone.utc) >= timedelta(hours=24)
        or version not in (session.version, session.version - 1)
    ):
        raise HTTPException(409, detail="Your saved picks are out of date. Refresh to continue.")
    state = copy.deepcopy(session.state)
    allowed = set(state.get("served", []))
    if any(str(key) not in allowed for key in payload.title_ids):
        raise HTTPException(409, detail="Refresh your picks to continue.")
    ids = list(dict.fromkeys(payload.title_ids))
    # Recover an acknowledged server page whose response never reached device storage.
    if version == session.version - 1:
        for item in session.last_response.get("items", []):
            key = UUID(item.get("title_id") or item["title"]["id"])
            if key not in ids:
                ids.append(key)
    excluded = excluded_title_ids(db, current_user.id)
    excluded.update(
        db.scalars(
            select(DiscoveryDecision.content_title_id).where(
                DiscoveryDecision.user_id == current_user.id,
                DiscoveryDecision.created_at >= session.created_at,
                DiscoveryDecision.undone_at.is_(None),
            )
        ).all()
    )
    by_id = {
        t.id: t for t in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(ids))).all()
    }
    rows = [
        by_id[key]
        for key in ids
        if key in by_id
        and feed.eligible(
            by_id[key],
            excluded,
            payload.preferred_type,
            genre,
            region,
            payload.mode,
            now.date(),
            now,
        )
    ]
    videos = state.get("resume_videos", {})
    if payload.surface == "preview":
        missing = [row for row in rows if str(row.id) not in videos]
        with ThreadPoolExecutor(max_workers=12) as pool:
            pending = {row.id: pool.submit(feed._video, row) for row in missing}
            for key, future in pending.items():
                try:
                    videos[str(key)] = future.result()
                except (httpx.HTTPError, TmdbConfigurationError):
                    raise HTTPException(503, detail="Could not restore previews. Please retry.")
        rows = [row for row in rows if videos.get(str(row.id))]
    scorer = scorer_for_user(db, current_user.id, rows)
    items = []
    for row in rows:
        match = scorer.score(row)
        reason = (
            match.explanation
            if match.score is not None
            else "Available in your region · learning your taste"
        )
        if payload.surface == "swipe":
            dto = _to_title_response(row)
            dto.scenedna = match
            items.append(
                {"title": dto.model_dump(mode="json"), "reason": reason, "seed_title_id": None}
            )
        else:
            items.append(
                {
                    "feed_item_id": f"pfi-{session.id}-{row.id}",
                    "title_id": str(row.id),
                    "tmdb_id": row.tmdb_id,
                    "media_type": row.content_type,
                    "title": row.title,
                    "year": row.release_date.year,
                    "poster_url": row.poster_url,
                    "backdrop_url": row.backdrop_url,
                    "overview": row.overview,
                    "video": videos[str(row.id)],
                    "scenedna": match.model_dump(mode="json"),
                    "reason": {"type": "signal_match", "label": reason},
                }
            )
    more = bool(state.get("pending")) or any(
        not source["done"] for source in state.get("sources", {}).values()
    )
    # Resume is read-only: it neither consumes a page nor records a swipe.
    return {
        "session_id": str(session.id),
        "items": items,
        "resume_cursor": f"{session.id}:{session.version}",
        "next_cursor": f"{session.id}:{session.version}" if more else None,
        "has_more": more,
        "status": "ready" if items else "pending" if more else "exhausted",
    }
