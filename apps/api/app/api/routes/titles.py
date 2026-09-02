from datetime import date
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentAvailability, ContentTitle
from app.models.social import Watchlist, WatchlistItem
from app.schemas.content import (
    PersonCreditResponse,
    PersonDetailResponse,
    RecommendationResponse,
    RelatedTitleResponse,
    StreamingAvailabilityResponse,
    StreamingOptionResponse,
    TitleImageResponse,
    TitlePersonResponse,
    TitleResponse,
)
from app.schemas.taste import SwipeRecordCreate, SwipeRecordResponse
from app.services.taste import build_swipe_feedback, get_social_recommendations, record_swipe
from app.services.tmdb import (
    TmdbConfigurationError,
    discover_titles_by_genre,
    fetch_person_details,
    fetch_title_gallery,
    fetch_title_videos,
    list_tmdb_genres,
    fetch_related_titles,
    fetch_trending_titles,
    refresh_streaming_options,
    refresh_title_details,
    search_titles as tmdb_search_titles,
)
from app.services.wikipedia import resolve_wikipedia_metadata

router = APIRouter()


@router.get("/search", response_model=list[TitleResponse])
def search_titles(q: str, db: DbSession) -> list[TitleResponse]:
    if not q.strip():
        return []
    try:
        titles = tmdb_search_titles(db, q)
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return [_to_title_response(title) for title in titles]


@router.get("/genres", response_model=list[str])
def get_genres() -> list[str]:
    try:
        return list_tmdb_genres()
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@router.get("/discover", response_model=list[TitleResponse])
def discover_titles(
    genre: str,
    db: DbSession,
    media_type: str = Query(default="all", pattern="^(all|movie|show)$"),
    limit: int = Query(default=30, ge=6, le=60),
) -> list[TitleResponse]:
    try:
        titles = discover_titles_by_genre(db, genre=genre, media_type=media_type, limit=limit)
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return [_to_title_response(title) for title in titles]


@router.get("/trending", response_model=list[TitleResponse])
def get_trending_titles(
    db: DbSession,
    limit: int = Query(default=20, ge=6, le=40),
) -> list[TitleResponse]:
    try:
        titles = fetch_trending_titles(db, limit=limit)
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return [_to_title_response(title) for title in titles]


@router.get("/calibration-candidates", response_model=list[TitleResponse])
def get_calibration_candidates(
    db: DbSession,
    _current_user: CurrentUser,
) -> list[TitleResponse]:
    """Balanced pool of 50 diverse titles for onboarding taste calibration."""
    import random

    seen: set[UUID] = set()
    pool: list = []

    try:
        trending = fetch_trending_titles(db, limit=20)
        for t in trending:
            if t.id not in seen:
                seen.add(t.id)
                pool.append(t)
    except TmdbConfigurationError:
        pass

    calibration_genres = ["drama", "action", "comedy", "thriller", "animation"]
    for genre in calibration_genres:
        if len(pool) >= 60:
            break
        try:
            batch = discover_titles_by_genre(db, genre=genre, media_type="all", limit=10)
            for t in batch:
                if t.id not in seen:
                    seen.add(t.id)
                    pool.append(t)
        except TmdbConfigurationError:
            continue

    random.shuffle(pool)
    return [_to_title_response(t) for t in pool[:50]]


@router.get("/person/{tmdb_person_id}", response_model=PersonDetailResponse)
def get_person_details(tmdb_person_id: int) -> PersonDetailResponse:
    try:
        data = fetch_person_details(tmdb_person_id)
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="TMDB person lookup failed") from exc

    return PersonDetailResponse(
        tmdb_person_id=data["tmdb_person_id"],
        name=data["name"],
        profile_url=data.get("profile_url"),
        biography=data.get("biography"),
        known_for_department=data.get("known_for_department"),
        birthday=data.get("birthday"),
        place_of_birth=data.get("place_of_birth"),
        credits=[
            PersonCreditResponse(
                tmdb_id=c["tmdb_id"],
                title=c["title"],
                media_type=c["media_type"],
                poster_url=c.get("poster_url"),
                release_date=c.get("release_date"),
                character=c.get("character"),
                job=c.get("job"),
            )
            for c in data.get("credits", [])
        ],
    )


@router.get("/by-tmdb/{media_type}/{tmdb_id}", response_model=TitleResponse)
def get_title_by_tmdb_id(media_type: str, tmdb_id: int, db: DbSession) -> TitleResponse:
    """Look up (or create) a ContentTitle from a TMDB id + media type.
    Used when the client only has a TMDB id (e.g. Person Detail filmography credits).
    Returns the full TitleResponse so the client can open the canonical detail modal."""
    mt = media_type.lower()
    if mt in ("movie", "tv"):
        content_type = "movie" if mt == "movie" else "series"
    elif mt in ("movie", "series"):
        content_type = mt
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="media_type must be movie|series|tv")

    title = db.scalar(select(ContentTitle).where(ContentTitle.tmdb_id == tmdb_id))
    if title is None:
        title = ContentTitle(
            tmdb_id=tmdb_id,
            content_type=content_type,
            title="",
            metadata_raw={},
        )
        db.add(title)
        db.flush()
    try:
        title = refresh_title_details(db, title)
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="TMDB title lookup failed") from exc
    db.commit()

    try:
        gallery = fetch_title_gallery(title, limit=14)
    except TmdbConfigurationError:
        gallery = []
    try:
        related_titles = fetch_related_titles(db, title, limit=10)
    except TmdbConfigurationError:
        related_titles = []
    availability = db.scalars(
        select(ContentAvailability)
        .where(ContentAvailability.content_title_id == title.id)
        .order_by(ContentAvailability.provider_name.asc())
    ).all()
    return _to_title_response(title, None, availability, gallery, related_titles)


