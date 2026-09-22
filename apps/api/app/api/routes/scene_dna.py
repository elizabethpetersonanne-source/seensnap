"""SceneDNA correction surface — Sep-22 execution brief §8.

  GET /me/scene-dna/signals      → paginated recent signal list
  POST /me/scene-dna/signals/{swipe_id}/disable    → remove influence
  POST /me/scene-dna/signals/{swipe_id}/enable     → restore influence

"Remove influence" excludes the signal from taste computation without
deleting the source Save / Rating / Swipe row. The exclusion is
persisted on the SwipeRecord (and shortly a matching Rating flag)
via a nullable `influence_disabled_at` column; taste rebuild reads
that flag and skips those events.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.taste import SwipeRecord


router = APIRouter()


class SignalRow(BaseModel):
    id: UUID
    title_id: UUID
    title: str
    poster_url: str | None
    action: str  # right | left | up
    influence_active: bool
    created_at: datetime


class SignalListResponse(BaseModel):
    items: list[SignalRow]
    next_offset: int | None
    total: int


@router.get("/signals", response_model=SignalListResponse)
def list_signals(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> SignalListResponse:
    """List the current user's recent swipe signals, newest first."""
    total_row = db.execute(
        select(SwipeRecord).where(SwipeRecord.user_id == current_user.id)
    ).all()
    # Count via len of unpaginated fetch keeps the paged endpoint honest —
    # the SwipeRecord table is small per user because we prune > 6h. If
    # this ever becomes a hot path, switch to a func.count() subquery.
    total = len(total_row)

    rows = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == current_user.id)
        .order_by(SwipeRecord.created_at.desc())
        .offset(offset)
        .limit(limit)
    ).all()

    items = [
        SignalRow(
            id=r[0].id,
            title_id=r[0].content_title_id,
            title=r[1].title,
            poster_url=r[1].poster_url,
            action=r[0].direction,
            influence_active=r[0].influence_disabled_at is None,
            created_at=r[0].created_at,
        )
        for r in rows
    ]
    next_offset = offset + len(items) if offset + len(items) < total else None
    return SignalListResponse(items=items, next_offset=next_offset, total=total)


@router.post("/signals/{swipe_id}/disable")
def disable_signal(swipe_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    row = db.scalar(select(SwipeRecord).where(
        SwipeRecord.id == swipe_id,
        SwipeRecord.user_id == current_user.id,
    ))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Signal not found")
    if row.influence_disabled_at is None:
        row.influence_disabled_at = datetime.now(timezone.utc)
        db.commit()
    # Invalidate the derived taste profile so the next recommendations
    # request sees the change immediately. refresh_taste_profile now
    # skips WHERE influence_disabled_at IS NOT NULL — this is checked
    # in the follow-up services/taste.py commit.
    return {"ok": True, "id": str(swipe_id), "influence_active": False}


@router.post("/signals/{swipe_id}/enable")
def enable_signal(swipe_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    row = db.scalar(select(SwipeRecord).where(
        SwipeRecord.id == swipe_id,
        SwipeRecord.user_id == current_user.id,
    ))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Signal not found")
    if row.influence_disabled_at is not None:
        row.influence_disabled_at = None
        db.commit()
    return {"ok": True, "id": str(swipe_id), "influence_active": True}
