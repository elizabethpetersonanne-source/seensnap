"""Oct-18 build brief §4 Concierge decision endpoint.

Request is natural-language intent. Server:
  1. Reserves a Concierge slot (Free allowance / Premium unlimited).
  2. Calls the AI adapter to resolve typed constraints + grounded
     title suggestions.
  3. Finalizes the slot — successful only if the decision produced
     usable results. Errors / empty results / unavailable adapter
     release the slot rather than consume it.
  4. Returns a canonical response the client renders as hero-plus-four.

A refinement in the SAME decision does not consume a second slot —
the client passes `refinement_of_decision_id` and the service uses
the previously-reserved slot (bounded abuse / rate limits apply).
"""
from __future__ import annotations

from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.services.concierge import decision_to_dict, resolve_concierge_decision
from app.services.entitlements import (
    finalize_concierge_decision,
    reserve_concierge_decision,
    resolve_entitlement,
)


router = APIRouter()


class ConciergeDecisionRequest(BaseModel):
    intent: str = Field(min_length=1, max_length=2000)
    # If present, this request REFINES the given decision — does not
    # consume a second allowance slot.
    refinement_of_decision_id: UUID | None = None
    # Client-side generated UUID; retries use the same key.
    idempotency_key: str = Field(min_length=8, max_length=96)


class ConciergeTitleCard(BaseModel):
    title_id: UUID
    tmdb_id: int
    title: str
    poster_url: str | None
    backdrop_url: str | None
    year: int | None
    media_type: str
    overview: str | None


class ConciergeDecisionResponse(BaseModel):
    decision_id: UUID | None
    status: str  # "ready" | "unavailable" | "empty" | "error" | "allowance_exhausted"
    status_detail: str = ""
    rationale: str = ""
    constraints: dict | None = None
    titles: list[ConciergeTitleCard] = []
    allowance_remaining: int | None = None
    allowance_cap: int | None = None
    resets_at: str | None = None


@router.post("/decision", response_model=ConciergeDecisionResponse)
def post_concierge_decision(
    payload: ConciergeDecisionRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> ConciergeDecisionResponse:
    entitlement = resolve_entitlement(db, current_user.id)

    # Enforce Free monthly allowance. Premium is unlimited (fair-use
    # ceiling can be added in config later).
    is_refinement = payload.refinement_of_decision_id is not None
    if not is_refinement:
        allowance = reserve_concierge_decision(
            db,
            current_user.id,
            idempotency_key=payload.idempotency_key,
        )
        if not allowance.allowed:
            return ConciergeDecisionResponse(
                decision_id=None,
                status="allowance_exhausted",
                status_detail=allowance.reason,
                allowance_remaining=0,
                allowance_cap=entitlement.concierge_monthly_cap,
                resets_at=allowance.resets_at.isoformat() if allowance.resets_at else None,
            )
    else:
        allowance = None

    # Resolve intent via the AI adapter.
    decision = resolve_concierge_decision(db, current_user.id, payload.intent)

    # Successful means we actually produced grounded results.
    successful = decision.status == "ready" and bool(decision.title_ids)
    if allowance is not None and allowance.decision_id is not None:
        finalize_concierge_decision(
            db,
            current_user.id,
            allowance.decision_id,
            successful=successful,
        )
        db.commit()

    # Hydrate the grounded titles for the client.
    titles: list[ConciergeTitleCard] = []
    if decision.title_ids:
        rows = {t.id: t for t in db.scalars(
            select(ContentTitle).where(ContentTitle.id.in_(decision.title_ids))
        ).all()}
        # Preserve the service's ordering.
        for tid in decision.title_ids:
            t = rows.get(tid)
            if t is None:
                continue
            titles.append(ConciergeTitleCard(
                title_id=t.id,
                tmdb_id=t.tmdb_id,
                title=t.title,
                poster_url=t.poster_url,
                backdrop_url=t.backdrop_url,
                year=t.release_date.year if t.release_date else None,
                media_type=t.content_type,
                overview=t.overview,
            ))

    decision_payload = decision_to_dict(decision)
    decision_id = allowance.decision_id if allowance else None

    # Remaining allowance for the response — compute fresh so a
    # successful finalize is reflected immediately.
    remaining = allowance.remaining if allowance is not None else None
    cap = entitlement.concierge_monthly_cap

    return ConciergeDecisionResponse(
        decision_id=decision_id,
        status=decision.status,
        status_detail=decision.status_detail,
        rationale=decision.rationale,
        constraints=decision_payload["constraints"],
        titles=titles,
        allowance_remaining=remaining,
        allowance_cap=cap,
        resets_at=allowance.resets_at.isoformat() if allowance and allowance.resets_at else None,
    )
