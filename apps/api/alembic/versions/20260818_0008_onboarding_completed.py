"""Add onboarding_completed to user_preferences

Revision ID: 20260818_0008
Revises: 20260818_0007
Create Date: 2026-08-18 01:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260818_0008"
down_revision: str | None = "20260818_0007"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("onboarding_completed", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "onboarding_completed")
