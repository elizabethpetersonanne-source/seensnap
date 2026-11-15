from __future__ import annotations

import secrets
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.social import ListShare, Watchlist, WatchlistItem


def _ensure_public_share(db: Session, watchlist: Watchlist) -> None:
    """Mint an active public share token for this list if one doesn't
    already exist. Called on every list-create path so lists are
    public-by-default per product decision — a user's lists get a
    shareable URL from the moment they exist, no manual "share" step
    needed. Idempotent (no-op when an active share is present)."""
    existing = db.scalar(
        select(ListShare).where(
            ListShare.watchlist_id == watchlist.id,
            ListShare.created_by_user_id == watchlist.owner_user_id,
            ListShare.revoked_at.is_(None),
        )
    )
    if existing is not None:
        return
    share = ListShare(
        watchlist_id=watchlist.id,
        created_by_user_id=watchlist.owner_user_id,
        token=secrets.token_urlsafe(24),
        visibility="public",
    )
    db.add(share)
    db.flush()

def ensure_default_watchlists(db: Session, user_id: UUID) -> list[Watchlist]:
    ensure_next_watch_list(db, user_id, commit=False)
    # Favorites is a rating-derived section. Preserve historical lists,
    # but do not create another physical Favorites destination for new users.
    db.commit()
    return db.scalars(select(Watchlist).where(Watchlist.owner_user_id == user_id,
        Watchlist.merged_into_id.is_(None)).order_by(Watchlist.is_default.desc(), Watchlist.created_at)).all()


def get_default_watchlist(db: Session, user_id: UUID) -> Watchlist:
    return ensure_next_watch_list(db, user_id)


def get_next_watch_list(db: Session, user_id: UUID) -> Watchlist | None:
    """QUEUE01: canonical Next Watch resolver. Uses system_role, NEVER
    name/is_default inference. Returns the single row with
    system_role='next_watch' or None if the user has none yet.

    Callers that need to CREATE the queue should use the ensure flow
    which creates a private queue when the migration did not find one.
    """
    return db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == user_id,
            Watchlist.system_role == "next_watch",
        )
    )


def ensure_next_watch_list(db: Session, user_id: UUID, *, commit: bool = True) -> Watchlist:
    """Resolve the canonical role, or create it under the owner lock.

    Legacy consolidation belongs to the migration, never a name-based read.
    """
    from app.models.user import User
    db.scalar(select(User.id).where(User.id == user_id).with_for_update())
    existing = get_next_watch_list(db, user_id)
    if existing is not None:
        _reconcile_legacy_queue(db, user_id, existing)
        if commit: db.commit()
        return existing
    # Last resort — create one.
    row = Watchlist(
        owner_user_id=user_id,
        name="My Next Watch",
        description="Titles you want to watch next.",
        is_default=True,
        is_system_list=True,
        system_role="next_watch",
    )
    db.add(row)
    db.flush()
    _reconcile_legacy_queue(db, user_id, row)
    if commit:
        db.commit()
    else:
        db.flush()
    db.refresh(row)
    return row


def _reconcile_legacy_queue(db, user_id, queue):
    """Catch legacy writes during rolling deployment without resurrecting unsaves.

    Each source membership has a durable import receipt. Originals and their
    audiences remain intact. Private source items never enter a public queue.
    """
    from app.models.social import WatchlistQueueImport
    if queue.visibility != "private":
        return
    legacy_names = {"my picks", "want to watch", "next watch", "my next watch"}
    sources = [row for row in db.scalars(select(Watchlist).where(
        Watchlist.owner_user_id == user_id, Watchlist.id != queue.id)).all()
        if row.merged_into_id == queue.id or (
            row.merged_into_id is None and row.is_system_list and row.name.strip().casefold() in legacy_names)]
    if not sources:
        return
    ids = [source.id for source in sources]
    pending = db.scalars(select(WatchlistItem).outerjoin(WatchlistQueueImport,
        WatchlistQueueImport.source_item_id == WatchlistItem.id).where(
        WatchlistItem.watchlist_id.in_(ids), WatchlistQueueImport.source_item_id.is_(None))
        .order_by(WatchlistItem.created_at, WatchlistItem.id)).all()
    existing = set(db.scalars(select(WatchlistItem.content_title_id).where(WatchlistItem.watchlist_id == queue.id)))
    for item in pending:
        if item.content_title_id not in existing:
            db.add(WatchlistItem(watchlist_id=queue.id, content_title_id=item.content_title_id,
                added_via="queue_migration", notes=item.notes, position=item.position, created_at=item.created_at))
            existing.add(item.content_title_id)
        db.add(WatchlistQueueImport(source_item_id=item.id, source_list_id=item.watchlist_id, queue_id=queue.id))
    for source in sources:
        source.merged_into_id = queue.id
        source.is_default = False
        source.is_system_list = False
        source.system_role = None
    if pending:
        from app.services.taste_invalidation import invalidate_taste
        invalidate_taste(db, user_id)
    db.flush()


