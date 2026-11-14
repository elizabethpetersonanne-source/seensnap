"""Consolidate legacy queues without broadening list audiences; invalidate taste.

Revision ID: 20261113_0043
Revises: 20261108_0042
"""
from datetime import datetime, timezone
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision = "20261113_0043"
down_revision = "20261108_0042"
branch_labels = None
depends_on = None


def reconcile_queues(connection):
    """Keep originals and their shares. Union only identified generated queues.

    Never infer that a user-created list is a queue from its name alone. Never
    copy private titles into a public/followers list. Original memberships,
    notes, ordering and URLs remain available as previous collections.
    """
    metadata = sa.MetaData()
    lists = sa.Table("watchlists", metadata, autoload_with=connection)
    items = sa.Table("watchlist_items", metadata, autoload_with=connection)
    imports = sa.Table("watchlist_queue_imports", metadata, autoload_with=connection)
    names = {"my picks", "want to watch", "next watch", "my next watch"}
    rows = connection.execute(sa.select(lists).order_by(lists.c.created_at, lists.c.id)).mappings().all()
    by_owner = {}
    for row in rows:
        if row["merged_into_id"] is None and (
            row["system_role"] == "next_watch"
            or row["is_default"]
            or (row["is_system_list"] and row["name"].strip().casefold() in names)
        ):
            by_owner.setdefault(row["owner_user_id"], []).append(row)
    for owner, sources in by_owner.items():
        canonical = next((r for r in sources if r["system_role"] == "next_watch" and r["visibility"] == "private"), None)
        if canonical is None:
            canonical = next((r for r in sources if r["visibility"] == "private"), None)
        connection.execute(lists.update().where(lists.c.owner_user_id == owner).values(is_default=False))
        connection.execute(lists.update().where(lists.c.owner_user_id == owner, lists.c.system_role == "next_watch").values(system_role=None))
        if canonical is None:
            canonical_id = uuid4()
            connection.execute(lists.insert().values(id=canonical_id, owner_user_id=owner,
                name="My Next Watch", description="Titles you want to watch next.", visibility="private",
                is_default=True, is_system_list=True, system_role="next_watch"))
        else:
            canonical_id = canonical["id"]
            connection.execute(lists.update().where(lists.c.id == canonical_id).values(
                name="My Next Watch", is_default=True, is_system_list=True, system_role="next_watch"))
        existing = set(connection.execute(sa.select(items.c.content_title_id).where(items.c.watchlist_id == canonical_id)).scalars())
        source_ids = [r["id"] for r in sources if r["id"] != canonical_id]
        for item in connection.execute(sa.select(items).where(items.c.watchlist_id.in_(source_ids)).order_by(items.c.created_at, items.c.id)).mappings():
            connection.execute(imports.insert().values(source_item_id=item["id"], source_list_id=item["watchlist_id"], queue_id=canonical_id))
            if item["content_title_id"] in existing:
                continue
            connection.execute(items.insert().values(id=uuid4(), watchlist_id=canonical_id,
                content_title_id=item["content_title_id"], added_via="queue_migration",
                notes=item["notes"], position=item["position"], created_at=item["created_at"]))
            existing.add(item["content_title_id"])
        if source_ids:
            connection.execute(lists.update().where(lists.c.id.in_(source_ids)).values(
                merged_into_id=canonical_id, is_default=False, is_system_list=False, system_role=None))


def upgrade():
    op.add_column("users", sa.Column("taste_version", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("user_taste_profiles", sa.Column("source_version", sa.Integer(), nullable=False, server_default="-1"))
    for field in ("user_a_version", "user_b_version", "rated_count_a", "rated_count_b"):
        op.add_column("compatibility_scores", sa.Column(field, sa.Integer(), nullable=False,
            server_default="-1" if field.endswith("version") else "0"))
    op.add_column("watchlists", sa.Column("merged_into_id", sa.UUID(), nullable=True))
    op.create_foreign_key("fk_watchlist_merged_into", "watchlists", "watchlists", ["merged_into_id"], ["id"], ondelete="SET NULL")
    op.create_table("watchlist_queue_imports",
        sa.Column("source_item_id", sa.UUID(), primary_key=True),
        sa.Column("source_list_id", sa.UUID(), sa.ForeignKey("watchlists.id", ondelete="CASCADE"), nullable=False),
        sa.Column("queue_id", sa.UUID(), sa.ForeignKey("watchlists.id", ondelete="CASCADE"), nullable=False))
    reconcile_queues(op.get_bind())
    stale = datetime(1970, 1, 1, tzinfo=timezone.utc)
    for name, field in (("user_taste_profiles", "updated_at"), ("user_signals", "last_updated"), ("compatibility_scores", "updated_at")):
        table = sa.table(name, sa.column(field, sa.DateTime(timezone=True)))
        op.get_bind().execute(table.update().values({field: stale}))
    # The canonical role already has a unique index. Do not add a unique
    # is_default constraint: the previous API may still write legacy defaults
    # while traffic drains, or after an emergency traffic rollback.


def downgrade():
    # Data consolidation is deliberately not reversed: that would discard new
    # saves or restore duplicate defaults. Original source lists remain intact.
    op.drop_table("watchlist_queue_imports")
    op.drop_constraint("fk_watchlist_merged_into", "watchlists", type_="foreignkey")
    op.drop_column("watchlists", "merged_into_id")
    for field in ("user_a_version", "user_b_version", "rated_count_a", "rated_count_b"):
        op.drop_column("compatibility_scores", field)
    op.drop_column("user_taste_profiles", "source_version")
    op.drop_column("users", "taste_version")
