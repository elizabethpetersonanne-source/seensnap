"""Oct-19 Social Stories endpoints.

  POST   /me/stories                  add a title to my story
  GET    /social/stories               active stories grouped by actor
  DELETE /me/stories/{story_id}       remove one of my stories
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import UserFollow
from app.models.story import SocialStory
from app.models.user import User, UserProfile


router = APIRouter()


STORY_TTL = timedelta(hours=72)


class StoryTitleCard(BaseModel):
    story_id: UUID
    title_id: UUID
    title: str
    poster_url: str | None
    backdrop_url: str | None
    caption: str | None
    created_at: datetime
    expires_at: datetime


class StoryActorGroup(BaseModel):
    user_id: UUID
    display_name: str | None
    username: str | None
    avatar_url: str | None
    stories: list[StoryTitleCard]


class StoriesFeedResponse(BaseModel):
    me: StoryActorGroup | None
    others: list[StoryActorGroup]


class CreateStoryRequest(BaseModel):
    title_id: UUID
    caption: str | None = Field(default=None, max_length=280)


@router.post("", response_model=StoryTitleCard, status_code=status.HTTP_201_CREATED)
def create_story(
    payload: CreateStoryRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> StoryTitleCard:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == payload.title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
    now = datetime.now(timezone.utc)
    story = SocialStory(
        id=uuid4(),
        user_id=current_user.id,
        content_title_id=payload.title_id,
        caption=(payload.caption or "").strip() or None,
        expires_at=now + STORY_TTL,
    )
    db.add(story)
    db.commit()
    db.refresh(story)
    return StoryTitleCard(
        story_id=story.id,
        title_id=title.id,
        title=title.title,
        poster_url=title.poster_url,
        backdrop_url=title.backdrop_url,
        caption=story.caption,
        created_at=story.created_at,
        expires_at=story.expires_at,
    )


@router.delete("/{story_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_story(story_id: UUID, current_user: CurrentUser, db: DbSession) -> None:
    story = db.scalar(select(SocialStory).where(SocialStory.id == story_id))
    if story is None:
        return
    if story.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your story")
    db.delete(story)
    db.commit()


def _group(stories: list[tuple[SocialStory, ContentTitle, UserProfile | None, User]]) -> list[StoryActorGroup]:
    """Group story rows by actor, preserving order (most recent first per actor)."""
    buckets: dict[UUID, StoryActorGroup] = {}
    order: list[UUID] = []
    for story, title, profile, user in stories:
        if user.id not in buckets:
            buckets[user.id] = StoryActorGroup(
                user_id=user.id,
                display_name=profile.display_name if profile and profile.display_name else None,
                username=profile.username if profile else None,
                avatar_url=profile.avatar_url if profile and profile.avatar_url else None,
                stories=[],
            )
            order.append(user.id)
        buckets[user.id].stories.append(
            StoryTitleCard(
                story_id=story.id,
                title_id=title.id,
                title=title.title,
                poster_url=title.poster_url,
                backdrop_url=title.backdrop_url,
                caption=story.caption,
                created_at=story.created_at,
                expires_at=story.expires_at,
            )
        )
    return [buckets[uid] for uid in order]


reader_router = APIRouter()


@reader_router.get("", response_model=StoriesFeedResponse)
def list_active_stories(current_user: CurrentUser, db: DbSession) -> StoriesFeedResponse:
    """Return active stories: the viewer's own group first (if any)
    followed by the groups of the people they follow. Stories past
    their expires_at are filtered out server-side."""
    now = datetime.now(timezone.utc)

    following_ids = list(db.scalars(
        select(UserFollow.following_user_id).where(UserFollow.follower_user_id == current_user.id)
    ).all())

    visible_user_ids = set(following_ids)
    visible_user_ids.add(current_user.id)
    if not visible_user_ids:
        return StoriesFeedResponse(me=None, others=[])

    rows = db.execute(
        select(SocialStory, ContentTitle, UserProfile, User)
        .join(ContentTitle, ContentTitle.id == SocialStory.content_title_id)
        .join(User, User.id == SocialStory.user_id)
        .outerjoin(UserProfile, UserProfile.user_id == SocialStory.user_id)
        .where(
            SocialStory.user_id.in_(visible_user_ids),
            SocialStory.expires_at > now,
        )
        .order_by(SocialStory.user_id, SocialStory.created_at.desc())
    ).all()

    all_rows = [(s, t, p, u) for s, t, p, u in rows]
    groups = _group(all_rows)

    me = next((g for g in groups if g.user_id == current_user.id), None)
    others = [g for g in groups if g.user_id != current_user.id]
    return StoriesFeedResponse(me=me, others=others)

