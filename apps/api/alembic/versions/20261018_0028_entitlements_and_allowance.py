"""Entitlement grants + Concierge allowance ledger

Oct-18 build brief §9: server-authoritative entitlements. One Premium
beta grant for every current + new user. Independent grant records so
earned/promo time is not consumed by purchase overlap.

Tables:

  entitlement_grants
    - user_id, source ('beta' | 'purchase' | 'earned' | 'promo' | 'legacy')
    - tier ('premium' | 'free')
    - starts_at / ends_at (nullable; null ends_at = indefinite)
    - verified (bool; store-event-verified or server-granted)
    - provider_product_id, provider_transaction_id (nullable)
    - revoked_at (nullable)

  concierge_allowance_entries
    - user_id, period_start (first of month UTC), period_end
    - decision_id (uuid), state ('reserved' | 'consumed' | 'released')
    - reserved_at / finalized_at
    - idempotency_key (unique for retries)

Also backfills a beta Premium grant for every existing user with
source='beta' and verified=true. Future beta signups receive the same
grant from the signup flow.

Revision ID: 20261018_0028
Revises: 20261018_0027
Create Date: 2026-10-18 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


revision: str = "20261018_0028"
down_revision: str | None = "20261018_0027"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "entitlement_grants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("tier", sa.String(16), nullable=False, server_default="premium"),
        sa.Column("starts_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("provider_product_id", sa.String(128), nullable=True),
        sa.Column("provider_transaction_id", sa.String(128), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_entitlement_grants_user", "entitlement_grants", ["user_id"])
    op.create_index(
        "ix_entitlement_grants_active_user",
        "entitlement_grants",
        ["user_id", "ends_at"],
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    # Oct-18 brief §3 fix 2: bounded Previews cursor. The previous
    # cursor packed served UUIDs into the opaque string which blew
    # past the 512-char route limit after ~10 titles. Server-side
    # session store keyed by UUID; the client-visible cursor is just
    # `session_id:page_offset`.
    op.create_table(
        "preview_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("filter_fingerprint", sa.String(96), nullable=False),
        sa.Column("served_title_ids", postgresql.ARRAY(postgresql.UUID(as_uuid=True)), nullable=False, server_default="{}"),
        sa.Column("scan_offset", sa.Integer, nullable=False, server_default="0"),
        sa.Column("exhausted", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_preview_sessions_user", "preview_sessions", ["user_id", "updated_at"])

    op.create_table(
        "concierge_allowance_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decision_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="reserved"),
        sa.Column("idempotency_key", sa.String(96), nullable=False),
        sa.Column("reserved_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finalized_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_allowance_user_idempotency"),
    )
    op.create_index("ix_allowance_period", "concierge_allowance_entries", ["user_id", "period_start"])

    # Backfill: every existing user receives one indefinite beta Premium grant.
    # Future users receive the same grant from the signup/auth flow.
    op.execute(
        text(
            """
            INSERT INTO entitlement_grants (id, user_id, source, tier, verified, payload)
            SELECT gen_random_uuid(), id, 'beta', 'premium', true,
                   jsonb_build_object('reason', 'beta_backfill_2026-10-18')
            FROM users
            WHERE is_demo IS NOT TRUE
            """
        )
    )


def downgrade() -> None:
    op.drop_index("ix_allowance_period", table_name="concierge_allowance_entries")
    op.drop_table("concierge_allowance_entries")
    op.drop_index("ix_preview_sessions_user", table_name="preview_sessions")
    op.drop_table("preview_sessions")
    op.drop_index("ix_entitlement_grants_active_user", table_name="entitlement_grants")
    op.drop_index("ix_entitlement_grants_user", table_name="entitlement_grants")
    op.drop_table("entitlement_grants")
