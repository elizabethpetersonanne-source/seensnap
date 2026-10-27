"""Notification channel toggles

Oct-27 Stefan/Caroline spec SET-02: persistence for per-channel
notification toggles (Direct, Watch Teams, Social). Stored as a JSONB
dict of key -> bool so the shape can evolve without future migrations.

Revision ID: 20261027_0032
Revises: 20261019_0031
Create Date: 2026-10-27 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20261027_0032"
down_revision: str | None = "20261019_0031"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column(
            "notification_channels",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "notification_channels")
