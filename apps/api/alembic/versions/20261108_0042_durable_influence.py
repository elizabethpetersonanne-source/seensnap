"""Keep swipe influence corrections after short-term history pruning."""

from alembic import op
import sqlalchemy as sa

revision = "20261108_0042"
down_revision = "20261108_0041"
branch_labels = depends_on = None


def upgrade():
    op.add_column("discovery_decisions", sa.Column("action_version", sa.Integer(), nullable=True))
    op.add_column(
        "discovery_decisions",
        sa.Column("influence_disabled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        "UPDATE discovery_decisions d SET action_version=s.action_version, influence_disabled_at=s.influence_disabled_at FROM swipe_records s WHERE s.id=d.id AND s.user_id=d.user_id"
    )
    # Unknown historical versions remain NULL; do not reinterpret old Up gestures.


def downgrade():
    raise RuntimeError("Durable influence corrections require a reviewed data-preserving rollback.")
