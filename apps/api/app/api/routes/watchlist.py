from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, func, select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import Team, TeamMember, Watchlist, WatchlistItem
from app.schemas.content import TitleResponse
from app.schemas.watchlist import (
    WatchlistAddRequest,
    WatchlistItemResponse,
    WatchlistListCreateRequest,
    WatchlistListSummaryResponse,
    WatchlistListUpdateRequest,
    WatchlistResponse,
)
from app.services.activity import log_team_activity
from app.services.feed import create_feed_event
from app.services.taste import refresh_taste_profile
from app.services.watchlists import (
    create_watchlist,
    delete_watchlist,
    ensure_default_watchlists,
    get_default_watchlist,
    get_watchlist as get_watchlist_record,
    list_watchlists as list_watchlist_records,
    update_watchlist,
)

router = APIRouter()


@router.get("", response_model=WatchlistResponse)
def get_watchlist(current_user: CurrentUser, db: DbSession) -> WatchlistResponse:
    watchlist = get_default_watchlist(db, current_user.id)
    return _watchlist_response(db, watchlist)


@router.get("/lists", response_model=list[WatchlistListSummaryResponse])
def get_watchlist_lists(current_user: CurrentUser, db: DbSession) -> list[WatchlistListSummaryResponse]:
    lists = list_watchlist_records(db, current_user.id)
    if not lists:
        return []
    list_ids = [item.id for item in lists]
    counts = dict(
        db.execute(
            select(WatchlistItem.watchlist_id, func.count(WatchlistItem.id))
            .where(WatchlistItem.watchlist_id.in_(list_ids))
            .group_by(WatchlistItem.watchlist_id)
        ).all()
    )
    previews: dict[UUID, list[str]] = {list_id: [] for list_id in list_ids}
    items = db.scalars(
        select(WatchlistItem)
        .where(WatchlistItem.watchlist_id.in_(list_ids))
        .order_by(WatchlistItem.created_at.desc())
    ).all()
    if items:
        title_ids = {item.content_title_id for item in items}
        titles = {
            title.id: title.poster_url
            for title in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(title_ids))).all()
        }
        for item in items:
            if len(previews[item.watchlist_id]) >= 4:
                continue
            poster = titles.get(item.content_title_id)
            if poster:
                previews[item.watchlist_id].append(poster)
    return [
        WatchlistListSummaryResponse(
            id=list_item.id,
            name=list_item.name,
            description=list_item.description,
            is_default=list_item.is_default,
            is_system_list=list_item.is_system_list,
            title_count=int(counts.get(list_item.id, 0)),
            updated_at=list_item.updated_at,
            preview_posters=previews.get(list_item.id, []),
        )
        for list_item in lists
    ]


@router.get("/title-ids", response_model=list[UUID])
def get_saved_title_ids(current_user: CurrentUser, db: DbSession) -> list[UUID]:
    ensure_default_watchlists(db, current_user.id)
    return db.scalars(
        select(WatchlistItem.content_title_id)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.owner_user_id == current_user.id)
    ).all()


@router.get("/lists/{list_id}", response_model=WatchlistResponse)
def get_watchlist_by_id(list_id: UUID, current_user: CurrentUser, db: DbSession) -> WatchlistResponse:
    ensure_default_watchlists(db, current_user.id)
    watchlist = get_watchlist_record(db, current_user.id, list_id)
    return _watchlist_response(db, watchlist)


