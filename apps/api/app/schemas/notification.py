from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class NotificationResponse(BaseModel):
    id: UUID
    notification_type: str
    title: str
    body: str
    actor_user_id: UUID | None = None
    entity_type: str | None = None
    entity_id: UUID | None = None
    route: str | None = None
    read_at: datetime | None = None
    opened_at: datetime | None = None
    created_at: datetime


class NotificationListResponse(BaseModel):
    items: list[NotificationResponse]
    unread_count: int
    next_cursor: str | None = None


class DeviceRegisterRequest(BaseModel):
    expo_push_token: str
    platform: str
    app_env: str | None = None
    app_build: str | None = None
    permission_state: str | None = None


class DeviceResponse(BaseModel):
    id: UUID
    platform: str
    app_env: str | None = None
    enabled: bool
    created_at: datetime


class NotificationPreferenceResponse(BaseModel):
    team_activity: bool
    direct_engagement: bool
    recommendations: bool
    availability: bool
    marketing: bool
    push_enabled: bool


class NotificationPreferenceUpdateRequest(BaseModel):
    team_activity: bool | None = None
    direct_engagement: bool | None = None
    recommendations: bool | None = None
    availability: bool | None = None
    marketing: bool | None = None
    push_enabled: bool | None = None
