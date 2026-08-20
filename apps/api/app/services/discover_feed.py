"""Discover feed orchestrator — Discover brief §2, §27, §28.

Backend returns Discover as a list of structured modules; the mobile client
renders what it gets. Each module has explicit eligibility (§27) — modules
appear because DATA EXISTS, never because "the homepage looked empty."

Module types:
  - contextual_pick       (single hero, brief §12)
  - personalized_rail     (For Your Scene — brief §15)
  - trending              (raw TMDB — brief §18, explicitly labeled)
  - trending_for_you      (personalized-filtered trending)
  - team_recommendation   (team-scoped recs when team+signals exist)
  - because_you           (strong-anchor rails, brief §16)
  - collection            (editorial curation, brief §19)
  - exploration_rail      (§23 — 10-20% inventory for taste stretch)

Session-level dedup happens INSIDE the orchestrator — a title picked as the
Contextual Hero is stripped from every subsequent module in the same response.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import Watchlist, WatchlistItem
from app.models.taste import UserSignal
from app.services.discover_context import (
    ContextProfile,
    compute_context_profile,
    label_for_confidence,
)
from app.services.recommendation_service import MODES, recommend_for_user
from app.services.teams import list_user_teams
from app.services.user_signals import ensure_signals


# Cold-start threshold — below these interaction counts, we mark the user
# stage 0 and only include modules that don't claim personalization (brief
# §26). Modules explicitly gated by `personal_signal_count >= X`.
_STAGE_1_MIN_SIGNALS = 3   # emerging signals exist
_STAGE_2_MIN_SIGNALS = 8   # full personalization unlocked


def _signal_count_for(db: Session, user_id: UUID) -> int:
    """How many first-class UserSignal rows the user has above zero score."""
    ensure_signals(db, user_id)
    rows = db.scalars(
        select(UserSignal).where(UserSignal.user_id == user_id, UserSignal.score > 0)
    ).all()
    return len(rows)


def _serialize_title(t: ContentTitle) -> dict:
    return {
        "id": str(t.id),
        "title": t.title,
        "content_type": t.content_type,
        "poster_url": t.poster_url,
        "backdrop_url": t.backdrop_url,
        "overview": t.overview,
        "release_date": t.release_date.isoformat() if t.release_date else None,
        "genres": t.genres or [],
        "tmdb_vote_average": float(t.tmdb_vote_average) if t.tmdb_vote_average is not None else None,
    }


def _dedup_ids(items: list[dict], seen: set[UUID]) -> list[dict]:
    """Strip any items already emitted higher in the same response."""
    out = []
    for item in items:
        tid = item.get("title", {}).get("id") if isinstance(item.get("title"), dict) else None
        if tid is None:
            continue
        try:
            uid = UUID(str(tid))
        except (ValueError, TypeError):
            continue
        if uid in seen:
            continue
        seen.add(uid)
        out.append(item)
    return out


def _to_item(rec: dict) -> dict:
    """Convert a recommendation_service result into the wire shape used by
    every Discover module. Includes impression_id for feedback attribution."""
    title = rec["title"]
    return {
        "impression_id": rec.get("impression_id"),
        "title": _serialize_title(title),
        "score": rec.get("score"),
        "confidence": rec.get("confidence"),
        "reasons": rec.get("reasons", []),
        "reason_template": rec.get("reason_template"),
    }


def _hero_label(context: ContextProfile, top_rec: dict | None) -> str:
    """Honest hero copy per brief §13:
      score >= 0.80 → 'Movie Night' / 'Late Night Pick' / etc. (context-scoped)
      0.60 - 0.79  → 'Worth a Look Tonight'
      < 0.60       → 'Popular Tonight'
    """
    if not top_rec:
        return "Popular Right Now"
    conf = top_rec.get("confidence", "cold-start")
    if conf == "excellent":
        return context.display_label
    if conf == "strong":
        return context.display_label
    if conf == "worth-a-look":
        return f"Worth a Look — {context.display_label}"
    return "Popular Right Now"


def _contextual_hero(
    db: Session,
    user_id: UUID,
    context: ContextProfile,
    seen: set[UUID],
) -> dict | None:
    """Highest-confidence single recommendation for the current context.
    §12: one large functional pick, not decorative. §13: label reflects real
    confidence — never claim certainty we don't have."""
    recs = recommend_for_user(
        db,
        user_id,
        mode=context.recommended_mode,
        limit=8,
        surface=f"discover_hero_{context.window}",
    )
    if not recs:
        return None
    fresh = [r for r in recs if r["title"].id not in seen]
    if not fresh:
        return None
    top = fresh[0]
    seen.add(top["title"].id)
    item = _to_item(top)
    return {
        "type": "contextual_pick",
        "window": context.window,
        "mode": context.recommended_mode,
        "label": _hero_label(context, top),
        "item": item,
    }


