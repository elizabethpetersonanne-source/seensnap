"""Discover context engine — Discover brief §9 + §10 + §11.

Computes a `ContextProfile` from local time + weekday/weekend + connected
services + recent activity. The profile is then used to CHANGE RANKING (not
just copy) per §11 — different windows boost different attribute sets, so
"Movie Night" and "Late Night" surface materially different titles even for
the same user.

Explicit non-goals for this MVP (§9): no weather, no calendar, no device
context, no AI-generated contextual storytelling. Time + day + region alone
are enough to shift the deck.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.social import Watchlist, WatchlistItem
from app.models.taste import SwipeRecord


# Context windows per Discover brief §10 (config lives here; not buried in
# React components). Half-open interval semantics: [start, end).
_WINDOWS: list[tuple[str, int, int]] = [
    ("morning", 6, 11),        # 6-11
    ("midday", 11, 14),        # 11-2
    ("afternoon", 14, 17),     # 2-5
    ("early_evening", 17, 19), # 5-7
    ("movie_night", 19, 22),   # 7-10
    # 22-06 wraps midnight; handled explicitly below.
]


@dataclass
class ContextProfile:
    """Snapshot of the user's current viewing context. Consumed by the
    recommendation service to pick a mode and by the feed orchestrator to
    label modules honestly.

    Fields:
        window          — canonical time window key ('movie_night' etc.)
        display_label   — human-facing label ('Movie Night', 'Late Night', ...)
        is_weekend      — True on Sat/Sun
        recommended_mode— which RecommendationService mode this window prefers
        confidence      — 'high' | 'medium' | 'low'; drives copy honesty per §13
        available_providers — connected streaming service codes (for §20 boost)
        recent_activity_seconds_ago — seconds since last user interaction, if any
    """

    window: str
    display_label: str
    is_weekend: bool
    recommended_mode: str
    confidence: str
    available_providers: list[str] = field(default_factory=list)
    recent_activity_seconds_ago: int | None = None
    local_hour: int = 0
    day_of_week: int = 0  # 0=Monday
    computed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "window": self.window,
            "display_label": self.display_label,
            "is_weekend": self.is_weekend,
            "recommended_mode": self.recommended_mode,
            "confidence": self.confidence,
            "available_providers": self.available_providers,
            "recent_activity_seconds_ago": self.recent_activity_seconds_ago,
            "local_hour": self.local_hour,
            "day_of_week": self.day_of_week,
        }


def _window_for_hour(hour: int) -> tuple[str, str]:
    """Returns (window_key, display_label)."""
    for key, start, end in _WINDOWS:
        if start <= hour < end:
            return key, _display_label(key)
    # Late night wraps midnight (22-06).
    return "late_night", "Late Night"


def _display_label(key: str) -> str:
    return {
        "morning": "Morning",
        "midday": "Midday",
        "afternoon": "Afternoon Pick",
        "early_evening": "Early Evening",
        "movie_night": "Movie Night",
        "late_night": "Late Night",
    }.get(key, "Tonight")


# Window → RecommendationService mode preference. Each mode is a REAL
# candidate-pool filter with attribute matching, not just a relabeling
# (see recommendation_service.MODES).
_WINDOW_TO_MODE: dict[str, str] = {
    "morning": "afternoon",       # low-intensity easy watch
    "midday": "afternoon",        # same treatment as morning
    "afternoon": "afternoon",     # runtime ≤ 100, easy-watch context
    "early_evening": "perfect",   # personalized default, no attribute filter
    "movie_night": "movie-night", # runtime ≥ 105, movie-night context
    "late_night": "late-night",   # runtime ≤ 95, late-night context
}


def compute_context_profile(
    db: Session,
    user_id: UUID,
    *,
    now: datetime | None = None,
    local_hour: int | None = None,
    is_weekend_override: bool | None = None,
    available_providers: list[str] | None = None,
) -> ContextProfile:
    """Assemble the profile. Server time is the fallback; callers running in
    the client's timezone (mobile app) should pass `local_hour` explicitly so
    the window matches the user's actual clock.

    `is_weekend_override` lets callers force Friday-evening-as-weekend
    treatment; default derives from `now`'s weekday."""
    when = now or datetime.now(timezone.utc)
    hour = local_hour if local_hour is not None else when.hour
    hour = max(0, min(hour, 23))

    day_of_week = when.weekday()
    is_weekend = is_weekend_override if is_weekend_override is not None else day_of_week >= 5

    window, label = _window_for_hour(hour)
    mode = _WINDOW_TO_MODE.get(window, "perfect")

    # Weekend nudge — Friday/Saturday evening extends Movie Night appetite
    # slightly (people commit to longer viewing). Sunday afternoon leans into
    # comfort/rewatch territory.
    if is_weekend and window == "early_evening":
        window = "movie_night"
        label = "Movie Night"
        mode = "movie-night"
    if is_weekend and day_of_week == 6 and window == "afternoon":
        mode = "comfort"

    # Recent activity — how many seconds since the user last did anything.
    # Discover uses this to distinguish "just opened the app" from "back
    # after 3 days" for module ranking.
    recent_activity = _seconds_since_last_activity(db, user_id, now=when)

    # Confidence — how strongly this profile should drive the hero pick.
    # High: user has activity in the last hour. Medium: within 24h.
    # Low: cold/first session — hero pick should soften copy per §13.
    if recent_activity is not None and recent_activity < 3600:
        confidence = "high"
    elif recent_activity is not None and recent_activity < 86_400:
        confidence = "medium"
    else:
        confidence = "low"

    return ContextProfile(
        window=window,
        display_label=label,
        is_weekend=is_weekend,
        recommended_mode=mode,
        confidence=confidence,
        available_providers=available_providers or [],
        recent_activity_seconds_ago=recent_activity,
        local_hour=hour,
        day_of_week=day_of_week,
    )


def _seconds_since_last_activity(
    db: Session, user_id: UUID, *, now: datetime
) -> int | None:
    """Cheap heuristic — most recent swipe or save timestamp. Watchlists
    and swipes cover 90%+ of real activity; adding rating checks would
    triple the query cost for marginal signal."""
    last_swipe = db.scalar(
        select(SwipeRecord.created_at)
        .where(SwipeRecord.user_id == user_id)
        .order_by(SwipeRecord.created_at.desc())
        .limit(1)
    )
    last_save = db.scalar(
        select(WatchlistItem.created_at)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.owner_user_id == user_id)
        .order_by(WatchlistItem.created_at.desc())
        .limit(1)
    )
    candidates = [c for c in (last_swipe, last_save) if c is not None]
    if not candidates:
        return None
    latest = max(candidates)
    if latest.tzinfo is None:
        latest = latest.replace(tzinfo=timezone.utc)
    return int((now - latest).total_seconds())


def label_for_confidence(confidence: str, default: str = "Tonight's Pick") -> str:
    """Honest copy per Discover brief §13.

        high  → "Tonight's Pick"       (score ≥ 0.80)
        medium→ "Worth a Look Tonight" (score 0.60-0.79)
        low   → "Popular Tonight"      (score < 0.60 or cold-start)

    Callers can override the default label per mode (e.g., "Late Night Pick").
    """
    return {
        "high": default,
        "medium": f"Worth a Look — {default.split(' — ')[-1]}" if " — " in default else "Worth a Look",
        "low": "Popular Right Now",
    }.get(confidence, default)
