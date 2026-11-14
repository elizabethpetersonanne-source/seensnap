"""Media-scoped retrieval before candidate limits; one SceneDNA base score."""

from datetime import date
from sqlalchemy import select
from app.models.content import ContentTitle
from app.schemas.content import RecommendationResponse, RecommendationEvidence
from app.services.discovery_decisions import excluded_title_ids
from app.services.title_compatibility import scorer_for_user


def popularity(title):
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    value = meta.get("popularity")
    return float(value) if isinstance(value, (int, float)) and value >= 0 else 0.0


def for_you_recommendations(
    db, user_id, *, preferred_type=None, genre=None, limit=24, offset=0, all_candidates=False
):
    from app.api.routes.titles import _to_title_response
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
    # Media is a retrieval constraint, not a filter over a movie-heavy shortlist.
    pool = db.scalars(query.order_by(ContentTitle.id)).all()
    if genre:
        wanted = canonical_genre("tv" if want == "series" else "movie", genre.strip().casefold())
        pool = [t for t in pool if wanted in {g.casefold() for g in t.genres or []}]
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
    scorer = scorer_for_user(db, user_id, pool)
    scores = {t.id: scorer.score(t) for t in pool}
    pool.sort(
        key=lambda t: (
            -(scores[t.id].score if scores[t.id].score is not None else 50.0),
            -popularity(t),
            str(t.id),
        )
    )
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
