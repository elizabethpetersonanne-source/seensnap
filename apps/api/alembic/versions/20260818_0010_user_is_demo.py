"""Add is_demo flag to users

Revision ID: 20260818_0010
Revises: 20260818_0009
Create Date: 2026-08-18 03:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260818_0010"
down_revision: str | None = "20260818_0009"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_demo", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.create_index("ix_users_is_demo", "users", ["is_demo"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_users_is_demo", table_name="users")
    op.drop_column("users", "is_demo")
