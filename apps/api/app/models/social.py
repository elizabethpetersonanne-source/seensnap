import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Rating(Base):
    __tablename__ = "ratings"
    __table_args__ = (UniqueConstraint("user_id", "content_title_id", name="uq_rating_user_title"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    score: Mapped[float] = mapped_column(Numeric(3, 1))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Review(Base):
    __tablename__ = "reviews"
    __table_args__ = (UniqueConstraint("user_id", "content_title_id", name="uq_review_user_title"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    rating_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ratings.id"))
    body: Mapped[str | None] = mapped_column(Text)
    emoji_reaction: Mapped[str | None] = mapped_column(String(32))
    contains_spoilers: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Watchlist(Base):
    __tablename__ = "watchlists"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(String(280))
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    is_system_list: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    __table_args__ = (UniqueConstraint("watchlist_id", "content_title_id", name="uq_watchlist_item"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    watchlist_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("watchlists.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    added_via: Mapped[str] = mapped_column(String(32))
    notes: Mapped[str | None] = mapped_column(String(280))
    position: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ListShare(Base):
    """Public share token for a Watchlist. Sharer generates one via POST
    /me/watchlist/lists/{id}/share; anyone with the token can view the list via
    GET /public/lists/{token}. Revocable — sets `revoked_at` and the public
    endpoint 404s."""
    __tablename__ = "list_shares"
    __table_args__ = (UniqueConstraint("token", name="uq_list_share_token"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    watchlist_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("watchlists.id"))
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    token: Mapped[str] = mapped_column(String(48))
    visibility: Mapped[str] = mapped_column(String(16), default="link")  # "link" | "public"
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    open_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(140), unique=True)
    description: Mapped[str | None] = mapped_column(String(280))
    visibility: Mapped[str] = mapped_column(String(16), default="private")
    icon: Mapped[str | None] = mapped_column(String(16))
    cover_image: Mapped[str | None] = mapped_column(String(512))
    owner_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    invite_code: Mapped[str] = mapped_column(String(32), unique=True)
    max_members: Mapped[int] = mapped_column(Integer, default=5)
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TeamMember(Base):
    __tablename__ = "team_members"
    __table_args__ = (UniqueConstraint("team_id", "user_id", name="uq_team_member"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    team_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teams.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    role: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="active")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Per-member read cursor. Powers unread_activity_count on Teams Home and
    # the "new since last visit" banner on Team Detail (brief §4, §8).
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TeamActivity(Base):
    __tablename__ = "team_activity"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    team_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teams.id"))
    actor_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    activity_type: Mapped[str] = mapped_column(String(32))
    content_title_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("content_titles.id"))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TeamTitle(Base):
    __tablename__ = "team_titles"
    __table_args__ = (UniqueConstraint("team_id", "content_title_id", name="uq_team_title"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    team_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teams.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    added_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    note: Mapped[str | None] = mapped_column(String(280))
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TeamRanking(Base):
    __tablename__ = "team_rankings"
    __table_args__ = (UniqueConstraint("team_id", "content_title_id", name="uq_team_ranking"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    team_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teams.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    rank: Mapped[int] = mapped_column(Integer)
    score: Mapped[float] = mapped_column(Numeric(3, 1), default=7.0)
    movement: Mapped[str] = mapped_column(String(8), default="same")
    weeks_on_list: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FeedEvent(Base):
    """FeedEvent doubles as the social-post table per Social brief §24.
    Team-scoped rows (`team_id` set) preserve the Watch Teams behavior;
    social posts have `team_id=NULL` and `visibility` set explicitly.
    A post references canonical rating / list objects rather than
    embedding them (§26)."""

    __tablename__ = "feed_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    team_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("teams.id"))
    content_title_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("content_titles.id"))
    # event_type: legacy team values ('title_added', 'ranking_updated', ...) +
    # social values ('title_share' | 'rating_share' | 'review_share' |
    # 'list_share' | 'list_publish'). Enforced in service layer, not at the
    # DB level, so we can add new types without a migration.
    event_type: Mapped[str] = mapped_column(String(32))
    source_type: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # visibility: 'team' (default for team activity) | 'public' | 'followers' | 'private'.
    visibility: Mapped[str] = mapped_column(String(16), default="team")
    # Canonical references for social posts — rating share links back to the
    # actual rating record; list share links to the actual watchlist.
    rating_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ratings.id"))
    list_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("watchlists.id"))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FeedReaction(Base):
    __tablename__ = "feed_reactions"
    __table_args__ = (UniqueConstraint("event_id", "user_id", name="uq_feed_reaction_event_user"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("feed_events.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    reaction: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserFollow(Base):
    __tablename__ = "user_follows"
    __table_args__ = (UniqueConstraint("follower_user_id", "following_user_id", name="uq_user_follow"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    follower_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    following_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FeedComment(Base):
    __tablename__ = "feed_comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("feed_events.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    parent_comment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("feed_comments.id"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Share(Base):
    __tablename__ = "shares"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    review_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("reviews.id"))
    target: Mapped[str] = mapped_column(String(32))
    team_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("teams.id"))
    shared_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AffiliateClick(Base):
    __tablename__ = "affiliate_clicks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    content_title_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_titles.id"))
    provider_code: Mapped[str] = mapped_column(String(64))
    region_code: Mapped[str] = mapped_column(String(2), default="US")
    target_url: Mapped[str] = mapped_column(String(512))
    partner_code: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notification_type: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(String(280))
    entity_type: Mapped[str | None] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    route: Mapped[str | None] = mapped_column(String(255))
    dedupe_key: Mapped[str | None] = mapped_column(String(255))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class NotificationPreference(Base):
    __tablename__ = "notification_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    team_activity: Mapped[bool] = mapped_column(Boolean, default=True)
    direct_engagement: Mapped[bool] = mapped_column(Boolean, default=True)
    recommendations: Mapped[bool] = mapped_column(Boolean, default=False)
    availability: Mapped[bool] = mapped_column(Boolean, default=False)
    marketing: Mapped[bool] = mapped_column(Boolean, default=False)
    push_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class NotificationOutbox(Base):
    __tablename__ = "notification_outbox"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    notification_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notifications.id"))
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"))
    provider: Mapped[str] = mapped_column(String(32), default="expo")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    provider_ticket_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ─── Social foundation (Social brief §16 + §23 + §40 + §52) ──────────────────


class Block(Base):
    """Asymmetric user block. Supersedes follow relationships — blocked users
    cannot view profiles, follow, see posts, or comment (§23)."""

    __tablename__ = "blocks"
    __table_args__ = (
        UniqueConstraint("blocker_user_id", "blocked_user_id", name="uq_block_pair"),
        CheckConstraint("blocker_user_id <> blocked_user_id", name="ck_no_self_block"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    blocker_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    blocked_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Report(Base):
    """Moderation report per §52. Reports go to a queue for review."""

    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reporter_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    reported_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    feed_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("feed_events.id", ondelete="SET NULL"))
    comment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("feed_comments.id", ondelete="SET NULL"))
    reason: Mapped[str] = mapped_column(String(32))
    notes: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[str] = mapped_column(String(16), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ListSave(Base):
    """User follows/saves someone else's public list (§40). References the
    canonical watchlist so title changes propagate; does NOT duplicate titles."""

    __tablename__ = "list_saves"
    __table_args__ = (UniqueConstraint("user_id", "watchlist_id", name="uq_list_save"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    watchlist_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("watchlists.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PeopleDismissal(Base):
    """Viewer's "Not interested" on a candidate profile in People discovery.
    Suppresses the candidate from suggestion lists for at least 30 days
    per People Discovery spec §10. Search results ignore dismissal."""

    __tablename__ = "people_dismissals"
    __table_args__ = (
        UniqueConstraint("viewer_user_id", "candidate_user_id", name="uq_people_dismissal_pair"),
        CheckConstraint("viewer_user_id <> candidate_user_id", name="ck_no_self_dismissal"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    viewer_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    candidate_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
