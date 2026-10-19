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

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

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


class PicksCollections(BaseModel):
    ranked_favorites: list[PickTitle]
    my_next_watch: list[PickTitle]
    favorites: list[PickTitle]
    watched: list[PickTitle]
    my_lists: list[PickList]


def _title_to_pick(t: ContentTitle, score: int | None = None, rank: int | None = None, context: str | None = None) -> PickTitle:
    return PickTitle(
        id=str(t.id),
        title=t.title,
        poster_url=t.poster_url,
        backdrop_url=t.backdrop_url,
        year=t.release_date.year if t.release_date else None,
        media_type=t.content_type,
        personal_score=score,
        rank_label=f"#{rank}" if rank is not None else None,
        context_label=context,
    )


@router.get("/collections", response_model=PicksCollections)
def get_my_picks_collections(current_user: CurrentUser, db: DbSession) -> PicksCollections:
    uid = current_user.id

    # ── Ranked favorites — explicit order from RankedFavorite ────────
    ranked_rows = db.scalars(
        select(RankedFavorite).where(RankedFavorite.user_id == uid).order_by(RankedFavorite.position.asc()).limit(100)
    ).all()
    ranked_title_ids = [r.content_title_id for r in ranked_rows]
    ranked_titles_map = {
        t.id: t for t in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(ranked_title_ids))).all()
    } if ranked_title_ids else {}
    ratings_rows = db.scalars(
        select(Rating).where(Rating.user_id == uid, Rating.content_title_id.in_(ranked_title_ids))
    ).all() if ranked_title_ids else []
    rating_lookup = {r.content_title_id: int(round(float(r.score))) for r in ratings_rows}
    ranked_favorites = [
        _title_to_pick(
            ranked_titles_map[r.content_title_id],
            score=rating_lookup.get(r.content_title_id),
            rank=r.position,
        )
        for r in ranked_rows
        if r.content_title_id in ranked_titles_map
    ]

    # ── My Next Watch — default watchlist named "Next Watch" ─────────
    next_watch_list = db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == uid,
            Watchlist.is_default.is_(True),
            Watchlist.name.ilike("next%watch%"),
        )
    )
    next_watch_titles: list[PickTitle] = []
    if next_watch_list is not None:
        rows = db.execute(
            select(WatchlistItem, ContentTitle)
            .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
            .where(WatchlistItem.watchlist_id == next_watch_list.id)
            .order_by(WatchlistItem.created_at.desc())
            .limit(100)
        ).all()
        next_watch_titles = [_title_to_pick(t) for _, t in rows]

    # ── Favorites — titles the user rated 8 or higher ────────────────
    fav_rows = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == uid, Rating.score >= 8)
        .order_by(Rating.score.desc(), Rating.updated_at.desc())
        .limit(100)
    ).all()
    favorites = [_title_to_pick(t, score=int(round(float(r.score)))) for r, t in fav_rows]

    # ── Watched — union of watched status rows + ratings ─────────────
    # Users can mark a title watched without rating it (TitleWatchStatus)
    # OR rate it (which implicitly watches it). Both count.
    watched_from_rating = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == uid, Rating.watched_state == "watched")
        .order_by(Rating.updated_at.desc())
        .limit(100)
    ).all()
    seen_ids: set[UUID] = {t.id for _, t in watched_from_rating}
    watched_titles = [
        _title_to_pick(t, score=int(round(float(r.score))))
        for r, t in watched_from_rating
    ]
    watched_from_status = db.execute(
        select(TitleWatchStatus, ContentTitle)
        .join(ContentTitle, ContentTitle.id == TitleWatchStatus.content_title_id)
        .where(TitleWatchStatus.user_id == uid, TitleWatchStatus.watched_state == "watched")
        .order_by(TitleWatchStatus.updated_at.desc())
        .limit(100)
    ).all()
    for _ws, t in watched_from_status:
        if t.id not in seen_ids:
            watched_titles.append(_title_to_pick(t))
            seen_ids.add(t.id)

    # ── My Lists — all user watchlists with preview posters ──────────
    list_rows = db.scalars(
        select(Watchlist).where(Watchlist.owner_user_id == uid).order_by(Watchlist.updated_at.desc())
    ).all()
    my_lists: list[PickList] = []
    for wl in list_rows:
        # Return the full list so the mobile My Lists tab can show
        # every title in the horizontal continuation strip, not just
        # a 5-poster preview.
        items = db.execute(
            select(WatchlistItem, ContentTitle)
            .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
            .where(WatchlistItem.watchlist_id == wl.id)
            .order_by(WatchlistItem.created_at.desc())
            .limit(200)
        ).all()
        my_lists.append(
            PickList(
                id=str(wl.id),
                name=wl.name,
                description=wl.description,
                is_default=bool(wl.is_default),
                titles=[_title_to_pick(t) for _, t in items],
            )
        )

    return PicksCollections(
        ranked_favorites=ranked_favorites,
        my_next_watch=next_watch_titles,
        favorites=favorites,
        watched=watched_titles,
        my_lists=my_lists,
    )
