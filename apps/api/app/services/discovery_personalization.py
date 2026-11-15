"""Bounded, owner-scoped candidate discovery and taste-led deck composition.

TMDB sees only public title/attribute IDs, never account identifiers or list
contents. Its related-title results are candidates, not SceneDNA evidence.
Every candidate is scored by the shared scorer and passes feed eligibility.
"""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from datetime import datetime, timezone
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.models.content import ContentTitle
from app.services.title_compatibility import title_features
from app.services.concierge_runtime import timeout_for, ConciergeDeadlineExceeded
from app.services.tmdb import (
    _fetch_genre_map, _match_genre_id, _tmdb_headers,
    _upsert_title_from_tmdb_result, _fresh_stamp, TmdbConfigurationError,
)

SPECIFIC = {"exemplars", "actors", "directors", "writers"}
MIX = {"taste": .70, "discovery": .20, "social": .10}
MAX_WAITING = 160


def needs_evidence(title, region):
    meta = title.metadata_raw or {}
    return not (_fresh_stamp(meta.get("_discovery_evidence_at")) and
                _fresh_stamp(meta.get("_discovery_provider_checks", {}).get(region))) and not _fresh_stamp(meta.get("_discovery_evidence_attempts", {}).get(region), hours=1)


def positive_seeds(db, scorer, state, preferred_type=None):
    """Several distinct favorites plus rotating library evidence, not two anchors."""
    positive = {key: e for key, e in scorer.evidence.items() if e.utility > 0}
    rows = list(db.scalars(select(ContentTitle).where(ContentTitle.id.in_(positive))).all())
    wanted = "series" if preferred_type == "show" else preferred_type
    same_format = [t for t in rows if not wanted or t.content_type == wanted]
    rows = same_format or rows
    sources = state.get("taste_sources", {})
    remaining = [t for t in rows if not sources.get(f"seed:{t.id}", {}).get("done")]
    # After related endpoints exhaust, the same history can still power
    # unexhausted keyword/creator queries and needs to remain available.
    rows = remaining or rows
    rows.sort(key=lambda t: (-positive[t.id].utility * positive[t.id].boost, str(t.id)))
    def similarity(a, b):
        fa, fb = scorer.features.get(a.id, {}), scorer.features.get(b.id, {})
        total = 0.
        for dim, weight in (("genres", .35), ("exemplars", .4), ("directors", .15), ("actors", .1)):
            x, y = set(fa.get(dim, {})), set(fb.get(dim, {}))
            if x and y:
                total += weight * len(x & y) / len(x | y)
        return total
    offset = int(state.get("seed_offset", 0))
    selected = []
    # Scoring uses ALL current evidence. The bounded network sample must
    # represent it too: perfect scores cannot crowd out 6–8s or right-swipe/
    # saved interest. Rotate within each group on successive feed pages.
    groups = [
        [t for t in rows if positive[t.id].kind == "rating" and (positive[t.id].rating or 0) >= 9],
        [t for t in rows if positive[t.id].kind == "rating" and (positive[t.id].rating or 0) < 9],
        [t for t in rows if positive[t.id].kind != "rating"],
    ]
    for group in groups:
        if group:
            selected.append(group[offset % len(group)])
    if not wanted:
        for kind in ("movie", "series"):
            if not any(t.content_type == kind for t in selected):
                row = next((t for t in rows if t.content_type == kind), None)
                if row and len(selected) < 4:
                    selected.append(row)
    while len(selected) < min(4, len(rows)):
        remaining = [t for t in rows if t not in selected]
        selected.append(max(remaining, key=lambda t: (
            positive[t.id].utility * positive[t.id].boost *
            (1 - max((similarity(t, other) for other in selected), default=0)), str(t.id))))
    state["retrieval_seeds"] = [str(t.id) for t in selected]
    rotating = rows[offset % len(rows):] + rows[:offset % len(rows)] if rows else []
    for title in rotating:
        if title not in selected:
            selected.append(title)
        if len(selected) >= 6:
            break
    state["rotating_seed"] = str(rotating[0].id) if rotating else None
    state["rotating_seeds"] = [str(t.id) for t in selected[4:]]
    state["seed_offset"] = offset + 1
    return selected


