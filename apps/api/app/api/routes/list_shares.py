"""List sharing — token-based public access to a user's watchlist.

Flow:
  1. Owner POSTs /me/watchlist/lists/{list_id}/share → server mints a token,
     returns a shareable URL (constructed against SHARE_BASE_URL).
  2. Anyone with the token GETs /public/lists/{token} → server returns the
     list contents (no auth required) unless the share was revoked.
  3. Owner DELETEs the share → sets revoked_at, future opens 404.

Never exposes private lists without an active token. Track open_count for
attribution / analytics.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.core.config import settings
from app.models.content import ContentTitle
from app.models.social import ListShare, Watchlist, WatchlistItem
from app.models.user import UserProfile

router = APIRouter()

TOKEN_BYTES = 12  # 96 bits — plenty for share tokens, short URL-safe base64


def _build_share_url(token: str) -> str:
    # `share_base_url` should be set in prod (e.g. https://seensnap.app).
    # For dev, defaults to the API host so URLs are testable.
    base = (getattr(settings, "share_base_url", None) or "https://seensnap.app").rstrip("/")
    return f"{base}/lists/{token}"


class ShareCreatedResponse(BaseModel):
    token: str
    url: str
    visibility: str
    revoked: bool = False
    open_count: int = 0
    created_at: datetime


class PublicListItemResponse(BaseModel):
    title_id: UUID
    tmdb_id: int
    title: str
    content_type: str
    poster_url: str | None = None
    backdrop_url: str | None = None
    year: int | None = None


class PublicListResponse(BaseModel):
    name: str
    description: str | None
    item_count: int
    shared_by_display_name: str | None
    items: list[PublicListItemResponse]


@router.post(
    "/me/watchlist/lists/{list_id}/share",
    response_model=ShareCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_or_reuse_list_share(
    list_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> ShareCreatedResponse:
    """Idempotent — returns the existing active share if one exists, otherwise mints new."""
    watchlist = db.scalar(
        select(Watchlist).where(Watchlist.id == list_id, Watchlist.owner_user_id == current_user.id)
    )
    if watchlist is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")

    existing = db.scalar(
        select(ListShare)
        .where(
            ListShare.watchlist_id == list_id,
            ListShare.created_by_user_id == current_user.id,
            ListShare.revoked_at.is_(None),
        )
        .order_by(ListShare.created_at.desc())
    )
    if existing is not None:
        return ShareCreatedResponse(
            token=existing.token,
            url=_build_share_url(existing.token),
            visibility=existing.visibility,
            revoked=False,
            open_count=existing.open_count,
            created_at=existing.created_at,
        )

    token = secrets.token_urlsafe(TOKEN_BYTES)
    share = ListShare(
        watchlist_id=list_id,
        created_by_user_id=current_user.id,
        token=token,
        visibility="link",
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return ShareCreatedResponse(
        token=share.token,
        url=_build_share_url(share.token),
        visibility=share.visibility,
        revoked=False,
        open_count=0,
        created_at=share.created_at,
    )


class ShareStatusResponse(BaseModel):
    is_public: bool
    token: str | None = None
    url: str | None = None
    open_count: int = 0
    created_at: datetime | None = None


@router.get(
    "/me/watchlist/lists/{list_id}/share",
    response_model=ShareStatusResponse,
)
def get_list_share_status(
    list_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> ShareStatusResponse:
    """Report whether the list currently has an active public share
    without minting a token. Owner-only. Used by the client to render
    PRIVATE / PUBLIC LINK state without side effects."""
    watchlist = db.scalar(
        select(Watchlist).where(Watchlist.id == list_id, Watchlist.owner_user_id == current_user.id)
    )
    if watchlist is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")
    share = db.scalar(
        select(ListShare)
        .where(
            ListShare.watchlist_id == list_id,
            ListShare.created_by_user_id == current_user.id,
            ListShare.revoked_at.is_(None),
        )
        .order_by(ListShare.created_at.desc())
    )
    if share is None:
        return ShareStatusResponse(is_public=False)
    return ShareStatusResponse(
        is_public=True,
        token=share.token,
        url=_build_share_url(share.token),
        open_count=share.open_count,
        created_at=share.created_at,
    )


@router.delete(
    "/me/watchlist/lists/{list_id}/share",
    status_code=status.HTTP_204_NO_CONTENT,
)
def revoke_list_share(
    list_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    """Revoke ALL active shares for this list owned by this user."""
    shares = db.scalars(
        select(ListShare).where(
            ListShare.watchlist_id == list_id,
            ListShare.created_by_user_id == current_user.id,
            ListShare.revoked_at.is_(None),
        )
    ).all()
    if not shares:
        return None
    now = datetime.now(timezone.utc)
    for s in shares:
        s.revoked_at = now
    db.commit()
    return None


@router.get("/public/lists/{token}", response_model=PublicListResponse)
def get_public_shared_list(token: str, db: DbSession) -> PublicListResponse:
    """No-auth public endpoint. Returns list contents for a valid, non-revoked token."""
    share = db.scalar(
        select(ListShare).where(ListShare.token == token, ListShare.revoked_at.is_(None))
    )
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found or revoked")
    watchlist = db.scalar(select(Watchlist).where(Watchlist.id == share.watchlist_id))
    if watchlist is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")

    items = db.execute(
        select(WatchlistItem, ContentTitle)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(WatchlistItem.watchlist_id == watchlist.id)
        .order_by(WatchlistItem.created_at.desc())
    ).all()

    profile = db.scalar(
        select(UserProfile).where(UserProfile.user_id == watchlist.owner_user_id)
    )

    share.open_count = (share.open_count or 0) + 1
    db.commit()

    return PublicListResponse(
        name=watchlist.name,
        description=watchlist.description,
        item_count=len(items),
        shared_by_display_name=profile.display_name if profile else None,
        items=[
            PublicListItemResponse(
                title_id=t.id,
                tmdb_id=t.tmdb_id,
                title=t.title,
                content_type=t.content_type,
                poster_url=t.poster_url,
                backdrop_url=t.backdrop_url,
                year=t.release_date.year if t.release_date else None,
            )
            for _, t in items
        ],
    )
