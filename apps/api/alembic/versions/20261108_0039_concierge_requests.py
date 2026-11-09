"""Owner-scoped durable Concierge requests with leased recovery."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg
revision = "20261108_0039"
down_revision = "20261108_0038"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("concierge_requests",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("idempotency_key", sa.String(96), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("lease_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("decision_id", pg.UUID(as_uuid=True), sa.ForeignKey("concierge_decisions.id")),
        sa.Column("response", pg.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_concierge_request_retry"),
    )
    op.create_index("ix_concierge_requests_user_id", "concierge_requests", ["user_id"])


def downgrade():
    raise RuntimeError("Retain Concierge request receipts. Review/export them before any manual rollback.")
