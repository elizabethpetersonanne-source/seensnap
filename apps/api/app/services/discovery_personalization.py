"""Bounded, owner-scoped candidate discovery and taste-led deck composition.

TMDB sees only public title/attribute IDs, never account identifiers or list
contents. Its related-title results are candidates, not SceneDNA evidence.
Every candidate is scored by the shared scorer and passes feed eligibility.
"""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.models.content import ContentTitle
from app.services.tmdb import (
    _fetch_genre_map, _match_genre_id, _tmdb_headers,
    _upsert_title_from_tmdb_result, _fresh_stamp, TmdbConfigurationError,
)

SPECIFIC = {"exemplars", "genres", "actors", "directors", "writers"}
MIX = {"taste": .70, "discovery": .20, "social": .10}
MAX_WAITING = 160


def needs_evidence(title, region):
    meta = title.metadata_raw or {}
    return not (_fresh_stamp(meta.get("_discovery_evidence_at")) and
                _fresh_stamp(meta.get("_discovery_provider_checks", {}).get(region))) and not _fresh_stamp(meta.get("_discovery_evidence_attempts", {}).get(region), hours=1)


def positive_seeds(db, scorer, state, preferred_type=None):
    """Two strong anchors plus rotating library evidence, not just recent saves."""
    positive = {key: e for key, e in scorer.evidence.items() if e.utility > 0}
    rows = list(db.scalars(select(ContentTitle).where(ContentTitle.id.in_(positive))).all())
    wanted = "series" if preferred_type == "show" else preferred_type
    same_format = [t for t in rows if not wanted or t.content_type == wanted]
    # Cross-format thematic transfer is useful when TV history is sparse.
    # Related-title endpoints themselves are never used for the wrong format.
    rows = same_format or rows
    rows.sort(key=lambda t: (-positive[t.id].utility * positive[t.id].boost, str(t.id)))
    offset = int(state.get("seed_offset", 0))
    rotating = rows[offset % len(rows):] + rows[:offset % len(rows)] if rows else []
    selected = list(dict.fromkeys([*rows[:2], *rotating[:2]]))
    state["rotating_seed"] = str(rotating[0].id) if rotating else None
    state["seed_offset"] = offset + 1
    return selected


def fetch_evidence(kind, tmdb_id):
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=3) as client:
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
        futures = [(title, pool.submit(fetch_evidence, "tv" if title.content_type == "series" else "movie", title.tmdb_id)) for title in work]
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
            except (httpx.HTTPError, TmdbConfigurationError, ValueError, TypeError):
                failed += 1
    return failed


def attribute_affinities(scorer):
    affinities = defaultdict(float)
    for key, evidence in scorer.evidence.items():
        for dim in ("exemplars", "directors", "actors", "genres"):
            for attr, share in scorer.features.get(key, {}).get(dim, {}).items():
                if dim != "exemplars" or attr.startswith("keyword:"):
                    affinities[dim, attr] += evidence.utility * evidence.boost * share
    return affinities


def plan_sources(scorer, seeds, state, preferred_type=None, genre=None):
    """Two title anchors and up to two learned trait queries per page."""
    kinds = ["movie"] if preferred_type == "movie" else ["tv"] if preferred_type == "show" else ["movie", "tv"]
    cycle = int(state.get("taste_cycle", 0))
    jobs = []
    eligible = [t for t in seeds if ("tv" if t.content_type == "series" else "movie") in kinds]
    if eligible:
        selected = [eligible[cycle % min(2, len(eligible))]]
        rotating = next((t for t in eligible if str(t.id) == state.get("rotating_seed")), None)
        if rotating and rotating not in selected:
            selected.append(rotating)
        elif len(eligible) > 1:
            selected.append(next(t for t in eligible if t not in selected))
        for title in selected:
            kind = "tv" if title.content_type == "series" else "movie"
            jobs.append({"key": f"seed:{title.id}", "kind": kind, "seed": str(title.id),
                         "path": f"/{kind}/{title.tmdb_id}/recommendations", "params": {}, "regional": False})
    affinities = attribute_affinities(scorer)
    for turn in range(2):
        kind = kinds[(cycle + turn) % len(kinds)]
        # Alternate theme/creator retrieval; fall back to positive genres when
        # the library lacks credits/keywords. Never infer those from a genre.
        dims = ("exemplars", "directors", "actors", "genres") if turn == 0 else ("directors", "actors", "exemplars", "genres")
        for dim in dims:
            if kind == "tv" and dim in {"directors", "actors"}:
                continue  # TMDB TV Discover has no movie with_cast/with_crew contract.
            values = sorted(((a, w) for (d, a), w in affinities.items() if d == dim and w > 0), key=lambda x: (-x[1], x[0]))
            if not values:
                continue
            attr = values[(cycle + turn) % min(len(values), 8)][0]
            param = {"exemplars": "with_keywords", "directors": "with_crew", "actors": "with_cast", "genres": "taste_genre"}[dim]
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
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=4) as client:
        response = client.get(job["path"], params=params)
        response.raise_for_status()
    data = response.json()
    rows = [dict(row, media_type=kind, genres=[{"id": gid, "name": mapping[gid]} for gid in row.get("genre_ids", []) if gid in mapping])
            for row in data.get("results", []) if not row.get("adult")]
    return {"rows": rows, "done": job["page"] >= min(int(data.get("total_pages", 0)), 500)}


