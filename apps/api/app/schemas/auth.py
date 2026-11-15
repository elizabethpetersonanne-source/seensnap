from uuid import UUID

from pydantic import BaseModel, Field


class DeleteAccountRequest(BaseModel):
    apple_authorization_code: str | None = Field(default=None, max_length=4096)


class GoogleAuthRequest(BaseModel):
    id_token: str


class AppleAuthRequest(BaseModel):
    identity_token: str
    display_name: str | None = None


class DevAuthRequest(BaseModel):
    email: str = "dev@seensnap.local"
    display_name: str = "Local Dev"


class SessionUserResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str
    avatar_url: str | None = None


class SessionResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: SessionUserResponse
