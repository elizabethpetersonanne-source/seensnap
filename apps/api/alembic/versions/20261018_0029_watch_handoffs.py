"""Watch handoff persistence

Oct-18 build brief §8: before launching a provider, persist a handoff
containing user, title, provider, origin, and launched_at. On
meaningful return the client reads unresolved handoffs and prompts
Did you watch?

Revision ID: 20261018_0029
Revises: 20261018_0028
Create Date: 2026-10-18 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20261018_0029"
down_revision: str | None = "20261018_0028"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "watch_handoffs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content_title_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("content_titles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider_code", sa.String(64), nullable=False),
        sa.Column("outbound_url", sa.String(1024), nullable=True),
        sa.Column("origin_surface", sa.String(64), nullable=False, server_default="unspecified"),
        sa.Column("launched_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # resolved_action: null = still open; "watched" = user confirmed;
        # "not_yet" = user dismissed; "expired" = aged out.
        sa.Column("resolved_action", sa.String(16), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", postgresql.JSONB, nullable=False, server_default="{}"),
    )
    op.create_index(
        "ix_watch_handoffs_user_open",
        "watch_handoffs",
        ["user_id", "launched_at"],
        postgresql_where=sa.text("resolved_action IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_watch_handoffs_user_open", table_name="watch_handoffs")
    op.drop_table("watch_handoffs")
