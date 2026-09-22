"""Ranked favorites (Top 20 / Top 100)

Sep-22 execution brief §14: one ordered collection of up to 100
unique titles per user; Top 20 is its first 20 so the two views
cannot disagree. `position` is 1-based contiguous per user with a
unique constraint per (user_id, position). Adding/reordering is
atomic — the API is responsible for renumbering to keep gaps out.

Also carries a `version` per row for optimistic-concurrency conflict
detection so an out-of-order write from a second device can't corrupt
the ordering.

Revision ID: 20260922_0026
Revises: 20260922_0025
Create Date: 2026-09-22 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260922_0026"
down_revision: str | None = "20260922_0025"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ranked_favorites",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content_title_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("content_titles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "content_title_id", name="uq_ranked_favorite_user_title"),
        # Deferrable per-user position uniqueness so a batch reorder
        # transaction can temporarily swap two rows to the same slot
        # inside a transaction before committing distinct final values.
        sa.UniqueConstraint("user_id", "position", name="uq_ranked_favorite_user_position", deferrable=True, initially="DEFERRED"),
        sa.CheckConstraint("position >= 1 AND position <= 100", name="ck_ranked_favorite_position_range"),
    )
    op.create_index("ix_ranked_favorites_user_position", "ranked_favorites", ["user_id", "position"])


def downgrade() -> None:
    op.drop_index("ix_ranked_favorites_user_position", table_name="ranked_favorites")
    op.drop_table("ranked_favorites")
