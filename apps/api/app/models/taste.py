import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserTasteProfile(Base):
    __tablename__ = "user_taste_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    top_genres: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    top_themes: Mapped[list[str]] = mapped_column(JSONB, default=list)
    top_platforms: Mapped[list[str]] = mapped_column(JSONB, default=list)
    favorite_eras: Mapped[list[str]] = mapped_column(JSONB, default=list)
    taste_labels: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    profile_summary: Mapped[str | None] = mapped_column(String(512))
    current_obsessions: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    top_posters: Mapped[list[str]] = mapped_column(JSONB, default=list)
    most_saved_genre: Mapped[str | None] = mapped_column(String(120))
    signal_counts: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CompatibilityScore(Base):
    __tablename__ = "compatibility_scores"
    __table_args__ = (
        UniqueConstraint("user_a_id", "user_b_id", name="uq_compatibility_pair"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_a_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    user_b_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    compatibility: Mapped[int] = mapped_column(Integer)
    shared_genres: Mapped[list[str]] = mapped_column(JSONB, default=list)
    shared_titles: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    shared_labels: Mapped[list[str]] = mapped_column(JSONB, default=list)
    shared_platforms: Mapped[list[str]] = mapped_column(JSONB, default=list)
    summary: Mapped[str | None] = mapped_column(String(280))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TeamAnalyticsSnapshot(Base):
    __tablename__ = "team_analytics"

    team_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teams.id"), primary_key=True)
    member_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    average_compatibility: Mapped[int] = mapped_column(Integer, default=0)
    most_aligned_pair: Mapped[dict] = mapped_column(JSONB, default=dict)
    most_divisive_member: Mapped[dict] = mapped_column(JSONB, default=dict)
    taste_mvp: Mapped[dict] = mapped_column(JSONB, default=dict)
    most_loved_title: Mapped[dict] = mapped_column(JSONB, default=dict)
    most_divisive_title: Mapped[dict] = mapped_column(JSONB, default=dict)
    genre_breakdown: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    activity_snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RecommendationSignal(Base):
    __tablename__ = "recommendation_signals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    signal_type: Mapped[str] = mapped_column(String(32))
    weight: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str | None] = mapped_column(String(280))
    metadata_json: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SwipeRecord(Base):
    __tablename__ = "swipe_records"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    direction: Mapped[str] = mapped_column(String(12))
    pause_ms: Mapped[int | None] = mapped_column(Integer)
    session_id: Mapped[str | None] = mapped_column(String(80))
    reason: Mapped[str | None] = mapped_column(String(280))
    source_surface: Mapped[str | None] = mapped_column(String(80))
    # Idempotency key per Onboarding spec §12 API behavior: "Swipe
    # writes must be idempotent to prevent double signals during
    # retry". Client-generated (UUID); server dedupes on
    # (user_id, idempotency_key). Nullable for backfill compat —
    # historical rows have no key, new writes should always supply one.
    idempotency_key: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WrappedStat(Base):
    __tablename__ = "wrapped_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "year", name="uq_wrapped_user_year"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    year: Mapped[int] = mapped_column(Integer)
    top_genre: Mapped[str | None] = mapped_column(String(120))
    most_saved_title: Mapped[str | None] = mapped_column(String(255))
    favorite_platform: Mapped[str | None] = mapped_column(String(120))
    titles_saved: Mapped[int] = mapped_column(Integer, default=0)
    reactions_count: Mapped[int] = mapped_column(Integer, default=0)
    top_label: Mapped[str | None] = mapped_column(String(120))
    stats: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ─── Intelligence Foundation (SceneDNA brief §15 + §28) ──────────────────────


class TitleFeatures(Base):
    """Semantic metadata layer per SceneDNA brief §7 + §8. Goes beyond TMDB
    genre so mood rails ("Dark & Cinematic", "Something Comforting") can be
    real attribute queries rather than keyword filters. Populated in two
    passes: v0 = derived from TMDB metadata, v1 = LLM-enriched."""

    __tablename__ = "title_features"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    content_title_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("content_titles.id", ondelete="CASCADE"), unique=True
    )
    # Controlled vocabularies — see app.services.title_features for the
    # authoritative lists. Deterministic overlap enables scoring without ML.
    tone: Mapped[list[str]] = mapped_column(JSONB, default=list)
    pacing: Mapped[str | None] = mapped_column(String(24))
    story_style: Mapped[list[str]] = mapped_column(JSONB, default=list)
    themes: Mapped[list[str]] = mapped_column(JSONB, default=list)
    visual_style: Mapped[list[str]] = mapped_column(JSONB, default=list)
    viewing_context: Mapped[list[str]] = mapped_column(JSONB, default=list)
    comfort_level: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    embedding: Mapped[list[float] | None] = mapped_column(JSONB)
    source: Mapped[str] = mapped_column(String(32), default="tmdb_v0")
    enrichment_version: Mapped[int] = mapped_column(Integer, default=0)
    enriched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserSignal(Base):
    """First-class taste signal per SceneDNA brief §15. Replaces on-the-fly
    derivation from UserTasteProfile.taste_labels; each signal now has its
    own persisted evidence, sample size, and trend so the signal detail
    view can honestly show *"11 saves, 4 ratings above 8, 3 recent swipe
    likes"* per §18."""

    __tablename__ = "user_signals"
    __table_args__ = (
        UniqueConstraint("user_id", "signal_type", "signal_name", name="uq_user_signal"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    signal_type: Mapped[str] = mapped_column(String(32))  # label | theme | genre | creator | tone | pacing
    signal_name: Mapped[str] = mapped_column(String(120))
    score: Mapped[Decimal] = mapped_column(Numeric(4, 3), default=Decimal("0"))
    confidence_tier: Mapped[str] = mapped_column(String(16), default="early")
    sample_size: Mapped[int] = mapped_column(Integer, default=0)
    trend: Mapped[str] = mapped_column(String(16), default="stable")  # rising | stable | fading
    positive_evidence: Mapped[list[str]] = mapped_column(JSONB, default=list)  # content_title_id strings
    negative_evidence: Mapped[list[str]] = mapped_column(JSONB, default=list)
    last_updated: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RecommendationImpression(Base):
    """Per SceneDNA brief §21. Every recommendation we surface is logged so
    we can answer "which recommendation sources actually cause saves." This
    replaces the old ephemeral RecommendationSignal table (which was cleared
    every request and had no attribution)."""

    __tablename__ = "recommendation_impressions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id", ondelete="CASCADE"))
    surface: Mapped[str] = mapped_column(String(48))  # swipe | scene_dna_rail | discover | ...
    mode: Mapped[str | None] = mapped_column(String(48))  # dark-cinematic | comfort | hidden-gems | ...
    position: Mapped[int | None] = mapped_column(Integer)
    score: Mapped[Decimal | None] = mapped_column(Numeric(5, 3))
    candidate_source: Mapped[str] = mapped_column(String(48))  # PICKS_SIMILARITY | SCENEDNA_MATCH | ...
    reason_type: Mapped[str | None] = mapped_column(String(48))
    algorithm_version: Mapped[str] = mapped_column(String(24), default="v1")
    scene_dna_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_id: Mapped[str | None] = mapped_column(String(96))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RecommendationFeedback(Base):
    """Per SceneDNA brief §21 + §28. Records the user's response to a
    specific impression so downstream ranking can learn — and so we can
    measure whether the personalized engine outperforms popularity."""

    __tablename__ = "recommendation_feedback"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    impression_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("recommendation_impressions.id", ondelete="CASCADE")
    )
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id", ondelete="CASCADE"))
    action: Mapped[str] = mapped_column(String(48))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
