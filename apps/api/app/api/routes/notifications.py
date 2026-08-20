from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Query, Response, status
from sqlalchemy import func, select, update

from app.api.dependencies import CurrentUser, DbSession
from app.db.session import SessionLocal
from app.models.social import Notification, NotificationPreference
from app.schemas.notification import (
    NotificationListResponse,
    NotificationPreferenceResponse,
    NotificationPreferenceUpdateRequest,
    NotificationResponse,
)
from app.services.push_delivery import send_pending_push_notifications

router = APIRouter()


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(default=None),
) -> NotificationListResponse:
    query = (
        select(Notification)
        .where(
            Notification.user_id == current_user.id,
            Notification.is_demo.is_(False),
        )
        .order_by(Notification.created_at.desc())
    )

    if cursor is not None:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
            query = query.where(Notification.created_at < cursor_dt)
        except ValueError:
            pass

    query = query.limit(limit + 1)
    rows = db.scalars(query).all()

    has_more = len(rows) > limit
    items = rows[:limit]

    unread_count = db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
            Notification.is_demo.is_(False),
        )
    ) or 0

    next_cursor = items[-1].created_at.isoformat() if has_more and items else None

    return NotificationListResponse(
        items=[_to_response(n) for n in items],
        unread_count=unread_count,
        next_cursor=next_cursor,
    )


@router.post("/{notification_id}/read", status_code=status.HTTP_200_OK, response_model=NotificationResponse)
def mark_notification_read(notification_id: UUID, current_user: CurrentUser, db: DbSession) -> NotificationResponse:
    notification = db.scalar(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == current_user.id,
        )
    )
    if notification is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")

    now = datetime.now(UTC)
    if notification.read_at is None:
        notification.read_at = now
    if notification.opened_at is None:
        notification.opened_at = now
    db.commit()
    db.refresh(notification)
    return _to_response(notification)


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
def mark_all_read(current_user: CurrentUser, db: DbSession) -> Response:
    now = datetime.now(UTC)
    db.execute(
        update(Notification)
        .where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=now)
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/preferences", response_model=NotificationPreferenceResponse)
def get_notification_preferences(current_user: CurrentUser, db: DbSession) -> NotificationPreferenceResponse:
    prefs = db.scalar(
        select(NotificationPreference).where(NotificationPreference.user_id == current_user.id)
    )
    if prefs is None:
        return NotificationPreferenceResponse(
            team_activity=True,
            direct_engagement=True,
            recommendations=False,
            availability=False,
            marketing=False,
            push_enabled=True,
        )
    return _prefs_to_response(prefs)


@router.patch("/preferences", response_model=NotificationPreferenceResponse)
def update_notification_preferences(
    payload: NotificationPreferenceUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> NotificationPreferenceResponse:
    prefs = db.scalar(
        select(NotificationPreference).where(NotificationPreference.user_id == current_user.id)
    )
    if prefs is None:
        prefs = NotificationPreference(user_id=current_user.id)
        db.add(prefs)
        db.flush()

    if payload.team_activity is not None:
        prefs.team_activity = payload.team_activity
    if payload.direct_engagement is not None:
        prefs.direct_engagement = payload.direct_engagement
    if payload.recommendations is not None:
        prefs.recommendations = payload.recommendations
    if payload.availability is not None:
        prefs.availability = payload.availability
    if payload.marketing is not None:
        prefs.marketing = payload.marketing
    if payload.push_enabled is not None:
        prefs.push_enabled = payload.push_enabled

    db.commit()
    db.refresh(prefs)
    return _prefs_to_response(prefs)


@router.post("/admin/send-pending", status_code=status.HTTP_204_NO_CONTENT, include_in_schema=False)
def trigger_send_pending(background_tasks: BackgroundTasks) -> Response:
    """Internal endpoint to process outbox. Call from a cron or health-check script."""
    background_tasks.add_task(_deliver_pending)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _deliver_pending() -> None:
    db = SessionLocal()
    try:
        send_pending_push_notifications(db)
    finally:
        db.close()


def _to_response(n: Notification) -> NotificationResponse:
    return NotificationResponse(
        id=n.id,
        notification_type=n.notification_type,
        title=n.title,
        body=n.body,
        actor_user_id=n.actor_user_id,
        entity_type=n.entity_type,
        entity_id=n.entity_id,
        route=n.route,
        read_at=n.read_at,
        opened_at=n.opened_at,
        created_at=n.created_at,
    )


def _prefs_to_response(prefs: NotificationPreference) -> NotificationPreferenceResponse:
    return NotificationPreferenceResponse(
        team_activity=prefs.team_activity,
        direct_engagement=prefs.direct_engagement,
        recommendations=prefs.recommendations,
        availability=prefs.availability,
        marketing=prefs.marketing,
        push_enabled=prefs.push_enabled,
    )
