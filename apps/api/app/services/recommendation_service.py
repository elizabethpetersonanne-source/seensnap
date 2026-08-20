"""Unified RecommendationService — SceneDNA brief §29.

One code path every SeenSnap surface (Swipe / SceneDNA / Discover / Teams)
calls. Prevents the situation where each screen invents its own recommendation
logic and drifts from the personalization engine.

Pipeline per brief §2:

    User Behavior → Taste Profile → Candidate Generation → Personal
    Re-Ranking → Diversity/Novelty → Availability → Reason → UI

Mode-scoped queries per §12 and §29:

    mode = "perfect"          → all sources, no attribute filter
    mode = "dark-cinematic"   → TitleFeatures.tone∋dark, visual_style∋cinematic
    mode = "comfort"          → comfort_level≥0.65, viewing_context comfort
    mode = "hidden-gems"      → low-popularity + high-rating, personal overlap
    mode = "stretch"          → 70% familiar + 30% adjacent-genre
    mode = "movie-night"      → runtime≥120 + feature films + cinematic
    mode = "late-night"       → shorter runtime + episodic + late-night context
    mode = "afternoon"        → runtime≤100 + comedy/documentary/light

Every result carries reason evidence AND logs a RecommendationImpression so
we can measure which strategies actually cause saves (brief §35).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import Watchlist, WatchlistItem
from app.models.taste import (
    RecommendationImpression,
    SwipeRecord,
    TitleFeatures,
    UserSignal,
)
from app.services.title_features import (
    ensure_title_features,
    match_titles_by_features,
)
from app.services.user_signals import ensure_signals


# ─── Mode configs (brief §12) ────────────────────────────────────────────────


@dataclass(frozen=True)
class ModeConfig:
    """Declarative description of a Scene Picks mode. The service reads this
    to build the candidate pool + reason label. Weights are illustrative and
    tunable per §8 — keeping them in one place makes config changes trivial."""

    key: str                                  # url-safe id
    display_label: str                        # "Dark & Cinematic"
    tone_any: set[str] | None = None
    visual_style_any: set[str] | None = None
    story_style_any: set[str] | None = None
    viewing_context_any: set[str] | None = None
    pacing: str | None = None
    comfort_min: float | None = None
    comfort_max: float | None = None
    runtime_min: int | None = None
    runtime_max: int | None = None
    reason_template: str = "Matches your {label} pattern."
    # Optional attribute weighting for personal re-ranking; when None the
    # service uses uniform UserSignal weighting.
    signal_boost: dict[str, float] | None = None


MODES: dict[str, ModeConfig] = {
    "perfect": ModeConfig(
        key="perfect",
        display_label="Perfect For You",
        reason_template="Matches your strongest signals.",
    ),
    "dark-cinematic": ModeConfig(
        key="dark-cinematic",
        display_label="Dark & Cinematic",
        tone_any={"dark", "unsettling", "tense"},
        visual_style_any={"cinematic", "atmospheric"},
        reason_template="Dark and cinematic — right in your lane.",
    ),
    "comfort": ModeConfig(
        key="comfort",
        display_label="Something Comforting",
        comfort_min=0.65,
        viewing_context_any={"background-comfort", "easy-watch"},
        reason_template="Comfort that lines up with what you actually rewatch.",
    ),
    "hidden-gems": ModeConfig(
        key="hidden-gems",
        display_label="Hidden Gem For You",
        reason_template="A low-exposure pick with a strong personal fit.",
    ),
    "stretch": ModeConfig(
        key="stretch",
        display_label="Stretch My Taste",
        reason_template="A step outside your usual — but the pull is there.",
    ),
    "movie-night": ModeConfig(
        key="movie-night",
        display_label="Movie Night",
        viewing_context_any={"movie-night"},
        runtime_min=105,
        signal_boost={"visual_style": 1.5},
        reason_template="Tonight's Pick.",
    ),
    "late-night": ModeConfig(
        key="late-night",
        display_label="Late Night",
        viewing_context_any={"late-night"},
        runtime_max=95,
        reason_template="Easy-in for late night — matches your pattern.",
    ),
    "afternoon": ModeConfig(
        key="afternoon",
        display_label="Afternoon Pick",
        runtime_max=100,
        viewing_context_any={"easy-watch", "background-comfort"},
        reason_template="Quick and easy for the afternoon.",
    ),
}


# ─── Personal re-ranking ─────────────────────────────────────────────────────


def _build_signal_index(db: Session, user_id: UUID) -> dict[tuple[str, str], float]:
    """Fast lookup from (signal_type, signal_name) → normalized user score.
    Ensures signals exist (recomputes when stale)."""
    ensure_signals(db, user_id)
    rows = db.scalars(select(UserSignal).where(UserSignal.user_id == user_id)).all()
    return {(r.signal_type, r.signal_name): float(r.score) for r in rows}


def _negative_evidence_set(db: Session, user_id: UUID) -> set[UUID]:
    """Titles the user has actively rejected via UserSignal.negative_evidence.
    Aggregated across all signals — used as a soft-exclude in ranking."""
    rows = db.scalars(select(UserSignal).where(UserSignal.user_id == user_id)).all()
    out: set[UUID] = set()
    for r in rows:
        for tid_str in (r.negative_evidence or [])[:20]:
            try:
                out.add(UUID(str(tid_str)))
            except (ValueError, TypeError):
                continue
    return out


def _title_signal_names(title: ContentTitle) -> dict[str, set[str]]:
    """Same contract as `_signal_names_for_title` in user_signals — kept as a
    thin re-export so recommendation_service doesn't need to know about the
    LABEL_RULES / THEME_KEYWORDS layout."""
    from app.services.user_signals import _signal_names_for_title

    return _signal_names_for_title(title)


def _personal_score(
    title: ContentTitle,
    features: TitleFeatures | None,
    signal_index: dict[tuple[str, str], float],
    mode: ModeConfig,
) -> tuple[float, list[dict[str, Any]]]:
    """Compute a title's personal match score for this user + mode. Returns
    (score, reasons_list) where reasons_list carries structured evidence
    that the reason layer can turn into user-facing copy WITHOUT invention
    (brief §14)."""
    reasons: list[dict[str, Any]] = []
    total = 0.0

    # 1) UserSignal alignment — sum the user's scores for signals this title
    # actually carries. This is the personalization core.
    sig_names = _title_signal_names(title)
    for stype, names in sig_names.items():
        for name in names:
            user_score = signal_index.get((stype, name), 0.0)
            if user_score <= 0:
                continue
            boost = 1.0
            if mode.signal_boost and stype in mode.signal_boost:
                boost = mode.signal_boost[stype]
            contribution = user_score * boost
            total += contribution
            # Only surface the highest-value reasons; keep list capped later.
            reasons.append(
                {
                    "type": "signal_match",
                    "signal_type": stype,
                    "signal_name": name,
                    "score": round(contribution, 3),
                }
            )

    # 2) Attribute-fit bonus for mode-scoped queries — the title already
    # passed the filter, but boost when it matches STRONGLY (multiple
    # matching tags, not just one).
    if features is not None:
        if mode.tone_any:
            tone_hits = len(set(features.tone or []) & mode.tone_any)
            if tone_hits > 0:
                bonus = 0.15 * tone_hits
                total += bonus
                reasons.append({"type": "tone_match", "hits": tone_hits, "score": bonus})
        if mode.visual_style_any:
            vis_hits = len(set(features.visual_style or []) & mode.visual_style_any)
            if vis_hits > 0:
                bonus = 0.10 * vis_hits
                total += bonus
                reasons.append({"type": "visual_match", "hits": vis_hits, "score": bonus})

    # 3) Quality safety signal — modest boost for well-rated titles so the
    # scoring never surfaces truly bad matches even when signals align.
    if title.tmdb_vote_average is not None:
        vote = float(title.tmdb_vote_average)
        if vote >= 7.5:
            total += 0.10
        elif vote >= 6.8:
            total += 0.05

    # Keep the top few reasons — sorted by contribution.
    reasons.sort(key=lambda r: r.get("score", 0), reverse=True)
    return total, reasons[:5]


def _confidence_from_score(score: float) -> str:
    """Confidence tier maps to the copy strength (brief §13). Honest labeling
    prevents claiming certainty we don't have."""
    if score >= 1.5:
        return "excellent"
    if score >= 0.8:
        return "strong"
    if score >= 0.4:
        return "worth-a-look"
    return "cold-start"


