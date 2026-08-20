"""Intelligence foundation: TitleFeatures + UserSignal + RecommendationImpression/Feedback

Per SceneDNA Personalization brief §15 + §28 + §21. Establishes the durable
tables that back the personalization rebuild (Phase 3). Prior state derived
signals on the fly from UserTasteProfile — no per-signal evidence, no trend,
no confidence, no impression attribution. This migration adds:

  - title_features  → LLM-enrichable semantic layer (tone, pacing, story
                      style, themes, comfort_level, embedding placeholder).
                      Backfill job populates from TMDB metadata as a
                      first pass; LLM enrichment upgrades over time.
  - user_signals    → first-class UserSignal rows so /scene-dna/signals/{id}
                      can show per-signal evidence + trend + sample_size.
  - recommendation_impressions
                    → every rec surfaced to a user with source/score/reason,
                      so we can attribute "user saved Arrival because Discover
                      recommended it" vs "user saved Arrival organically."
  - recommendation_feedback
                    → the action taken on an impression (open/save/dismiss).

Revision ID: 20260820_0018
Revises: 20260819_0017
Create Date: 2026-08-20 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260820_0018"
down_revision: str | None = "20260819_0017"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # ── TitleFeatures ──────────────────────────────────────────────────────
    op.create_table(
        "title_features",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "content_title_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("content_titles.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        # Semantic attributes — arrays of controlled vocabulary strings so
        # scoring can compute overlap deterministically. LLM enrichment can
        # populate these; TMDB metadata seeds a v0 attempt.
        sa.Column("tone", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("pacing", sa.String(24), nullable=True),
        sa.Column("story_style", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("themes", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("visual_style", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("viewing_context", postgresql.JSONB, nullable=False, server_default="[]"),
        # 0.0 = very intense / dark, 1.0 = comfort food.
        sa.Column("comfort_level", sa.Numeric(3, 2), nullable=True),
        # Reserved for future vector-search backends.
        sa.Column("embedding", postgresql.JSONB, nullable=True),
        # Provenance so we can distinguish TMDB-derived v0 from LLM-enriched v1.
        sa.Column("source", sa.String(32), nullable=False, server_default="tmdb_v0"),
        sa.Column("enrichment_version", sa.Integer, nullable=False, server_default="0"),
        sa.Column("enriched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_title_features_content_title_id", "title_features", ["content_title_id"])
    op.create_index("ix_title_features_pacing", "title_features", ["pacing"])
    op.create_index("ix_title_features_source", "title_features", ["source"])

    # ── UserSignal ─────────────────────────────────────────────────────────
    op.create_table(
        "user_signals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # signal_type = category (label/theme/genre/creator); signal_name is
        # the specific value ("Prestige Drama", "Slow Burn", "Drama").
        sa.Column("signal_type", sa.String(32), nullable=False),
        sa.Column("signal_name", sa.String(120), nullable=False),
        # Normalized score 0-1. Confidence tier derived from sample_size +
        # score coherence.
        sa.Column("score", sa.Numeric(4, 3), nullable=False, server_default="0"),
        sa.Column("confidence_tier", sa.String(16), nullable=False, server_default="early"),
        sa.Column("sample_size", sa.Integer, nullable=False, server_default="0"),
        sa.Column("trend", sa.String(16), nullable=False, server_default="stable"),
        # Evidence links — arrays of content_title_id strings. Positive =
        # titles that DROVE the signal up; negative = user actions that
        # actively suppress it (dismissed / left-swiped / removed).
        sa.Column("positive_evidence", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("negative_evidence", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("last_updated", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "signal_type", "signal_name", name="uq_user_signal"),
    )
    op.create_index("ix_user_signals_user_id", "user_signals", ["user_id"])
    op.create_index("ix_user_signals_user_score", "user_signals", ["user_id", "score"])

    # ── RecommendationImpression ───────────────────────────────────────────
    op.create_table(
        "recommendation_impressions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "content_title_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("content_titles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Where this impression was served (module/rail identifier).
        sa.Column("surface", sa.String(48), nullable=False),
        sa.Column("mode", sa.String(48), nullable=True),  # e.g. "dark-cinematic"
        sa.Column("position", sa.Integer, nullable=True),
        # Score + candidate source + reason ref for post-hoc attribution.
        sa.Column("score", sa.Numeric(5, 3), nullable=True),
        sa.Column("candidate_source", sa.String(48), nullable=False),  # PICKS_SIMILARITY etc.
        sa.Column("reason_type", sa.String(48), nullable=True),
        sa.Column("algorithm_version", sa.String(24), nullable=False, server_default="v1"),
        sa.Column("scene_dna_snapshot_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("session_id", sa.String(96), nullable=True),
        sa.Column("payload", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_rec_impressions_user_created", "recommendation_impressions", ["user_id", "created_at"])
    op.create_index("ix_rec_impressions_user_title", "recommendation_impressions", ["user_id", "content_title_id"])
    op.create_index("ix_rec_impressions_source", "recommendation_impressions", ["candidate_source"])

    # ── RecommendationFeedback ─────────────────────────────────────────────
    op.create_table(
        "recommendation_feedback",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "impression_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("recommendation_impressions.id", ondelete="CASCADE"),
            nullable=True,  # nullable because we sometimes only know title, not impression
        ),
        sa.Column(
            "content_title_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("content_titles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # open / save / dismiss / swipe_right / swipe_left / watch_now / share
        # / signal_less_like / signal_not_me
        sa.Column("action", sa.String(48), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_rec_feedback_user_created", "recommendation_feedback", ["user_id", "created_at"])
    op.create_index("ix_rec_feedback_impression", "recommendation_feedback", ["impression_id"])
    op.create_index("ix_rec_feedback_action", "recommendation_feedback", ["action"])


def downgrade() -> None:
    op.drop_index("ix_rec_feedback_action", table_name="recommendation_feedback")
    op.drop_index("ix_rec_feedback_impression", table_name="recommendation_feedback")
    op.drop_index("ix_rec_feedback_user_created", table_name="recommendation_feedback")
    op.drop_table("recommendation_feedback")

    op.drop_index("ix_rec_impressions_source", table_name="recommendation_impressions")
    op.drop_index("ix_rec_impressions_user_title", table_name="recommendation_impressions")
    op.drop_index("ix_rec_impressions_user_created", table_name="recommendation_impressions")
    op.drop_table("recommendation_impressions")

    op.drop_index("ix_user_signals_user_score", table_name="user_signals")
    op.drop_index("ix_user_signals_user_id", table_name="user_signals")
    op.drop_table("user_signals")

    op.drop_index("ix_title_features_source", table_name="title_features")
    op.drop_index("ix_title_features_pacing", table_name="title_features")
    op.drop_index("ix_title_features_content_title_id", table_name="title_features")
    op.drop_table("title_features")
