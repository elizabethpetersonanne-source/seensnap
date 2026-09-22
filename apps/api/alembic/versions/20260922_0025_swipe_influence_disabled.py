"""Signal-level "remove influence" flag

Sep-22 execution brief §8: users can exclude a specific signal from
their SceneDNA computation without deleting the underlying event.
Adds `influence_disabled_at` to swipe_records (nullable timestamp).
NULL = influence active; non-null = disabled at that time. Taste
recompute filters WHERE influence_disabled_at IS NULL.

Revision ID: 20260922_0025
Revises: 20260922_0024
Create Date: 2026-09-22 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260922_0025"
down_revision: str | None = "20260922_0024"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "swipe_records",
        sa.Column("influence_disabled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_swipe_records_influence_active",
        "swipe_records",
        ["user_id"],
        postgresql_where=sa.text("influence_disabled_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_swipe_records_influence_active", table_name="swipe_records")
    op.drop_column("swipe_records", "influence_disabled_at")
