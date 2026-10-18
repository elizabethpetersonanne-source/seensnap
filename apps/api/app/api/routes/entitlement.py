"""Oct-18 build brief §9: typed entitlement endpoint.

The client reads this to know its tier. There is NO client-side
Premium override — every protected API boundary checks the server
resolution for authorization. The response is a safe shape to cache
briefly (login, resume, verified restore, relevant account changes).
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.dependencies import CurrentUser, DbSession
from app.services.entitlements import resolve_entitlement


router = APIRouter()


class EntitlementResponse(BaseModel):
    tier: str  # "premium" | "free"
    sources: list[str]
    expires_at: datetime | None
    verified: bool
    concierge_monthly_cap: int | None  # None = premium / effectively unlimited
    is_beta: bool


@router.get("", response_model=EntitlementResponse)
def get_my_entitlement(current_user: CurrentUser, db: DbSession) -> EntitlementResponse:
    ent = resolve_entitlement(db, current_user.id)
    return EntitlementResponse(
        tier=ent.tier,
        sources=ent.sources,
        expires_at=ent.expires_at,
        verified=ent.verified,
        concierge_monthly_cap=ent.concierge_monthly_cap,
        is_beta=ent.is_beta,
    )