# ─── Diversity + dedup ───────────────────────────────────────────────────────


def _diversify(
    ranked: list[dict], limit: int, max_consecutive_genre: int = 2
) -> list[dict]:
    """Prevent 3 consecutive titles with the same primary genre. Also caps
    same-title (rare after dedup) and same-reason-type consecutively."""
    out: list[dict] = []
    for item in ranked:
        title = item["title"]
        if len(out) >= max_consecutive_genre:
            last_genres = [
                set((t["title"].genres or [])[:1])
                for t in out[-max_consecutive_genre:]
            ]
            item_genres = set((title.genres or [])[:1])
            if item_genres and all(item_genres & g for g in last_genres if g):
                continue
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _exclude_ids(db: Session, user_id: UUID) -> set[UUID]:
    """Never recommend titles the user has already saved OR recently
    left-swiped (last 60). Cap recycling window at 60 to match the earlier
    Swipe brief fix (task #30/#52)."""
    saves = set(
        db.scalars(
            select(WatchlistItem.content_title_id)
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .where(Watchlist.owner_user_id == user_id)
        ).all()
    )
    recent_dismisses = db.execute(
        select(SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == user_id, SwipeRecord.direction == "left")
        .order_by(SwipeRecord.created_at.desc())
        .limit(60)
    ).all()
    return saves | {r[0] for r in recent_dismisses if r[0] is not None}


