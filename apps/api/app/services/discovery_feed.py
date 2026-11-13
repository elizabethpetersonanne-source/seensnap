"""Shared streaming-discovery eligibility and stable Swipe/Preview continuation.

TMDB pages are queried with the actual movie/TV genre ID, region and release
band. Persisted pending/served IDs prevent regenerated-pool offset skips.
"""
import calendar
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.models.content import ContentTitle, ContentAvailability
from app.models.discovery import DiscoverySession
from app.models.taste import TitleFeatures
from app.models.user import UserProfile
from app.services.discovery_decisions import excluded_title_ids
from app.services.title_compatibility import scorer_for_user
from app.services.tmdb import _fetch_genre_map, _match_genre_id, _tmdb_headers, _upsert_title_from_tmdb_result, fetch_title_videos, TmdbConfigurationError

from app.core.scenedna_config import SCORE_VERSION
ALGORITHM = "discovery_v3:" + SCORE_VERSION
WEIGHTS = (0.50, 0.30, 0.15, 0.05)


def anniversary(day: date, years: int):
    year = day.year + years
    return day.replace(year=year, day=min(day.day, calendar.monthrange(year, day.month)[1]))


def age_band(released: date, as_of: date):
    for band, years in enumerate((10, 20, 40)):
        if as_of < anniversary(released, years):
            return band
    return 3


def next_band(counts, available):
    total = sum(counts[i] for i in available) + 1
    weight = sum(WEIGHTS[i] for i in available)
    return max(available, key=lambda i: (total * WEIGHTS[i] / weight - counts[i], -i))


def fingerprint(preferred_type, genre, region, mode, surface):
    return hashlib.sha256(json.dumps([preferred_type, (genre or "").casefold(), region, mode, surface, ALGORITHM]).encode()).hexdigest()


def canonical_genre(kind, genre):
    if kind in {"tv", "series"}:
        return {"action": "action & adventure", "adventure": "action & adventure",
                "science fiction": "sci-fi & fantasy", "fantasy": "sci-fi & fantasy",
                "war": "war & politics"}.get(genre, genre)
    return genre


def catalog_page(kind, band, page, genre, region, mode, as_of):
    genre = canonical_genre(kind, genre)
    mapping = _fetch_genre_map(kind)
    genre_id = _match_genre_id(mapping, genre) if genre else None
    if genre and genre_id is None:
        return {"rows": [], "done": True, "cap": False}
    params = {"page": page, "sort_by": "popularity.desc", "language": "en-US",
              "include_adult": "false", "watch_region": region,
              "with_watch_monetization_types": "flatrate|free|ads" if mode == "streaming" else "flatrate|free|ads|rent|buy"}
    if genre_id is not None:
        params["with_genres"] = str(genre_id)
    key = "primary_release_date" if kind == "movie" else "first_air_date"
    low, high = ((0, 10), (10, 20), (20, 40), (40, None))[band]
    # Expand anniversary bounds by one day around leap-year edges; the
    # canonical age_band check below assigns each title to exactly one band.
    params[key + ".lte"] = min(as_of, anniversary(as_of, -low) + timedelta(days=1)).isoformat()
    if high is not None:
        params[key + ".gte"] = (anniversary(as_of, -high) - timedelta(days=1)).isoformat()
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=10) as client:
        response = client.get(f"/discover/{kind}", params=params)
        response.raise_for_status()
    data = response.json()
    total_pages = int(data.get("total_pages", 0))
    rows = []
    for raw in data.get("results", []):
        raw = dict(raw, media_type=kind)
        raw["genres"] = [{"id": g, "name": mapping[g]} for g in raw.get("genre_ids", []) if g in mapping]
        rows.append(raw)
    return {"rows": rows, "done": page >= min(total_pages, 500), "cap": total_pages > 500 and page >= 500}


def _streaming_evidence(title, region, mode, now):
    stamp = (title.metadata_raw or {}).get("_discovery_availability", {}).get(f"{region}:{mode}")
    try:
        return timedelta(0) <= now - datetime.fromisoformat(stamp) < timedelta(hours=24)
    except (ValueError, TypeError):
        return False


