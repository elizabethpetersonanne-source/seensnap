"""notification push schema

Revision ID: 20260818_0011
Revises: 20260818_0010
Create Date: 2026-08-18 12:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "20260818_0011"
down_revision = "20260818_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── devices: rename push_token → expo_push_token, add new fields ──────────
    op.alter_column("devices", "push_token", new_column_name="expo_push_token")
    op.add_column("devices", sa.Column("app_env", sa.String(16), nullable=True))
    op.add_column("devices", sa.Column("app_build", sa.String(32), nullable=True))
    op.add_column("devices", sa.Column("permission_state", sa.String(16), nullable=True))
    op.add_column("devices", sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("devices", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_devices_user_enabled", "devices", ["user_id", "enabled"])

    # ── notifications: add fields for push payload and deduplication ───────────
    op.add_column("notifications", sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("notifications", sa.Column("dedupe_key", sa.String(255), nullable=True))
    op.add_column("notifications", sa.Column("is_demo", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("notifications", sa.Column("actor_user_id", UUID(as_uuid=True), nullable=True))
    op.add_column("notifications", sa.Column("entity_type", sa.String(32), nullable=True))
    op.add_column("notifications", sa.Column("entity_id", UUID(as_uuid=True), nullable=True))
    op.add_column("notifications", sa.Column("route", sa.String(255), nullable=True))
    op.create_index("ix_notifications_dedupe_key", "notifications", ["dedupe_key"])
    op.create_index("ix_notifications_user_created", "notifications", ["user_id", "created_at"])

    # ── notification_preferences ───────────────────────────────────────────────
    op.create_table(
        "notification_preferences",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("team_activity", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("direct_engagement", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("recommendations", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("availability", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("marketing", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("push_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # ── notification_outbox: durable push delivery jobs ────────────────────────
    op.create_table(
        "notification_outbox",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "notification_id",
            UUID(as_uuid=True),
            sa.ForeignKey("notifications.id"),
            nullable=False,
        ),
        sa.Column(
            "device_id",
            UUID(as_uuid=True),
            sa.ForeignKey("devices.id"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(32), nullable=False, server_default="expo"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("provider_ticket_id", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_notification_outbox_status_next", "notification_outbox", ["status", "next_attempt_at"])
    op.create_index("ix_notification_outbox_device_id", "notification_outbox", ["device_id"])
    op.create_index("ix_notification_outbox_ticket", "notification_outbox", ["provider_ticket_id"])


def downgrade() -> None:
    op.drop_index("ix_notification_outbox_ticket", "notification_outbox")
    op.drop_index("ix_notification_outbox_device_id", "notification_outbox")
    op.drop_index("ix_notification_outbox_status_next", "notification_outbox")
    op.drop_table("notification_outbox")

    op.drop_table("notification_preferences")

    op.drop_index("ix_notifications_user_created", "notifications")
    op.drop_index("ix_notifications_dedupe_key", "notifications")
    op.drop_column("notifications", "route")
    op.drop_column("notifications", "entity_id")
    op.drop_column("notifications", "entity_type")
    op.drop_column("notifications", "actor_user_id")
    op.drop_column("notifications", "is_demo")
    op.drop_column("notifications", "dedupe_key")
    op.drop_column("notifications", "opened_at")

    op.drop_index("ix_devices_user_enabled", "devices")
    op.drop_column("devices", "last_seen_at")
    op.drop_column("devices", "enabled")
    op.drop_column("devices", "permission_state")
    op.drop_column("devices", "app_build")
    op.drop_column("devices", "app_env")
    op.alter_column("devices", "expo_push_token", new_column_name="push_token")