def negative_seeds(scorer, state):
    """Hydrate dislikes too: opposite themes inside Drama must remain distinct."""
    rows = [scorer.reasons.titles[key] for key, e in scorer.evidence.items()
            if e.utility < 0 and key in scorer.reasons.titles]
    rows.sort(key=lambda t: (scorer.evidence[t.id].utility, str(t.id)))
    offset = int(state.get("negative_offset", 0))
    rotated = rows[offset % len(rows):] + rows[:offset % len(rows)] if rows else []
    state["negative_offset"] = offset + 2
    return rotated[:2]


def fetch_evidence(kind, tmdb_id):
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=timeout_for(3)) as client:
        response = client.get(f"/{kind}/{tmdb_id}", params={
            "language": "en-US", "append_to_response": "credits,keywords,watch/providers",
        })
        response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or data.get("id") != tmdb_id:
        raise ValueError("Unexpected title evidence response")
    return dict(data, media_type=kind)


def enrich_evidence(db, titles, region, *, limit):
    """At most one bounded worker wave; SQL stays on the request thread.

Negative provider lookups are cached too. Missing appended data is not proof
of no availability and never overwrites a prior positive provider check.
    """
    work = []
    for title in dict.fromkeys(titles):
        if not needs_evidence(title, region):
            continue
        work.append(title)
        if len(work) >= limit:
            break
    if not work:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    for title in work:
        meta = title.metadata_raw or {}
        title.metadata_raw = {**meta, "_discovery_evidence_attempts": {**meta.get("_discovery_evidence_attempts", {}), region: now}}
    failed = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [(title, pool.submit(copy_context().run, fetch_evidence, "tv" if title.content_type == "series" else "movie", title.tmdb_id)) for title in work]
        for title, future in futures:
            try:
                raw = future.result()
                # Partial merge preserves images and other independently cached data.
                _upsert_title_from_tmdb_result(db, raw)
                meta = dict(title.metadata_raw or {})
                if isinstance(raw.get("credits"), dict) and isinstance(raw.get("keywords"), (dict, list)):
                    meta["_discovery_evidence_at"] = now
                providers = raw.get("watch/providers")
                if isinstance(providers, dict) and isinstance(providers.get("results"), dict):
                    offers = providers["results"].get(region) or {}
                    checks = dict(meta.get("_discovery_provider_checks", {})); checks[region] = now
                    stamps = dict(meta.get("_discovery_availability", {}))
                    for mode, groups in (("streaming", ("flatrate", "free", "ads")), ("all", ("flatrate", "free", "ads", "rent", "buy"))):
                        if any(offers.get(group) for group in groups):
                            stamps[f"{region}:{mode}"] = now
                        else:
                            stamps.pop(f"{region}:{mode}", None)
                    meta.update(_discovery_provider_checks=checks, _discovery_availability=stamps)
                title.metadata_raw = meta
            except (httpx.HTTPError, TmdbConfigurationError, ConciergeDeadlineExceeded, ValueError, TypeError):
                failed += 1
    return failed


def attribute_affinities(scorer):
    affinities = defaultdict(float)
    for key, evidence in scorer.evidence.items():
        # Plot subjects cannot power personalized retrieval. Style vectors do
        # not map to TMDB keyword IDs; use owned title/creator sources instead.
        for dim in ("directors", "actors", "genres"):
            for attr, share in scorer.features.get(key, {}).get(dim, {}).items():
                affinities[dim, attr] += evidence.utility * evidence.boost * share
    return affinities


