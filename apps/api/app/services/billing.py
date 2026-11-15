"""Verified App Store subscription snapshots; the client never grants access.

Webhooks are invalidation signals. Always retrieve the current provider snapshot
under the user's lock, so replayed or delayed events cannot roll access backwards.
Only explicitly configured subscription products are eligible for Premium.
"""
from datetime import datetime, timezone
from uuid import UUID, NAMESPACE_URL, uuid5
import secrets

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.entitlements import EntitlementGrant
from app.models.user import User


def billing_ready() -> bool:
    # Turning new sales off must not stop refunds, restores or data deletion.
    return bool(settings.revenuecat_secret_api_key
                and settings.revenuecat_webhook_token and settings.revenuecat_app_id
                and settings.premium_products())


def require_billing() -> None:
    if not billing_ready():
        raise HTTPException(503, "Purchases are not available yet.")


def verify_webhook(authorization: str | None) -> None:
    require_billing()
    expected = f"Bearer {settings.revenuecat_webhook_token}"
    if not secrets.compare_digest(authorization or "", expected):
        raise HTTPException(401, "Invalid webhook authorization")


def fetch_subscriber(user_id: UUID) -> dict:
    try:
        response = httpx.get(f"https://api.revenuecat.com/v1/subscribers/{user_id}",
            headers={"Authorization": f"Bearer {settings.revenuecat_secret_api_key}"}, timeout=10)
        response.raise_for_status()
        subscriber = response.json()["subscriber"]
        if not isinstance(subscriber, dict) or not isinstance(subscriber.get("subscriptions"), dict):
            raise ValueError("Invalid subscription snapshot")
        return subscriber
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(503, "Could not verify purchases. Please retry; your existing access has not been changed.") from exc


def _date(value) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Invalid date")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("A purchase date must include a timezone")
    return parsed.astimezone(timezone.utc)


def sync_purchases(db: Session, user_id: UUID, *, now: datetime | None = None) -> None:
    require_billing()
    # Serializes purchase/restore/webhook snapshots for the same account in PG.
    user = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if user is None:
        return  # webhook for an account that has been deleted
    now = now or datetime.now(timezone.utc)
    subscriber = fetch_subscriber(user_id)
    # Purchases stay with their original SeenSnap account. The dashboard must
    # use "Keep with original App User ID" as its restore/transfer policy too.
    try:
        original = UUID(subscriber.get("original_app_user_id", ""))
    except (ValueError, TypeError, AttributeError):
        original = None
    if original is not None and original != user_id:
        subscriber = {**subscriber, "subscriptions": {}}
    incoming = []
    sandbox_only_products = set()
    try:
        for product, subscription in subscriber["subscriptions"].items():
            if product not in settings.premium_products():
                continue
            if not isinstance(subscription, dict):
                raise ValueError("Invalid subscription")
            if subscription.get("store") != "app_store":
                continue
            if not isinstance(subscription.get("is_sandbox"), bool):
                raise ValueError("Missing purchase environment")
            environment = "SANDBOX" if subscription["is_sandbox"] else "PRODUCTION"
            # Sandbox receipts never unlock a regular account, even on this shared API.
            if environment == "SANDBOX" and str(user_id) not in settings.billing_test_users():
                sandbox_only_products.add(product)
                continue
            starts = _date(subscription.get("purchase_date"))
            expires = _date(subscription.get("expires_date"))
            grace = _date(subscription.get("grace_period_expires_date"))
            if starts is None or expires is None:
                raise ValueError("Subscription dates are missing")
            ends = max(expires, grace) if grace else expires
            if starts > now or ends <= now or subscription.get("refunded_at"):
                continue
            incoming.append((product, environment, starts, ends,
                subscription.get("store_transaction_id"), bool(subscription.get("unsubscribe_detected_at"))))
    except (TypeError, ValueError) as exc:
        # Validate the whole snapshot before changing a single grant.
        raise HTTPException(503, "Purchase verification is temporarily unavailable. Please retry.") from exc

    existing = db.scalars(select(EntitlementGrant).where(
        EntitlementGrant.user_id == user_id, EntitlementGrant.source == "purchase")).all()
    received = set()
    for product, environment, starts, ends, transaction, cancelled in incoming:
        grant_id = uuid5(NAMESPACE_URL, f"seensnap:revenuecat:{user_id}:{environment}:{product}")
        received.add(grant_id)
        grant = db.get(EntitlementGrant, grant_id)
        if grant is None:
            grant = EntitlementGrant(id=grant_id, user_id=user_id, source="purchase", tier="premium")
            db.add(grant)
        grant.starts_at, grant.ends_at, grant.revoked_at = starts, ends, None
        grant.verified = True
        grant.provider_product_id = product
        grant.provider_transaction_id = transaction
        grant.payload = {"provider": "revenuecat", "store": "app_store", "environment": environment,
                         "auto_renew_disabled": cancelled, "checked_at": now.isoformat()}
        grant.updated_at = now
    for grant in existing:
        if grant.payload.get("provider") == "revenuecat" and grant.id not in received:
            # A sandbox receipt must not overwrite a production subscription
            # with the same product ID. Retain its verified expiry; never extend.
            if grant.payload.get("environment") == "PRODUCTION" and grant.provider_product_id in sandbox_only_products:
                continue
            grant.revoked_at = now
            grant.updated_at = now
    db.flush()


def delete_billing_customer(user_id: UUID) -> None:
    if not billing_ready():
        return
    try:
        response = httpx.delete(f"https://api.revenuecat.com/v1/subscribers/{user_id}",
            headers={"Authorization": f"Bearer {settings.revenuecat_secret_api_key}"}, timeout=10)
        if response.status_code != 404:
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(503, "We could not remove your billing profile. Please retry account deletion.") from exc
