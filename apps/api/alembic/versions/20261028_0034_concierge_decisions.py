"""Concierge decisions

Oct-27 Concierge follow-up chunk E: persisted decision records so
refinements can validate ownership and track shown title IDs across
turns. One row per decision; refinements append to the turns JSONB.

Revision ID: 20261028_0034
Revises: 20261028_0033
Create Date: 2026-10-28 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20261028_0034"
down_revision: str | None = "20261028_0033"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "concierge_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("original_intent", sa.String(2000), nullable=False),
        sa.Column("current_intent", sa.String(2000), nullable=False),
        sa.Column("constraints", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("rationale", sa.String(600), nullable=False, server_default=""),
        sa.Column("status", sa.String(32), nullable=False, server_default="ready"),
        sa.Column("status_detail", sa.String(96), nullable=False, server_default=""),
        sa.Column("latest_title_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("shown_title_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("featured_title_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("context_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("turns", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_concierge_decisions_user_id", "concierge_decisions", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_concierge_decisions_user_id", table_name="concierge_decisions")
    op.drop_table("concierge_decisions")
