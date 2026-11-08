"""Durable discovery decisions and continuation, separate from taste history."""
import uuid
from datetime import datetime
from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base


class DiscoveryDecision(Base):
    __tablename__ = "discovery_decisions"
    __table_args__ = (
        UniqueConstraint("user_id", "sequence", name="uq_discovery_decision_sequence"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_discovery_decision_retry"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"), index=True)
    sequence: Mapped[int | None] = mapped_column(BigInteger)
    direction: Mapped[str] = mapped_column(String(12))
    idempotency_key: Mapped[str | None] = mapped_column(String(80))
    state_before: Mapped[dict] = mapped_column(JSONB, default=dict)
    state_after: Mapped[dict] = mapped_column(JSONB, default=dict)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DiscoverySession(Base):
    __tablename__ = "discovery_sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    version: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[dict] = mapped_column(JSONB, default=dict)
    last_response: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
