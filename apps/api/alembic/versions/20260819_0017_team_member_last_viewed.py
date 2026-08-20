"""Team member last-viewed cursor

Adds team_members.last_viewed_at so we can compute per-user unread activity
counts and "team status" (active / quiet / dormant) for the Watch Teams
overhaul (activity-first inversion).

Revision ID: 20260819_0017
Revises: 20260819_0016
Create Date: 2026-08-19 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260819_0017"
down_revision: str | None = "20260819_0016"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "team_members",
        sa.Column("last_viewed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("team_members", "last_viewed_at")
