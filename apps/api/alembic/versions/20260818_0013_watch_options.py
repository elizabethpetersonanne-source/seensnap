"""watch options columns on content_availability

Revision ID: 20260818_0013
Revises: 20260818_0012
Create Date: 2026-08-18 14:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20260818_0013"
down_revision = "20260818_0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "content_availability",
        sa.Column(
            "monetization_type",
            sa.String(16),
            nullable=False,
            server_default="flatrate",
        ),
    )
    op.add_column(
        "content_availability",
        sa.Column("tmdb_provider_id", sa.Integer, nullable=True),
    )
    op.add_column(
        "content_availability",
        sa.Column("logo_path", sa.String(512), nullable=True),
    )
    op.add_column(
        "content_availability",
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_content_availability_title_region",
        "content_availability",
        ["content_title_id", "region_code", "monetization_type"],
    )


def downgrade() -> None:
    op.drop_index("ix_content_availability_title_region", table_name="content_availability")
    op.drop_column("content_availability", "expires_at")
    op.drop_column("content_availability", "logo_path")
    op.drop_column("content_availability", "tmdb_provider_id")
    op.drop_column("content_availability", "monetization_type")
