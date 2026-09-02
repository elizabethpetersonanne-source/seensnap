"""Swipe idempotency key

Adds a nullable idempotency_key column to swipe_records with a partial
unique index scoped to (user_id, idempotency_key) — nulls are ignored
by the index so historical rows and non-idempotent legacy writes stay
compatible. Per Onboarding spec §12: "Swipe writes must be idempotent
to prevent double signals during retry."

Revision ID: 20260902_0023
Revises: 20260902_0022
Create Date: 2026-09-02 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260902_0023"
down_revision: str | None = "20260902_0022"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "swipe_records",
        sa.Column("idempotency_key", sa.String(80), nullable=True),
    )
    # Partial unique index — Postgres skips NULL entries so historical
    # rows without a key don't create a collision. New writes get
    # unique (user_id, idempotency_key) enforcement.
    op.create_index(
        "uq_swipe_records_user_idempotency",
        "swipe_records",
        ["user_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_swipe_records_user_idempotency", table_name="swipe_records")
    op.drop_column("swipe_records", "idempotency_key")
