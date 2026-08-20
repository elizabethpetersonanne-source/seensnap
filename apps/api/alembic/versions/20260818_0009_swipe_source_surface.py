"""Add source_surface to swipe_records

Revision ID: 20260818_0009
Revises: 20260818_0008
Create Date: 2026-08-18 02:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260818_0009"
down_revision: str | None = "20260818_0008"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "swipe_records",
        sa.Column("source_surface", sa.String(length=80), nullable=True),
    )
    op.create_index(
        "ix_swipe_records_source_surface",
        "swipe_records",
        ["source_surface"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_swipe_records_source_surface", table_name="swipe_records")
    op.drop_column("swipe_records", "source_surface")
