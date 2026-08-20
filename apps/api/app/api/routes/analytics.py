"""Analytics event ingestion.

Deliberately minimal: append-only insert, fire-and-forget from client. If a real
analytics pipeline (Segment/PostHog/Sentry) is wired in later, this endpoint can
mirror-write without breaking the mobile contract.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import OptionalCurrentUser, DbSession
from app.core.limiter import limiter
from app.models.analytics import AnalyticsEvent

router = APIRouter()


class AnalyticsEventCreate(BaseModel):
    event: str = Field(..., min_length=1, max_length=80)
    properties: dict[str, Any] = Field(default_factory=dict)
    platform: str | None = Field(default=None, max_length=16)
    app_build: str | None = Field(default=None, max_length=32)
    session_id: str | None = Field(default=None, max_length=80)
    occurred_at: datetime | None = None


class AnalyticsBatchCreate(BaseModel):
    events: list[AnalyticsEventCreate]


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("120/minute")
def ingest_event(
    request: Request,
    payload: AnalyticsEventCreate,
    current_user: OptionalCurrentUser,
    db: DbSession,
) -> None:
    row = AnalyticsEvent(
        user_id=current_user.id if current_user is not None else None,
        event_name=payload.event,
        properties=payload.properties or {},
        platform=payload.platform,
        app_build=payload.app_build,
        session_id=payload.session_id,
    )
    if payload.occurred_at is not None:
        row.occurred_at = payload.occurred_at
    db.add(row)
    db.commit()


@router.post("/batch", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("60/minute")
def ingest_batch(
    request: Request,
    payload: AnalyticsBatchCreate,
    current_user: OptionalCurrentUser,
    db: DbSession,
) -> None:
    if not payload.events:
        return None
    uid = current_user.id if current_user is not None else None
    rows: list[AnalyticsEvent] = []
    for e in payload.events[:200]:  # bound the batch size
        row = AnalyticsEvent(
            user_id=uid,
            event_name=e.event,
            properties=e.properties or {},
            platform=e.platform,
            app_build=e.app_build,
            session_id=e.session_id,
        )
        if e.occurred_at is not None:
            row.occurred_at = e.occurred_at
        rows.append(row)
    db.add_all(rows)
    db.commit()
