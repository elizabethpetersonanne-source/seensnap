"""Oct-18 build brief §9 entitlement + allowance models."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class EntitlementGrant(Base):
    """Server-authoritative tier grant. One user can hold several
    overlapping grants (e.g. beta backfill + purchased sub + earned
    referral time); the resolver chooses the effective tier +
    expiration from the full active set so earned time is never
    silently consumed by purchase overlap."""
    __tablename__ = "entitlement_grants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # "beta" | "purchase" | "earned" | "promo" | "legacy"
    source: Mapped[str] = mapped_column(String(32))
    # "premium" | "free" (free grants exist for test fixtures / explicit downgrades)
    tier: Mapped[str] = mapped_column(String(16), default="premium")
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=True)
    provider_product_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    provider_transaction_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ConciergeAllowanceEntry(Base):
    """One row per Concierge decision slot for a Free user in a given
    UTC calendar month. Atomic reservation + finalization so parallel
    requests can't exceed the 3-per-month allowance and retries don't
    double-charge."""
    __tablename__ = "concierge_allowance_entries"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_allowance_user_idempotency"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decision_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    # "reserved" | "consumed" | "released"
    state: Mapped[str] = mapped_column(String(16), default="reserved")
    idempotency_key: Mapped[str] = mapped_column(String(96))
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ConciergeDecisionRecord(Base):
    """Oct-27 Concierge chunk E: a persisted decision + its refinement
    chain. One row per decision; refinements add turns via the
    `turns` JSONB array rather than new rows so we don't need a
    second table.

    Owned by the user who created it — any refinement endpoint MUST
    load the row and verify user_id before responding. Validates
    "forged refinement UUIDs can't bypass quota" from the brief.
    """
    __tablename__ = "concierge_decisions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Original intent as the user typed it; preserved across turns.
    original_intent: Mapped[str] = mapped_column(String(2000))
    # Latest intent after refinements; what the model saw last.
    current_intent: Mapped[str] = mapped_column(String(2000))
    # Validated constraints after resolution. JSONB blob of the dict
    # produced by asdict(ConciergeConstraints) for the latest turn.
    constraints: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Latest rationale displayed to the user.
    rationale: Mapped[str] = mapped_column(String(600), default="")
    # Latest status ("ready" | "empty" | "needs_clarification" | ...)
    status: Mapped[str] = mapped_column(String(32), default="ready")
    status_detail: Mapped[str] = mapped_column(String(96), default="")
    # Full title_ids the latest turn returned. Separate from `shown`
    # because the user may advance the carousel to see every one.
    latest_title_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    # Every title id shown across ANY turn in this decision. "Different
    # options" uses this set as an exclusion filter so refinements
    # don't recycle the same posters.
    shown_title_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    # Selected (featured/promoted) title id — the "current pick."
    # Follow-ups like "more like this" resolve against this id.
    featured_title_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # Snapshot of the user's data version at decision time so a
    # ranking change can invalidate stale decisions when needed.
    context_revision: Mapped[int] = mapped_column(default=0)
    # Append-only history of (turn_type, intent, status, rationale,
    # title_ids). The model never sees this directly; it's for the
    # client's refinement chain and for support.
    turns: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
