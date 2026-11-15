"""Shared evidence preparation and selection for personal recommendation surfaces.

The score remains SceneDNA's score. Retrieval provenance and plot subjects do
not become style evidence. Public metadata enrichment has a fixed work budget.
"""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from datetime import datetime, timezone, date
from uuid import UUID

import httpx
from sqlalchemy import select

from app.core.config import settings
from app.models.content import ContentTitle
from app.models.user import UserProfile
from app.services import discovery_personalization as personal
from app.services import viewing_style
from app.services.title_compatibility import scorer_for_user
from app.services.taste_semantics import semantic_similarity
from app.services.tmdb import TmdbConfigurationError
from app.services.concierge_runtime import ConciergeDeadlineExceeded


def history(db, user_id, preferred_type=None):
    scorer = scorer_for_user(db, user_id)
    state = {}
    seeds = personal.positive_seeds(db, scorer, state, preferred_type)
    negatives = personal.negative_seeds(scorer, state)
    return scorer, seeds, negatives, state


def region_for(db, user_id):
    profile = db.get(UserProfile, user_id) if user_id else None
    return ((profile.country_code if profile else None) or "US").upper()


def prepare_evidence(db, rows, *, seeds=(), negatives=(), anchors=(), region="US", limit=32, metadata=True):
    # Prefer the explicit similarity anchor, then diverse current owner evidence.
    work = list(dict.fromkeys([*anchors[:4], *seeds[:6], *negatives[:2], *rows]))[:min(limit, 32)]
    if not work:
        return []
    if metadata and settings.tmdb_api_key:
        personal.enrich_evidence(db, work, region, limit=len(work))
    viewing_style.enrich_styles(work, limit=len(work))
    db.flush()
    return work


def retrieve_personal(db, scorer, seeds, state, *, preferred_type=None, genre=None, region="US"):
    """Four owner-title sources and two trait sources; never fetch an entire catalog."""
    if not seeds or not settings.tmdb_api_key:
        return [], {}
    jobs = personal.plan_sources(scorer, seeds, state, preferred_type, genre)
    now = datetime.now(timezone.utc)
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = [(job, executor.submit(copy_context().run, personal.fetch_source,
                    job, genre, region, "all", date.today())) for job in jobs]
        for job, future in futures:
            try:
                personal.ingest_source(db, job, future.result(), state, now, region, "all")
            except (httpx.HTTPError, TmdbConfigurationError, ConciergeDeadlineExceeded, ValueError, TypeError):
                continue  # Local evidence still works when a source is unavailable.
    origins = dict(list(state.get("taste_waiting", {}).items())[:personal.MAX_WAITING])
    rows = list(db.scalars(select(ContentTitle).where(ContentTitle.id.in_([UUID(key) for key in origins]))))
    return rows, origins


def inspection_order(rows, origins, scorer, limit=24):
    """Inspect different sources even if their sparse records initially score poorly."""
    groups = {}
    for row in rows:
        origin = origins.get(str(row.id))
        if origin:
            groups.setdefault(origin["source"], []).append((origin.get("position", 999), str(row.id), row))
    for group in groups.values():
        group.sort(key=lambda item: item[:2])
    selected = []
    while any(groups.values()) and len(selected) < limit - 4:
        for source in sorted(groups):
            if groups[source] and len(selected) < limit - 4:
                selected.append(groups[source].pop(0)[2])
    for row in sorted(rows, key=lambda t: (-(scorer.score(t).score or 50), str(t.id))):
        if row not in selected:
            selected.append(row)
        if len(selected) >= limit:
            break
    return selected


def similarity_strength(source, candidate):
    """Style or verified creator evidence; a shared genre/actor/topic is insufficient."""
    a, b = source.get("exemplars", {}), candidate.get("exemplars", {})
    shared = semantic_similarity(a, b)
    if shared:
        return shared
    # Known opposing styles must not be rescued by a shared director.
    axes = lambda values: {key.split(":")[1] for key in values if key.startswith("style:")}
    if len(axes(a)) >= 2 and len(axes(b)) >= 2:
        return 0.
    creators = set(source.get("directors", {})) & set(candidate.get("directors", {}))
    genres = set(source.get("genres", {})) & set(candidate.get("genres", {}))
    return .2 if creators and genres else 0.


def similarity_unknown(source, candidate):
    """Missing multi-axis style is uncertainty, not evidence of a mismatch."""
    return any(len({key.split(":")[1] for key in features.get("exemplars", {})
                    if key.startswith("style:")}) < 2 for features in (source, candidate))


def order_personal(rows, scorer, *, relevance=None):
    """Quality first. Diversity only among equally relevant, similarly fitting titles.

    Concierge relevance is an exact first key; diversity cannot override a
    request. Diversity only breaks ties in the displayed SceneDNA percentage.
    """
    remaining = list(rows)
    scores = {t.id: scorer.score(t) for t in rows}
    links = {t.id: scorer.reasons.connection(t, scorer.candidate_features[t.id]) for t in rows}
    selected, anchors, franchises = [], Counter(), Counter()
    while remaining:
        if relevance is not None:
            best_relevance = max(relevance[t.id] for t in remaining)
            choices = [t for t in remaining if relevance[t.id] == best_relevance]
        else:
            choices = [t for t in remaining if scores[t.id].score is None or scores[t.id].score >= 50]
            if not choices:
                break
            specific = [t for t in choices if personal.specific_match(scores[t.id])]
            choices = specific or choices
        score = lambda t: scores[t.id].score if scores[t.id].score is not None else 50.
        best = max(score(t) for t in choices)
        choices = [t for t in choices if round(score(t)) == round(best)]
        def franchise(t):
            value = (t.metadata_raw or {}).get("belongs_to_collection")
            return value.get("id") if isinstance(value, dict) else None
        def key(t):
            anchor = links[t.id]["anchor"] if links[t.id] else None
            penalty = 3 * anchors[anchor] if anchor else 0
            if franchise(t):
                penalty += 3 * franchises[franchise(t)]
            return (-(score(t) - penalty), -scores[t.id].confidence, str(t.id))
        chosen = min(choices, key=key)
        selected.append(chosen); remaining.remove(chosen)
        if links[chosen.id]: anchors[links[chosen.id]["anchor"]] += 1
        if franchise(chosen): franchises[franchise(chosen)] += 1
    return selected, scores
