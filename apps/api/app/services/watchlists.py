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

DEFAULT_LISTS: tuple[tuple[str, str | None, bool, bool], ...] = (
    ("My Picks", "Your master saved list.", True, True),
    ("Want to Watch", "Future viewing queue.", False, True),
    ("Favorites", "Your personal canon.", False, True),
)


def ensure_default_watchlists(db: Session, user_id: UUID) -> list[Watchlist]:
    existing = db.scalars(select(Watchlist).where(Watchlist.owner_user_id == user_id)).all()
    by_name = {item.name.lower(): item for item in existing}
    changed = False
    for name, description, is_default, is_system in DEFAULT_LISTS:
        current = by_name.get(name.lower())
        if current is None:
            db.add(
                Watchlist(
                    owner_user_id=user_id,
                    name=name,
                    description=description,
                    is_default=is_default,
                    is_system_list=is_system,
                )
            )
            changed = True
            continue
        if is_default and not current.is_default:
            current.is_default = True
            changed = True
        if is_system and not current.is_system_list:
            current.is_system_list = True
            changed = True
        if current.description != description and current.is_system_list:
            current.description = description
            changed = True
    if changed:
        db.commit()
    lists = db.scalars(
        select(Watchlist).where(Watchlist.owner_user_id == user_id).order_by(Watchlist.is_default.desc(), Watchlist.created_at.asc())
    ).all()
    # Oct-18 brief §3 fix 8: lists are PRIVATE by default. No implicit
    # public share creation. The earlier "share-by-default" behavior
    # has been removed — a list only has a public ListShare when the
    # user explicitly publishes it via POST /me/watchlist/lists/{id}/share.
    # Legacy intentionally-public shares already in the database are
    # preserved; nothing is retroactively privatized here.
    return lists


def get_default_watchlist(db: Session, user_id: UUID) -> Watchlist:
    ensure_default_watchlists(db, user_id)
    watchlist = db.scalar(
        select(Watchlist).where(Watchlist.owner_user_id == user_id, Watchlist.is_default.is_(True))
    )
    if watchlist is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Default list missing")
    return watchlist


def get_next_watch_list(db: Session, user_id: UUID) -> Watchlist | None:
    """QUEUE01: canonical Next Watch resolver. Uses system_role, NEVER
    name/is_default inference. Returns the single row with
    system_role='next_watch' or None if the user has none yet.

    Callers that need to CREATE the queue should use the ensure flow
    which stamps system_role on the historical default list.
    """
    return db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == user_id,
            Watchlist.system_role == "next_watch",
        )
    )


def ensure_next_watch_list(db: Session, user_id: UUID) -> Watchlist:
    """QUEUE01: resolve or back-fill the Next Watch system list. If
    the migration already stamped a row we return it; otherwise we
    promote the owner's default (name-matched) list; if neither
    exists we create a new one.
    """
    existing = get_next_watch_list(db, user_id)
    if existing is not None:
        return existing
    # Try the historical default list first.
    candidate = db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == user_id,
            Watchlist.is_default.is_(True),
            Watchlist.name.ilike("next%watch%"),
        )
    )
    if candidate is not None:
        candidate.system_role = "next_watch"
        db.commit()
        db.refresh(candidate)
        return candidate
    # Last resort — create one.
    row = Watchlist(
        owner_user_id=user_id,
        name="Next Watch",
        description="Future viewing queue.",
        is_default=True,
        is_system_list=True,
        system_role="next_watch",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_watchlists(db: Session, user_id: UUID) -> list[Watchlist]:
    ensure_default_watchlists(db, user_id)
    return db.scalars(
        select(Watchlist).where(Watchlist.owner_user_id == user_id).order_by(Watchlist.is_default.desc(), Watchlist.created_at.asc())
    ).all()


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
        if watchlist.is_default and clean_name.lower() != "my picks":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="My Picks cannot be renamed")
        watchlist.name = clean_name
    if description is not None:
        watchlist.description = description.strip() if description.strip() else None
    if visibility is not None:
        if visibility not in _ALLOWED_VISIBILITIES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown visibility: {visibility}")
        watchlist.visibility = visibility
    watchlist.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(watchlist)
    return watchlist


def delete_watchlist(db: Session, watchlist: Watchlist) -> None:
    if watchlist.is_default:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Default My Picks list cannot be deleted")
    db.query(WatchlistItem).filter(WatchlistItem.watchlist_id == watchlist.id).delete(synchronize_session=False)
    db.delete(watchlist)
    db.commit()

