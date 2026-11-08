"""Explicit private team state and durable bounded image assets."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = "20261108_0040"
down_revision = "20261108_0039"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "team_title_states",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "team_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("teams.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "content_title_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("content_titles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("shared_rating", sa.Integer()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("team_id", "user_id", "content_title_id", name="uq_team_title_state"),
    )
    op.create_index("ix_team_title_states_team_id", "team_title_states", ["team_id"])
    op.create_table(
        "media_assets",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "owner_user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("team_id", pg.UUID(as_uuid=True), sa.ForeignKey("teams.id", ondelete="CASCADE")),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_media_assets_owner_user_id", "media_assets", ["owner_user_id"])


def downgrade():
    raise RuntimeError(
        "Export team-shared states and image assets before any reviewed manual rollback."
    )