def ingest_source(db, job, result, state, now, region, mode):
    waiting = state.setdefault("taste_waiting", {})
    state["taste_sources"][job["key"]] = {"page": job["page"] + 1, "done": result["done"]}
    for raw in result["rows"]:
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
        waiting.setdefault(str(title.id), {"seed": job.get("seed"), "source": job["key"]})


def specific_match(match):
    return match.score is not None and match.score >= 55 and any(d.dimension in SPECIFIC and d.score > 55 for d in match.breakdown)


def compose(titles, scores, social, limit, history=()):
    """70/20/10 target when supported. Never manufacture a strong-match label.

Social retrieval has a hard two-in-twenty cap; missing buckets fall back to
available taste/discovery candidates. Diversity is a small ranking penalty,
not a hidden alteration of the displayed SceneDNA percentage.
    """
    remaining = set(titles)
    selected, recent = [], list(history)[-19:]
    while remaining and len(selected) < limit:
        buckets = defaultdict(list)
        for key in remaining:
            match = scores[key]
            kind = "social" if key in social else "taste" if specific_match(match) else "discovery"
            if kind == "social" and sum(x["kind"] == "social" for x in recent[-19:]) >= 2:
                continue
            buckets[kind].append(key)
        # Explicitly poor fits are last-resort exploration, never required filler.
        nonnegative = {key for keys in buckets.values() for key in keys if scores[key].score is None or scores[key].score >= 50}
        if nonnegative:
            buckets = {kind: [key for key in keys if key in nonnegative] for kind, keys in buckets.items()}
        buckets = {kind: keys for kind, keys in buckets.items() if keys}
        if not buckets:
            break
        counts = {kind: sum(x["kind"] == kind for x in recent) for kind in MIX}
        target = max(buckets, key=lambda kind: ((len(recent) + 1) * MIX[kind] - counts[kind], MIX[kind]))
        def order(key):
            title = titles[key]
            genres = set(g.casefold() for g in title.genres or [])
            collection = (title.metadata_raw or {}).get("belongs_to_collection") or {}
            franchise = collection.get("id") if isinstance(collection, dict) else None
            penalty = sum(2 for h in recent[-2:] if genres and genres.intersection(h.get("genres", [])))
            penalty += sum(5 for h in recent[-4:] if franchise and franchise == h.get("franchise"))
            score = scores[key].score if scores[key].score is not None else 50
            return (-(score - penalty), -scores[key].confidence, key)
        key = min(buckets[target], key=order)
        row = titles[key]
        collection = (row.metadata_raw or {}).get("belongs_to_collection") or {}
        recent.append({"kind": target, "genres": [g.casefold() for g in row.genres or []],
                       "franchise": collection.get("id") if isinstance(collection, dict) else None})
        recent = recent[-20:]
        remaining.remove(key); selected.append(key)
    return selected, recent


def personal_reason(db, scorer, origin):
    seed_id = origin.get("seed") if origin else None
    if not seed_id:
        return None
    evidence = scorer.evidence.get(UUID(seed_id))
    if not evidence or evidence.utility <= 0:
        return None
    title = db.get(ContentTitle, UUID(seed_id))
    if title is None:
        return None
    return f"Because you {'saved' if evidence.kind in {'save', 'interest'} else 'liked'} {title.title}"


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
    for key, progress in sources.items():
        if key.startswith("trait:") and not progress["done"]:
            _, kind, dim, attr = key.split(":", 3)
            if (not wanted or kind == ("tv" if wanted == "series" else "movie")) and affinities[dim, attr] > 0:
                return True
    return False
