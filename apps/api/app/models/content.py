import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Collection(Base):
    __tablename__ = "collections"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(255))
    subtitle: Mapped[str | None] = mapped_column(String(512))
    thesis: Mapped[str | None] = mapped_column(Text)
    collection_type: Mapped[str] = mapped_column(String(32))  # dynamic_discover | manual | creator | seasonal
    media_scope: Mapped[str] = mapped_column(String(8), default="mixed")  # movie | tv | mixed
    rule_config: Mapped[dict] = mapped_column(JSONB, default=dict)
    manual_tmdb_ids: Mapped[list] = mapped_column(JSONB, default=list)
    editorial_rank: Mapped[int] = mapped_column(Integer, default=100)
    active_from: Mapped[date | None] = mapped_column(Date)
    active_until: Mapped[date | None] = mapped_column(Date)
    refresh_policy: Mapped[str] = mapped_column(String(16), default="daily")  # hourly | daily | weekly | manual
    status: Mapped[str] = mapped_column(String(16), default="active")  # draft | active | archived
    cached_title_ids: Mapped[list] = mapped_column(JSONB, default=list)
    cached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ContentTitle(Base):
    __tablename__ = "content_titles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tmdb_id: Mapped[int] = mapped_column(Integer, unique=True)
    content_type: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(255))
    original_title: Mapped[str | None] = mapped_column(String(255))
    overview: Mapped[str | None] = mapped_column(Text)
    poster_url: Mapped[str | None] = mapped_column(String(512))
    backdrop_url: Mapped[str | None] = mapped_column(String(512))
    release_date: Mapped[date | None] = mapped_column(Date)
    tmdb_vote_average: Mapped[float | None] = mapped_column(Numeric(3, 1))
    genres: Mapped[list[str]] = mapped_column(JSONB, default=list)
    runtime_minutes: Mapped[int | None] = mapped_column(Integer)
    season_count: Mapped[int | None] = mapped_column(Integer)
    metadata_raw: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ContentAvailability(Base):
    __tablename__ = "content_availability"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    provider_code: Mapped[str] = mapped_column(String(64))
    provider_name: Mapped[str] = mapped_column(String(128))
    region_code: Mapped[str] = mapped_column(String(2), default="US")
    deeplink_url: Mapped[str | None] = mapped_column(String(512))
    web_url: Mapped[str | None] = mapped_column(String(512))
    affiliate_partner: Mapped[str | None] = mapped_column(String(64))
    is_connected_priority: Mapped[bool] = mapped_column(Boolean, default=False)
    monetization_type: Mapped[str] = mapped_column(String(16), default="flatrate")  # flatrate|free|ads|rent|buy
    tmdb_provider_id: Mapped[int | None] = mapped_column(Integer)
    logo_path: Mapped[str | None] = mapped_column(String(512))  # TMDB logo_path e.g. "/abc.jpg"
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Snip(Base):
    __tablename__ = "snips"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    content_title_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("content_titles.id"))
    image_url: Mapped[str | None] = mapped_column(String(512))
    match_status: Mapped[str] = mapped_column(String(16), default="pending")
    match_confidence: Mapped[float | None] = mapped_column(Numeric(3, 2))
    capture_source: Mapped[str] = mapped_column(String(32))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
