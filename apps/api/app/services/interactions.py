"""Interaction event helper — Discover brief §4 + §5.

One canonical entry point every mutation surface goes through so we can
attribute "user saved Arrival" vs "user saved Arrival because Discover
recommended it." Also drives immediate lightweight UserSignal refreshes
(§27) after high-value interactions.

Events are captured into the existing AnalyticsEvent append-only log. Signal
weights + recency multipliers are re-exported from `user_signals` so this
module is the single import point for downstream tuning.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.analytics import AnalyticsEvent
from app.services.user_signals import (
    SIGNAL_WEIGHTS,
    _recency_multiplier,  # re-export for external ranker tests
    compute_user_signals,
)


# High-value events trigger an immediate UserSignal recompute so recommendations
# feel responsive per brief §27 ("recalculate immediately after rating / save /
# removal / dislike / swipe / mood change"). Low-value events (profile views,
# impressions) skip the recompute and rely on the standard 6-hour staleness
# refresh in ensure_signals().
_RECOMPUTE_ON: set[str] = {
    "TITLE_RATED",
    "TITLE_SAVED",
    "TITLE_REMOVED",
    "SWIPE_LIKE",
    "SWIPE_DISLIKE",
    "SIGNAL_CORRECTION",
    "RECOMMENDATION_SAVED",
    "RECOMMENDATION_DISMISSED",
}


def log_interaction(
    db: Session,
    user_id: UUID | None,
    *,
    event_name: str,
    properties: dict[str, Any] | None = None,
    source_surface: str | None = None,
    source_module: str | None = None,
    recommendation_id: UUID | None = None,
    title_id: UUID | None = None,
    team_id: UUID | None = None,
    session_id: str | None = None,
    platform: str | None = None,
    app_build: str | None = None,
    recompute_signals: bool | None = None,
) -> None:
    """Record a normalized interaction event and optionally refresh signals.

    `event_name` should come from the taxonomy in Discover brief §4:
      TITLE_SAVED / TITLE_REMOVED / TITLE_RATED / TITLE_VIEWED /
      TITLE_DETAIL_OPENED / TITLE_SEARCHED / SWIPE_LIKE / SWIPE_DISLIKE /
      SWIPE_SKIP / RECOMMENDATION_OPENED / RECOMMENDATION_SAVED /
      RECOMMENDATION_DISMISSED / WATCH_PROVIDER_CLICKED / TEAM_TITLE_SAVED /
      TEAM_TITLE_VOTED / SIGNAL_CORRECTION.

    `recompute_signals` overrides the default (which is: recompute for the
    high-value events above). Explicit True forces recompute; False skips
    even for high-value events. Callers issuing multiple mutations in one
    request should pass False on all but the last to avoid redundant work.
    """
    merged_props = dict(properties or {})
    if source_surface:
        merged_props.setdefault("source_surface", source_surface)
    if source_module:
        merged_props.setdefault("source_module", source_module)
    if recommendation_id is not None:
        merged_props.setdefault("recommendation_id", str(recommendation_id))
    if title_id is not None:
        merged_props.setdefault("title_id", str(title_id))
    if team_id is not None:
        merged_props.setdefault("team_id", str(team_id))

    db.add(
        AnalyticsEvent(
            user_id=user_id,
            event_name=event_name,
            properties=merged_props,
            platform=platform,
            app_build=app_build,
            session_id=session_id,
        )
    )
    db.flush()

    should_recompute = (
        recompute_signals
        if recompute_signals is not None
        else event_name in _RECOMPUTE_ON
    )
    if should_recompute and user_id is not None:
        # Recompute is idempotent; failures shouldn't block the mutation.
        try:
            compute_user_signals(db, user_id)
        except Exception:
            pass


__all__ = [
    "log_interaction",
    "SIGNAL_WEIGHTS",
    "_recency_multiplier",
]
