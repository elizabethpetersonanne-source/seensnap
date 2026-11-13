"""One owner-scoped title scorer. No popularity, source quotas or query boosts.

Each canonical title contributes once. Categorical attributes split its weight;
semantic exemplars use weighted Jaccard on actual TMDB keywords and separately
enriched features, never the old genre-derived semantic labels. Affinity is regularized once; metadata coverage is reported separately.
This is a preference match, not a calibrated probability of enjoyment.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from math import sqrt
from uuid import UUID

from sqlalchemy import select

from app.core.scenedna_config import (
    WEIGHTS,
    SCORE_VERSION,
    RATING_UTILITY,
    AFFINITY_PRIOR,
    CONFIDENCE_FULL_TITLES,
    DISPLAY_MIN_RATINGS,
    DISPLAY_MIN_COVERAGE,
)
from app.models.content import ContentTitle, ContentAvailability
from app.models.discovery import DiscoveryDecision
from app.models.social import Rating, RankedFavorite, TitleWatchStatus, Watchlist, WatchlistItem
from app.models.taste import SwipeRecord, TitleFeatures
from app.models.user import UserProfile
from app.models.watch_handoff import WatchHandoff
from app.schemas.scenedna import TitleCompatibility, SceneDnaDimension


def _utc(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def _normalized(values):
    values = sorted(set(values))
    return {value: 1.0 / len(values) for value in values} if values else {}


def _rows(value):
    return value if isinstance(value, list) else []


def _ids(rows):
    return [
        str(r["id"])
        for r in _rows(rows)
        if isinstance(r, dict) and type(r.get("id")) is int and r["id"] > 0
    ]


def title_features(title, enriched=None, providers=()):
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    credits = meta.get("credits") if isinstance(meta.get("credits"), dict) else {}
    cast = [r for r in _rows(credits.get("cast")) if isinstance(r, dict)]
    cast.sort(key=lambda r: r.get("order") if type(r.get("order")) is int else 9999)
    crew = [r for r in _rows(credits.get("crew")) if isinstance(r, dict)]
    keywords = meta.get("keywords", {})
    if isinstance(keywords, dict):
        keywords = keywords.get("keywords", keywords.get("results", []))
    if not isinstance(keywords, list):
        keywords = []
    semantic = {
        "keyword:" + str(k["id"])
        for k in keywords
        if isinstance(k, dict) and type(k.get("id")) is int and k["id"] > 0
    }
    # tmdb_v0 tone/pacing/story labels are broad genre/runtime heuristics.
    # They cannot earn another 28% of apparent evidence for the same genre.
    if enriched and enriched.enrichment_version > 0 and enriched.source != "tmdb_v0":
        for field in ("tone", "story_style", "themes", "visual_style"):
            semantic.update(
                field + ":" + str(x).casefold() for x in getattr(enriched, field, []) or []
            )
        if enriched.pacing:
            semantic.add("pacing:" + enriched.pacing)
    language = meta.get("original_language")
    return {
        "exemplars": _normalized(semantic),
        "genres": _normalized(
            str(g).strip().casefold() for g in title.genres or [] if str(g).strip()
        ),
        "actors": _normalized(_ids(cast[:8])),
        "decade": {str(title.release_date.year // 10 * 10): 1.0} if title.release_date else {},
        "format": {title.content_type: 1.0} if title.content_type in ("movie", "series") else {},
        "language": {language.lower(): 1.0}
        if isinstance(language, str) and len(language) in (2, 3) and language not in ("xx", "und")
        else {},
        "directors": _normalized(_ids([r for r in crew if r.get("job") == "Director"])),
        "writers": _normalized(
            _ids([r for r in crew if r.get("job") in ("Writer", "Screenplay", "Story", "Teleplay")])
        ),
        "studios": _normalized(_ids(meta.get("production_companies", []) or [])),
        "services": _normalized(providers),
    }


@dataclass(frozen=True)
class Evidence:
    title_id: UUID
    utility: float
    kind: str
    boost: float = 1.0


def effective_evidence(ratings, ranks, saved, swipes, watched):
    """Current numeric ratings supersede every weaker action, including neutral 5/6."""
    evidence = {}
    numeric_count = 0
    for title_id in set(ratings) | set(ranks) | set(saved) | set(swipes):
        score = ratings.get(title_id)
        if score is not None and 1 <= score <= 10:
            numeric_count += 1
            utility, kind = RATING_UTILITY[int(round(score))], "rating"
        elif "down" in swipes.get(title_id, set()):
            utility, kind = -1.0, "dislike"
        elif title_id in ranks:
            utility, kind = 0.3, "rank"
        elif title_id in saved:
            utility, kind = 0.3, "save"
        elif title_id not in watched and "right" in swipes.get(title_id, set()):
            utility, kind = 0.2, "interest"
        else:
            continue  # Left and unrated Watched are neutral, not dislikes.
        if utility == 0:
            continue
        boost = (
            1.0 + 0.2 / (1.0 + (max(ranks.get(title_id, 1), 1) - 1) / 20.0)
            if utility > 0 and title_id in ranks
            else 1.0
        )
        evidence[title_id] = Evidence(title_id, utility, kind, boost)
    return evidence, numeric_count


class TitleScorer:
    def __init__(
        self,
        evidence,
        numeric_count,
        features,
        *,
        version=SCORE_VERSION,
        weights=WEIGHTS,
        now=None,
        candidate_features=None,
    ):
        if (
            set(weights) != set(WEIGHTS)
            or any(w < 0 for w in weights.values())
            or sum(weights.values()) != 100
        ):
            raise ValueError("SceneDNA dimension weights must be nonnegative and total 100.")
        self.evidence, self.numeric_count, self.features = evidence, numeric_count, features
        self.candidate_features = candidate_features if candidate_features is not None else features
        self.version, self.weights, self.now = version, weights, now or datetime.now(timezone.utc)
        self.score_cache = {}
        self.semantic_index = defaultdict(set)
        for key in evidence:
            for attr in features.get(key, {}).get("exemplars", {}):
                self.semantic_index[attr].add(key)
        self.known_dimensions = set()
        self.attribute_sum = defaultdict(float)
        self.attribute_weight = defaultdict(float)
        self.attribute_evidence = defaultdict(set)
        for key, signal in evidence.items():
            for dimension, attrs in features.get(key, {}).items():
                if dimension == "exemplars" or not attrs:
                    continue
                self.known_dimensions.add(dimension)
                for attribute, share in attrs.items():
                    self.attribute_evidence[dimension, attribute].add(key)
                    weight = share * signal.boost
                    self.attribute_sum[dimension, attribute] += weight * signal.utility
                    self.attribute_weight[dimension, attribute] += weight

    def score_features(self, candidate):
        breakdown = []
        comparable_weight = 0.0
        for dimension, configured_weight in self.weights.items():
            attrs = candidate.get(dimension) or {}
            if not attrs:
                continue
            # Unknown attributes contribute neutral fit, without pretending to
            # carry confidence. Otherwise omitting an unseen genre can make it
            # outrank a known favorite merely by changing the denominator.
            if dimension == "exemplars":
                if self.semantic_index:
                    comparable_weight += configured_weight
            elif dimension in self.known_dimensions:
                comparable_weight += configured_weight
            supported_mass = 1.0
            if dimension == "exemplars":
                numerator = denominator = quality = 0.0
                count = 0
                related = set().union(*(self.semantic_index.get(attr, set()) for attr in attrs))
                for key in related:
                    signal = self.evidence[key]
                    other = self.features.get(key, {}).get("exemplars", {})
                    union = set(attrs) | set(other)
                    total = sum(max(attrs.get(k, 0), other.get(k, 0)) for k in union)
                    similarity = (
                        sum(min(attrs.get(k, 0), other.get(k, 0)) for k in union) / total
                        if total
                        else 0
                    )
                    if similarity <= 0:
                        continue
                    weight = similarity * signal.boost
                    numerator += weight * signal.utility
                    denominator += weight
                    count += 1
                    quality += 1.0 if signal.kind in ("rating", "dislike") else 0.5
                affinity = numerator / (AFFINITY_PRIOR + denominator)
            else:
                supported = {attr: share for attr, share in attrs.items()
                             if self.attribute_evidence[dimension, attr]}
                related = set().union(*(self.attribute_evidence[dimension, attr] for attr in supported))
                count = len(related)
                quality = sum(1.0 if self.evidence[key].kind in ("rating", "dislike") else 0.5
                              for key in related)
                supported_mass = sum(supported.values())
                # Unseen actors/genres are missing evidence, not neutral votes.
                # The regularizing prior already protects sparse attributes.
                affinity = sum(
                    share * self.attribute_sum[dimension, attr]
                    / (AFFINITY_PRIOR + self.attribute_weight[dimension, attr])
                    for attr, share in supported.items()
                )
            if not count:
                continue
            confidence = min(1.0, sqrt(count / CONFIDENCE_FULL_TITLES)) * (quality / count) * supported_mass
            # Enriched semantics are interpretations, not certified preferences.
            if dimension == "exemplars" and any(not k.startswith("keyword:") for k in attrs):
                confidence *= 0.75
            breakdown.append(
                SceneDnaDimension(
                    dimension=dimension,
                    weight=configured_weight,
                    score=round(50 + 50 * max(-1.0, min(1.0, affinity)), 6),
                    confidence=confidence,
                    evidence_count=count,
                )
            )
        denominator = sum(d.weight * d.confidence for d in breakdown)
        coverage = min(1.0, denominator / 100)
        score = (
            max(0.0, min(100.0, 50 + sum(d.weight * (d.score - 50) for d in breakdown)
                         / comparable_weight))
            if breakdown and comparable_weight else None
        )
        show = self.numeric_count >= DISPLAY_MIN_RATINGS and coverage >= DISPLAY_MIN_COVERAGE
        positive = sorted(
            (d for d in breakdown if d.score > 50),
            key=lambda d: -(d.score - 50) * d.weight * d.confidence,
        )
        labels = {
            "exemplars": "similar title themes",
            "genres": "genres",
            "actors": "cast",
            "decade": "release decades",
            "format": "film and series preferences",
            "language": "original languages",
            "directors": "directors",
            "writers": "writers",
            "services": "services you watched on",
            "studios": "production studios",
        }
        explanation = (
            "Based on your " + ", ".join(labels[d.dimension] for d in positive[:2])
            if positive
            else "Learning your taste"
            if score is None
            else "Based on your title preferences"
        )
        return TitleCompatibility(
            score=round(score, 6) if score is not None else None,
            percentage=round(score) if show and score is not None else None,
            score_version=self.version,
            computed_at=self.now,
            evidence_count=len(self.evidence),
            numeric_rating_count=self.numeric_count,
            confidence=round(coverage, 6),
            available_dimensions=[d.dimension for d in breakdown],
            breakdown=breakdown,
            learning=not show,
            learning_reason=("more_ratings" if self.numeric_count < DISPLAY_MIN_RATINGS
                             else "limited_title_evidence") if not show else None,
            explanation=explanation,
        )

    def score(self, title):
        features = self.candidate_features.get(title.id) or title_features(title)
        key = tuple((dim, tuple(sorted(attrs.items()))) for dim, attrs in sorted(features.items()))
        # Only this scorer/request owns the cache. No cross-account or stale
        # taste-state reuse; identical feature sets need evaluating only once.
        if key not in self.score_cache:
            self.score_cache[key] = self.score_features(features)
        return self.score_cache[key]


def load_effective_evidence(db, user_id):
    """Read authoritative state each request; never a day-old derived signal cache."""
    ratings = {
        r.content_title_id: float(r.score) if r.score is not None else None
        for r in db.scalars(select(Rating).where(Rating.user_id == user_id)).all()
    }
    ranks = {
        r.content_title_id: r.position
        for r in db.scalars(select(RankedFavorite).where(RankedFavorite.user_id == user_id)).all()
    }
    saved = set(
        db.scalars(
            select(WatchlistItem.content_title_id)
            .join(Watchlist)
            .where(Watchlist.owner_user_id == user_id)
        ).all()
    )
    watched = set(
        db.scalars(
            select(TitleWatchStatus.content_title_id).where(
                TitleWatchStatus.user_id == user_id, TitleWatchStatus.watched_state == "watched"
            )
        ).all()
    )
    records = db.scalars(select(SwipeRecord).where(SwipeRecord.user_id == user_id)).all()
    disabled = {r.id for r in records if r.influence_disabled_at is not None}
    decisions = db.scalars(
        select(DiscoveryDecision).where(DiscoveryDecision.user_id == user_id)
    ).all()
    decision_ids = {d.id for d in decisions}
    actions = defaultdict(set)
    for d in decisions:
        if d.undone_at is None and d.influence_disabled_at is None and d.id not in disabled:
            actions[d.content_title_id].add(d.direction)
    for r in records:
        if (
            r.id not in decision_ids
            and r.id not in disabled
            and (r.direction == "right" or (r.action_version >= 2 and r.direction == "down"))
        ):
            actions[r.content_title_id].add(r.direction)
    return effective_evidence(ratings, ranks, saved, actions, watched), ranks


def scorer_for_user(db, user_id, candidates=()):
    (evidence, numeric_count), ranks = load_effective_evidence(db, user_id)
    titles = {
        t.id: t
        for t in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(list(evidence)))).all()
    }
    titles.update({t.id: t for t in candidates})
    enriched = {
        f.content_title_id: f
        for f in db.scalars(
            select(TitleFeatures).where(TitleFeatures.content_title_id.in_(list(titles)))
        ).all()
    }
    now = datetime.now(timezone.utc)
    profile = db.get(UserProfile, user_id)
    region = (profile.country_code if profile else None) or "US"
    providers = defaultdict(set)
    for row in db.scalars(
        select(ContentAvailability).where(
            ContentAvailability.content_title_id.in_(list(titles)),
            ContentAvailability.region_code == region.upper(),
        )
    ).all():
        if row.expires_at and _utc(row.expires_at) > now:
            providers[row.content_title_id].add(row.provider_code)
    features = {
        key: title_features(title, enriched.get(key), providers[key])
        for key, title in titles.items()
    }
    # Only a real resolved handoff paired with positive explicit taste can
    # teach service affinity. Merely selecting subscriptions adds no evidence.
    handoffs = db.scalars(
        select(WatchHandoff)
        .where(WatchHandoff.user_id == user_id, WatchHandoff.resolved_action == "watched")
        .order_by(WatchHandoff.resolved_at.desc())
    ).all()
    candidate_features = {
        key: {dim: dict(attrs) for dim, attrs in dims.items()} for key, dims in features.items()
    }
    chosen = set()
    for key in evidence:
        features[key]["services"] = {}
    for row in handoffs:
        signal = evidence.get(row.content_title_id)
        if (
            signal
            and signal.utility > 0
            and (signal.kind == "rating" or row.content_title_id in ranks)
            and row.content_title_id not in chosen
        ):
            features[row.content_title_id]["services"] = {row.provider_code: 1.0}
            chosen.add(row.content_title_id)
    return TitleScorer(
        evidence, numeric_count, features, now=now, candidate_features=candidate_features
    )
