"""Every image read rechecks current audience; opaque IDs are not permission."""

import base64
from uuid import UUID
from fastapi import APIRouter, HTTPException, Response
from app.api.dependencies import CurrentUser, DbSession
from app.models.team_state import MediaAsset
from app.models.social import TeamMember, Team
from app.services.visibility import can_view_profile
from sqlalchemy import select

router = APIRouter()


def readable(db, asset_id, user_id):
    asset = db.get(MediaAsset, asset_id)
    allowed = False
    if asset:
        if asset.team_id:
            allowed = (
                db.scalar(
                    select(TeamMember.id)
                    .join(Team, Team.id == TeamMember.team_id)
                    .where(
                        TeamMember.team_id == asset.team_id,
                        TeamMember.user_id == user_id,
                        TeamMember.status == "active",
                        Team.archived_at.is_(None),
                    )
                )
                is not None
            )
        elif asset.purpose == "avatar":
            allowed = can_view_profile(db, asset.owner_user_id, user_id)
        else:
            allowed = asset.owner_user_id == user_id
    if not allowed:
        raise HTTPException(404, detail="Image unavailable.")
    return asset


@router.get("/{asset_id}")
def get_image(asset_id: UUID, current_user: CurrentUser, db: DbSession):
    return Response(
        readable(db, asset_id, current_user.id).data,
        media_type="image/webp",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/{asset_id}/source")
def get_image_source(asset_id: UUID, current_user: CurrentUser, db: DbSession, response: Response):
    asset = readable(db, asset_id, current_user.id)
    response.headers["Cache-Control"] = "private, no-store"
    return {"uri": "data:image/webp;base64," + base64.b64encode(asset.data).decode()}
