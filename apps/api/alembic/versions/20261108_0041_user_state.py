"""Persistent title revisions and owner-only onboarding drafts."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = "20261108_0041"
down_revision = "20261108_0040"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "user_title_revisions",
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "content_title_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("content_titles.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.execute(
        "INSERT INTO user_title_revisions (user_id,content_title_id,version,updated_at) SELECT user_id,content_title_id,version,updated_at FROM ratings"
    )
    op.create_table(
        "onboarding_drafts",
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("data", pg.JSONB(), nullable=False, server_default="{}"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade():
    raise RuntimeError(
        "Persistent revisions and onboarding drafts require a reviewed data-preserving rollback."
    )
