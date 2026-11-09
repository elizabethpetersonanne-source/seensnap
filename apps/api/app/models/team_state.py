"""Explicit team-shared state; never inferred from a member's personal lists."""

import uuid
from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, String, Integer, UniqueConstraint, LargeBinary, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base


class TeamTitleState(Base):
    __tablename__ = "team_title_states"
    __table_args__ = (
        UniqueConstraint("team_id", "user_id", "content_title_id", name="uq_team_title_state"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    team_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("content_titles.id", ondelete="CASCADE")
    )
    state: Mapped[str] = mapped_column(String(16))
    shared_rating: Mapped[int | None] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MediaAsset(Base):
    """Small sanitized images stored durably with the existing beta database.

    Bounded to 512 KiB after conversion; no ephemeral container files, public
    bucket ACLs, bearer URLs or new cloud credential dependency.
    """

    __tablename__ = "media_assets"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"))
    purpose: Mapped[str] = mapped_column(String(16))
    data: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
