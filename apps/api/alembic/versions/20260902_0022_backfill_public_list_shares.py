"""Backfill public list shares for every existing watchlist.

Product decision (2026-09-02): all lists are public-by-default. For new
lists, `services/watchlists._ensure_public_share` mints a token at
creation time. This migration covers the historical case — every
Watchlist that doesn't already have an active (non-revoked) ListShare
gets one, so every existing user's lists become shareable via URL
without any action on their part.

Revision ID: 20260902_0022
Revises: 20260902_0021
Create Date: 2026-09-02 00:00:00.000000
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import Sequence

from alembic import op


revision: str = "20260902_0022"
down_revision: str | None = "20260902_0021"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    # Find every watchlist that has NO active (non-revoked) share.
    rows = conn.execute(
        # NOT EXISTS pattern is dialect-agnostic and cheap on the
        # (small) list_shares table with the ix_list_shares_watchlist_id
        # index that already exists.
        _NEEDS_SHARE_SQL
    ).fetchall()

    if not rows:
        return

    # Insert one ListShare per orphan list. Token is URL-safe base64
    # (secrets.token_urlsafe(24) matches the runtime helper).
    for row in rows:
        watchlist_id = row[0]
        owner_user_id = row[1]
        conn.execute(
            _INSERT_SHARE_SQL,
            {
                "id": str(uuid.uuid4()),
                "watchlist_id": str(watchlist_id),
                "owner_user_id": str(owner_user_id),
                "token": secrets.token_urlsafe(24),
            },
        )


def downgrade() -> None:
    # No safe automatic downgrade — we can't distinguish shares this
    # migration created from ones users manually minted. Left as no-op;
    # the correct undo is to `revoke_at` specific tokens per user.
    pass


# Kept as bound SQL statements below the code so the upgrade() body
# stays readable.
from sqlalchemy import text  # noqa: E402

_NEEDS_SHARE_SQL = text(
    """
    SELECT w.id, w.owner_user_id
    FROM watchlists w
    WHERE NOT EXISTS (
        SELECT 1 FROM list_shares s
        WHERE s.watchlist_id = w.id
          AND s.revoked_at IS NULL
    )
    """
)

_INSERT_SHARE_SQL = text(
    """
    INSERT INTO list_shares (
        id, watchlist_id, created_by_user_id, token, visibility,
        revoked_at, open_count, created_at
    ) VALUES (
        :id, :watchlist_id, :owner_user_id, :token, 'public',
        NULL, 0, NOW()
    )
    """
)
