"""Oct-18 build brief §8 watch handoff model."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class WatchHandoff(Base):
    __tablename__ = "watch_handoffs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id", ondelete="CASCADE"))
    provider_code: Mapped[str] = mapped_column(String(64))
    outbound_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    origin_surface: Mapped[str] = mapped_column(String(64), default="unspecified")
    launched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # null = still open; "watched" | "not_yet" | "expired" otherwise.
    resolved_action: Mapped[str | None] = mapped_column(String(16), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
