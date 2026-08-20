"""Analytics events append-only log

Revision ID: 20260818_0015
Revises: 20260818_0014
Create Date: 2026-08-18 22:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260818_0015"
down_revision: str | None = "20260818_0014"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "analytics_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("event_name", sa.String(80), nullable=False),
        sa.Column("properties", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("platform", sa.String(16), nullable=True),
        sa.Column("app_build", sa.String(32), nullable=True),
        sa.Column("session_id", sa.String(80), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_analytics_events_event_name", "analytics_events", ["event_name"])
    op.create_index("ix_analytics_events_user_id", "analytics_events", ["user_id"])
    op.create_index("ix_analytics_events_occurred_at", "analytics_events", ["occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_analytics_events_occurred_at", table_name="analytics_events")
    op.drop_index("ix_analytics_events_user_id", table_name="analytics_events")
    op.drop_index("ix_analytics_events_event_name", table_name="analytics_events")
    op.drop_table("analytics_events")
