from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.dependencies import CurrentUser, DbSession
from app.core.config import settings
from app.core.limiter import limiter
from app.services.billing import billing_ready, sync_purchases, verify_webhook
from app.services.entitlements import resolve_entitlement
from app.api.routes.entitlement import EntitlementResponse

router = APIRouter()


@router.get("/config")
def configuration(current_user: CurrentUser, db: DbSession) -> dict:
    ent = resolve_entitlement(db, current_user.id)
    return {"available": billing_ready(), "purchases_enabled": settings.billing_enabled,
            "purchase_allowed": billing_ready() and settings.billing_enabled and ent.tier == "free",
            "product_ids": sorted(settings.premium_products()) if billing_ready() else [],
            "sandbox_tester": str(current_user.id) in settings.billing_test_users()}


@router.post("/sync", response_model=EntitlementResponse)
@limiter.limit("10/minute")
def synchronize(request: Request, current_user: CurrentUser, db: DbSession) -> EntitlementResponse:
    # No user ID, tier or transaction claims accepted from the client.
    sync_purchases(db, current_user.id)
    db.commit()
    return EntitlementResponse(**vars(resolve_entitlement(db, current_user.id)))


class ProviderEvent(BaseModel):
    id: str = Field(max_length=128)
    type: str = Field(max_length=64)
    app_id: str = Field(max_length=128)
    app_user_id: str | None = Field(default=None, max_length=128)
    original_app_user_id: str | None = Field(default=None, max_length=128)
    aliases: list[str] = Field(default_factory=list, max_length=50)
    transferred_from: list[str] = Field(default_factory=list, max_length=50)
    transferred_to: list[str] = Field(default_factory=list, max_length=50)


class ProviderEnvelope(BaseModel):
    event: ProviderEvent


@router.post("/revenuecat")
def webhook(payload: ProviderEnvelope, db: DbSession,
            authorization: Annotated[str | None, Header()] = None) -> dict:
    verify_webhook(authorization)
    event = payload.event
    if event.app_id != settings.revenuecat_app_id:
        raise HTTPException(400, "Unexpected billing app")
    if event.type == "TEST":
        return {"received": True}
    # Query every affected account after a transfer; no local grant is copied.
    values = [event.app_user_id, event.original_app_user_id, *event.aliases,
              *event.transferred_from, *event.transferred_to]
    user_ids = set()
    for value in values:
        try:
            user_ids.add(UUID(value))
        except (ValueError, TypeError, AttributeError):
            continue  # ignore RevenueCat anonymous IDs; app uses authenticated UUIDs
    # Same order for overlapping account transfers prevents deadlocks.
    for user_id in sorted(user_ids):
        sync_purchases(db, user_id)
    db.commit()
    return {"received": True}
