"""Owner-only swipe evidence and durable, reversible influence corrections."""

from datetime import datetime, timezone
from uuid import UUID
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, union_all, exists
from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.taste import SwipeRecord
from app.models.discovery import DiscoveryDecision
from app.models.user import User

router = APIRouter()


class SignalRow(BaseModel):
    id: UUID
    title_id: UUID
    title: str
    poster_url: str | None
    action: str
    action_version: int | None = None
    influence_active: bool
    created_at: datetime


class SignalListResponse(BaseModel):
    items: list[SignalRow]
    next_offset: int | None
    total: int


def _signal_query(user_id):
    def cols(model):
        return [
            model.id,
            model.content_title_id.label("title_id"),
            model.direction.label("action"),
            model.action_version,
            model.influence_disabled_at,
            model.created_at,
        ]

    ledger = select(*cols(DiscoveryDecision)).where(
        DiscoveryDecision.user_id == user_id, DiscoveryDecision.undone_at.is_(None)
    )
    legacy = select(*cols(SwipeRecord)).where(
        SwipeRecord.user_id == user_id,
        ~exists(select(DiscoveryDecision.id).where(DiscoveryDecision.id == SwipeRecord.id)),
    )
    return union_all(ledger, legacy).subquery()


@router.get("/signals", response_model=SignalListResponse)
def list_signals(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    source = _signal_query(current_user.id)
    total = db.scalar(select(func.count()).select_from(source)) or 0
    rows = (
        db.execute(
            select(source, ContentTitle.title, ContentTitle.poster_url)
            .join(ContentTitle, ContentTitle.id == source.c.title_id)
            .order_by(source.c.created_at.desc(), source.c.id.desc())
            .offset(offset)
            .limit(limit)
        )
        .mappings()
        .all()
    )
    items = [
        SignalRow(
            **{k: v for k, v in row.items() if k != "influence_disabled_at"},
            influence_active=row["influence_disabled_at"] is None,
        )
        for row in rows
    ]
    return SignalListResponse(
        items=items,
        total=total,
        next_offset=offset + len(items) if offset + len(items) < total else None,
    )


def _set_influence(db, user_id, swipe_id, enabled):
    db.scalar(select(User.id).where(User.id == user_id).with_for_update())
    record = db.scalar(
        select(SwipeRecord).where(SwipeRecord.id == swipe_id, SwipeRecord.user_id == user_id)
    )
    ledger = db.scalar(
        select(DiscoveryDecision).where(
            DiscoveryDecision.id == swipe_id, DiscoveryDecision.user_id == user_id
        )
    )
    if (record is None and ledger is None) or (ledger and ledger.undone_at is not None):
        raise HTTPException(404, detail="Signal not found")
    value = None if enabled else datetime.now(timezone.utc)
    for row in (record, ledger):
        if row is not None:
            row.influence_disabled_at = value
    db.flush()
    from app.services.user_signals import compute_user_signals
    from app.services.taste import refresh_taste_profile

    compute_user_signals(db, user_id)
    refresh_taste_profile(db, user_id)
    db.commit()
    return {"ok": True, "id": str(swipe_id), "influence_active": enabled}


@router.post("/signals/{swipe_id}/disable")
def disable_signal(swipe_id: UUID, current_user: CurrentUser, db: DbSession):
    return _set_influence(db, current_user.id, swipe_id, False)


@router.post("/signals/{swipe_id}/enable")
def enable_signal(swipe_id: UUID, current_user: CurrentUser, db: DbSession):
    return _set_influence(db, current_user.id, swipe_id, True)
