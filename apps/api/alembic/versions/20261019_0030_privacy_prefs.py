"""Privacy preferences

Oct-19 Visual Design brief §10 + Settings §4: profile visibility and
per-area activity toggles.

Revision ID: 20261019_0030
Revises: 20261018_0029
Create Date: 2026-10-19 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261019_0030"
down_revision: str | None = "20261018_0029"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("profile_visibility", sa.String(16), nullable=False, server_default="public"),
    )
    op.add_column(
        "user_preferences",
        sa.Column("show_activity", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "user_preferences",
        sa.Column("show_teams", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "user_preferences",
        sa.Column("show_public_lists", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "show_public_lists")
    op.drop_column("user_preferences", "show_teams")
    op.drop_column("user_preferences", "show_activity")
    op.drop_column("user_preferences", "profile_visibility")
