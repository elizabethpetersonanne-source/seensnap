"""Backfill is_demo=true on existing demo users

Revision ID: 20260818_0014
Revises: 20260818_0013
Create Date: 2026-08-18 08:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260818_0014"
down_revision: str | None = "20260818_0013"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # Flag every user that the demo seed script created: they use auth_provider="demo"
    # or an @demo.seensnap.local email (including the canonical SeenSnap demo account).
    op.execute(
        """
        UPDATE users
        SET is_demo = TRUE
        WHERE is_demo = FALSE
          AND (
            auth_provider = 'demo'
            OR LOWER(email) LIKE '%@demo.seensnap.local'
            OR LOWER(email) = 'seensnap.demo@demo.seensnap.local'
            OR LOWER(email) = 'demo@seensnap.app'
          )
        """
    )


def downgrade() -> None:
    # Non-reversible in a safe way — flagging cannot be perfectly untagged after real users
    # may have signed up. Leaving is_demo flags in place on downgrade.
    pass