def eligible(title, excluded, preferred_type, genre, region, mode, as_of, now):
    if title.id in excluded or not title.poster_url or not (title.overview or "").strip():
        return False
    if title.release_date is None or title.release_date > as_of:
        return False
    expected = "series" if preferred_type == "show" else preferred_type
    if expected and title.content_type != expected:
        return False
    genre = canonical_genre("tv" if title.content_type == "series" else "movie", genre)
    if genre and genre.casefold() not in {g.casefold() for g in title.genres or []}:
        return False
    return _streaming_evidence(title, region, mode, now)


def _video(title):
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=8) as client:
        videos = fetch_title_videos(title, client=client)
    for wanted in ("Teaser", "Trailer"):
        for item in videos:
            if item.get("site") == "YouTube" and str(item.get("official")).lower() == "true" and item.get("key") and item.get("type") == wanted:
                return {"provider": "YouTube", "external_key": item["key"], "type": wanted,
                        "name": item.get("name", ""), "official": True}
    return None


def private_sources(db, user_id, excluded):
    from app.services.taste import _source_social_saves, _source_watch_team
    from app.services.teams import list_user_teams
    social = _source_social_saves(db, user_id, excluded, 20)
    team_ids = [team.id for team, _ in list_user_teams(db, user_id)]
    teams = _source_watch_team(db, team_ids, excluded, 20)
    return social, teams


def source_labels(social, teams):
    labels = {str(item["title"].id): "In your Watch Teams" for item in teams}
    labels.update({str(item["title"].id): "Saved by someone you follow" for item in social})
    return labels


