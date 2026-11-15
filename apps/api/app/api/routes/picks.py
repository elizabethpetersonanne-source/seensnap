"""Oct-18 UI/UX rebuild: My Picks collections endpoint.

Serves the five categories rendered by the My Picks screen in one call:
  - ranked_favorites   (from RankedFavorite)
  - my_next_watch      (from the default "Next Watch" watchlist)
  - favorites          (titles the user rated 8 or higher)
  - watched            (titles with watched_state='watched')
  - my_lists           (meta + preview posters for each user list)

Returning them together saves five round-trips when the user opens
My Picks and keeps the client simple — one fetch, five renderable
collections.
"""

from __future__ import annotations
from uuid import UUID


from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select, and_, or_

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import (
    RankedFavorite,
    Rating,
    TitleWatchStatus,
    Watchlist,
    WatchlistItem,
)


router = APIRouter()


class PickTitle(BaseModel):
    id: str
    tmdb_id: int
    title: str
    poster_url: str | None
    backdrop_url: str | None
    year: int | None
    media_type: str
    personal_score: int | None = None
    rank_label: str | None = None
    context_label: str | None = None


class PickList(BaseModel):
    id: str
    name: str
    description: str | None
    is_default: bool
    titles: list[PickTitle]
    total_count: int = 0
    is_previous_collection: bool = False


class PicksCollections(BaseModel):
    ranked_favorites: list[PickTitle]
    my_next_watch: list[PickTitle]
    favorites: list[PickTitle]
    watched: list[PickTitle]
    my_lists: list[PickList]
    # Oct-27 spec PICKS-01: display counts must agree with the eligible
    # collection, not just the loaded page. Expose the real count so
    # the client can show "N titles" accurately.
    ranked_favorites_count: int = 0
    # Oct-27 follow-up: titles the user has rated but hasn't placed in
    # the Ranked Favorites order yet. Owner-only visibility.
    rated_unplaced_count: int = 0
    my_next_watch_count: int = 0
    favorites_count: int = 0
    watched_count: int = 0


def _title_to_pick(
    t: ContentTitle, score: int | None = None, rank: int | None = None, context: str | None = None
) -> PickTitle:
    return PickTitle(
        id=str(t.id),
        tmdb_id=t.tmdb_id,
        title=t.title,
        poster_url=t.poster_url,
        backdrop_url=t.backdrop_url,
        year=t.release_date.year if t.release_date else None,
        media_type=t.content_type,
        personal_score=score,
        rank_label=f"#{rank}" if rank is not None else None,
        context_label=context,
    )


class PicksPage(BaseModel):
    items: list[PickTitle]
    total: int
    offset: int
    has_more: bool


def _section_query(uid, category):
    rating_join = and_(Rating.content_title_id == ContentTitle.id, Rating.user_id == uid)
    if category == "ranked_favorites":
        return (
            select(ContentTitle, Rating.score, RankedFavorite.position)
            .join(RankedFavorite, RankedFavorite.content_title_id == ContentTitle.id)
            .outerjoin(Rating, rating_join)
            .where(RankedFavorite.user_id == uid)
            .order_by(RankedFavorite.position)
        )
    query = select(ContentTitle, Rating.score).outerjoin(Rating, rating_join)
    if category == "my_next_watch":
        query = (
            query.join(WatchlistItem, WatchlistItem.content_title_id == ContentTitle.id)
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .where(Watchlist.owner_user_id == uid, Watchlist.system_role == "next_watch")
            .order_by(WatchlistItem.created_at.desc(), ContentTitle.id)
        )
    elif category == "favorites":
        query = query.where(Rating.score >= 8).order_by(
            Rating.score.desc(), Rating.updated_at.desc(), ContentTitle.id
        )
    elif category == "watched":
        query = (
            query.outerjoin(
                TitleWatchStatus,
                and_(
                    TitleWatchStatus.content_title_id == ContentTitle.id,
                    TitleWatchStatus.user_id == uid,
                ),
            )
            .where(
                or_(Rating.watched_state == "watched", TitleWatchStatus.watched_state == "watched")
            )
            .order_by(
                func.coalesce(Rating.updated_at, TitleWatchStatus.updated_at).desc(),
                ContentTitle.id,
            )
        )
    else:
        raise HTTPException(404, detail="Collection not found")
    return query


