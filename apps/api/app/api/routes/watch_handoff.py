"""Oct-18 build brief §8 watch handoff endpoints.

  POST   /me/handoffs                         persist a launched handoff
  GET    /me/handoffs/open                    unresolved handoffs ready for prompting
  POST   /me/handoffs/{id}/watched            user confirmed watch
  POST   /me/handoffs/{id}/not-yet            user dismissed
  POST   /me/handoffs/{id}/expire             server-side age-out
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.watch_handoff import WatchHandoff
from app.services.title_state import mark_watched, rate_title


router = APIRouter()


# Oct-18 §8 configured defaults; brief explicitly calls out that 10
# minutes is a STARTING threshold, not a measurement of viewing.
_HANDOFF_PROMPT_MIN_SECONDS = 10 * 60       # Quick returns don't prompt
_HANDOFF_PROMPT_MAX_SECONDS = 48 * 60 * 60  # After 48h we expire the handoff


class LaunchHandoffRequest(BaseModel):
    title_id: UUID
    provider_code: str = Field(min_length=1, max_length=64)
    outbound_url: str | None = Field(default=None, max_length=1024)
    origin_surface: str = Field(default="unspecified", max_length=64)


class HandoffResponse(BaseModel):
    id: UUID
    title_id: UUID
    title: str
    poster_url: str | None
    provider_code: str
    launched_at: datetime
    resolved_action: str | None


@router.post("", response_model=HandoffResponse, status_code=status.HTTP_201_CREATED)
def launch_handoff(
    payload: LaunchHandoffRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> HandoffResponse:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == payload.title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
    row = WatchHandoff(
        id=uuid4(),
        user_id=current_user.id,
        content_title_id=payload.title_id,
        provider_code=payload.provider_code,
        outbound_url=payload.outbound_url,
        origin_surface=payload.origin_surface,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return HandoffResponse(
        id=row.id,
        title_id=title.id,
        title=title.title,
        poster_url=title.poster_url,
        provider_code=row.provider_code,
        launched_at=row.launched_at,
        resolved_action=None,
    )


@router.get("/open", response_model=list[HandoffResponse])
def list_open_handoffs(current_user: CurrentUser, db: DbSession) -> list[HandoffResponse]:
    """Returns ONLY handoffs that are old enough to prompt (brief §8:
    quick returns don't prompt) but not yet expired. The client should
    show the first one as Did you watch?."""
    now = datetime.now(timezone.utc)
    min_launched_before = now - timedelta(seconds=_HANDOFF_PROMPT_MIN_SECONDS)
    max_launched_after = now - timedelta(seconds=_HANDOFF_PROMPT_MAX_SECONDS)
    rows = db.execute(
        select(WatchHandoff, ContentTitle)
        .join(ContentTitle, ContentTitle.id == WatchHandoff.content_title_id)
        .where(
            WatchHandoff.user_id == current_user.id,
            WatchHandoff.resolved_action.is_(None),
            WatchHandoff.launched_at <= min_launched_before,
            WatchHandoff.launched_at > max_launched_after,
        )
        .order_by(WatchHandoff.launched_at.desc())
    ).all()
    return [
        HandoffResponse(
            id=row.id,
            title_id=row.content_title_id,
            title=title.title,
            poster_url=title.poster_url,
            provider_code=row.provider_code,
            launched_at=row.launched_at,
            resolved_action=row.resolved_action,
        )
        for row, title in rows
    ]


class WatchedConfirmRequest(BaseModel):
    rating: int | None = Field(default=None, ge=1, le=10)


@router.post("/{handoff_id}/watched")
def confirm_watched(
    handoff_id: UUID,
    payload: WatchedConfirmRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    row = db.scalar(select(WatchHandoff).where(
        WatchHandoff.id == handoff_id,
        WatchHandoff.user_id == current_user.id,
    ))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Handoff not found")
    if row.resolved_action is None:
        row.resolved_action = "watched"
        row.resolved_at = datetime.now(timezone.utc)
    # Route through the canonical title_state service — never set
    # watched directly on the Rating table from here.
    if payload.rating is not None:
        snap = rate_title(db, current_user.id, row.content_title_id, payload.rating)
    else:
        snap = mark_watched(db, current_user.id, row.content_title_id)
    db.commit()
    return {"ok": True, "state": {
        "watched": snap.watched,
        "rating": snap.rating,
        "saved": snap.saved,
    }}


@router.post("/{handoff_id}/not-yet")
def dismiss_not_yet(handoff_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    row = db.scalar(select(WatchHandoff).where(
        WatchHandoff.id == handoff_id,
        WatchHandoff.user_id == current_user.id,
    ))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Handoff not found")
    if row.resolved_action is None:
        row.resolved_action = "not_yet"
        row.resolved_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True}


@router.post("/{handoff_id}/expire")
def expire_handoff(handoff_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    row = db.scalar(select(WatchHandoff).where(
        WatchHandoff.id == handoff_id,
        WatchHandoff.user_id == current_user.id,
    ))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Handoff not found")
    if row.resolved_action is None:
        row.resolved_action = "expired"
        row.resolved_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True}