def get_feed(db, user_id, *, preferred_type=None, genre=None, cursor=None, limit=20, surface="swipe", mode="streaming"):
    now = datetime.now(timezone.utc)
    profile = db.get(UserProfile, user_id)
    region = (profile.country_code if profile else "US") or "US"
    region = region.upper()
    genre = (genre or "").strip().casefold() or None
    fp = fingerprint(preferred_type, genre, region, mode, surface)
    requested_version = 0
    if cursor:
        try:
            raw_id, raw_version = cursor.split(":")
            requested_version = int(raw_version)
            session_id = UUID(raw_id)
        except (ValueError, TypeError):
            raise HTTPException(status_code=409, detail={"error": "reset_feed", "message": "Refresh these picks to continue."})
        session = db.scalar(select(DiscoverySession).where(
            DiscoverySession.id == session_id, DiscoverySession.user_id == user_id,
        ).with_for_update())
        if session is None or session.fingerprint != fp or now - session.created_at.replace(tzinfo=timezone.utc) >= timedelta(hours=24):
            raise HTTPException(status_code=409, detail={"error": "reset_feed", "message": "Your filters or region changed. Refresh these picks."})
        if requested_version == session.version - 1 and session.last_response:
            response = dict(session.last_response)
            excluded = excluded_title_ids(db, user_id)
            response["items"] = [item for item in response["items"] if UUID(item.get("title_id") or item["title"]["id"]) not in excluded]
            rows = db.scalars(select(ContentTitle).where(ContentTitle.id.in_([
                UUID(item.get("title_id") or item["title"]["id"]) for item in response["items"]
            ]))).all()
            scorer = scorer_for_user(db, user_id, rows)
            matches = {str(row.id):scorer.score(row).model_dump(mode="json") for row in rows}
            current_sources = source_labels(*private_sources(db, user_id, excluded))
            for item in response["items"]:
                key = str(item.get("title_id") or item["title"]["id"])
                if key in matches:
                    previous = item.get("scenedna") if "title_id" in item else item["title"].get("scenedna")
                    if previous and {k:v for k,v in previous.items() if k != "computed_at"} == {k:v for k,v in matches[key].items() if k != "computed_at"}:
                        matches[key] = previous
                    if "title_id" in item: item["scenedna"] = matches[key]
                    else: item["title"] = {**item["title"], "scenedna":matches[key]}
                    old_reason = item.get("reason")
                    label = old_reason.get("label") if isinstance(old_reason, dict) else old_reason
                    if label in {"In your Watch Teams", "Saved by someone you follow"}:
                        label = current_sources.get(key) or matches[key]["explanation"]
                        item["reason"] = {**old_reason, "label": label} if isinstance(old_reason, dict) else label
            return response
        if requested_version != session.version:
            raise HTTPException(status_code=409, detail={"error": "reset_feed", "message": "This feed cursor is out of date."})
    else:
        kinds = ["movie"] if preferred_type == "movie" else ["tv"] if preferred_type == "show" else ["movie", "tv"]
        session = DiscoverySession(user_id=user_id, fingerprint=fp, state={
            "as_of": now.date().isoformat(), "pending": [], "served": [], "counts": [0, 0, 0, 0],
            "sources": {f"{kind}:{band}": {"page": 1, "done": False, "cap": False} for kind in kinds for band in range(4)},
        })
        db.add(session)
        db.flush()
    state = json.loads(json.dumps(session.state))
    as_of = date.fromisoformat(state["as_of"])
    excluded = excluded_title_ids(db, user_id)
    served = set(state["served"])
    pending = {str(t.id): t for t in db.scalars(select(ContentTitle).where(
        ContentTitle.id.in_([UUID(x) for x in state["pending"]]),
    )).all()}
    pending = {key: title for key, title in pending.items() if key not in served and eligible(
        title, excluded, preferred_type, genre, region, mode, as_of, now,
    )}
    counts_by_band = [sum(age_band(t.release_date, as_of) == band for t in pending.values()) for band in range(4)]
    work = [(key, source) for key, source in state["sources"].items()
            if not source["done"] and counts_by_band[int(key.split(":")[1])] < max(12, limit)]
    upstream_failure = False
    # HTTP in workers; SQLAlchemy session and title mutations stay on this thread.
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {key: pool.submit(catalog_page, key.split(":")[0], int(key.split(":")[1]), source["page"], genre, region, mode, as_of) for key, source in work}
        for key, future in futures.items():
            try:
                result = future.result()
            except (httpx.HTTPError, TmdbConfigurationError):
                upstream_failure = True
                continue
            source = state["sources"][key]
            source.update(page=source["page"] + 1, done=result["done"], cap=result.get("cap", False))
            for raw in result["rows"]:
                try:
                    with db.begin_nested():
                        title = _upsert_title_from_tmdb_result(db, raw)
                except IntegrityError:
                    # Another feed may have inserted this canonical TMDB title
                    # concurrently. Retry after rolling back only the savepoint.
                    title = _upsert_title_from_tmdb_result(db, raw)
                if title is None:
                    continue
                metadata = dict(title.metadata_raw or {})
                evidence = dict(metadata.get("_discovery_availability", {}))
                evidence[f"{region}:{mode}"] = now.isoformat()
                metadata["_discovery_availability"] = evidence
                title.metadata_raw = metadata
                if str(title.id) not in served and eligible(title, excluded, preferred_type, genre, region, mode, as_of, now):
                    pending[str(title.id)] = title
    # Private sources are read in the viewer's scope. They still must pass
    # exactly the same genre/media/region/exclusion rules as catalog titles.
    social, teams = private_sources(db, user_id, excluded)
    source_reasons = {}
    source_ids = {item["title"].id for item in social + teams}
    # Current provider evidence can qualify a team/followed title even when it
    # was not in this page of the TMDB popularity feed.
    source_availability = {}
    if source_ids:
        for offer in db.scalars(select(ContentAvailability).where(
            ContentAvailability.content_title_id.in_(source_ids),
            ContentAvailability.region_code == region,
            ContentAvailability.expires_at > now,
            ContentAvailability.monetization_type.in_(["flatrate", "free", "ads"] if mode == "streaming" else ["flatrate", "free", "ads", "rent", "buy"]),
        )).all():
            source_availability[offer.content_title_id] = offer.expires_at

    for source, label in ((social, "Saved by someone you follow"), (teams, "In your Watch Teams")):
        for item in source:
            title = item["title"]
            key = str(title.id)
            expires = source_availability.get(title.id)
            if expires:
                expires = expires.replace(tzinfo=timezone.utc) if expires.tzinfo is None else expires
                meta = dict(title.metadata_raw or {})
                stamps = dict(meta.get("_discovery_availability", {}))
                # Never extend the actual provider cache lifetime.
                stamps[f"{region}:{mode}"] = min(now, expires - timedelta(hours=24)).isoformat()
                title.metadata_raw = {**meta, "_discovery_availability": stamps}
            if key not in served and eligible(title, excluded, preferred_type, genre, region, mode, as_of, now):
                pending[key] = title
                source_reasons.setdefault(key, label)
    scorer = scorer_for_user(db, user_id, pending.values())
    scores = {key: scorer.score(title) for key, title in pending.items()}
    bands = {band: sorted([key for key, t in pending.items() if age_band(t.release_date, as_of) == band],
                         key=lambda key: (-(scores[key].score if scores[key].score is not None else 50.), key)) for band in range(4)}
    for band, keys in bands.items():
        related = [key for key in keys if key in source_reasons]
        if related:
            keys.remove(related[0])
            keys.insert(0, related[0])
    selected, video_cache, checked = [], {}, 0
    counts = list(state["counts"])
    if surface == "preview":
        video_keys = [key for band in range(4) for key in bands[band][:12]]
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {key: pool.submit(_video, pending[key]) for key in video_keys}
            for key, future in futures.items():
                try:
                    video_cache[key] = future.result()
                except (httpx.HTTPError, TmdbConfigurationError):
                    upstream_failure = True
        # Only scanned candidates take part in this page. Unscanned ones
        # stay pending, so a short video page never loses catalog positions.
        bands = {band: [key for key in keys if key in video_cache] for band, keys in bands.items()}
    while len(selected) < limit and any(bands.values()) and checked < 60:
        band = next_band(counts, [i for i in bands if bands[i]])
        key = bands[band].pop(0)
        title = pending[key]
        checked += 1
        if surface == "preview":
            video = video_cache[key]
            if video is None:
                pending.pop(key)
                served.add(key)  # scanned no-video titles are not regenerated
                continue
            video_cache[key] = video
        selected.append(key)
        counts[band] += 1
    # Mutations can have landed while upstream requests were in flight.
    excluded = excluded_title_ids(db, user_id)
    items = []
    from app.api.routes.titles import _to_title_response
    for key in selected:
        title = pending.pop(key)
        if title.id in excluded:
            counts[age_band(title.release_date, as_of)] -= 1
            continue
        served.add(key)
        compatibility = scores[key]
        matching = compatibility.score is not None
        reason = source_reasons.get(key) or (compatibility.explanation if matching else "Available to stream in your region · learning your taste")
        if surface == "preview":
            items.append({"feed_item_id": f"pfi-{title.id}", "title_id": str(title.id), "tmdb_id": title.tmdb_id,
                "media_type": title.content_type, "title": title.title, "year": title.release_date.year,
                "poster_url": title.poster_url, "backdrop_url": title.backdrop_url, "overview": title.overview,
                "video": video_cache[key], "scenedna": compatibility.model_dump(mode="json"), "reason": {"type": "signal_match" if matching else "regional_streaming", "label": reason}})
        else:
            dto = _to_title_response(title)
            dto.scenedna = compatibility
            items.append({"title": dto.model_dump(mode="json"), "reason": reason,
                "reason_type": "signal_match" if matching else "regional_streaming", "seed_title_id": None})
    more = bool(pending) or any(not source["done"] for source in state["sources"].values())
    if upstream_failure and not items:
        db.rollback()
        raise HTTPException(status_code=503, detail="Couldn't load streaming picks right now. Please retry with the same filters.")
    session.version += 1
    cap = any(source["cap"] for source in state["sources"].values())
    response = {"session_id": str(session.id), "items": items,
        "next_cursor": f"{session.id}:{session.version}" if more else None,
        "resume_cursor": f"{session.id}:{session.version}",
        "has_more": more, "status": "ready" if items else "pending" if more else "exhausted",
        "exhausted_reason": None if more else "retrieval_limit" if cap else "available_catalog_exhausted",
        "filter_fingerprint": fp, "algorithm_version": ALGORITHM,
        "state_version": hashlib.sha256("|".join(sorted(str(x) for x in excluded)).encode()).hexdigest()[:16],
        "release_age_counts": counts,
        "supply_shortfall_bands": [i for i in range(4) if not bands[i] and not any(
            not source["done"] for key, source in state["sources"].items() if key.endswith(f":{i}"))],
    }
    if surface == "preview":
        known = state.get("resume_videos", {})
        known.update({str(key):value for key,value in video_cache.items() if value})
        state["resume_videos"] = dict(list(known.items())[-200:])
    state.update(pending=list(pending), served=sorted(served), counts=counts)
    session.state, session.last_response = state, response
    db.commit()
    return response
