"""Discover home composition and trending aggregation with confidence ladder."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.content import ContentTitle
from app.models.taste import SwipeRecord
from app.models.social import Rating, Watchlist, WatchlistItem
from app.models.user import User
from app.services.tmdb import (
    _tmdb_headers,
    _upsert_title_from_tmdb_result,
    TmdbConfigurationError,
    fetch_trending_titles,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Trending signal weights (centralised — change here, affects everything)
# ---------------------------------------------------------------------------

SIGNAL_WEIGHTS: dict[str, float] = {
    "watch_now_click": 5.0,
    "save": 5.0,
    "share": 4.0,
    "team_action": 4.0,
    "high_rating": 3.5,   # rating >= 4
    "strong_team_rank": 3.0,
    "swipe_right": 2.0,
    "swipe_super": 4.0,
    "title_detail_open": 0.5,
    "swipe_left": -0.5,   # small dampener
}

# Require these minimums for "seensnap" source mode
SEENSNAP_MIN_UNIQUE_USERS = 5
SEENSNAP_MIN_WEIGHTED_SCORE = 10.0

# For "hybrid" mode: some SeenSnap activity exists but below confidence threshold
HYBRID_MIN_UNIQUE_USERS = 2


def _trending_window_cutoff(hours: int = 72) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=hours)


def _compute_seensnap_trending(db: Session, limit: int = 20) -> tuple[list[ContentTitle], str]:
    """
    Score titles from real SeenSnap activity. Returns (titles, source_mode).
    source_mode: 'seensnap' | 'hybrid' | None (insufficient data)
    """
    cutoff = _trending_window_cutoff(hours=72)

    # Collect weighted scores per title from different signal tables
    scores: dict[str, float] = {}
    unique_users: dict[str, set[str]] = {}

    def _add(title_id: str, user_id: str, weight: float) -> None:
        scores[title_id] = scores.get(title_id, 0.0) + weight
        unique_users.setdefault(title_id, set()).add(user_id)

    # Real-user filter: never include demo accounts in trending computation.
    # This mirrors the isolation applied in feed/teams/search queries.
    non_demo_user_ids = select(User.id).where(User.is_demo.is_(False))

    # SwipeRecord signals
    try:
        swipes = db.execute(
            select(
                SwipeRecord.content_title_id,
                SwipeRecord.user_id,
                SwipeRecord.direction,
            ).where(
                SwipeRecord.created_at >= cutoff,
                SwipeRecord.user_id.in_(non_demo_user_ids),
            )
        ).fetchall()
        for row in swipes:
            tid, uid, direction = str(row[0]), str(row[1]), row[2]
            if direction == "right":
                _add(tid, uid, SIGNAL_WEIGHTS["swipe_right"])
            elif direction == "up":
                _add(tid, uid, SIGNAL_WEIGHTS["swipe_super"])
            elif direction == "left":
                _add(tid, uid, SIGNAL_WEIGHTS["swipe_left"])
    except Exception as exc:
        log.debug("Swipe trending query failed: %s", exc)

    # WatchlistItem saves (join through Watchlist to get owner user_id)
    try:
        saves = db.execute(
            select(
                WatchlistItem.content_title_id,
                Watchlist.owner_user_id,
            )
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .where(
                WatchlistItem.created_at >= cutoff,
                Watchlist.owner_user_id.in_(non_demo_user_ids),
            )
        ).fetchall()
        for row in saves:
            tid, uid = str(row[0]), str(row[1])
            _add(tid, uid, SIGNAL_WEIGHTS["save"])
    except Exception as exc:
        log.debug("Save trending query failed: %s", exc)

    # Rating signals
    try:
        ratings = db.execute(
            select(
                Rating.content_title_id,
                Rating.user_id,
                Rating.score,
            ).where(
                Rating.created_at >= cutoff,
                Rating.user_id.in_(non_demo_user_ids),
            )
        ).fetchall()
        for row in ratings:
            tid, uid, score = str(row[0]), str(row[1]), float(row[2] or 0)
            if score >= 4:
                _add(tid, uid, SIGNAL_WEIGHTS["high_rating"])
    except Exception as exc:
        log.debug("Rating trending query failed: %s", exc)

    # Determine confidence level
    qualified: list[tuple[str, float]] = []
    for tid, score in scores.items():
        ucount = len(unique_users.get(tid, set()))
        if ucount >= SEENSNAP_MIN_UNIQUE_USERS and score >= SEENSNAP_MIN_WEIGHTED_SCORE:
            qualified.append((tid, score))

    if len(qualified) >= 6:
        source_mode = "seensnap"
        sorted_ids = [tid for tid, _ in sorted(qualified, key=lambda x: x[1], reverse=True)][:limit]
    elif any(len(u) >= HYBRID_MIN_UNIQUE_USERS for u in unique_users.values()):
        source_mode = "hybrid"
        # Keep any title with ≥2 unique users for hybrid blend
        partial = [(tid, sc) for tid, sc in scores.items() if len(unique_users.get(tid, set())) >= HYBRID_MIN_UNIQUE_USERS]
        sorted_ids = [tid for tid, _ in sorted(partial, key=lambda x: x[1], reverse=True)][:limit // 2]
    else:
        return [], "insufficient"

    if not sorted_ids:
        return [], "insufficient"

    rows = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(sorted_ids))).all()
    id_order = {str(r.id): i for i, r in enumerate(rows)}
    ordered = sorted(rows, key=lambda r: id_order.get(str(r.id), 999))
    return ordered, source_mode


def _fetch_tmdb_trending(db: Session, limit: int) -> list[ContentTitle]:
    try:
        return fetch_trending_titles(db, limit=limit)
    except Exception as exc:
        log.warning("TMDB trending fetch failed: %s", exc)
        return []


def _fetch_tmdb_popular(db: Session, limit: int) -> list[ContentTitle]:
    try:
        with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
            resp = client.get("/movie/popular", params={"language": "en-US", "page": 1})
            resp.raise_for_status()
            results = resp.json().get("results", [])[:limit]
        titles = []
        for item in results:
            item["media_type"] = "movie"
            t = _upsert_title_from_tmdb_result(db, item)
            if t:
                titles.append(t)
        db.commit()
        return titles
    except Exception as exc:
        log.warning("TMDB popular fetch failed: %s", exc)
        return []


def _fetch_tmdb_top_rated(db: Session, limit: int) -> list[ContentTitle]:
    try:
        with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
            resp = client.get("/movie/top_rated", params={"language": "en-US", "page": 1})
            resp.raise_for_status()
            results = resp.json().get("results", [])[:limit]
        titles = []
        for item in results:
            item["media_type"] = "movie"
            t = _upsert_title_from_tmdb_result(db, item)
            if t:
                titles.append(t)
        db.commit()
        return titles
    except Exception as exc:
        log.warning("TMDB top-rated fetch failed: %s", exc)
        return []


SOURCE_MODE_LABELS: dict[str, str] = {
    "seensnap": "Trending on SeenSnap",
    "hybrid": "Trending Now",
    "tmdb_trending": "Trending Now",
    "tmdb_popular": "Popular Right Now",
    "tmdb_top_rated": "All-Time Favorites",
}


def get_trending(db: Session, limit: int = 12) -> dict[str, Any]:
    """Return trending titles with confidence-aware source_mode and display label."""
    generated_at = datetime.now(timezone.utc).isoformat()

    seensnap_titles, ss_mode = _compute_seensnap_trending(db, limit=limit)

    if ss_mode == "seensnap" and seensnap_titles:
        source_mode = "seensnap"
        titles = seensnap_titles
    elif ss_mode == "hybrid" and seensnap_titles:
        # Blend: SeenSnap titles first, pad with TMDB trending
        tmdb_fallback = _fetch_tmdb_trending(db, limit=limit)
        seen_ids = {str(t.id) for t in seensnap_titles}
        extra = [t for t in tmdb_fallback if str(t.id) not in seen_ids]
        titles = (seensnap_titles + extra)[:limit]
        source_mode = "hybrid"
    else:
        tmdb_titles = _fetch_tmdb_trending(db, limit=limit)
        if tmdb_titles:
            source_mode = "tmdb_trending"
            titles = tmdb_titles
        else:
            popular = _fetch_tmdb_popular(db, limit=limit)
            if popular:
                source_mode = "tmdb_popular"
                titles = popular
            else:
                top_rated = _fetch_tmdb_top_rated(db, limit=limit)
                source_mode = "tmdb_top_rated"
                titles = top_rated

    display_label = SOURCE_MODE_LABELS.get(source_mode, "Trending Now")

    return {
        "source_mode": source_mode,
        "display_label": display_label,
        "generated_at": generated_at,
        "items": titles,
    }