def plan_sources(scorer, seeds, state, preferred_type=None, genre=None):
    """Up to four title anchors and two learned trait queries per page."""
    kinds = ["movie"] if preferred_type == "movie" else ["tv"] if preferred_type == "show" else ["movie", "tv"]
    cycle = int(state.get("taste_cycle", 0))
    jobs = []
    eligible = [t for t in seeds if ("tv" if t.content_type == "series" else "movie") in kinds]
    if eligible:
        progress = state.get("taste_sources", {})
        # Unvisited sources come before deeper pages from the same favorite.
        rotating = [t for t in eligible if str(t.id) in state.get("rotating_seeds", [])]
        primary = [t for t in eligible if t not in rotating]
        offset = cycle % len(primary) if primary else 0
        primary = primary[offset:] + primary[:offset]
        representative = [t for t in eligible if str(t.id) in state.get("retrieval_seeds", [])]
        selected = representative[:4] or (sorted(primary,
            key=lambda t: progress.get(f"seed:{t.id}", {}).get("page", 1))[:4-len(rotating)] + rotating)
        for title in selected:
            kind = "tv" if title.content_type == "series" else "movie"
            jobs.append({"key": f"seed:{title.id}", "kind": kind, "seed": str(title.id),
                         "path": f"/{kind}/{title.tmdb_id}/recommendations", "params": {}, "regional": False})
    affinities = attribute_affinities(scorer)
    for turn in range(2):
        kind = kinds[(cycle + turn) % len(kinds)]
        # Creator-led sources supplement owned-title retrieval. Broad genres
        # can provide discovery supply but never prove a personal style match.
        dims = ("directors", "actors", "genres") if turn == 0 else ("actors", "directors", "genres")
        for dim in dims:
            if kind == "tv" and dim in {"directors", "actors"}:
                continue  # TMDB TV Discover has no movie with_cast/with_crew contract.
            values = sorted(((a, w) for (d, a), w in affinities.items() if d == dim and w > 0
                             and not state.get("taste_sources", {}).get(f"trait:{kind}:{dim}:{a}", {}).get("done")),
                            key=lambda x: (-x[1], x[0]))
            if not values:
                continue
            attr = values[(cycle + turn) % len(values)][0]
            param = {"directors": "with_crew", "actors": "with_cast", "genres": "taste_genre"}[dim]
            key = f"trait:{kind}:{dim}:{attr}"
            if any(j["key"] == key for j in jobs):
                continue
            jobs.append({"key": key, "kind": kind, "path": f"/discover/{kind}",
                         "params": {param: attr.removeprefix("keyword:")}, "regional": True})
            break
    sources = state.setdefault("taste_sources", {})
    planned = []
    for job in jobs:
        progress = sources.setdefault(job["key"], {"page": 1, "done": False})
        if not progress["done"]:
            planned.append({**job, "page": progress["page"]})
    state["taste_cycle"] = cycle + 1
    return planned


def fetch_source(job, genre, region, mode, as_of):
    from app.services.discovery_feed import canonical_genre
    kind = job["kind"]
    mapping = _fetch_genre_map(kind)
    params = {"language": "en-US", "page": job["page"], **job["params"]}
    if job["regional"]:
        requested = canonical_genre(kind, genre) if genre else None
        seed_genre = canonical_genre(kind, params.pop("taste_genre", None))
        ids = [_match_genre_id(mapping, g) for g in [requested, seed_genre] if g]
        if any(g is None for g in ids):
            return {"rows": [], "done": True}
        params.update({"include_adult": "false", "sort_by": "popularity.desc", "watch_region": region,
            "with_watch_monetization_types": "flatrate|free|ads" if mode == "streaming" else "flatrate|free|ads|rent|buy",
            ("primary_release_date.lte" if kind == "movie" else "first_air_date.lte"): as_of.isoformat()})
        if ids:
            params["with_genres"] = ",".join(str(g) for g in dict.fromkeys(ids))
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=timeout_for(4)) as client:
        response = client.get(job["path"], params=params)
        response.raise_for_status()
    data = response.json()
    rows = [dict(row, media_type=kind, genres=[{"id": gid, "name": mapping[gid]} for gid in row.get("genre_ids", []) if gid in mapping])
            for row in data.get("results", []) if not row.get("adult")]
    return {"rows": rows, "done": job["page"] >= min(int(data.get("total_pages", 0)), 500)}


