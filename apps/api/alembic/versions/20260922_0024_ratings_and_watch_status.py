"""Ratings 1-10 hardening + watch status

Sep-22 execution brief §7:
  - Ratings become an integer 1-10 canonical personal score. Legacy
    Numeric(3,1) column stays for backward compat with 5.0-style half-
    star data but a check constraint bounds new writes to [1, 10] and
    the API rejects non-integer submissions.
  - Adds watched_state (want_to_watch | watched) so we can represent
    Watched-but-unrated titles alongside rated ones.
  - Adds version for optimistic-concurrency conflict detection so an
    out-of-order retry can't overwrite a newer rating.

Also creates title_watch_status so a saved-but-not-yet-rated title
can carry a Want to Watch / Watched flag independent of the rating
row (a save with Want to Watch has no rating row at all).

Revision ID: 20260922_0024
Revises: 20260902_0023
Create Date: 2026-09-22 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260922_0024"
down_revision: str | None = "20260902_0023"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ratings",
        sa.Column("watched_state", sa.String(16), nullable=False, server_default="watched"),
    )
    op.add_column(
        "ratings",
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
    )
    # Clamp any legacy out-of-range value to the 1-10 window so the
    # check constraint below can be applied cleanly. Anything below 1
    # snaps to 1; anything above 10 snaps to 10. Legacy 0.5-decimal
    # scores stay as-is (Numeric(3,1) preserves them) and the API
    # returns them rounded up on read; new writes are integer-only.
    op.execute("UPDATE ratings SET score = 1 WHERE score < 1")
    op.execute("UPDATE ratings SET score = 10 WHERE score > 10")
    op.create_check_constraint(
        "ck_rating_score_1_10",
        "ratings",
        "score >= 1 AND score <= 10",
    )

    op.create_table(
        "title_watch_status",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content_title_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("content_titles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("watched_state", sa.String(16), nullable=False, server_default="want_to_watch"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "content_title_id", name="uq_watch_status_user_title"),
    )
    op.create_index("ix_title_watch_status_user", "title_watch_status", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_title_watch_status_user", table_name="title_watch_status")
    op.drop_table("title_watch_status")
    op.drop_constraint("ck_rating_score_1_10", "ratings")
    op.drop_column("ratings", "version")
    op.drop_column("ratings", "watched_state")