@router.get("/{title_id}", response_model=TitleResponse)
def get_title(title_id: UUID, db: DbSession) -> TitleResponse:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    try:
        title = refresh_title_details(db, title)
    except TmdbConfigurationError:
        pass
    try:
        wikipedia_metadata = resolve_wikipedia_metadata(
            title=title.title,
            release_date=title.release_date,
            content_type=title.content_type,
        )
    except httpx.HTTPError:
        wikipedia_metadata = None
    try:
        refresh_streaming_options(db, title)
    except TmdbConfigurationError:
        pass
    try:
        gallery = fetch_title_gallery(title, limit=14)
    except TmdbConfigurationError:
        gallery = []
    try:
        related_titles = fetch_related_titles(db, title, limit=10)
    except TmdbConfigurationError:
        related_titles = []
    availability = db.scalars(
        select(ContentAvailability)
        .where(ContentAvailability.content_title_id == title.id)
        .order_by(ContentAvailability.provider_name.asc())
    ).all()
    return _to_title_response(title, wikipedia_metadata, availability, gallery, related_titles)


@router.get("/{title_id}/videos")
def get_title_videos(title_id: UUID, db: DbSession) -> list[dict]:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
    try:
        return fetch_title_videos(title)
    except TmdbConfigurationError:
        return []
    except httpx.HTTPError:
        return []


@router.get("/{title_id}/streaming-options", response_model=list[StreamingOptionResponse])
def get_streaming_options(title_id: UUID, db: DbSession) -> list[StreamingOptionResponse]:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    try:
        options = refresh_streaming_options(db, title)
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return [_to_streaming_response(option) for option in options]


@router.get("/recommendations/for-me", response_model=list[RecommendationResponse])
def get_my_recommendations(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=24, ge=6, le=60),
    preferred_type: str | None = Query(default=None, pattern="^(movie|show)$"),
    session_id: str | None = Query(default=None, max_length=80),
) -> list[RecommendationResponse]:
    try:
        return get_social_recommendations(
            db,
            current_user.id,
            limit=limit,
            preferred_type=preferred_type,
            session_id=session_id,
        )
    except TmdbConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@router.post("/swipes", response_model=SwipeRecordResponse)
