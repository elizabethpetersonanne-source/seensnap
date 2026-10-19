"""Social stories (72h expiry)

Revision ID: 20261019_0031
Revises: 20261019_0030
Create Date: 2026-10-19 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20261019_0031"
down_revision: str | None = "20261019_0030"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "social_stories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content_title_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("content_titles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("caption", sa.String(280), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_social_stories_user_expires", "social_stories", ["user_id", "expires_at"])
    op.create_index("ix_social_stories_expires", "social_stories", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_social_stories_expires", table_name="social_stories")
    op.drop_index("ix_social_stories_user_expires", table_name="social_stories")
    op.drop_table("social_stories")