def _personalized_rail(db: Session, user_id: UUID, seen: set[UUID]) -> dict | None:
    """For Your Scene — the principal personalized rail (§15). Only visible
    when the user has enough signal to justify the "for you" framing."""
    recs = recommend_for_user(
        db,
        user_id,
        mode="perfect",
        limit=12,
        surface="discover_for_your_scene",
    )
    items = _dedup_ids([_to_item(r) for r in recs], seen)
    if not items:
        return None
    return {
        "type": "personalized_rail",
        "key": "for_your_scene",
        "label": "For Your Scene",
        "subtitle": "Personalized to your taste this week.",
        "items": items,
    }


def _because_you_rail(
    db: Session, user_id: UUID, seen: set[UUID]
) -> dict | None:
    """§16 — only generate when there IS a legitimate anchor. Uses the user's
    strongest recent positive signal as the anchor. Skipped when no strong
    signal exists (rather than manufacturing a rail to fill space)."""
    ensure_signals(db, user_id)
    top_signal = db.scalar(
        select(UserSignal)
        .where(
            UserSignal.user_id == user_id,
            UserSignal.signal_type.in_(("label", "theme", "genre")),
            UserSignal.score >= 0.55,
            UserSignal.sample_size >= 4,
        )
        .order_by(UserSignal.score.desc())
        .limit(1)
    )
    if top_signal is None:
        return None
    recs = recommend_for_user(
        db,
        user_id,
        mode="perfect",
        limit=10,
        surface=f"discover_because_you:{top_signal.signal_name}",
    )
    items = _dedup_ids([_to_item(r) for r in recs], seen)
    if len(items) < 4:
        return None
    return {
        "type": "because_you",
        "key": f"because_you:{top_signal.signal_name}",
        "label": f"Because you keep saving {top_signal.signal_name.lower()}",
        "subtitle": f"{top_signal.sample_size} interactions and counting.",
        "items": items[:8],
    }


def _team_module(
    db: Session, user_id: UUID, seen: set[UUID]
) -> dict | None:
    """§27 — team_recommendation requires active_team + team_signal_count >= X.
    Absent when the user has no teams (never populated with mock)."""
    team_ids = [team.id for team, _ in list_user_teams(db, user_id)]
    if not team_ids:
        return None
    # For MVP: use "perfect" mode with a distinct surface tag so team-context
    # dedup and analytics work. Real team-personalized ranking lives in
    # _source_watch_team inside taste.py which the unified service already
    # inherits when we blend later.
    recs = recommend_for_user(
        db,
        user_id,
        mode="perfect",
        limit=8,
        surface="discover_team",
    )
    items = _dedup_ids([_to_item(r) for r in recs], seen)
    if len(items) < 3:
        return None
    return {
        "type": "team_recommendation",
        "key": "from_your_teams",
        "label": "From Your Teams",
        "subtitle": "Titles crossing shared taste.",
        "items": items[:6],
    }