def list_watchlists(db: Session, user_id: UUID) -> list[Watchlist]:
    return ensure_default_watchlists(db, user_id)


def get_watchlist(db: Session, user_id: UUID, list_id: UUID) -> Watchlist:
    watchlist = db.scalar(select(Watchlist).where(Watchlist.id == list_id, Watchlist.owner_user_id == user_id))
    if watchlist is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")
    return watchlist


_ALLOWED_VISIBILITIES = {"private", "followers", "public"}


def create_watchlist(
    db: Session,
    user_id: UUID,
    *,
    name: str,
    description: str | None,
    visibility: str = "private",
) -> Watchlist:
    clean_name = name.strip()
    if len(clean_name) < 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="List name must be at least 2 characters")
    if visibility not in _ALLOWED_VISIBILITIES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown visibility: {visibility}")
    duplicate = db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == user_id,
            func.lower(Watchlist.name) == clean_name.lower(),
        )
    )
    if duplicate is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="List with this name already exists")
    watchlist = Watchlist(
        owner_user_id=user_id,
        name=clean_name,
        description=description.strip() if description else None,
        is_default=False,
        is_system_list=False,
        visibility=visibility,
    )
    db.add(watchlist)
    db.flush()
    db.commit()
    db.refresh(watchlist)
    return watchlist


def update_watchlist(
    db: Session,
    watchlist: Watchlist,
    *,
    name: str | None,
    description: str | None,
    visibility: str | None = None,
) -> Watchlist:
    if name is not None:
        clean_name = name.strip()
        if len(clean_name) < 2:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="List name must be at least 2 characters")
        if watchlist.system_role == "next_watch" and clean_name != watchlist.name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="My Next Watch keeps its name so it is easy to find")
        watchlist.name = clean_name
    if description is not None:
        watchlist.description = description.strip() if description.strip() else None
    if visibility is not None:
        if visibility not in _ALLOWED_VISIBILITIES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown visibility: {visibility}")
        if visibility != watchlist.visibility and visibility != "public":
            # Old public URLs must not revive if the owner later republishes.
            for share in db.scalars(select(ListShare).where(
                ListShare.watchlist_id == watchlist.id, ListShare.revoked_at.is_(None),
            )).all():
                share.revoked_at = datetime.now(UTC)
        watchlist.visibility = visibility
    watchlist.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(watchlist)
    return watchlist


def delete_watchlist(db: Session, watchlist: Watchlist) -> None:
    if watchlist.system_role in {"next_watch", "favorites"} or watchlist.is_system_list:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This built-in collection cannot be deleted; you can remove its titles")
    from app.models.social import ListSave
    db.query(ListShare).filter(ListShare.watchlist_id == watchlist.id).delete(synchronize_session=False)
    db.query(ListSave).filter(ListSave.watchlist_id == watchlist.id).delete(synchronize_session=False)
    db.query(WatchlistItem).filter(WatchlistItem.watchlist_id == watchlist.id).delete(synchronize_session=False)
    db.delete(watchlist)
    from app.services.taste_invalidation import invalidate_taste
    invalidate_taste(db, watchlist.owner_user_id)
    db.commit()

