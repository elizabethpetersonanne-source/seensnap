"""collections table

Revision ID: 20260818_0012
Revises: 20260818_0011
Create Date: 2026-08-18 13:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "20260818_0012"
down_revision = "20260818_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "collections",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(128), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("subtitle", sa.String(512), nullable=True),
        sa.Column("thesis", sa.Text, nullable=True),
        sa.Column("collection_type", sa.String(32), nullable=False),
        sa.Column("media_scope", sa.String(8), nullable=False, server_default="mixed"),
        sa.Column("rule_config", JSONB, nullable=False, server_default="{}"),
        sa.Column("manual_tmdb_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("editorial_rank", sa.Integer, nullable=False, server_default="100"),
        sa.Column("active_from", sa.Date, nullable=True),
        sa.Column("active_until", sa.Date, nullable=True),
        sa.Column("refresh_policy", sa.String(16), nullable=False, server_default="daily"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("cached_title_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("cached_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_collections_slug", "collections", ["slug"], unique=True)
    op.create_index("ix_collections_status_rank", "collections", ["status", "editorial_rank"])


def downgrade() -> None:
    op.drop_index("ix_collections_status_rank", table_name="collections")
    op.drop_index("ix_collections_slug", table_name="collections")
    op.drop_table("collections")