def record_title_swipe(
    payload: SwipeRecordCreate,
    current_user: CurrentUser,
    db: DbSession,
) -> SwipeRecordResponse:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == payload.title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
    try:
        record = record_swipe(
            db,
            current_user.id,
            title_id=payload.title_id,
            direction=payload.direction,
            pause_ms=payload.pause_ms,
            session_id=payload.session_id,
            reason=payload.reason,
            source_surface=payload.source_surface,
            idempotency_key=payload.idempotency_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    feedback = build_swipe_feedback(db, current_user.id, payload.title_id, payload.direction)
    return SwipeRecordResponse(
        title_id=payload.title_id,
        direction=payload.direction,
        updated_at=record.created_at,
        scene_dna_feedback=feedback,
    )


def _to_title_response(
    title: ContentTitle,
    wikipedia_metadata=None,
    availability: list[ContentAvailability] | None = None,
    gallery: list[dict] | None = None,
    related_titles: list[ContentTitle] | None = None,
) -> TitleResponse:
    metadata = title.metadata_raw or {}
    credits = metadata.get("credits", {}) if isinstance(metadata, dict) else {}
    crew = credits.get("crew", []) if isinstance(credits, dict) else []
    cast = credits.get("cast", []) if isinstance(credits, dict) else []
    director = next(
        (
            person.get("name")
            for person in crew
            if isinstance(person, dict) and person.get("job") == "Director" and person.get("name")
        ),
        None,
    )
    top_cast = [
        person.get("name")
        for person in cast
        if isinstance(person, dict) and person.get("name")
    ][:5]

    release_date = title.release_date
    if wikipedia_metadata and wikipedia_metadata.year:
        release_date = release_date or date(wikipedia_metadata.year, 1, 1)

    genres = (
        wikipedia_metadata.genres
        if wikipedia_metadata and wikipedia_metadata.genres
        else title.genres
    )
    # Per spec: TMDB is the canonical overview source. Never silently substitute
    # scraped Wikipedia copy. If TMDB has no overview, the client shows an
    # intentional unavailable state rather than a synthetic description.
    overview = title.overview
    runtime = (
        wikipedia_metadata.runtime_minutes
        if wikipedia_metadata and wikipedia_metadata.runtime_minutes
        else title.runtime_minutes
    )
    seasons = (
        wikipedia_metadata.seasons
        if wikipedia_metadata and wikipedia_metadata.seasons
        else title.season_count
    )
    episodes = wikipedia_metadata.episodes if wikipedia_metadata and wikipedia_metadata.episodes else None
    director_name = (
        wikipedia_metadata.director or wikipedia_metadata.creator
        if wikipedia_metadata
        else director
    ) or director
    cast_names = (wikipedia_metadata.cast if wikipedia_metadata and wikipedia_metadata.cast else top_cast) or []
    language = (
        wikipedia_metadata.language
        if wikipedia_metadata and wikipedia_metadata.language
        else metadata.get("original_language") if isinstance(metadata, dict) else None
    )
    country = wikipedia_metadata.country if wikipedia_metadata and wikipedia_metadata.country else None
    creator = wikipedia_metadata.creator if wikipedia_metadata and wikipedia_metadata.creator else None
    image_url = (
        wikipedia_metadata.image_url
        if wikipedia_metadata and wikipedia_metadata.image_url
        else title.poster_url
    )
    wikipedia_url = wikipedia_metadata.wikipedia_url if wikipedia_metadata else None
    source_label = "wikipedia" if wikipedia_metadata else "tmdb_fallback"
    cast_people = [
        TitlePersonResponse(
            name=person.get("name") or "Unknown",
            role=person.get("character") or "Actor",
            headshot_url=f"https://image.tmdb.org/t/p/w185{person['profile_path']}"
            if person.get("profile_path")
            else None,
            tmdb_person_id=person.get("id") if isinstance(person.get("id"), int) else None,
        )
        for person in cast
        if isinstance(person, dict) and person.get("name")
    ][:8]
    creators_people = []
    creator_roles = ["Creator", "Director", "Writer", "Screenplay", "Executive Producer"]
    seen_creator_keys: set[tuple[str, str]] = set()
    for person in crew:
        if not isinstance(person, dict):
            continue
        role = person.get("job")
        name = person.get("name")
        if role not in creator_roles or not name:
            continue
        key = (str(name), str(role))
        if key in seen_creator_keys:
            continue
        seen_creator_keys.add(key)
        creators_people.append(
            TitlePersonResponse(
                name=str(name),
                role=str(role),
                headshot_url=f"https://image.tmdb.org/t/p/w185{person['profile_path']}"
                if person.get("profile_path")
                else None,
                tmdb_person_id=person.get("id") if isinstance(person.get("id"), int) else None,
            )
        )
        if len(creators_people) >= 4:
            break

    return TitleResponse(
        id=title.id,
        tmdb_id=title.tmdb_id,
        content_type=title.content_type,
        title=title.title,
        original_title=title.original_title,
        overview=overview,
        poster_url=image_url,
        backdrop_url=title.backdrop_url,
        genres=genres,
        release_date=release_date,
        runtime_minutes=runtime,
        season_count=seasons,
        episode_count=episodes,
        tmdb_rating=float(title.tmdb_vote_average) if title.tmdb_vote_average is not None else None,
        language=language,
        country=country,
        creator=creator,
        director=director_name,
        top_cast=cast_names,
        wikipedia_url=wikipedia_url,
        metadata_source=source_label,
        streaming_availability=[
            StreamingAvailabilityResponse(
                service=option.provider_code,
                service_name=option.provider_name,
                app_url=option.deeplink_url,
                web_url=option.web_url,
            )
            for option in (availability or [])
            if option.deeplink_url or option.web_url
        ],
        image_gallery=[
            TitleImageResponse(
                url=str(image.get("url")),
                kind=str(image.get("kind") or "backdrop"),
                width=image.get("width") if isinstance(image.get("width"), int) else None,
                height=image.get("height") if isinstance(image.get("height"), int) else None,
            )
            for image in (
                gallery
                or [
                    {"url": title.backdrop_url, "kind": "backdrop"},
                    {"url": image_url, "kind": "poster"},
                ]
            )
            if image.get("url")
        ],
        cast=cast_people or [TitlePersonResponse(name=name, role="Actor", headshot_url=None) for name in cast_names[:5]],
        creators=creators_people
        or ([TitlePersonResponse(name=director_name, role="Director", headshot_url=None)] if director_name else []),
        related_titles=[
            RelatedTitleResponse(
                id=related.id,
                title=related.title,
                content_type=related.content_type,
                poster_url=related.poster_url,
                release_date=related.release_date,
            )
            for related in (related_titles or [])
            if related.id != title.id
        ],
    )


def _to_streaming_response(option: ContentAvailability) -> StreamingOptionResponse:
    return StreamingOptionResponse(
        provider_code=option.provider_code,
        provider_name=option.provider_name,
        region_code=option.region_code,
        deeplink_url=option.deeplink_url,
        web_url=option.web_url,
        is_connected_priority=option.is_connected_priority,
    )
