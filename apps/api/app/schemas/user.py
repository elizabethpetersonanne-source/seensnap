from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.taste import CompatibilityResponse, TasteGenreScoreResponse, TasteLabelResponse, TasteTitleReferenceResponse


class ProfileResponse(BaseModel):
    user_id: UUID
    email: str
    username: str
    display_name: str
    favorite_genres: list[str]
    country_code: str
    avatar_url: str | None = None
    bio: str | None = None


class PreferencesResponse(BaseModel):
    notifications_enabled: bool
    preferred_regions: list[str]
    connected_streaming_services: list[str]
    instagram_share_default: bool
    onboarding_completed: bool = False


class PreferencesUpdateRequest(BaseModel):
    connected_streaming_services: list[str] | None = None
    onboarding_completed: bool | None = None


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    username: str | None = Field(default=None, min_length=3, max_length=40)
    bio: str | None = Field(default=None, max_length=280)
    avatar_url: str | None = Field(default=None, max_length=4096)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)


class PublicProfileResponse(BaseModel):
    user_id: UUID
    username: str
    display_name: str
    avatar_url: str | None = None
    bio: str | None = None
    follower_count: int = 0
    following_count: int = 0
    post_count: int = 0
    is_following: bool = False
    can_follow: bool = True
    taste_labels: list[TasteLabelResponse] = Field(default_factory=list)
    favorite_genres: list[TasteGenreScoreResponse] = Field(default_factory=list)
    favorite_platforms: list[str] = Field(default_factory=list)
    profile_summary: str | None = None
    current_obsessions: list[TasteTitleReferenceResponse] = Field(default_factory=list)
    top_posters: list[str] = Field(default_factory=list)
    compatibility: CompatibilityResponse | None = None


class PublicProfilePostResponse(BaseModel):
    id: UUID
    author_id: UUID
    author_display_name: str | None = None
    author_avatar_url: str | None = None
    title_id: UUID | None = None
    title_name: str | None = None
    title_poster_url: str | None = None
    caption: str | None = None
    rating: float | None = None
    created_at: datetime
