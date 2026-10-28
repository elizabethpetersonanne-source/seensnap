"""Taste action_version + canonical system list roles

Oct-27 personalization brief TASTE05 + QUEUE01-02:
  - SwipeRecord.action_version: v1 = old Up meaning (Watch Now),
    v2 = new Up meaning (Watched + rate). Historical rows default
    to v1 so reprocessing doesn't retroactively reinterpret them.
  - Watchlist.system_role: canonical "next_watch" / "favorites"
    role identifier. Resolver uses this, not name/is_default.
    Backfill assigns next_watch to the owner's default list whose
    name matches /next.*watch/i (the historical default name).

Revision ID: 20261028_0036
Revises: 20261028_0035
Create Date: 2026-10-28 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261028_0036"
down_revision: str | None = "20261028_0035"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "swipe_records",
        sa.Column("action_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "watchlists",
        sa.Column("system_role", sa.String(32), nullable=True),
    )
    # Idempotent one-time backfill: at most one row per owner can
    # claim system_role=next_watch. We pick the DEFAULT list whose
    # name looks like Next Watch — matches the historical
    # ensure_default_watchlists path.
    op.execute(
        """
        WITH ranked AS (
            SELECT id, owner_user_id,
                   ROW_NUMBER() OVER (
                       PARTITION BY owner_user_id
                       ORDER BY created_at ASC
                   ) AS rn
            FROM watchlists
            WHERE is_default = TRUE
              AND LOWER(name) LIKE 'next%watch%'
        )
        UPDATE watchlists
        SET system_role = 'next_watch'
        FROM ranked
        WHERE watchlists.id = ranked.id
          AND ranked.rn = 1
        """
    )
    op.create_index(
        "ux_watchlist_system_role_per_owner",
        "watchlists",
        ["owner_user_id", "system_role"],
        unique=True,
        postgresql_where=sa.text("system_role IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ux_watchlist_system_role_per_owner", table_name="watchlists")
    op.drop_column("watchlists", "system_role")
    op.drop_column("swipe_records", "action_version")
