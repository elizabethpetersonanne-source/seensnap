"""Oct-18 build brief §3 fix 2: Previews cursor state.

Server-side session store so the client cursor can stay small +
opaque. Keyed by session UUID + filter_fingerprint so filter changes
invalidate the cursor cleanly.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PreviewSession(Base):
    __tablename__ = "preview_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # Filter identity: media_type + genre + source hashed. Changes
    # invalidate the cursor without needing a separate reset endpoint.
    filter_fingerprint: Mapped[str] = mapped_column(String(96))
    served_title_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)
    scan_offset: Mapped[int] = mapped_column(Integer, default=0)
    exhausted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
