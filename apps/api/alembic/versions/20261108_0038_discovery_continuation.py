"""Durable discovery action counting and owner-bound feed cursors."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = "20261108_0038"
down_revision = "20261108_0037"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("discovery_decisions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("content_title_id", pg.UUID(as_uuid=True), sa.ForeignKey("content_titles.id"), nullable=False),
        sa.Column("sequence", sa.BigInteger()),
        sa.Column("direction", sa.String(12), nullable=False),
        sa.Column("idempotency_key", sa.String(80)),
        sa.Column("state_before", pg.JSONB(), nullable=False, server_default="{}"),
        sa.Column("state_after", pg.JSONB(), nullable=False, server_default="{}"),
        sa.Column("undone_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "sequence", name="uq_discovery_decision_sequence"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_discovery_decision_retry"),
    )
    op.create_index("ix_discovery_decisions_user_id", "discovery_decisions", ["user_id"])
    op.create_index("ix_discovery_decisions_content_title_id", "discovery_decisions", ["content_title_id"])
    # Retained legacy history is the only evidence available. Do not invent
    # events already pruned by previous releases. Unknown prior state is not
    # reconstructed for destructive Undo.
    op.execute("""INSERT INTO discovery_decisions
        (id, user_id, content_title_id, sequence, direction, idempotency_key, created_at)
        SELECT id, user_id, content_title_id,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id),
          direction, idempotency_key, created_at
        FROM swipe_records
        WHERE COALESCE(source_surface, '') NOT LIKE 'onboarding%'
          AND direction IN ('left', 'right', 'up', 'down')""")
    op.create_table("discovery_sessions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("state", pg.JSONB(), nullable=False, server_default="{}"),
        sa.Column("last_response", pg.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_discovery_sessions_user_id", "discovery_sessions", ["user_id"])


def downgrade():
    raise RuntimeError("Discovery history must be retained. Review and export it before any manual schema rollback.")