# ─── Public API ──────────────────────────────────────────────────────────────


def _signal_feature_filter(signal_name: str) -> dict:
    """Map a signal name to a TitleFeatures attribute filter so that
    different signals produce meaningfully different candidate pools even
    when their underlying genre sets overlap. Themes like "Slow Burn" +
    "Character Driven" + "Emotionally Intense" all map to Drama-heavy
    genres — the feature filter is what makes them distinct.

    Returns a kwargs dict for `match_titles_by_features`. Empty dict when we
    don't have a mapping (caller falls back to genre-only + rotation)."""
    lname = signal_name.lower()
    # Pacing / rhythm patterns
    if "slow burn" in lname:
        return {"pacing": "slow", "tone_any": {"tense", "melancholic", "unsettling"}}
    if "high stakes" in lname or "thriller" in lname or "chase" in lname or "propulsive" in lname:
        return {"tone_any": {"tense", "hyped"}, "pacing": "propulsive"}

    # Character / story-style patterns
    if "character study" in lname or "character-driven" in lname or "character driven" in lname:
        return {"story_style_any": {"character-driven"}, "tone_any": {"melancholic"}}
    if "relationship" in lname or "romance" in lname:
        return {"story_style_any": {"relationship-focused"}, "tone_any": {"sentimental"}}
    if "ensemble" in lname:
        return {"story_style_any": {"ensemble"}}
    if "coming of age" in lname or "coming-of-age" in lname:
        return {"story_style_any": {"coming-of-age"}, "tone_any": {"sentimental", "hopeful"}}

    # Tone / emotion patterns
    if "emotionally intense" in lname or "emotional realist" in lname or "emotionally" in lname:
        return {"tone_any": {"melancholic", "unsettling", "sentimental"}}
    if "dark humor" in lname or "dry humor" in lname or "irreverent" in lname or "chaos comedy" in lname:
        return {"tone_any": {"irreverent", "cynical"}}
    if "warm" in lname or "hopeful" in lname:
        return {"tone_any": {"warm", "hopeful"}}

    # Aesthetic / visual patterns
    if "prestige drama" in lname or "awards season" in lname:
        return {"visual_style_any": {"cinematic", "atmospheric"}, "story_style_any": {"character-driven"}}
    if "a24" in lname or "indie darling" in lname or "festival circuit" in lname:
        return {"visual_style_any": {"minimalist", "intimate", "atmospheric"}, "story_style_any": {"character-driven"}}
    if "visually bold" in lname or "cinematic maximalist" in lname or "cinematic" in lname:
        return {"visual_style_any": {"highly-stylized", "cinematic"}}

    # Horror family
    if "elevated horror" in lname or "atmospheric horror" in lname:
        return {"tone_any": {"unsettling", "dark"}, "visual_style_any": {"atmospheric"}}
    if "camp horror" in lname:
        return {"tone_any": {"irreverent"}, "visual_style_any": {"highly-stylized"}}
    if "survival horror" in lname or "slasher" in lname:
        return {"tone_any": {"tense", "unsettling"}, "pacing": "propulsive"}
    if "dark" in lname or "cynical" in lname:
        return {"tone_any": {"dark", "unsettling", "tense"}, "visual_style_any": {"atmospheric"}}

    # Comfort / rewatch
    if "comfort" in lname or "cozy" in lname or "sitcom" in lname:
        return {"comfort_min": 0.6, "viewing_context_any": {"background-comfort", "easy-watch"}}

    # Sci-fi patterns
    if "cerebral sci" in lname or "dystopian" in lname or "time loop" in lname:
        return {"tone_any": {"unsettling"}, "visual_style_any": {"highly-stylized"}}
    if "space opera" in lname:
        return {"tone_any": {"hyped"}, "visual_style_any": {"cinematic", "highly-stylized"}}

    # Crime family
    if "dark crime" in lname or "neo-noir" in lname or "serial killer" in lname or "psychological thriller" in lname:
        return {"tone_any": {"dark", "tense"}, "visual_style_any": {"atmospheric", "cinematic"}}

    return {}


