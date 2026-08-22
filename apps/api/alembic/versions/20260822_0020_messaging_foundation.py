"""Messaging foundation — direct 1:1 conversations, messages, participants.

Per Messaging spec §30-§35.

Adds three tables:
  - conversations              — one row per thread (direct = 1:1 for MVP)
  - conversation_participants  — per-user membership + read cursor + mute
  - messages                   — text, title, list, or text_with_content

Direct-pair uniqueness is enforced via a partial unique index on
conversations.pair_key so the same two users can never accidentally end up
with two parallel threads (the classic race when both tap "Send" at once).
pair_key = min(uuid_a, uuid_b) + ":" + max(uuid_a, uuid_b), computed by
the service layer.

Idempotency: messages.client_message_id (nullable) is unique per
(sender_user_id, conversation_id) so retries and network wobbles don't
create duplicates.

Content attachments are stored as (content_type, content_id, snapshot_json).
content_type in {null, title, list}; content_id references the canonical
row in content_titles or watchlists. snapshot_json holds a small snapshot
(name, poster ref) so the card still renders something honest if the
referenced object is later deleted or made private.

Revision ID: 20260822_0020
Revises: 20260821_0019
Create Date: 2026-08-22 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260822_0020"
down_revision: str | None = "20260821_0019"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # ── conversations ──────────────────────────────────────────────────────
    op.create_table(
        "conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("conversation_type", sa.String(16), nullable=False, server_default="direct"),
        # pair_key is only meaningful for direct conversations — null for
        # future group threads. Partial unique index below enforces
        # one-direct-conversation-per-pair.
        sa.Column("pair_key", sa.String(80), nullable=True),
        sa.Column(
            "last_message_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "last_message_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "conversation_type IN ('direct')",
            name="ck_conversation_type",
        ),
    )
    # Partial unique index — direct threads only. Group threads (future)
    # legitimately have no pair_key so we allow multiple nulls.
    op.execute(
        "CREATE UNIQUE INDEX uq_conversations_pair_key "
        "ON conversations (pair_key) WHERE pair_key IS NOT NULL"
    )
    op.create_index("ix_conversations_last_message_at", "conversations", ["last_message_at"])

    # ── conversation_participants ──────────────────────────────────────────
    op.create_table(
        "conversation_participants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # last_read_at / last_read_message_id power the unread cursor.
        # Kept private to each participant — never exposed to the other
        # side per spec §29 (no read receipts).
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "last_read_message_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column("muted_at", sa.DateTime(timezone=True), nullable=True),
        # hidden_at removes conversation from the inbox for this user
        # until a new message arrives (spec §34 — Hide Conversation).
        sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("conversation_id", "user_id", name="uq_conversation_participant"),
    )
    op.create_index(
        "ix_conversation_participants_user_id",
        "conversation_participants",
        ["user_id"],
    )

    # ── messages ───────────────────────────────────────────────────────────
    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "sender_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("message_type", sa.String(32), nullable=False),
        sa.Column("text_body", sa.String(2000), nullable=True),
        # Attachment. content_type in {null, 'title', 'list'} — extend as
        # message_type gains variants. content_id is a UUID reference to
        # the canonical row; snapshot_json holds a tiny at-send snapshot
        # so a title/list that later gets deleted still renders honestly.
        sa.Column("content_type", sa.String(32), nullable=True),
        sa.Column("content_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("snapshot_json", postgresql.JSONB, nullable=True),
        # Idempotency key from the client. Nullable so old clients still
        # work; unique per (sender, conversation) so retries dedupe.
        sa.Column("client_message_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # Reserved for future "hide for me" / moderation flows. Currently
        # unused by MVP; kept nullable so we don't need another migration.
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "moderation_status",
            sa.String(16),
            nullable=False,
            server_default="active",
        ),
        sa.CheckConstraint(
            "message_type IN ('text', 'content', 'text_with_content', 'system')",
            name="ck_message_type",
        ),
        sa.CheckConstraint(
            "content_type IS NULL OR content_type IN ('title', 'list')",
            name="ck_message_content_type",
        ),
        # A message is meaningful iff it carries text OR content.
        sa.CheckConstraint(
            "(text_body IS NOT NULL) OR (content_type IS NOT NULL AND content_id IS NOT NULL)",
            name="ck_message_has_payload",
        ),
        sa.UniqueConstraint(
            "sender_user_id",
            "conversation_id",
            "client_message_id",
            name="uq_message_idempotency",
        ),
    )
    op.create_index("ix_messages_conversation_id", "messages", ["conversation_id"])
    op.create_index(
        "ix_messages_conversation_created",
        "messages",
        ["conversation_id", "created_at"],
    )

    # Now that messages exists, back-fill the last_message_id FK on
    # conversations. Kept nullable — a conversation starts before any
    # message exists (server creates the row on first send).
    op.create_foreign_key(
        "fk_conversations_last_message_id",
        source_table="conversations",
        referent_table="messages",
        local_cols=["last_message_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_conversation_participants_last_read_message_id",
        source_table="conversation_participants",
        referent_table="messages",
        local_cols=["last_read_message_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_conversation_participants_last_read_message_id",
        "conversation_participants",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_conversations_last_message_id",
        "conversations",
        type_="foreignkey",
    )
    op.drop_index("ix_messages_conversation_created", table_name="messages")
    op.drop_index("ix_messages_conversation_id", table_name="messages")
    op.drop_table("messages")
    op.drop_index(
        "ix_conversation_participants_user_id",
        table_name="conversation_participants",
    )
    op.drop_table("conversation_participants")
    op.drop_index("ix_conversations_last_message_at", table_name="conversations")
    op.execute("DROP INDEX IF EXISTS uq_conversations_pair_key")
    op.drop_table("conversations")
