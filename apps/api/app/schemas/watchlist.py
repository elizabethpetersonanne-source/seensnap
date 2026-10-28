from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.content import TitleResponse


class WatchlistItemResponse(BaseModel):
    id: UUID
    content_title_id: UUID
    added_via: str
    created_at: datetime
    title: TitleResponse


class WatchlistResponse(BaseModel):
    id: UUID
    name: str
    description: str | None = None
    is_default: bool = False
    is_system_list: bool = False
    # Oct-27 followup A69: list audience.
    visibility: str = "private"
    items: list[WatchlistItemResponse]


class WatchlistAddRequest(BaseModel):
    content_title_id: UUID
    list_id: UUID | None = None
    added_via: str = Field(default="manual", min_length=1, max_length=32)
    share_to_team_id: UUID | None = None


class WatchlistListCreateRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=280)
    # Default private — publishing is an explicit choice per spec.
    visibility: str = Field(default="private", pattern="^(private|followers|public)$")


class WatchlistListUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=280)
    visibility: str | None = Field(default=None, pattern="^(private|followers|public)$")


class WatchlistListSummaryResponse(BaseModel):
    id: UUID
    name: str
    description: str | None = None
    is_default: bool = False
    is_system_list: bool = False
    visibility: str = "private"
    title_count: int
    updated_at: datetime | None = None
    preview_posters: list[str] = Field(default_factory=list)