@router.post("/lists", response_model=WatchlistResponse, status_code=status.HTTP_201_CREATED)
def create_watchlist_list(
    payload: WatchlistListCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> WatchlistResponse:
    watchlist = create_watchlist(db, current_user.id, name=payload.name, description=payload.description)
    return _watchlist_response(db, watchlist)


@router.patch("/lists/{list_id}", response_model=WatchlistResponse)
def patch_watchlist_list(
    list_id: UUID,
    payload: WatchlistListUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> WatchlistResponse:
    watchlist = get_watchlist_record(db, current_user.id, list_id)
    updated = update_watchlist(db, watchlist, name=payload.name, description=payload.description)
    return _watchlist_response(db, updated)


@router.delete("/lists/{list_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_watchlist_list(list_id: UUID, current_user: CurrentUser, db: DbSession) -> None:
    watchlist = get_watchlist_record(db, current_user.id, list_id)
    delete_watchlist(db, watchlist)
    return None


@router.post("/items", response_model=WatchlistResponse, status_code=status.HTTP_201_CREATED)
def add_watchlist_item(
    payload: WatchlistAddRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> WatchlistResponse:
    watchlist = (
        get_watchlist_record(db, current_user.id, payload.list_id)
        if payload.list_id is not None
        else get_default_watchlist(db, current_user.id)
    )
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == payload.content_title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    existing = db.scalar(
        select(WatchlistItem).where(
            WatchlistItem.watchlist_id == watchlist.id,
            WatchlistItem.content_title_id == payload.content_title_id,
        )
    )
    if existing is None:
        item = WatchlistItem(
            watchlist_id=watchlist.id,
            content_title_id=payload.content_title_id,
            added_via=payload.added_via,
        )
        db.add(item)
        db.flush()
        if payload.share_to_team_id is not None:
            _log_watchlist_to_team(
                db,
                user_id=current_user.id,
                team_id=payload.share_to_team_id,
                title=title,
                list_name=watchlist.name,
                added_via=payload.added_via,
                entity_id=item.id,
            )
        db.commit()
        # Save adds a positive intent signal — refresh SceneDNA immediately.
        try:
            refresh_taste_profile(db, current_user.id)
        except Exception:
            pass  # Non-blocking; profile will refresh on next lazy read.
    return _watchlist_response(db, watchlist)


@router.delete("/items/{item_id}", response_model=WatchlistResponse)
def delete_watchlist_item(item_id: UUID, current_user: CurrentUser, db: DbSession) -> WatchlistResponse:
    ensure_default_watchlists(db, current_user.id)
    item = db.scalar(
        select(WatchlistItem)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(WatchlistItem.id == item_id, Watchlist.owner_user_id == current_user.id)
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watchlist item not found")
    watchlist = db.scalar(select(Watchlist).where(Watchlist.id == item.watchlist_id))
    db.execute(delete(WatchlistItem).where(WatchlistItem.id == item.id))
    db.commit()
    # Removing revokes the prior positive-intent signal — not a strong dislike, but
    # SceneDNA must reflect the change immediately so the taste profile stays dynamic.
    try:
        refresh_taste_profile(db, current_user.id)
    except Exception:
        pass
    if watchlist is None:
        watchlist = get_default_watchlist(db, current_user.id)
    return _watchlist_response(db, watchlist)


@router.delete("/lists/{list_id}/titles/{title_id}", response_model=WatchlistResponse)
def remove_title_from_list(list_id: UUID, title_id: UUID, current_user: CurrentUser, db: DbSession) -> WatchlistResponse:
    watchlist = get_watchlist_record(db, current_user.id, list_id)
    item = db.scalar(
        select(WatchlistItem).where(
            WatchlistItem.watchlist_id == watchlist.id,
            WatchlistItem.content_title_id == title_id,
        )
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not in list")
    db.execute(delete(WatchlistItem).where(WatchlistItem.id == item.id))
    db.commit()
    try:
        refresh_taste_profile(db, current_user.id)
    except Exception:
        pass
    return _watchlist_response(db, watchlist)


def _watchlist_response(db: DbSession, watchlist: Watchlist) -> WatchlistResponse:
    items = db.scalars(
        select(WatchlistItem).where(WatchlistItem.watchlist_id == watchlist.id).order_by(WatchlistItem.created_at.desc())
    ).all()
    titles = {
        title.id: title
        for title in db.scalars(
            select(ContentTitle).where(ContentTitle.id.in_([item.content_title_id for item in items]))
        ).all()
    }
    return WatchlistResponse(
        id=watchlist.id,
        name=watchlist.name,
        description=watchlist.description,
        is_default=watchlist.is_default,
        is_system_list=watchlist.is_system_list,
        items=[
            WatchlistItemResponse(
                id=item.id,
                content_title_id=item.content_title_id,
                added_via=item.added_via,
                created_at=item.created_at,
                title=_title_response(titles[item.content_title_id]),
            )
            for item in items
            if item.content_title_id in titles
        ],
    )


def _log_watchlist_to_team(
    db: DbSession,
    user_id: UUID,
    team_id: UUID,
    title: ContentTitle,
    list_name: str,
    added_via: str,
    entity_id: UUID,
) -> None:
    membership = db.scalar(
        select(TeamMember)
        .join(Team, Team.id == TeamMember.team_id)
        .where(
            TeamMember.team_id == team_id,
            TeamMember.user_id == user_id,
            TeamMember.status == "active",
            Team.archived_at.is_(None),
        )
    )
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of selected Watch Team")
    log_team_activity(
        db,
        team_id=team_id,
        actor_user_id=user_id,
        activity_type="watchlist_item_added",
        content_title_id=title.id,
        entity_id=entity_id,
        payload={
            "title_name": title.title,
            "content_type": title.content_type,
            "list_name": list_name,
            "added_via": added_via,
        },
    )
    create_feed_event(
        db,
        actor_user_id=user_id,
        team_id=team_id,
        content_title_id=title.id,
        event_type="watchlist_item_added",
        source_type="watchlist_item",
        source_id=entity_id,
        payload={
            "title_name": title.title,
            "content_type": title.content_type,
            "list_name": list_name,
            "added_via": added_via,
            "cta": "add_to_watchlist",
        },
    )


def _title_response(title: ContentTitle) -> TitleResponse:
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
    return TitleResponse(
        id=title.id,
        tmdb_id=title.tmdb_id,
        content_type=title.content_type,
        title=title.title,
        original_title=title.original_title,
        overview=title.overview,
        poster_url=title.poster_url,
        backdrop_url=title.backdrop_url,
        genres=title.genres,
        release_date=title.release_date,
        runtime_minutes=title.runtime_minutes,
        season_count=title.season_count,
        tmdb_rating=float(title.tmdb_vote_average) if title.tmdb_vote_average is not None else None,
        language=metadata.get("original_language") if isinstance(metadata, dict) else None,
        director=director,
        top_cast=top_cast,
    )