def _section_page(db, uid, category, limit, offset):
    query = _section_query(uid, category)
    total = int(db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0)
    rows = db.execute(query.offset(offset).limit(limit)).all()
    items = [
        _title_to_pick(
            row[0],
            score=int(round(float(row[1]))) if row[1] is not None else None,
            rank=row[2] if category == "ranked_favorites" else None,
        )
        for row in rows
    ]
    return PicksPage(items=items, total=total, offset=offset, has_more=offset + len(items) < total)


@router.get("/collections/{category}", response_model=PicksPage)
def get_collection_page(
    category: str,
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return _section_page(db, current_user.id, category, limit, offset)


@router.get("/collections", response_model=PicksCollections)
def get_my_picks_collections(current_user: CurrentUser, db: DbSession) -> PicksCollections:
    uid = current_user.id
    from app.services.watchlists import ensure_next_watch_list
    ensure_next_watch_list(db, uid)
    pages = {
        key: _section_page(db, uid, key, 100, 0)
        for key in ("ranked_favorites", "my_next_watch", "favorites", "watched")
    }
    # Count across the full collection, never just the displayed page.
    ranked_ids = select(RankedFavorite.content_title_id).where(RankedFavorite.user_id == uid)
    rated_unplaced_count = int(
        db.scalar(
            select(func.count())
            .select_from(Rating)
            .where(Rating.user_id == uid, Rating.content_title_id.not_in(ranked_ids))
        )
        or 0
    )
    lists = db.scalars(
        select(Watchlist)
        .where(Watchlist.owner_user_id == uid, or_(Watchlist.system_role.is_(None), Watchlist.system_role != "next_watch"))
        .order_by(Watchlist.updated_at.desc())
    ).all()
    my_lists = []
    for wl in lists:
        titles = db.scalars(
            select(ContentTitle)
            .join(WatchlistItem, WatchlistItem.content_title_id == ContentTitle.id)
            .where(WatchlistItem.watchlist_id == wl.id)
            .order_by(WatchlistItem.created_at.desc(), ContentTitle.id)
            .limit(20)
        ).all()
        total = int(
            db.scalar(
                select(func.count())
                .select_from(WatchlistItem)
                .where(WatchlistItem.watchlist_id == wl.id)
            )
            or 0
        )
        my_lists.append(
            PickList(
                id=str(wl.id),
                name=wl.name,
                description=wl.description,
                is_default=bool(wl.is_default),
                titles=[_title_to_pick(t) for t in titles],
                total_count=total,
                is_previous_collection=wl.merged_into_id is not None,
            )
        )
    return PicksCollections(
        **{key: page.items for key, page in pages.items()},
        **{key + "_count": page.total for key, page in pages.items()},
        my_lists=my_lists,
        rated_unplaced_count=rated_unplaced_count,
    )


@router.get("/lists/{list_id}/titles", response_model=PicksPage)
def get_my_list_titles(list_id: UUID, current_user: CurrentUser, db: DbSession,
    limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0)):
    from app.services.watchlists import get_watchlist
    get_watchlist(db, current_user.id, list_id)
    query = select(ContentTitle).join(WatchlistItem, WatchlistItem.content_title_id == ContentTitle.id)        .where(WatchlistItem.watchlist_id == list_id).order_by(WatchlistItem.created_at.desc(), ContentTitle.id)
    total = int(db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0)
    titles = db.scalars(query.offset(offset).limit(limit)).all()
    return PicksPage(items=[_title_to_pick(t) for t in titles], total=total, offset=offset, has_more=offset+len(titles)<total)
