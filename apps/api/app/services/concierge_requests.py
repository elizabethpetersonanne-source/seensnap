"""Short database locks around Concierge work; never hold user locks over model calls."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import select
from app.models.entitlements import ConciergeRequest, ConciergeAllowanceEntry
from app.models.user import User
from app.services.entitlements import reserve_concierge_decision

LEASE_SECONDS = 150


def request_fingerprint(payload):
    data = payload.model_dump(mode="json", exclude={"idempotency_key"})
    data["intent"] = data["intent"].strip()
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def claim(db, user_id, payload):
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
    # Reservation retries (including a worker lost after commit) must not leak
    # slots or bypass the free-tier cap. The user row serializes cap checks.
    if request:
        entry = db.scalar(select(ConciergeAllowanceEntry).where(
            ConciergeAllowanceEntry.user_id == user_id, ConciergeAllowanceEntry.idempotency_key == payload.idempotency_key,
        ))
        if entry and entry.state == "reserved":
            entry.state = "released"
            db.flush()
    allowance = reserve_concierge_decision(db, user_id, idempotency_key=payload.idempotency_key, now=now)
    if not allowance.allowed:
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
