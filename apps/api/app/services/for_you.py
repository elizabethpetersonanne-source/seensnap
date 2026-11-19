"""Media-scoped retrieval before candidate limits; one SceneDNA base score."""

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from uuid import UUID
from sqlalchemy import select, cast, String, func, or_
from app.models.content import ContentTitle
from app.models.discovery import DiscoverySession
from app.models.user import User
from app.core.config import settings
from app.core.scenedna_config import SCORE_VERSION
from app.schemas.content import RecommendationResponse, RecommendationEvidence
from app.services.discovery_decisions import excluded_title_ids
from app.services.title_compatibility import scorer_for_user
from app.services import taste_candidates as taste
from app.services.concierge_runtime import request_runtime, ConciergeDeadlineExceeded


def popularity(title):
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    value = meta.get("popularity")
    return float(value) if isinstance(value, (int, float)) and value >= 0 else 0.0


def for_you_recommendations(
    db, user_id, *, preferred_type=None, genre=None, limit=24, offset=0, all_candidates=False
):
    from app.services.tmdb import fetch_popular_titles, TmdbConfigurationError
    from app.services.discovery_feed import canonical_genre
    import httpx

    want = "movie" if preferred_type == "movie" else "series" if preferred_type == "show" else None
    excluded = excluded_title_ids(db, user_id)
    query = select(ContentTitle).where(
        ContentTitle.poster_url.is_not(None),
        ContentTitle.overview.is_not(None),
        ContentTitle.release_date <= date.today(),
    )
    if want:
        query = query.where(ContentTitle.content_type == want)
    if excluded:
        query = query.where(ContentTitle.id.notin_(excluded))
    def genre_clause(name):
        return func.lower(cast(ContentTitle.genres, String)).contains('"' + name.casefold() + '"', autoescape=True)
    if genre:
        wanted = canonical_genre("tv" if want == "series" else "movie", genre.strip().casefold())
        query = query.where(genre_clause(wanted))
    region = taste.region_for(db, user_id)
    version = db.scalar(select(User.taste_version).where(User.id == user_id)) or 0
    fingerprint = "for_you_v2:" + hashlib.sha256(json.dumps(
        [SCORE_VERSION, preferred_type, genre, region, version]
    ).encode()).hexdigest()[:48]
    # Shared by the home rail and See All. IDs only; scores, exclusions and
    # explanations are always read from current owner evidence.
    cached = db.scalar(select(DiscoverySession).where(
        DiscoverySession.user_id == user_id,
        DiscoverySession.fingerprint == fingerprint,
        DiscoverySession.created_at > datetime.now(timezone.utc) - timedelta(minutes=15),
    ).order_by(DiscoverySession.created_at.desc()).limit(1))
    if cached and cached.state.get("candidate_ids"):
        ids = [UUID(key) for key in cached.state.get("candidate_ids", [])]
        pool = list(db.scalars(query.where(ContentTitle.id.in_(ids))))
        return _results(db, user_id, pool, limit, offset, all_candidates)

    preliminary, seeds, negatives, source_state = taste.history(db, user_id, preferred_type)
    # Filter before materialization. Sample release eras so older work cannot
    # be displaced solely by hundreds of newer titles in the local catalog.
    affinities = taste.personal.attribute_affinities(preliminary)
    genres = [name for (dim, name), weight in sorted(affinities.items(), key=lambda item: -item[1])
              if dim == "genres" and weight > 0][:4]
    pool = []
    media_types = [want] if want else ["movie", "series"]
    years = [date(date.today().year - n, 1, 1) for n in (3, 10, 25)]
    eras = [ContentTitle.release_date >= years[0],
            (ContentTitle.release_date < years[0]) & (ContentTitle.release_date >= years[1]),
            (ContentTitle.release_date < years[1]) & (ContentTitle.release_date >= years[2]),
            ContentTitle.release_date < years[2]]
    for media in media_types:
        for era in eras:
            scoped = query.where(ContentTitle.content_type == media, era)
            budget = 200 // len(media_types)
            band = []
            if genres:
                band.extend(db.scalars(scoped.where(or_(*(genre_clause(g) for g in genres)))
                    .order_by(ContentTitle.release_date.desc(), ContentTitle.id).limit(budget // 2)))
            band.extend(db.scalars(scoped.where(ContentTitle.id.notin_([t.id for t in band]))
                .order_by(ContentTitle.release_date.desc(), ContentTitle.id).limit(budget - len(band))))
            pool.extend(band)

    if seeds:
        try:
            with request_runtime("for-you-evidence", seconds=18):
                if settings.tmdb_api_key:
                    taste.personal.enrich_evidence(db, [*seeds, *negatives], region, limit=8)
                preliminary = scorer_for_user(db, user_id, pool)
                related, origins = taste.retrieve_personal(db, preliminary, seeds, source_state,
                    preferred_type=preferred_type, genre=genre, region=region)
                # Apply exactly the same media/genre/release/exclusion rules to new sources.
                related = list(db.scalars(query.where(ContentTitle.id.in_([t.id for t in related]))))
                pool = list({t.id: t for t in [*related, *pool]}.values())
                preliminary = scorer_for_user(db, user_id, pool)
                prospects = taste.inspection_order(pool, origins, preliminary)
                taste.prepare_evidence(db, prospects, seeds=seeds, negatives=negatives, region=region)
        except (ConciergeDeadlineExceeded, TmdbConfigurationError, httpx.HTTPError):
            # Optional network enrichment must not discard confirmed local
            # candidates. They are still ranked by current personal evidence.
            # Do not catch database/validation errors as successful responses.
            pass
    # Return usable local results without serial upstream padding. Only a true
    # cold start waits for one bounded page of the requested TMDB media.
    if not pool:
        try:
            extras = fetch_popular_titles(
                db,
                limit=max(20, limit),
                max_pages=1,
                timeout_seconds=4,
                media_type_filter=preferred_type,
                genre_filter=genre,
                exclude_title_ids=excluded | {t.id for t in pool},
            )
            pool.extend(
                t
                for t in extras
                if t.id not in excluded
                and (not want or t.content_type == want)
                and t.poster_url
                and t.overview
                and t.release_date
                and t.release_date <= date.today()
            )
        except (TmdbConfigurationError, httpx.HTTPError):
            if not pool:
                raise
    pool = list({t.id: t for t in pool}.values())
    # Reuse the single cache record for this surface/filter rather than leave
    # an unbounded trail of warmed pools on every refresh.
    scope = [preferred_type, genre, region]
    old = db.scalars(select(DiscoverySession).where(DiscoverySession.user_id == user_id,
        DiscoverySession.fingerprint.like("for_you_v2:%"))).all()
    for row in old:
        if row.state.get("scope") == scope or row.fingerprint == fingerprint or row.created_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc) - timedelta(days=1):
            db.delete(row)
    db.add(DiscoverySession(user_id=user_id, fingerprint=fingerprint,
        state={"candidate_ids": [str(t.id) for t in pool], "scope": scope}))
    db.commit()
    return _results(db, user_id, pool, limit, offset, all_candidates)


def _results(db, user_id, pool, limit, offset, all_candidates):
    from app.api.routes.titles import _to_title_response
    scorer = scorer_for_user(db, user_id, pool)
    pool, scores = taste.order_personal(pool, scorer)
    if not scorer.evidence:
        pool.sort(key=lambda t: (-popularity(t), str(t.id)))
    items = []
    for title in pool if all_candidates else pool[offset : offset + limit]:
        match = scores[title.id]
        dto = _to_title_response(title)
        dto.scenedna = match
        reason = (
            match.explanation
            if match.score is not None
            else "Popular titles to get you started · learning your taste"
        )
        items.append(
            RecommendationResponse(
                title=dto,
                reason=reason,
                reason_type="SCENEDNA_MATCH" if match.score is not None else "COLD_START",
                evidence=RecommendationEvidence(confidence=match.confidence),
            )
        )
    return items