def recommend_for_signal(
    db: Session,
    user_id: UUID,
    *,
    signal_name: str,
    limit: int = 8,
    session_id: str | None = None,
    surface: str | None = None,
) -> list[dict]:
    """Rec rail scoped to a SPECIFIC UserSignal — powers the "Explore this
    signal" section in the SceneDNA signal detail drawer. Different signals
    return different titles because the candidate pool is built from the
    signal's semantic feature filter (see `_signal_feature_filter`) with a
    genre fallback. Ranks by personal fit + signal alignment."""
    from app.services.taste import _signal_genre_set, _title_genres_set

    signal_genres = _signal_genre_set(signal_name)
    feature_filter = _signal_feature_filter(signal_name)

    exclude = _exclude_ids(db, user_id) | _negative_evidence_set(db, user_id)
    signal_index = _build_signal_index(db, user_id)
    config = MODES["perfect"]

    # Prefer feature-based candidate pool (differentiates similar-genre
    # signals like Slow Burn vs. Character Driven). Fall back to genre
    # filter when no feature mapping exists.
    candidates: list[ContentTitle] = []
    if feature_filter:
        feature_rows = match_titles_by_features(
            db,
            exclude=exclude,
            limit=400,
            **feature_filter,
        )
        candidate_ids = [f.content_title_id for f in feature_rows]
        if candidate_ids:
            candidates = db.scalars(
                select(ContentTitle).where(ContentTitle.id.in_(candidate_ids))
            ).all()

    if not candidates:
        # Genre-only fallback.
        if not signal_genres:
            return recommend_for_user(
                db, user_id, mode="perfect", limit=limit, session_id=session_id,
                surface=surface or f"signal_explore:{signal_name}",
            )
        pool = db.scalars(
            select(ContentTitle)
            .where(ContentTitle.tmdb_vote_average.is_not(None), ContentTitle.tmdb_vote_average >= 6.5)
            .order_by(ContentTitle.tmdb_vote_average.desc())
            .limit(500)
        ).all()
        candidates = [t for t in pool if signal_genres & _title_genres_set(t) and t.id not in exclude]

    scored: list[dict] = []
    for title in candidates:
        if title.id in exclude:
            continue
        genre_overlap = signal_genres & _title_genres_set(title) if signal_genres else set()
        features = ensure_title_features(db, title.id)
        score, reasons = _personal_score(title, features, signal_index, config)
        if genre_overlap:
            score += 0.2 * len(genre_overlap)
        # Feature-filter alignment bonus so titles fitting MORE of the
        # signal's semantic attributes rank higher.
        if features is not None and feature_filter:
            attr_hits = 0
            for key in ("tone_any", "visual_style_any", "story_style_any", "viewing_context_any"):
                if key in feature_filter:
                    col = key.replace("_any", "")
                    val = getattr(features, col, None) or []
                    attr_hits += len(set(val) & feature_filter[key])
            score += 0.15 * attr_hits
        reasons.insert(0, {
            "type": "signal_scoped",
            "signal_name": signal_name,
            "genres_matched": sorted(list(genre_overlap))[:3] if genre_overlap else [],
            "score": round(0.2 * len(genre_overlap) if genre_overlap else 0.0, 3),
        })
        scored.append({"title": title, "score": score, "reasons": reasons[:5]})

    scored.sort(key=lambda x: x["score"], reverse=True)
    # Per-signal rotation so overlapping filter maps (e.g. Character Driven
    # vs. Emotionally Intense both land on the same top-scored pool) don't
    # produce identical rails. Hash the signal_name into a small offset and
    # rotate the top-K candidates before diversifying. Keeps the ordering
    # deterministic per signal so the user sees stable results per signal
    # while different signals produce visibly different rails.
    if len(scored) > limit * 2:
        rot_pool = scored[: limit * 3]
        offset = abs(hash(signal_name)) % max(len(rot_pool), 1)
        scored = rot_pool[offset:] + rot_pool[:offset] + scored[limit * 3:]

    diversified = _diversify(scored, limit=limit)

    results: list[dict] = []
    surface_key = surface or f"signal_explore:{signal_name}"
    for position, item in enumerate(diversified):
        title = item["title"]
        confidence = _confidence_from_score(item["score"])
        impression = RecommendationImpression(
            id=uuid4(),
            user_id=user_id,
            content_title_id=title.id,
            surface=surface_key,
            mode=f"signal:{signal_name}",
            position=position,
            score=Decimal(f"{min(item['score'], 9.999):.3f}"),
            candidate_source="signal_scoped",
            reason_type="signal_scoped",
            algorithm_version="reco_service_v1",
            session_id=session_id,
            payload={"reasons": item["reasons"], "signal_name": signal_name},
        )
        db.add(impression)
        results.append({
            "title": title,
            "score": item["score"],
            "confidence": confidence,
            "reasons": item["reasons"],
            "mode": f"signal:{signal_name}",
            "mode_label": signal_name,
            "reason_template": f"Because you keep saving {signal_name.lower()}.",
            "impression_id": str(impression.id),
        })
    db.commit()
    return results


