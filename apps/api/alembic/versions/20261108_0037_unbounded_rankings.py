"""Remove the obsolete 100-title ranking constraint.

Revision ID: 20261108_0037
Revises: 20261028_0036
"""

from alembic import op
import sqlalchemy as sa

revision = "20261108_0037"
down_revision = "20261028_0036"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("ck_ranked_favorite_position_range", "ranked_favorites", type_="check")
    op.create_check_constraint(
        "ck_ranked_favorite_position_range", "ranked_favorites", "position >= 1"
    )


def downgrade():
    # Never silently delete or truncate a person's manual rankings.
    if op.get_bind().scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM ranked_favorites WHERE position > 100)")
    ):
        raise RuntimeError("Cannot restore the 100-title limit while longer rankings exist")
    op.drop_constraint("ck_ranked_favorite_position_range", "ranked_favorites", type_="check")
    op.create_check_constraint(
        "ck_ranked_favorite_position_range", "ranked_favorites", "position >= 1 AND position <= 100"
    )
