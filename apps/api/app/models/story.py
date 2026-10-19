"""Oct-19 Social Stories — 72-hour title stories per the mock.

Each user can post a title to their story. Entries auto-expire 72
hours after creation. Fetching returns active (non-expired) entries
grouped by actor.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SocialStory(Base):
    __tablename__ = "social_stories"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id", ondelete="CASCADE"), nullable=False)
    caption: Mapped[str | None] = mapped_column(String(280), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