def recommend_for_user(
    db: Session,
    user_id: UUID,
    *,
    mode: str = "perfect",
    limit: int = 20,
    session_id: str | None = None,
    surface: str = "recommendations",
) -> list[dict]:
    """Return ranked recommendations for a user + mode. Every result is a
    dict with `title`, `score`, `confidence`, `reasons`, `mode`, and
    `impression_id` (the persisted RecommendationImpression row id so the
    client can later post feedback tied to the exact rec)."""
    if mode not in MODES:
        mode = "perfect"
    config = MODES[mode]

    exclude = _exclude_ids(db, user_id)
    negative_titles = _negative_evidence_set(db, user_id)
    exclude |= negative_titles

    signal_index = _build_signal_index(db, user_id)

    # ── Candidate pool ──────────────────────────────────────────────────────
    # Mode-scoped attribute filter narrows the universe. When mode="perfect"
    # we skip the filter and rank everything the user hasn't seen.
    if any([config.tone_any, config.visual_style_any, config.story_style_any,
            config.viewing_context_any, config.pacing, config.comfort_min,
            config.comfort_max]):
        features = match_titles_by_features(
            db,
            tone_any=config.tone_any,
            visual_style_any=config.visual_style_any,
            story_style_any=config.story_style_any,
            viewing_context_any=config.viewing_context_any,
            pacing=config.pacing,
            comfort_min=config.comfort_min,
            comfort_max=config.comfort_max,
            exclude=exclude,
            limit=400,
        )
        candidate_ids = [f.content_title_id for f in features]
        feature_by_id = {f.content_title_id: f for f in features}
    else:
        # Perfect mode: pull the user's UserSignal top-scored candidates by
        # fetching titles matching their positive_evidence + newly-encountered
        # popular titles. Cap at 400 for cost.
        popular = db.scalars(
            select(ContentTitle)
            .where(ContentTitle.tmdb_vote_average.is_not(None), ContentTitle.tmdb_vote_average >= 6.5)
            .order_by(ContentTitle.tmdb_vote_average.desc())
            .limit(400)
        ).all()
        candidate_ids = [t.id for t in popular if t.id not in exclude]
        feature_by_id = {}

    if not candidate_ids:
        return []

    # Hidden Gems mode: apply low-popularity filter on top of the candidate
    # pool. Uses TMDB popularity from metadata_raw as the threshold signal.
    titles = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(candidate_ids))).all()
    if mode == "hidden-gems":
        filtered_titles = []
        for t in titles:
            if t.tmdb_vote_average is None or float(t.tmdb_vote_average) < 6.8:
                continue
            meta = t.metadata_raw if isinstance(t.metadata_raw, dict) else {}
            pop = meta.get("popularity")
            if isinstance(pop, (int, float)) and pop >= 60:
                continue  # too mainstream
            filtered_titles.append(t)
        titles = filtered_titles

    # ── Personal re-ranking ─────────────────────────────────────────────────
    scored: list[dict] = []
    for title in titles:
        features = feature_by_id.get(title.id) or ensure_title_features(db, title.id)
        score, reasons = _personal_score(title, features, signal_index, config)
        if score <= 0:
            continue
        scored.append({
            "title": title,
            "score": score,
            "reasons": reasons,
        })
    scored.sort(key=lambda x: x["score"], reverse=True)

    # ── Diversity + limit ───────────────────────────────────────────────────
    diversified = _diversify(scored, limit=limit)

    # ── Log impressions ────────────────────────────────────────────────────
    results: list[dict] = []
    algorithm_version = "reco_service_v1"
    for position, item in enumerate(diversified):
        title = item["title"]
        confidence = _confidence_from_score(item["score"])
        primary_reason = item["reasons"][0] if item["reasons"] else None
        reason_type = primary_reason["type"] if primary_reason else "signal_match"
        impression = RecommendationImpression(
            id=uuid4(),
            user_id=user_id,
            content_title_id=title.id,
            surface=surface,
            mode=config.key,
            position=position,
            score=Decimal(f"{min(item['score'], 9.999):.3f}"),
            candidate_source="unified_service",
            reason_type=reason_type,
            algorithm_version=algorithm_version,
            session_id=session_id,
            payload={"reasons": item["reasons"], "mode_label": config.display_label},
        )
        db.add(impression)
        results.append({
            "title": title,
            "score": item["score"],
            "confidence": confidence,
            "reasons": item["reasons"],
            "mode": config.key,
            "mode_label": config.display_label,
            "reason_template": config.reason_template,
            "impression_id": str(impression.id),
        })
    db.commit()
    return results
