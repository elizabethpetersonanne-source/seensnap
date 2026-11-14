"""Short database locks around Concierge work; never hold user locks over model calls."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import select, func
from app.models.entitlements import ConciergeRequest, ConciergeAllowanceEntry
from app.models.user import User
from app.services.entitlements import reserve_concierge_decision

LEASE_SECONDS = 150


def request_fingerprint(payload):
    data = payload.model_dump(mode="json", exclude={"idempotency_key"})
    if "intent" in data: data["intent"] = data["intent"].strip()
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def claim(db, user_id, payload, *, reserve_allowance=True):
    now = datetime.now(timezone.utc)
    db.scalar(select(User.id).where(User.id == user_id).with_for_update())
    request = db.scalar(select(ConciergeRequest).where(
        ConciergeRequest.user_id == user_id, ConciergeRequest.idempotency_key == payload.idempotency_key,
    ).execution_options(populate_existing=True))
    fingerprint = request_fingerprint(payload)
    if request:
        if request.fingerprint != fingerprint:
            raise HTTPException(409, detail={"code": "request_key_conflict", "message": "Use a new request key for a changed search."})
        if request.state == "completed" or (request.state == "processing" and request.lease_expires_at.replace(tzinfo=timezone.utc) > now):
            db.commit()
            return request, False, None
    from app.core.config import settings
    live = db.scalar(select(func.count()).select_from(ConciergeRequest).where(
        ConciergeRequest.user_id == user_id, ConciergeRequest.state == "processing",
        ConciergeRequest.lease_expires_at > now)) or 0
    recent = db.scalar(select(func.count()).select_from(ConciergeRequest).where(
        ConciergeRequest.user_id == user_id, ConciergeRequest.created_at > now - timedelta(minutes=1))) or 0
    if live >= max(1, settings.concierge_max_concurrent_per_user):
        raise HTTPException(429, detail={"code": "search_busy", "retryable": True,
            "message": "Your previous search is still running. Please try again shortly."}, headers={"Retry-After": "3"})
    if request is None and recent >= max(1, settings.concierge_requests_per_minute):
        raise HTTPException(429, detail={"code": "search_rate_limited", "retryable": True,
            "message": "Please wait a moment before starting another search."}, headers={"Retry-After": "60"})
    # Reservation retries (including a worker lost after commit) must not leak
    # slots or bypass the free-tier cap. The user row serializes cap checks.
    if request:
        entry = db.scalar(select(ConciergeAllowanceEntry).where(
            ConciergeAllowanceEntry.user_id == user_id, ConciergeAllowanceEntry.idempotency_key == payload.idempotency_key,
        ))
        if entry and entry.state == "reserved":
            entry.state = "released"
            db.flush()
    allowance = reserve_concierge_decision(db, user_id, idempotency_key=payload.idempotency_key, now=now) if reserve_allowance else None
    if allowance is not None and not allowance.allowed:
        db.commit()
        return request, False, allowance
    if request is None:
        request = ConciergeRequest(user_id=user_id, idempotency_key=payload.idempotency_key,
            fingerprint=fingerprint, lease_id=uuid4(), lease_expires_at=now + timedelta(seconds=LEASE_SECONDS))
        db.add(request)
    else:
        request.attempt += 1
        request.lease_id = uuid4()
        request.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
        request.state = "processing"
        request.updated_at = now
    db.commit()
    return request, True, allowance


def lock_current(db, user_id, request_id, lease_id):
    db.scalar(select(User.id).where(User.id == user_id).with_for_update())
    request = db.scalar(select(ConciergeRequest).where(
        ConciergeRequest.id == request_id, ConciergeRequest.user_id == user_id,
    ).execution_options(populate_existing=True))
    if request is None or request.lease_id != lease_id or request.state != "processing" or request.lease_expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise HTTPException(409, detail={"code": "request_superseded", "message": "This request has resumed elsewhere. Check its current result."})
    return request
