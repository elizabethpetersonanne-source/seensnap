"""Oct-18 build brief §5: canonical user-title transition service.

One transactional entry point for every mutation to a user's title
relationship. The §5 matrix (abbreviated here):

    Save               → add to Next Watch; leave watched/rating alone
    Remove Save        → remove from Next Watch only
    Mark Watched       → set watched; remove from Next Watch
    Rate 1-10          → set watched + remove Next Watch + update
                         rating atomically. Taste signal updates
                         downstream; initial algorithmic rank
                         eligibility is implicit via watched state.
    Change rating      → update rating. Reconsider automatic rank
                         ONLY if the title has never been manually
                         positioned (RankedFavorite row origin).
    Remove rating      → remove rating. Preserve watched + any
                         favorite/list state. Remove ranked entry if
                         its origin was 'rating' and no manual move
                         has happened.
    Undo Watched       → clear watched. If a rating or auto-rank
                         depends on it, caller must confirm and this
                         service clears those dependent values
                         atomically.
    Favorite / unfavorite  → independent Favorite boolean; no
                             implicit social Like or public post.

Returns a canonical response projection (TitleStateSnapshot) so the
mobile client can reconcile every surface with one write.

This service does NOT:
  - Publish anything to the public feed. Explicit publication is a
    separate /me/activity/publish call.
  - Mutate another user's data.
  - Automatically re-rank. Manual rank is sacred per §5.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import Rating, RankedFavorite, TitleWatchStatus, Watchlist, WatchlistItem


# My Next Watch is a canonical watchlist per Sep-22 brief §7. We find
# or create it on demand so transitions are robust.
_NEXT_WATCH_NAME = "My Next Watch"


@dataclass
class TitleStateSnapshot:
    """Canonical response for every title mutation. Clients
    reconcile all surfaces off this. Field names mirror the mobile
    RatingSnapshot type with additional fields the full state carries."""
    title_id: UUID
    saved: bool              # in Next Watch
    watched: bool
    rating: int | None       # 1-10 integer; None = unrated
    favorite: bool           # independent, not implied by rating/save
    ranked_position: int | None
    rank_origin: str | None  # 'manual' | 'rating' | None
    version: int             # monotonic — bumps on each successful mutation
    updated_at: datetime


class TitleStateError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _get_or_create_next_watch(db: Session, user_id: UUID) -> Watchlist:
    wl = db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == user_id,
            Watchlist.name == _NEXT_WATCH_NAME,
        )
    )
    if wl is None:
        wl = Watchlist(
            owner_user_id=user_id,
            name=_NEXT_WATCH_NAME,
            description="Titles you want to watch next.",
            is_default=False,
            is_system_list=True,
        )
        db.add(wl)
        db.flush()
    return wl


def _snapshot(db: Session, user_id: UUID, title_id: UUID) -> TitleStateSnapshot:
    # Watched + rating
    rating = db.scalar(select(Rating).where(
        Rating.user_id == user_id,
        Rating.content_title_id == title_id,
    ))
    ws = db.scalar(select(TitleWatchStatus).where(
        TitleWatchStatus.user_id == user_id,
        TitleWatchStatus.content_title_id == title_id,
    ))
    watched = (rating is not None and (rating.watched_state == "watched")) or (
        ws is not None and ws.watched_state == "watched"
    )
    score_int: int | None = None
    if rating is not None and rating.score is not None:
        score_int = int(round(float(rating.score)))

    # Saved — anywhere in Next Watch
    nw = db.scalar(select(Watchlist).where(
        Watchlist.owner_user_id == user_id,
        Watchlist.name == _NEXT_WATCH_NAME,
    ))
    saved = False
    if nw is not None:
        saved = db.scalar(select(WatchlistItem.id).where(
            WatchlistItem.watchlist_id == nw.id,
            WatchlistItem.content_title_id == title_id,
        )) is not None

    # Rank
    rank_row = db.scalar(select(RankedFavorite).where(
        RankedFavorite.user_id == user_id,
        RankedFavorite.content_title_id == title_id,
    ))
    ranked_position = rank_row.position if rank_row is not None else None
    # Rank origin lives in rank_row.payload — not a column yet; conservatively
    # treat all existing rows as manual so no later automatic rebuild can
    # silently reorder them. Future migration can add an explicit `origin`
    # column.
    rank_origin: str | None = "manual" if rank_row is not None else None

    # Favorite — currently piggybacks on Watchlist name 'Favorites' per
    # existing shelves. Independent of save/rating.
    fav = db.scalar(select(Watchlist).where(
        Watchlist.owner_user_id == user_id,
        Watchlist.name == "Favorites",
    ))
    favorite = False
    if fav is not None:
        favorite = db.scalar(select(WatchlistItem.id).where(
            WatchlistItem.watchlist_id == fav.id,
            WatchlistItem.content_title_id == title_id,
        )) is not None

    updated_at = rating.updated_at if rating else (
        ws.updated_at if ws else datetime.now(timezone.utc)
    )
    version = rating.version if rating is not None else 0
    return TitleStateSnapshot(
        title_id=title_id,
        saved=saved,
        watched=watched,
        rating=score_int,
        favorite=favorite,
        ranked_position=ranked_position,
        rank_origin=rank_origin,
        version=version,
        updated_at=updated_at,
    )


def save_title(db: Session, user_id: UUID, title_id: UUID) -> TitleStateSnapshot:
    """Save → add to Next Watch; leaves watched/rating/favorite alone.
    If the user had explicitly saved a previously-watched title, we
    keep both — rewatch intent is independent of past watching."""
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise TitleStateError("title_not_found", "Title not found")
    wl = _get_or_create_next_watch(db, user_id)
    existing = db.scalar(select(WatchlistItem).where(
        WatchlistItem.watchlist_id == wl.id,
        WatchlistItem.content_title_id == title_id,
    ))
    if existing is None:
        db.add(WatchlistItem(
            watchlist_id=wl.id,
            content_title_id=title_id,
            added_via="save_title",
        ))
    db.commit()
    return _snapshot(db, user_id, title_id)


def unsave_title(db: Session, user_id: UUID, title_id: UUID) -> TitleStateSnapshot:
    """Remove from Next Watch only. Does NOT clear watched/rating/favorite."""
    wl = db.scalar(select(Watchlist).where(
        Watchlist.owner_user_id == user_id,
        Watchlist.name == _NEXT_WATCH_NAME,
    ))
    if wl is not None:
        db.execute(
            WatchlistItem.__table__.delete().where(
                WatchlistItem.watchlist_id == wl.id,
                WatchlistItem.content_title_id == title_id,
            )
        )
        db.commit()
    return _snapshot(db, user_id, title_id)


def mark_watched(db: Session, user_id: UUID, title_id: UUID) -> TitleStateSnapshot:
    """Set watched; remove from Next Watch. Rating optional."""
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise TitleStateError("title_not_found", "Title not found")

    rating = db.scalar(select(Rating).where(
        Rating.user_id == user_id,
        Rating.content_title_id == title_id,
    ))
    if rating is not None:
        rating.watched_state = "watched"
        rating.updated_at = datetime.now(timezone.utc)
        rating.version += 1
    else:
        ws = db.scalar(select(TitleWatchStatus).where(
            TitleWatchStatus.user_id == user_id,
            TitleWatchStatus.content_title_id == title_id,
        ))
        if ws is None:
            db.add(TitleWatchStatus(
                id=uuid4(),
                user_id=user_id,
                content_title_id=title_id,
                watched_state="watched",
            ))
        else:
            ws.watched_state = "watched"
            ws.updated_at = datetime.now(timezone.utc)

    # Remove from Next Watch — Watched supersedes Want To Watch intent
    # unless the user has explicitly re-saved after watching.
    wl = db.scalar(select(Watchlist).where(
        Watchlist.owner_user_id == user_id,
        Watchlist.name == _NEXT_WATCH_NAME,
    ))
    if wl is not None:
        db.execute(
            WatchlistItem.__table__.delete().where(
                WatchlistItem.watchlist_id == wl.id,
                WatchlistItem.content_title_id == title_id,
            )
        )
    db.commit()
    return _snapshot(db, user_id, title_id)


def rate_title(
    db: Session,
    user_id: UUID,
    title_id: UUID,
    score: int,
    *,
    expected_version: int | None = None,
) -> TitleStateSnapshot:
    """Rate 1-10. Sets watched, removes from Next Watch, updates rating
    atomically. Optimistic concurrency via expected_version."""
    if not (1 <= score <= 10):
        raise TitleStateError("invalid_score", "score must be 1-10")
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise TitleStateError("title_not_found", "Title not found")

    existing = db.scalar(select(Rating).where(
        Rating.user_id == user_id,
        Rating.content_title_id == title_id,
    ))
    if existing is not None:
        if expected_version is not None and expected_version != existing.version:
            raise TitleStateError("version_conflict", "stale version")
        existing.score = Decimal(str(score))
        existing.watched_state = "watched"
        existing.version += 1
        existing.updated_at = datetime.now(timezone.utc)
    else:
        existing = Rating(
            id=uuid4(),
            user_id=user_id,
            content_title_id=title_id,
            score=Decimal(str(score)),
            watched_state="watched",
            version=1,
        )
        db.add(existing)

    # Clean up TitleWatchStatus — the Rating is now the authoritative source.
    db.execute(
        TitleWatchStatus.__table__.delete().where(
            TitleWatchStatus.user_id == user_id,
            TitleWatchStatus.content_title_id == title_id,
        )
    )
    # Remove from Next Watch.
    wl = db.scalar(select(Watchlist).where(
        Watchlist.owner_user_id == user_id,
        Watchlist.name == _NEXT_WATCH_NAME,
    ))
    if wl is not None:
        db.execute(
            WatchlistItem.__table__.delete().where(
                WatchlistItem.watchlist_id == wl.id,
                WatchlistItem.content_title_id == title_id,
            )
        )
    db.commit()
    return _snapshot(db, user_id, title_id)


def clear_rating(db: Session, user_id: UUID, title_id: UUID) -> TitleStateSnapshot:
    """Remove rating. Preserves watched (as a Watched TitleWatchStatus
    row) and all independent favorite/list state. Removes ranked entry
    if its origin was derived from the rating (not yet tracked by a
    column — conservative: existing ranked rows are treated as manual
    and preserved)."""
    rating = db.scalar(select(Rating).where(
        Rating.user_id == user_id,
        Rating.content_title_id == title_id,
    ))
    if rating is None:
        return _snapshot(db, user_id, title_id)
    # Preserve Watched state by creating a TitleWatchStatus row if there
    # isn't one; delete the Rating row.
    ws = db.scalar(select(TitleWatchStatus).where(
        TitleWatchStatus.user_id == user_id,
        TitleWatchStatus.content_title_id == title_id,
    ))
    if ws is None:
        db.add(TitleWatchStatus(
            id=uuid4(),
            user_id=user_id,
            content_title_id=title_id,
            watched_state="watched",
        ))
    db.delete(rating)
    db.commit()
    return _snapshot(db, user_id, title_id)
