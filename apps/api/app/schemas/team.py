from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.taste import TeamAnalyticsResponse


class TeamCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=280)
    visibility: str = Field(default="private", pattern="^(private|invite_only|public)$")
    icon: str | None = Field(default=None, max_length=16)
    cover_image: str | None = Field(default=None, max_length=512)
    max_members: int = Field(default=5, ge=2, le=12)


class TeamUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=3, max_length=120)
    description: str | None = Field(default=None, max_length=280)
    visibility: str | None = Field(default=None, pattern="^(private|invite_only|public)$")
    icon: str | None = Field(default=None, max_length=16)
    cover_image: str | None = Field(default=None, max_length=512)


class TeamJoinRequest(BaseModel):
    invite_code: str = Field(min_length=4, max_length=32)


class TeamMemberSummaryResponse(BaseModel):
    user_id: UUID
    display_name: str | None = None
    avatar_url: str | None = None
    role: str
    status: str
    joined_at: datetime


class TeamSummaryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    description: str | None = None
    visibility: str
    icon: str | None = None
    cover_image: str | None = None
    owner_user_id: UUID
    invite_code: str
    max_members: int
    member_count: int
    last_activity_at: datetime | None = None
    latest_activity: str | None = None
    recent_member_avatars: list[str] = Field(default_factory=list)
    # Watch Teams overhaul (brief §8): fields that power the "inbox of group
    # momentum" pattern on Teams Home + the sticky pulse header on detail.
    unread_activity_count: int = 0
    active_member_count_24h: int = 0
    team_status: str = "quiet"  # 'active' | 'quiet' | 'dormant'
    top10_updated_at: datetime | None = None


class TeamResponse(TeamSummaryResponse):
    members: list[TeamMemberSummaryResponse]
    analytics: TeamAnalyticsResponse | None = None


class TeamTitleResponse(BaseModel):
    id: UUID
    team_id: UUID
    content_title_id: UUID
    added_by_user_id: UUID
    added_by_name: str | None = None
    note: str | None = None
    added_at: datetime
    title_name: str
    content_type: str
    poster_url: str | None = None
    year: int | None = None


class TeamRankingResponse(BaseModel):
    id: UUID
    team_id: UUID
    content_title_id: UUID
    rank: int
    score: float
    movement: str
    weeks_on_list: int
    title_name: str
    poster_url: str | None = None


class TeamTitleAddRequest(BaseModel):
    content_title_id: UUID
    note: str | None = Field(default=None, max_length=280)
    suggested_rank: int | None = Field(default=None, ge=1, le=10)
    also_post_to_feed: bool = False


class TeamMemberAddRequest(BaseModel):
    user_id: UUID
    role: str = Field(default="member", pattern="^(member|admin)$")


class TeamUserSearchResponse(BaseModel):
    user_id: UUID
    display_name: str | None = None
    username: str | None = None
    avatar_url: str | None = None


class TeamFeedPostCreateRequest(BaseModel):
    text: str | None = Field(default=None, max_length=500)
    content_title_id: UUID | None = None
    rating: float | None = None


class TeamActivityResponse(BaseModel):
    id: UUID
    activity_type: str
    actor_user_id: UUID
    actor_display_name: str | None = None
    actor_avatar_url: str | None = None
    content_title_id: UUID | None = None
    entity_id: UUID | None = None
    payload: dict = Field(default_factory=dict)
    created_at: datetime


class TeamActivityCommentCreateRequest(BaseModel):
    comment: str = Field(min_length=1, max_length=280)


class TeamActivityReactionCreateRequest(BaseModel):
    reaction: str = Field(default="like", min_length=1, max_length=32)
