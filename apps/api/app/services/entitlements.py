"""Oct-18 build brief §9 entitlement + Concierge allowance service.

Server-authoritative tier resolution. The `/me/entitlement` endpoint
is the only client-visible truth; a client-side `isPremium` boolean
is not accepted anywhere.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.models.entitlements import ConciergeAllowanceEntry, EntitlementGrant


# Oct-18 brief §9 configured defaults; put in named config so they're
# documented and testable. These are implementation defaults, not
# founder-approved facts.
CONCIERGE_FREE_MONTHLY_ALLOWANCE = 3


Tier = Literal["premium", "free"]


@dataclass
class Entitlement:
    tier: Tier
    sources: list[str]
    expires_at: datetime | None  # earliest tier-ending moment across active grants, None = indefinite
    verified: bool
    concierge_monthly_cap: int | None  # None = effectively unlimited (fair-use ceiling set elsewhere)
    is_beta: bool


def _first_of_month_utc(now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _first_of_next_month_utc(now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    year = now.year + (1 if now.month == 12 else 0)
    month = 1 if now.month == 12 else now.month + 1
    return now.replace(year=year, month=month, day=1, hour=0, minute=0, second=0, microsecond=0)


def _active_grants(db: Session, user_id: UUID, now: datetime | None = None) -> list[EntitlementGrant]:
    now = now or datetime.now(timezone.utc)
    rows = db.scalars(
        select(EntitlementGrant).where(
            EntitlementGrant.user_id == user_id,
            EntitlementGrant.revoked_at.is_(None),
            EntitlementGrant.verified.is_(True),
            EntitlementGrant.starts_at <= now,
            or_(EntitlementGrant.ends_at.is_(None), EntitlementGrant.ends_at > now),
        )
    ).all()
    return list(rows)


def resolve_entitlement(db: Session, user_id: UUID, now: datetime | None = None) -> Entitlement:
    """Return the user's current entitlement. Beta/legacy source alone
    is enough to grant Premium; a cancelled-but-still-valid subscription
    remains active until its ends_at. Earned/promo + purchased grants
    coexist — the resolver takes the premium tier if ANY active grant
    is premium, and the earliest ends_at as the composite expiry."""
    grants = _active_grants(db, user_id, now=now)
    is_premium = any(g.tier == "premium" for g in grants)
    is_beta = any(g.source == "beta" for g in grants)
    # Expiry: earliest non-null ends_at across tier-giving grants.
    tier_grants = [g for g in grants if g.tier == "premium"] if is_premium else grants
    expiries = [g.ends_at for g in tier_grants if g.ends_at is not None]
    expires_at = min(expiries) if expiries else None
    # Oct-18 §9: Premium is unlimited (configured fair-use elsewhere).
    monthly_cap = None if is_premium else CONCIERGE_FREE_MONTHLY_ALLOWANCE
    return Entitlement(
        tier="premium" if is_premium else "free",
        sources=sorted({g.source for g in grants}),
        expires_at=expires_at,
        verified=all(g.verified for g in grants) if grants else False,
        concierge_monthly_cap=monthly_cap,
        is_beta=is_beta,
    )


def grant_beta_premium(db: Session, user_id: UUID) -> EntitlementGrant:
    """Idempotent: creates a beta Premium grant for a user if they
    don't already have an active one. Called from the auth flow on
    every new signup during beta so there's no race between signup
    and the backfill migration."""
    existing = db.scalar(
        select(EntitlementGrant).where(
            EntitlementGrant.user_id == user_id,
            EntitlementGrant.source == "beta",
            EntitlementGrant.revoked_at.is_(None),
        )
    )
    if existing is not None:
        return existing
    grant = EntitlementGrant(
        id=uuid4(),
        user_id=user_id,
        source="beta",
        tier="premium",
        verified=True,
        payload={"reason": "beta_signup_grant"},
    )
    db.add(grant)
    db.flush()
    return grant


# ─── Concierge allowance ────────────────────────────────────────────


@dataclass
class AllowanceDecision:
    allowed: bool
    remaining: int | None  # None = premium / no cap
    reason: str
    decision_id: UUID | None  # set if reserved
    resets_at: datetime


def _active_period_entries(db: Session, user_id: UUID, now: datetime | None = None) -> list[ConciergeAllowanceEntry]:
    period_start = _first_of_month_utc(now)
    rows = db.scalars(
        select(ConciergeAllowanceEntry).where(
            ConciergeAllowanceEntry.user_id == user_id,
            ConciergeAllowanceEntry.period_start == period_start,
            ConciergeAllowanceEntry.state.in_(["reserved", "consumed"]),
        )
    ).all()
    return list(rows)


def reserve_concierge_decision(
    db: Session,
    user_id: UUID,
    *,
    idempotency_key: str,
    now: datetime | None = None,
) -> AllowanceDecision:
    """Atomically reserve a Concierge slot for the current month.
    Premium always allowed; Free gets up to CONCIERGE_FREE_MONTHLY_ALLOWANCE.

    Idempotent: the same idempotency_key always resolves to the same
    reservation outcome. Retries don't double-charge; a decision that
    later fails/returns-no-results can be `released` without consuming
    the slot."""
    now = now or datetime.now(timezone.utc)
    period_start = _first_of_month_utc(now)
    period_end = _first_of_next_month_utc(now)
    ent = resolve_entitlement(db, user_id, now=now)

    # Premium — no slot reservation needed, but still log for observability.
    if ent.tier == "premium":
        # Store a 'consumed' row keyed by idempotency to prevent duplicate
        # analytics on retry. No cap enforcement for premium.
        existing = db.scalar(
            select(ConciergeAllowanceEntry).where(
                ConciergeAllowanceEntry.user_id == user_id,
                ConciergeAllowanceEntry.idempotency_key == idempotency_key,
            )
        )
        if existing is not None:
            return AllowanceDecision(
                allowed=True,
                remaining=None,
                reason="premium",
                decision_id=existing.decision_id,
                resets_at=period_end,
            )
        decision_id = uuid4()
        db.add(ConciergeAllowanceEntry(
            id=uuid4(),
            user_id=user_id,
            period_start=period_start,
            period_end=period_end,
            decision_id=decision_id,
            state="consumed",  # premium decisions are consumed-on-reserve for logging only
            idempotency_key=idempotency_key,
            finalized_at=now,
        ))
        db.flush()
        return AllowanceDecision(
            allowed=True,
            remaining=None,
            reason="premium",
            decision_id=decision_id,
            resets_at=period_end,
        )

    # Free — check idempotency first.
    existing = db.scalar(
        select(ConciergeAllowanceEntry).where(
            ConciergeAllowanceEntry.user_id == user_id,
            ConciergeAllowanceEntry.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        in_period = _active_period_entries(db, user_id, now=now)
        return AllowanceDecision(
            allowed=existing.state in ("reserved", "consumed"),
            remaining=max((CONCIERGE_FREE_MONTHLY_ALLOWANCE - len(in_period)), 0),
            reason="idempotent_replay",
            decision_id=existing.decision_id,
            resets_at=period_end,
        )

    in_period = _active_period_entries(db, user_id, now=now)
    used = len(in_period)
    if used >= CONCIERGE_FREE_MONTHLY_ALLOWANCE:
        return AllowanceDecision(
            allowed=False,
            remaining=0,
            reason="monthly_cap_reached",
            decision_id=None,
            resets_at=period_end,
        )
    decision_id = uuid4()
    db.add(ConciergeAllowanceEntry(
        id=uuid4(),
        user_id=user_id,
        period_start=period_start,
        period_end=period_end,
        decision_id=decision_id,
        state="reserved",
        idempotency_key=idempotency_key,
    ))
    db.flush()
    return AllowanceDecision(
        allowed=True,
        remaining=max(CONCIERGE_FREE_MONTHLY_ALLOWANCE - used - 1, 0),
        reason="within_allowance",
        decision_id=decision_id,
        resets_at=period_end,
    )


def finalize_concierge_decision(
    db: Session,
    user_id: UUID,
    decision_id: UUID,
    *,
    successful: bool,
    now: datetime | None = None,
) -> None:
    """Mark a reserved decision consumed (if the Concierge returned
    usable results) or released (error / no results / user cancelled).
    Only consumed slots count toward the monthly cap."""
    now = now or datetime.now(timezone.utc)
    row = db.scalar(
        select(ConciergeAllowanceEntry).where(
            ConciergeAllowanceEntry.user_id == user_id,
            ConciergeAllowanceEntry.decision_id == decision_id,
        )
    )
    if row is None or row.state != "reserved":
        return
    row.state = "consumed" if successful else "released"
    row.finalized_at = now
