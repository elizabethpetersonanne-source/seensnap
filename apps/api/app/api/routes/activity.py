"""Oct-18 build brief §6: explicit publication endpoint.

Personal save / rate / rank changes NEVER auto-create a public feed
event. When a user wants to share, they go through this endpoint
with the title, the activity kind (rated / ranked / added_to_list /
watched_team / public_list), an optional Take (≤ 300 chars), and the
visibility (public / followers).

The historical rank/rating snapshot is captured at publish time so
later private edits never silently rewrite the post text.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import FeedEvent, Rating, RankedFavorite


router = APIRouter()


# Supported explicit publication kinds (brief §6).
_SUPPORTED_KINDS = {
    "rated_title",      # user rated a title and chose to publish
    "ranked_change",    # user adjusted a ranked position and chose to publish
    "added_to_list",    # user added a title to a public list
    "list_published",   # user made a list public
    "watched_team",     # team watched outcome
}


class PublishActivityRequest(BaseModel):
    kind: str = Field(min_length=1, max_length=40)
    title_id: UUID | None = None
    list_id: UUID | None = None
    team_id: UUID | None = None
    take: str | None = Field(default=None, max_length=300)
    visibility: str = Field(default="public", pattern="^(public|followers)$")


class PublishActivityResponse(BaseModel):
    event_id: UUID
    created_at: datetime
    kind: str
    visibility: str


@router.post("/publish", response_model=PublishActivityResponse)
def publish_activity(
    payload: PublishActivityRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> PublishActivityResponse:
    if payload.kind not in _SUPPORTED_KINDS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported activity kind: {payload.kind}")

    # Snapshot the current private state for whichever subject applies.
    event_payload: dict = {
        "take": (payload.take or "").strip() or None,
    }

    if payload.title_id is not None:
        title = db.scalar(select(ContentTitle).where(ContentTitle.id == payload.title_id))
        if title is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
        event_payload["title_name_at_publish"] = title.title

        # For rated_title / ranked_change, capture the HISTORICAL rating
        # + rank so a later edit doesn't silently rewrite the post text.
        if payload.kind in ("rated_title",):
            rating = db.scalar(select(Rating).where(
                Rating.user_id == current_user.id,
                Rating.content_title_id == payload.title_id,
            ))
            if rating is not None:
                event_payload["rating_at_publish"] = int(round(float(rating.score)))
        if payload.kind == "ranked_change":
            rank = db.scalar(select(RankedFavorite).where(
                RankedFavorite.user_id == current_user.id,
                RankedFavorite.content_title_id == payload.title_id,
            ))
            if rank is not None:
                event_payload["ranked_position_at_publish"] = rank.position

    # Explicit FeedEvent write — this is the only path that creates
    # public activity. source_type="explicit_publish" so we can
    # distinguish these from internal / team activity in queries.
    event = FeedEvent(
        id=uuid4(),
        actor_user_id=current_user.id,
        team_id=payload.team_id,
        content_title_id=payload.title_id,
        event_type=payload.kind,
        source_type="explicit_publish",
        visibility=payload.visibility,
        list_id=payload.list_id,
        payload=event_payload,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return PublishActivityResponse(
        event_id=event.id,
        created_at=event.created_at,
        kind=payload.kind,
        visibility=event.visibility or "public",
    )


class EditTakeRequest(BaseModel):
    take: str | None = Field(default=None, max_length=300)


@router.patch("/events/{event_id}/take", response_model=PublishActivityResponse)
def edit_take(
    event_id: UUID,
    payload: EditTakeRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> PublishActivityResponse:
    """Edit an existing event's Take only. The historical snapshot
    fields (rating / rank at publish) are intentionally frozen so
    editing a Take never silently rewrites the score / position the
    post was originally made with per brief §6."""
    event = db.scalar(select(FeedEvent).where(
        FeedEvent.id == event_id,
        FeedEvent.actor_user_id == current_user.id,
    ))
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")
    payload_dict = dict(event.payload or {})
    payload_dict["take"] = (payload.take or "").strip() or None
    event.payload = payload_dict
    db.commit()
    return PublishActivityResponse(
        event_id=event.id,
        created_at=event.created_at,
        kind=event.event_type,
        visibility=event.visibility or "public",
    )


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_publication(
    event_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    """Delete a public event. Private state (watched / rating / rank)
    is NOT touched — brief §5: deleting a public post removes
    publication only."""
    event = db.scalar(select(FeedEvent).where(
        FeedEvent.id == event_id,
        FeedEvent.actor_user_id == current_user.id,
    ))
    if event is None:
        return None
    db.delete(event)
    db.commit()
    return None
