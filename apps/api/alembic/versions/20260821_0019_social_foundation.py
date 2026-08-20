"""Social foundation — blocks, reports, list_saves + FeedEvent social scope

Per Social brief §16–§25 + §52–§54.

Reuses the existing `feed_events` table for social posts (visibility + optional
rating/list references added) rather than creating a parallel table — every
"post" is still a FeedEvent, just with `team_id = NULL` and `visibility` set.
The rating and list domains stay canonical (ratings + watchlists tables
already exist); a social post REFERENCES them rather than embedding.

Added tables:
  - blocks       — asymmetric user-blocks; supersedes follow relationships
  - reports      — moderation queue for profile / post / comment
  - list_saves   — "save someone else's public list" so a user can follow
                   another user's watchlist without duplicating titles

Added columns on feed_events:
  - visibility   — public | followers | private | team (default 'team' for
                   back-compat with existing team-scoped events)
  - rating_id    — references the canonical rating a post is about
  - list_id      — references a watchlist for list_share / list_publish posts

Revision ID: 20260821_0019
Revises: 20260820_0018
Create Date: 2026-08-21 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260821_0019"
down_revision: str | None = "20260820_0018"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # ── blocks ──────────────────────────────────────────────────────────────
    op.create_table(
        "blocks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "blocker_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "blocked_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("blocker_user_id", "blocked_user_id", name="uq_block_pair"),
        sa.CheckConstraint("blocker_user_id <> blocked_user_id", name="ck_no_self_block"),
    )
    op.create_index("ix_blocks_blocker", "blocks", ["blocker_user_id"])
    op.create_index("ix_blocks_blocked", "blocks", ["blocked_user_id"])

    # ── reports ─────────────────────────────────────────────────────────────
    op.create_table(
        "reports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "reporter_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "reported_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "feed_event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("feed_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "comment_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("feed_comments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # harassment | hate | spam | inappropriate | impersonation | other
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column("notes", sa.String(1000), nullable=True),
        # open | reviewing | resolved | dismissed
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_reports_reporter", "reports", ["reporter_user_id"])
    op.create_index("ix_reports_status", "reports", ["status"])

    # ── list_saves ──────────────────────────────────────────────────────────
    # A user follows another user's public list (references canonical
    # watchlist so title changes propagate). Does NOT duplicate titles.
    op.create_table(
        "list_saves",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "watchlist_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("watchlists.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "watchlist_id", name="uq_list_save"),
    )
    op.create_index("ix_list_saves_user", "list_saves", ["user_id"])
    op.create_index("ix_list_saves_watchlist", "list_saves", ["watchlist_id"])

    # ── feed_events additions for social scope ─────────────────────────────
    # Existing feed_events rows (team activity) default to visibility='team'
    # so their exposure is unchanged; new social posts write visibility
    # 'public' | 'followers' | 'private' explicitly.
    op.add_column(
        "feed_events",
        sa.Column("visibility", sa.String(16), nullable=False, server_default="team"),
    )
    op.add_column(
        "feed_events",
        sa.Column(
            "rating_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ratings.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "feed_events",
        sa.Column(
            "list_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("watchlists.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_feed_events_visibility", "feed_events", ["visibility"])
    op.create_index("ix_feed_events_actor_created", "feed_events", ["actor_user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_feed_events_actor_created", table_name="feed_events")
    op.drop_index("ix_feed_events_visibility", table_name="feed_events")
    op.drop_column("feed_events", "list_id")
    op.drop_column("feed_events", "rating_id")
    op.drop_column("feed_events", "visibility")

    op.drop_index("ix_list_saves_watchlist", table_name="list_saves")
    op.drop_index("ix_list_saves_user", table_name="list_saves")
    op.drop_table("list_saves")

    op.drop_index("ix_reports_status", table_name="reports")
    op.drop_index("ix_reports_reporter", table_name="reports")
    op.drop_table("reports")

    op.drop_index("ix_blocks_blocked", table_name="blocks")
    op.drop_index("ix_blocks_blocker", table_name="blocks")
    op.drop_table("blocks")
