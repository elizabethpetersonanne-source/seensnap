from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.social import Notification, NotificationOutbox
from app.models.user import Device

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
MAX_ATTEMPTS = 5
BATCH_SIZE = 100


def send_pending_push_notifications(db: Session) -> int:
    """Deliver pending outbox jobs via Expo. Returns number of jobs processed."""
    now = datetime.now(UTC)
    jobs = db.scalars(
        select(NotificationOutbox)
        .where(
            NotificationOutbox.status == "pending",
            (NotificationOutbox.next_attempt_at.is_(None)) | (NotificationOutbox.next_attempt_at <= now),
        )
        .limit(BATCH_SIZE)
    ).all()

    if not jobs:
        return 0

    messages: list[dict] = []
    job_index: list[NotificationOutbox] = []

    for job in jobs:
        device = db.scalar(select(Device).where(Device.id == job.device_id))
        if device is None or not device.expo_push_token or not device.enabled:
            job.status = "skipped"
            continue

        notification = db.scalar(select(Notification).where(Notification.id == job.notification_id))
        if notification is None:
            job.status = "skipped"
            continue

        messages.append({
            "to": device.expo_push_token,
            "title": notification.title,
            "body": notification.body,
            "data": {
                "notificationId": str(notification.id),
                "type": notification.notification_type,
                "route": notification.route or "",
                "entityType": notification.entity_type or "",
                "entityId": str(notification.entity_id) if notification.entity_id else "",
            },
            "channelId": "default",
            "sound": "default",
        })
        job_index.append(job)

    if not messages:
        db.commit()
        return len(jobs)

    try:
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                EXPO_PUSH_URL,
                json=messages,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
        resp.raise_for_status()
        tickets = resp.json().get("data", [])

        for job, ticket in zip(job_index, tickets):
            if ticket.get("status") == "ok":
                job.status = "sent"
                job.provider_ticket_id = ticket.get("id")
                job.sent_at = datetime.now(UTC)
            elif ticket.get("details", {}).get("error") == "DeviceNotRegistered":
                job.status = "failed"
                job.last_error = "DeviceNotRegistered"
                _deactivate_device(db, job.device_id)
            else:
                _schedule_retry(job, str(ticket.get("details", {}).get("error", "unknown")))

    except httpx.HTTPError as exc:
        logger.error("Expo push send error: %s", exc)
        for job in job_index:
            _schedule_retry(job, str(exc))

    db.commit()
    return len(jobs)


def check_push_receipts(db: Session) -> int:
    """Fetch Expo push receipts and handle stale tokens. Returns number checked."""
    jobs = db.scalars(
        select(NotificationOutbox)
        .where(
            NotificationOutbox.status == "sent",
            NotificationOutbox.provider_ticket_id.is_not(None),
        )
        .limit(BATCH_SIZE)
    ).all()

    if not jobs:
        return 0

    ticket_ids = [j.provider_ticket_id for j in jobs if j.provider_ticket_id]
    job_by_ticket = {j.provider_ticket_id: j for j in jobs if j.provider_ticket_id}

    try:
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                EXPO_RECEIPTS_URL,
                json={"ids": ticket_ids},
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
        resp.raise_for_status()
        receipts = resp.json().get("data", {})

        for ticket_id, receipt in receipts.items():
            job = job_by_ticket.get(ticket_id)
            if job is None:
                continue
            if receipt.get("status") == "ok":
                job.status = "delivered"
            elif receipt.get("details", {}).get("error") == "DeviceNotRegistered":
                job.status = "failed"
                job.last_error = "DeviceNotRegistered"
                _deactivate_device(db, job.device_id)
            else:
                job.status = "failed"
                job.last_error = str(receipt.get("details", {}).get("error", "unknown"))

    except httpx.HTTPError as exc:
        logger.error("Expo receipt check error: %s", exc)

    db.commit()
    return len(jobs)


def _deactivate_device(db: Session, device_id) -> None:
    device = db.scalar(select(Device).where(Device.id == device_id))
    if device:
        device.enabled = False


def _schedule_retry(job: NotificationOutbox, error: str) -> None:
    job.attempt_count = (job.attempt_count or 0) + 1
    job.last_error = error[:255]
    if job.attempt_count >= MAX_ATTEMPTS:
        job.status = "failed"
    else:
        backoff_minutes = 2 ** job.attempt_count
        job.next_attempt_at = datetime.now(UTC) + timedelta(minutes=backoff_minutes)
