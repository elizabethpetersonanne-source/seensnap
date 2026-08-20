import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AnalyticsEvent(Base):
    """Append-only event log. Populated by mobile clients via POST /events.

    Demo users still record events (harmless) — reporting queries should filter by
    joining users.is_demo when computing KPIs. Kept intentionally minimal; a dedicated
    analytics pipeline (Segment / PostHog / Sentry) can be layered on later without
    breaking the client contract.
    """
    __tablename__ = "analytics_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    event_name: Mapped[str] = mapped_column(String(80))
    properties: Mapped[dict] = mapped_column(JSONB, default=dict)
    platform: Mapped[str | None] = mapped_column(String(16))
    app_build: Mapped[str | None] = mapped_column(String(32))
    session_id: Mapped[str | None] = mapped_column(String(80))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
