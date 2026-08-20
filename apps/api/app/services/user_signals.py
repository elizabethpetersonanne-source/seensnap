"""User signal computation — SceneDNA brief §14 through §17.

Every taste signal is a first-class UserSignal row with:
  - score (0-1 normalized)
  - confidence_tier ('strong' | 'established' | 'emerging' | 'exploring' | 'early')
  - sample_size (interactions supporting the signal)
  - trend ('rising' | 'stable' | 'fading')
  - positive_evidence[] / negative_evidence[] (content_title_ids)

Signal strength formula (deterministic, per §16):
    +5  10/10 rated title carrying this signal
    +4  9/10 rated
    +3  saved title carrying this signal
    +2  swipe right
    +1  detail-page engagement (not tracked yet — will use interaction events)
    -3  swipe left
    -5  explicit "less like this" / "not for me"

Then normalize against interaction volume + recency + repeated evidence
so a single 10-rated title doesn't define the user's identity.

Signal vocabularies come from `_signal_genre_set` in taste.py — LABEL_RULES,
THEME_KEYWORDS, plus raw genre names — so what we compute here stays in sync
with what the mood rails query later.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import Rating, Watchlist, WatchlistItem
from app.models.taste import RecommendationFeedback, SwipeRecord, UserSignal


# Signal weight schedule per brief §16. Kept in a single dict so tuning is
# one-line, not scattered across the codebase.
SIGNAL_WEIGHTS: dict[str, float] = {
    "rating_10": 5.0,
    "rating_9": 4.0,
    "rating_8": 3.0,
    "rating_7": 1.5,
    "saved": 3.0,
    "swipe_right": 2.0,
    "swipe_up": 3.0,  # "more like this" — stronger than plain right
    "detail_opened": 1.0,
    "swipe_left": -3.0,
    "rating_low": -3.0,  # <=4
    "removed_from_picks": -2.0,
    "signal_less_like": -5.0,
    "signal_not_me": -5.0,
}

# Recency multipliers per Discover brief §6. Applied on top of raw weights so
# recent behavior lands harder without erasing older preferences.
_RECENCY_TABLE = [
    (7, 1.00),
    (30, 0.90),
    (90, 0.75),
    (365, 0.55),
]
_RECENCY_FLOOR = 0.40


def _recency_multiplier(interaction_at: datetime | None) -> float:
    if interaction_at is None:
        return _RECENCY_FLOOR
    now = datetime.now(timezone.utc)
    if interaction_at.tzinfo is None:
        interaction_at = interaction_at.replace(tzinfo=timezone.utc)
    days = (now - interaction_at).days
    for cutoff, mult in _RECENCY_TABLE:
        if days <= cutoff:
            return mult
    return _RECENCY_FLOOR


def _confidence_tier(score: float, sample_size: int) -> str:
    """§17 — score and confidence are DIFFERENT dimensions. High score with
    tiny sample = "emerging", not "strong." Established requires broad
    evidence AND meaningful strength."""
    if sample_size >= 20 and score >= 0.65:
        return "established"
    if sample_size >= 10 and score >= 0.55:
        return "strong"
    if sample_size >= 5 and score >= 0.35:
        return "emerging"
    if sample_size >= 2:
        return "exploring"
    return "early"


def _score_trend(current_score: float, previous_score: float | None) -> str:
    if previous_score is None:
        return "stable"
    delta = current_score - previous_score
    if delta > 0.08:
        return "rising"
    if delta < -0.08:
        return "fading"
    return "stable"


def _signal_names_for_title(title: ContentTitle) -> dict[str, set[str]]:
    """Given a title, return the signals it carries, grouped by type. Uses
    _signal_genre_set from taste.py implicitly via the genre-→-label mapping
    already established there. To avoid a circular import we duplicate the
    minimal genre extraction here and reference LABEL_RULES + THEME_KEYWORDS
    directly."""
    # Local import to break the cycle with taste.py (which imports us later).
    from app.services.taste import (
        LABEL_RULES,
        THEME_KEYWORDS,
        _title_creator_names,
        _title_genres_set,
    )

    title_genres = _title_genres_set(title)
    out: dict[str, set[str]] = defaultdict(set)

    # Raw genre signals — every genre the title carries is a candidate.
    for g in title_genres:
        out["genre"].add(g)

    # Label signals — LABEL_RULES defines the label→genres map.
    for label, rule in LABEL_RULES.items():
        rule_genres = rule.get("genres") if isinstance(rule, dict) else None
        if not isinstance(rule_genres, dict):
            continue
        # Fire the label if there's ANY overlap with the title's genres —
        # this mirrors how _signal_genre_set works in the reverse direction.
        if set(rule_genres.keys()) & title_genres:
            out["label"].add(label)

    # Theme signals — THEME_KEYWORDS keys are themes, values are genre substrings.
    lowered_title = {g.lower() for g in title_genres}
    for theme, tokens in THEME_KEYWORDS.items():
        if any(any(tok in g for tok in tokens) for g in lowered_title):
            out["theme"].add(theme)

    # Creator signals — director/creator names captured from title metadata.
    for creator in _title_creator_names(title):
        out["creator"].add(creator)

    return out


def _collect_interactions(
    db: Session, user_id: UUID
) -> list[tuple[ContentTitle, float, datetime]]:
    """Every interaction the user has with a title becomes a (title, weight,
    timestamp) triple. Weights come from SIGNAL_WEIGHTS; sign encodes
    positive vs negative signal contribution."""
    interactions: list[tuple[ContentTitle, float, datetime]] = []

    # Ratings — weight by score bucket per §5 hierarchy.
    ratings = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == user_id)
    ).all()
    for rating, title in ratings:
        if title is None:
            continue
        score = float(rating.score) if rating.score is not None else 0.0
        weight = 0.0
        if score >= 10:
            weight = SIGNAL_WEIGHTS["rating_10"]
        elif score >= 9:
            weight = SIGNAL_WEIGHTS["rating_9"]
        elif score >= 8:
            weight = SIGNAL_WEIGHTS["rating_8"]
        elif score >= 7:
            weight = SIGNAL_WEIGHTS["rating_7"]
        elif score <= 4:
            weight = SIGNAL_WEIGHTS["rating_low"]
        if weight != 0:
            interactions.append((title, weight, rating.created_at))

    # Watchlist saves — flat weight; created_at for recency.
    saves = db.execute(
        select(WatchlistItem, ContentTitle)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(Watchlist.owner_user_id == user_id)
    ).all()
    for item, title in saves:
        if title is None:
            continue
        interactions.append((title, SIGNAL_WEIGHTS["saved"], item.created_at))

    # Swipes — direction picks the weight.
    swipes = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == user_id)
        .order_by(SwipeRecord.created_at.desc())
        .limit(500)
    ).all()
    for swipe, title in swipes:
        if title is None:
            continue
        if swipe.direction == "right":
            interactions.append((title, SIGNAL_WEIGHTS["swipe_right"], swipe.created_at))
        elif swipe.direction == "up":
            interactions.append((title, SIGNAL_WEIGHTS["swipe_up"], swipe.created_at))
        elif swipe.direction == "left":
            interactions.append((title, SIGNAL_WEIGHTS["swipe_left"], swipe.created_at))

    # Recommendation feedback — signal-level actions (less_like / not_me).
    feedback = db.execute(
        select(RecommendationFeedback, ContentTitle)
        .join(ContentTitle, ContentTitle.id == RecommendationFeedback.content_title_id)
        .where(RecommendationFeedback.user_id == user_id)
        .limit(500)
    ).all()
    for fb, title in feedback:
        if title is None:
            continue
        w = SIGNAL_WEIGHTS.get(fb.action)
        if w:
            interactions.append((title, w, fb.created_at))

    return interactions


def compute_user_signals(db: Session, user_id: UUID) -> list[UserSignal]:
    """Rebuild UserSignal rows for a user from their real interaction history.
    Idempotent — clears the user's existing signals and reinserts fresh.

    Returns the persisted UserSignal rows for downstream use (e.g.
    /scene-dna/signals). Trend detection reads the previous score before
    delete so we can compare (rising/stable/fading)."""
    # Snapshot previous scores for trend calculation.
    previous = {
        (row.signal_type, row.signal_name): float(row.score)
        for row in db.scalars(select(UserSignal).where(UserSignal.user_id == user_id)).all()
    }
    db.execute(delete(UserSignal).where(UserSignal.user_id == user_id))

    interactions = _collect_interactions(db, user_id)
    if not interactions:
        db.commit()
        return []

    # Per-signal accumulator. `positive_sum` and `negative_sum` are tracked
    # separately so the score can represent "how much do you like this trait"
    # while `negative_sum` (via evidence + a confidence damping factor)
    # captures "how much do you actively reject it." Prior implementation
    # summed signed weights, which meant heavy left-swipers had every signal
    # collapse to 0 even when they had clear positive patterns underneath.
    accumulators: dict[tuple[str, str], dict] = defaultdict(
        lambda: {
            "positive_sum": 0.0,
            "negative_sum": 0.0,
            "positive_evidence": [],
            "negative_evidence": [],
            "positive_sample": 0,
            "negative_sample": 0,
        }
    )

    # Track which title contributed to each signal on each side so we don't
    # double-count when the user has rated AND saved the same title.
    seen_positive: set[tuple[str, str, UUID]] = set()
    seen_negative: set[tuple[str, str, UUID]] = set()

    for title, weight, ts in interactions:
        rec = _recency_multiplier(ts)
        effective = weight * rec
        signals_by_type = _signal_names_for_title(title)
        for signal_type, names in signals_by_type.items():
            for name in names:
                bucket = accumulators[(signal_type, name)]
                title_id_str = str(title.id)
                if weight > 0:
                    key = (signal_type, name, title.id)
                    if key in seen_positive:
                        continue
                    seen_positive.add(key)
                    bucket["positive_sum"] += effective
                    bucket["positive_sample"] += 1
                    if title_id_str not in bucket["positive_evidence"]:
                        bucket["positive_evidence"].append(title_id_str)
                elif weight < 0:
                    key = (signal_type, name, title.id)
                    if key in seen_negative:
                        continue
                    seen_negative.add(key)
                    # Store negative magnitude (positive number).
                    bucket["negative_sum"] += abs(effective)
                    bucket["negative_sample"] += 1
                    if title_id_str not in bucket["negative_evidence"]:
                        bucket["negative_evidence"].append(title_id_str)

    # Score = positive_sum normalized against the max positive_sum across all
    # signals. Negative activity does NOT reduce the score itself — it lands
    # in negative_evidence + damps the confidence tier per §17.
    max_positive = max(
        (b["positive_sum"] for b in accumulators.values()),
        default=0.0,
    )
    denom = max_positive if max_positive > 1 else 1.0

    rows: list[UserSignal] = []
    for (signal_type, name), bucket in accumulators.items():
        positive_sum = bucket["positive_sum"]
        negative_sum = bucket["negative_sum"]
        positive_sample = bucket["positive_sample"]
        negative_sample = bucket["negative_sample"]
        # Skip signals with no evidence on either side.
        if positive_sample == 0 and negative_sample == 0:
            continue
        # Normalize positive score.
        normalized = min(max(positive_sum / denom, 0.0), 1.0)
        # Confidence damping — if the user has meaningfully rejected this
        # trait, downgrade the confidence tier even when positive score is
        # high. The score itself stays honest; the tier reflects mixed signal.
        effective_positive_sample = positive_sample
        if negative_sample > positive_sample and positive_sample > 0:
            # More negative than positive interactions — signal is contested.
            effective_positive_sample = max(positive_sample // 2, 1)
        tier = _confidence_tier(normalized, effective_positive_sample)
        trend = _score_trend(normalized, previous.get((signal_type, name)))
        row = UserSignal(
            user_id=user_id,
            signal_type=signal_type,
            signal_name=name,
            score=Decimal(f"{normalized:.3f}"),
            confidence_tier=tier,
            sample_size=positive_sample + negative_sample,
            trend=trend,
            positive_evidence=bucket["positive_evidence"][:20],
            negative_evidence=bucket["negative_evidence"][:20],
            last_updated=datetime.now(timezone.utc),
        )
        db.add(row)
        rows.append(row)

    db.commit()
    return rows


def list_user_signals(
    db: Session,
    user_id: UUID,
    *,
    signal_type: str | None = None,
    limit: int = 10,
) -> list[UserSignal]:
    """Read signals for a user ordered by score desc. Filter by type when a
    caller wants only labels / only themes / only genres."""
    q = select(UserSignal).where(UserSignal.user_id == user_id)
    if signal_type is not None:
        q = q.where(UserSignal.signal_type == signal_type)
    q = q.order_by(UserSignal.score.desc()).limit(limit)
    return list(db.scalars(q).all())


def _is_stale(profile_updated_at: datetime | None, *, hours: int = 12) -> bool:
    if profile_updated_at is None:
        return True
    if profile_updated_at.tzinfo is None:
        profile_updated_at = profile_updated_at.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - profile_updated_at).total_seconds() > hours * 3600


def ensure_signals(db: Session, user_id: UUID, *, force: bool = False) -> list[UserSignal]:
    """Return the user's signals, recomputing when stale or forced. Cheap
    read when signals are fresh — no unnecessary reflow on every request."""
    if not force:
        latest = db.scalar(
            select(UserSignal.last_updated)
            .where(UserSignal.user_id == user_id)
            .order_by(UserSignal.last_updated.desc())
            .limit(1)
        )
        if latest is not None and not _is_stale(latest, hours=6):
            return list_user_signals(db, user_id, limit=50)
    return compute_user_signals(db, user_id)
