"""People discovery — discovery_enabled on user_profiles + people_dismissals table

Per People Discovery spec §10 + §13.

Adds:
  - user_profiles.discovery_enabled  bool default true
    Existing accounts default to discoverable — consistent with the current
    Social visibility model. Users can opt out in Privacy settings later.
  - people_dismissals table  (viewer_user_id, candidate_user_id, created_at)
    Records "Not interested" so the same candidate doesn't reappear for at
    least 30 days per spec §10 dismissal rule.

Revision ID: 20260902_0021
Revises: 20260822_0020
Create Date: 2026-09-02 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260902_0021"
down_revision: str | None = "20260822_0020"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_profiles",
        sa.Column(
            "discovery_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )

    op.create_table(
        "people_dismissals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "viewer_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "candidate_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("viewer_user_id", "candidate_user_id", name="uq_people_dismissal_pair"),
        sa.CheckConstraint("viewer_user_id <> candidate_user_id", name="ck_no_self_dismissal"),
    )
    op.create_index(
        "ix_people_dismissals_viewer",
        "people_dismissals",
        ["viewer_user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_people_dismissals_viewer", table_name="people_dismissals")
    op.drop_table("people_dismissals")
    op.drop_column("user_profiles", "discovery_enabled")
