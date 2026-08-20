"""List share tokens

Revision ID: 20260819_0016
Revises: 20260818_0015
Create Date: 2026-08-19 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260819_0016"
down_revision: str | None = "20260818_0015"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "list_shares",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("watchlist_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("watchlists.id"), nullable=False),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token", sa.String(48), nullable=False),
        sa.Column("visibility", sa.String(16), nullable=False, server_default="link"),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("open_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("token", name="uq_list_share_token"),
    )
    op.create_index("ix_list_shares_watchlist_id", "list_shares", ["watchlist_id"])
    op.create_index("ix_list_shares_created_by_user_id", "list_shares", ["created_by_user_id"])


def downgrade() -> None:
    op.drop_index("ix_list_shares_created_by_user_id", table_name="list_shares")
    op.drop_index("ix_list_shares_watchlist_id", table_name="list_shares")
    op.drop_table("list_shares")