def ingest_source(db, job, result, state, now, region, mode):
    waiting = state.setdefault("taste_waiting", {})
    state["taste_sources"][job["key"]] = {"page": job["page"] + 1, "done": result["done"]}
    for position, raw in enumerate(result["rows"]):
        try:
            with db.begin_nested():
                title = _upsert_title_from_tmdb_result(db, raw)
        except IntegrityError:
            title = _upsert_title_from_tmdb_result(db, raw)
        if title is None:
            continue
        if job["regional"]:
            meta = dict(title.metadata_raw or {})
            meta["_discovery_availability"] = {**meta.get("_discovery_availability", {}), f"{region}:{mode}": now.isoformat()}
            title.metadata_raw = meta
        waiting.setdefault(str(title.id), {"seed": job.get("seed"), "source": job["key"], "position": position})


def specific_match(match):
    return match.score is not None and match.score >= 55 and any(d.dimension in SPECIFIC and d.score > 55 for d in match.breakdown)


def conflicts_with_taste(match):
    return match.score is not None and match.score < 50 and any(
        d.dimension in SPECIFIC and d.score < 45 for d in match.breakdown
    )


def evidence_prospects(waiting, pending, origins, scorer, region, limit=24):
    """Round-robin real source results before broad-genre catalog guesses.

TMDB list responses do not contain credits/keywords. Without this step most
of a 20-card deck was never examined beyond its genres. Preserve upstream
related-title ordering for inspection, not UUID / sparse-metadata scoring.
    """
    groups = defaultdict(list)
    for key, title in waiting.items():
        if needs_evidence(title, region):
            origin = origins.get(key, {})
            groups[origin.get("source", "related")].append((origin.get("position", 999), key, title))
    for rows in groups.values():
        rows.sort(key=lambda row: (row[0], row[1]))
    selected, seen = [], set()
    while any(groups.values()) and len(selected) < limit - 4:
        for source in sorted(groups):
            if groups[source] and len(selected) < limit - 4:
                _, key, title = groups[source].pop(0)
                if key not in seen:
                    selected.append(title); seen.add(key)
    catalog = sorted(pending.items(), key=lambda item: (
        -(scorer.score(item[1]).score or 50), item[0]))
    for key, title in catalog:
        if key not in seen and needs_evidence(title, region):
            selected.append(title); seen.add(key)
        if len(selected) >= limit:
            break
    # If catalog work was already cached, spend the remaining budget on
    # unexamined personal candidates instead of leaving slots unused.
    while any(groups.values()) and len(selected) < limit:
        for source in sorted(groups):
            if groups[source] and len(selected) < limit:
                _, key, title = groups[source].pop(0)
                if key not in seen:
                    selected.append(title); seen.add(key)
    return selected


def ranking_context(scorer, titles, origins):
    anchors, related = {}, set()
    for key, title in titles.items():
        connection = scorer.reasons.connection(title, scorer.candidate_features.get(title.id) or title_features(title))
        origin = origins.get(key, {})
        try:
            seed = UUID(origin.get("seed", ""))
        except (ValueError, TypeError, AttributeError):
            seed = None
        signal = scorer.evidence.get(seed)
        if seed and signal and signal.utility > 0:
            related.add(key)
            anchors[key] = str(seed)
        if connection:
            anchors[key] = connection["anchor"]
    return anchors, related


