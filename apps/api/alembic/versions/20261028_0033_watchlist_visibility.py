"""Watchlist visibility

Oct-27 follow-up A69: persistent list audience ("private", "followers",
"public"). Default private — the New List create flow surfaces the
selector; publishing is an explicit choice.

Revision ID: 20261028_0033
Revises: 20261027_0032
Create Date: 2026-10-28 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261028_0033"
down_revision: str | None = "20261027_0032"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "watchlists",
        sa.Column("visibility", sa.String(16), nullable=False, server_default="private"),
    )


def downgrade() -> None:
    op.drop_column("watchlists", "visibility")
