"""Messaging models — 1:1 direct conversations, participants, messages.

Per Messaging spec §30-§35. Group threads are deliberately out of scope for
MVP; the schema accommodates them (conversation_type + null pair_key) so
we don't need another migration when they land.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Conversation(Base):
    """A messaging thread. For MVP always conversation_type='direct' with
    exactly two participants. pair_key is the canonical `min(a,b):max(a,b)`
    of the two user IDs — enforced unique by partial index so the same
    two people can never end up with duplicate parallel threads."""

    __tablename__ = "conversations"
    __table_args__ = (
        CheckConstraint("conversation_type IN ('direct')", name="ck_conversation_type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_type: Mapped[str] = mapped_column(String(16), default="direct")
    pair_key: Mapped[str | None] = mapped_column(String(80), nullable=True)
    last_message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ConversationParticipant(Base):
    """Per-user membership in a conversation. Owns the private read cursor
    (last_read_at + last_read_message_id) — never exposed to the other side
    per spec §29 (no read receipts). Also owns mute + hide state."""

    __tablename__ = "conversation_participants"
    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_conversation_participant"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_read_message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )
    muted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Message(Base):
    """A single message in a conversation. Payload is either text, a
    reference to a SeenSnap object (title / list), or both. snapshot_json
    holds a small at-send snapshot so the card still renders honestly if
    the referenced object is later deleted or made private."""

    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint(
            "message_type IN ('text', 'content', 'text_with_content', 'system')",
            name="ck_message_type",
        ),
        CheckConstraint(
            "content_type IS NULL OR content_type IN ('title', 'list')",
            name="ck_message_content_type",
        ),
        CheckConstraint(
            "(text_body IS NOT NULL) OR (content_type IS NOT NULL AND content_id IS NOT NULL)",
            name="ck_message_has_payload",
        ),
        UniqueConstraint(
            "sender_user_id",
            "conversation_id",
            "client_message_id",
            name="uq_message_idempotency",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE")
    )
    sender_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    message_type: Mapped[str] = mapped_column(String(32))
    text_body: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    content_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    content_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    snapshot_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    client_message_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    moderation_status: Mapped[str] = mapped_column(String(16), default="active")