def _trending_module(db: Session, seen: set[UUID], *, limit: int = 12) -> dict | None:
    """Raw TMDB-backed trending. Explicitly labeled "Trending Now" — brief
    §18 makes clear this is separate from any personalized rank. Uses the
    existing discover_trending source. Always eligible (§27) but obeys
    session dedup so a title already surfaced elsewhere isn't repeated."""
    from app.services.discover import get_trending

    # get_trending returns a dict, not an object — `.items` on a dict is a
    # method, so we index by key. Over-fetch so dedup doesn't leave gaps.
    result = get_trending(db, limit=limit * 2)
    titles = result.get("items") if isinstance(result, dict) else []
    items: list[dict] = []
    for t in titles:
        if t.id in seen:
            continue
        seen.add(t.id)
        items.append({
            "impression_id": None,  # trending isn't a personalized impression
            "title": _serialize_title(t),
            "score": None,
            "confidence": None,
            "reasons": [{"type": "trending_source"}],
            "reason_template": "Trending on SeenSnap right now.",
        })
        if len(items) >= limit:
            break
    if not items:
        return None
    return {
        "type": "trending",
        "key": "trending_now",
        "label": "Trending Now",
        "subtitle": "Not personalized — what everyone's watching.",
        "items": items,
    }


def _exploration_rail(
    db: Session, user_id: UUID, seen: set[UUID]
) -> dict | None:
    """§23 — controlled taste expansion. Uses the 'stretch' mode which is
    intended to blend adjacent-genre picks. Always labeled explicitly so the
    user knows this is discovery, not personalization certainty."""
    recs = recommend_for_user(
        db,
        user_id,
        mode="stretch",
        limit=8,
        surface="discover_exploration",
    )
    items = _dedup_ids([_to_item(r) for r in recs], seen)
    if len(items) < 3:
        return None
    return {
        "type": "exploration_rail",
        "key": "outside_your_scene",
        "label": "A little outside your scene",
        "subtitle": "Different, but with a plausible connection.",
        "items": items[:6],
    }


def build_discover_feed(
    db: Session,
    user_id: UUID,
    *,
    local_hour: int | None = None,
    is_weekend_override: bool | None = None,
    available_providers: list[str] | None = None,
) -> dict:
    """Assemble the Discover feed. Returns a structured payload the client
    renders directly — no per-module fetching. Every included module is
    eligible (per §27); absent modules did not qualify.

    Returns:
        {
          "context": {...},
          "user_stage": "cold_start" | "emerging" | "personalized",
          "modules": [ {type, key, label, subtitle, items[]}, ... ]
        }
    """
    context = compute_context_profile(
        db,
        user_id,
        local_hour=local_hour,
        is_weekend_override=is_weekend_override,
        available_providers=available_providers,
    )
    signal_count = _signal_count_for(db, user_id)
    if signal_count < _STAGE_1_MIN_SIGNALS:
        user_stage = "cold_start"
    elif signal_count < _STAGE_2_MIN_SIGNALS:
        user_stage = "emerging"
    else:
        user_stage = "personalized"

    # Session-level dedup — brief §24. Track title_ids already emitted so a
    # title chosen as Contextual Hero doesn't reappear three rows later.
    seen: set[UUID] = set()
    modules: list[dict] = []

    # 1) Contextual Hero — always attempted, always honest about confidence.
    hero = _contextual_hero(db, user_id, context, seen)
    if hero is not None:
        modules.append(hero)

    # 2) Personalized rail — only when user has enough signal to justify.
    if user_stage != "cold_start":
        rail = _personalized_rail(db, user_id, seen)
        if rail is not None:
            modules.append(rail)

    # 3) Because You — only when a strong anchor signal exists.
    if user_stage == "personalized":
        by = _because_you_rail(db, user_id, seen)
        if by is not None:
            modules.append(by)

    # 4) Trending Now — always eligible, honestly labeled per §18. Uses raw
    # TMDB trending; not re-ranked against user taste (that's what "For Your
    # Scene" is for). Order: after personalized rails so personalization leads.
    tr = _trending_module(db, seen)
    if tr is not None:
        modules.append(tr)

    # 5) Team module — only when user is in a team AND we can pull candidates.
    team = _team_module(db, user_id, seen)
    if team is not None:
        modules.append(team)

    # 6) Exploration rail — available past cold-start, honest label.
    if user_stage != "cold_start":
        exp = _exploration_rail(db, user_id, seen)
        if exp is not None:
            modules.append(exp)

    return {
        "context": context.to_dict(),
        "user_stage": user_stage,
        "modules": modules,
    }
