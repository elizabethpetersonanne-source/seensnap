"""Oct-18 build brief §6 share-asset generation endpoint.

Returns an honest unavailable status when no image renderer is wired
in this environment — brief forbids fabricating preview URLs."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.dependencies import CurrentUser
from app.services.share_asset import ShareAssetRequest, generate_share_asset


router = APIRouter()


class ShareAssetBody(BaseModel):
    title_id: UUID
    take: str | None = Field(default=None, max_length=300)
    include_rating: bool = True
    include_rank: bool = False


class ShareAssetResponse(BaseModel):
    status: str
    status_detail: str
    asset_url: str | None
    expires_at: str | None


@router.post("", response_model=ShareAssetResponse)
def create_share_asset(
    payload: ShareAssetBody,
    current_user: CurrentUser,
) -> ShareAssetResponse:
    result = generate_share_asset(
        ShareAssetRequest(
            user_id=current_user.id,
            title_id=payload.title_id,
            take=payload.take,
            include_rating=payload.include_rating,
            include_rank=payload.include_rank,
        )
    )
    return ShareAssetResponse(
        status=result.status,
        status_detail=result.status_detail,
        asset_url=result.asset_url,
        expires_at=result.expires_at,
    )
