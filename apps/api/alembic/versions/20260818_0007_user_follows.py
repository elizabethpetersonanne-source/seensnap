"""Add user_follows table to migration history

Previously this table was created via runtime DDL in services/follows.py.
This migration makes it a proper part of the schema history so fresh
database deploys work without requiring a follow action to trigger
the table creation.

Revision ID: 20260818_0007
Revises: 20260501_0006
Create Date: 2026-08-18 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260818_0007"
down_revision: str | None = "20260501_0006"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_follows (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            follower_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            following_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_user_follow UNIQUE (follower_user_id, following_user_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_user_follows_follower ON user_follows (follower_user_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_user_follows_following ON user_follows (following_user_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_user_follows_following")
    op.execute("DROP INDEX IF EXISTS ix_user_follows_follower")
    op.drop_table("user_follows")