def compose(titles, scores, social, limit, history=(), *, anchors=None, related=()):
    """70/20/10 target when supported. Never manufacture a strong-match label.

Social retrieval has a hard two-in-twenty cap; missing buckets fall back to
available taste/discovery candidates. Diversity is a small ranking penalty,
not a hidden alteration of the displayed SceneDNA percentage.
    """
    anchors = anchors or {}
    remaining = set(titles)
    selected, recent = [], list(history)[-19:]
    while remaining and len(selected) < limit:
        buckets = defaultdict(list)
        for key in remaining:
            match = scores[key]
            if match.score is not None and match.score < 50:
                continue  # A short page beats padding it with negative fits.
            # Being in a TMDB related-title list is retrieval provenance, not
            # proof of shared taste or permission to fill the taste quota.
            personal = specific_match(match)
            kind = "social" if key in social else "taste" if personal else "discovery"
            if kind == "social" and sum(x["kind"] == "social" for x in recent[-19:]) >= 2:
                continue
            buckets[kind].append(key)
        buckets = {kind: keys for kind, keys in buckets.items() if keys}
        if not buckets:
            break
        counts = {kind: sum(x["kind"] == kind for x in recent) for kind in MIX}
        target = max(buckets, key=lambda kind: ((len(recent) + 1) * MIX[kind] - counts[kind], MIX[kind]))
        if target == "discovery" and buckets.get("taste"):
            best_taste = max(scores[key].score or 50 for key in buckets["taste"])
            best_exploration = max(scores[key].score or 50 for key in buckets["discovery"])
            if best_taste > best_exploration + 8:
                target = "taste"  # A quota must not displace a materially better fit.
        choices = buckets[target]
        def anchor_count(key):
            return sum(h.get("anchor") == anchors[key] for h in recent[-9:]) if key in anchors else 0
        # Do not serve seven titles from one favorite when credible alternatives
        # exist. This diversifies the titles themselves, not just the wording.
        best_score = max(scores[key].score if scores[key].score is not None else 50 for key in choices)
        has_specific = target == "taste" and any(specific_match(scores[key]) for key in choices)
        alternatives = [key for key in choices if anchor_count(key) < 3
                        and (scores[key].score if scores[key].score is not None else 50) >= best_score - 8
                        and (not has_specific or specific_match(scores[key]))]
        if alternatives:
            choices = alternatives
        def order(key):
            title = titles[key]
            genres = set(g.casefold() for g in title.genres or [])
            collection = (title.metadata_raw or {}).get("belongs_to_collection") or {}
            franchise = collection.get("id") if isinstance(collection, dict) else None
            penalty = sum(2 for h in recent[-2:] if genres and genres.intersection(h.get("genres", [])))
            penalty += sum(5 for h in recent[-4:] if franchise and franchise == h.get("franchise"))
            penalty += anchor_count(key) * 4
            if recent and key in anchors and recent[-1].get("anchor") == anchors[key]:
                penalty += 6
            score = scores[key].score if scores[key].score is not None else 50
            # Verified specific matches beat thin related-title candidates;
            # generic genre/decade scores cannot crowd these out.
            return (-int(specific_match(scores[key])) if target == "taste" else 0,
                    -(score - penalty), -scores[key].confidence, key)
        key = min(choices, key=order)
        row = titles[key]
        collection = (row.metadata_raw or {}).get("belongs_to_collection") or {}
        recent.append({"kind": target, "genres": [g.casefold() for g in row.genres or []],
                       "franchise": collection.get("id") if isinstance(collection, dict) else None,
                       "anchor": anchors.get(key)})
        recent = recent[-20:]
        remaining.remove(key); selected.append(key)
    return selected, recent


def personal_reason(db, scorer, origin, candidate=None):
    if candidate is not None:
        features = scorer.candidate_features.get(candidate.id) or title_features(candidate)
        return scorer.reasons.for_title(candidate, features)
    seed_id = origin.get("seed") if origin else None
    if not seed_id:
        return None
    try:
        seed_id = UUID(seed_id)
    except (ValueError, TypeError, AttributeError):
        return None
    return scorer.reasons.from_seed(seed_id)


def has_more_sources(scorer, state, preferred_type):
    if not settings.tmdb_api_key:
        return False
    wanted = "series" if preferred_type == "show" else preferred_type
    sources = state.get("taste_sources", {})
    seeds = {f"seed:{key}" for key, e in scorer.evidence.items() if e.utility > 0
             and (not wanted or wanted in scorer.features.get(key, {}).get("format", {}))}
    if any(key not in sources or not sources[key]["done"] for key in seeds):
        return True
    affinities = attribute_affinities(scorer)
    kinds = ["tv" if wanted == "series" else "movie"] if wanted else ["movie", "tv"]
    for (dim, attr), weight in affinities.items():
        for kind in kinds:
            if weight <= 0 or (kind == "tv" and dim in {"actors", "directors"}):
                continue
            if not sources.get(f"trait:{kind}:{dim}:{attr}", {}).get("done"):
                return True
    return False
