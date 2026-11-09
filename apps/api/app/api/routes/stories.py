"""Oct-19 Social Stories endpoints.

POST   /me/stories                  add a title to my story
GET    /social/stories               active stories grouped by actor
DELETE /me/stories/{story_id}       remove one of my stories
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_, and_

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import UserFollow
from app.models.story import SocialStory
from app.models.user import User, UserProfile
from app.services.visibility import visible_profile_clause


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


class StoryHistoryResponse(BaseModel):
    items: list[StoryTitleCard]
    next_cursor: str | None
    total: int


def _card(story, title):
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


@router.get("", response_model=StoryHistoryResponse)
def list_my_stories(
    current_user: CurrentUser,
    db: DbSession,
    state: str = Query("all", pattern="^(all|active|archived)$"),
    limit: int = Query(24, ge=1, le=100),
    cursor: str | None = Query(None, max_length=120),
):
    """Private owner history. Expiry hides stories from Social, not their owner."""
    clauses = [SocialStory.user_id == current_user.id]
    now = datetime.now(timezone.utc)
    if state == "active":
        clauses.append(SocialStory.expires_at > now)
    if state == "archived":
        clauses.append(SocialStory.expires_at <= now)
    total = db.scalar(select(func.count(SocialStory.id)).where(*clauses)) or 0
    if cursor:
        try:
            timestamp, raw_id = cursor.split("|")
            before = datetime.fromisoformat(timestamp)
            if before.tzinfo is None:
                before = before.replace(tzinfo=timezone.utc)
            before_id = UUID(raw_id)
        except (ValueError, TypeError):
            raise HTTPException(422, detail="Invalid story history cursor")
        clauses.append(
            or_(
                SocialStory.created_at < before,
                and_(SocialStory.created_at == before, SocialStory.id < before_id),
            )
        )
    rows = db.execute(
        select(SocialStory, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SocialStory.content_title_id)
        .where(*clauses)
        .order_by(SocialStory.created_at.desc(), SocialStory.id.desc())
        .limit(limit + 1)
    ).all()
    page = rows[:limit]
    last = page[-1][0] if page else None
    return StoryHistoryResponse(
        items=[_card(story, title) for story, title in page],
        total=total,
        next_cursor=f"{last.created_at.isoformat()}|{last.id}"
        if len(rows) > limit and last
        else None,
    )


@router.get("/{story_id}", response_model=StoryTitleCard)
def get_my_story(story_id: UUID, current_user: CurrentUser, db: DbSession):
    row = db.execute(
        select(SocialStory, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SocialStory.content_title_id)
        .where(SocialStory.id == story_id, SocialStory.user_id == current_user.id)
    ).first()
    if row is None:
        raise HTTPException(404, detail="Story not found")
    return _card(*row)


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
    story = db.scalar(
        select(SocialStory)
        .where(SocialStory.id == story_id, SocialStory.user_id == current_user.id)
        .with_for_update()
    )
    if story is None:
        return
    if story.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your story")
    db.delete(story)
    db.commit()


class EditStoryRequest(BaseModel):
    """Oct-27 spec EDIT-01/02: owner can correct the title and caption
    on an active story. Expiry is NEVER extended — expired stories
    reject the edit rather than resurrecting."""

    title_id: UUID | None = None
    caption: str | None = Field(default=None, max_length=280)


@router.patch("/{story_id}", response_model=StoryTitleCard)
def edit_story(
    story_id: UUID,
    payload: EditStoryRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> StoryTitleCard:
    story = db.scalar(
        select(SocialStory)
        .where(SocialStory.id == story_id, SocialStory.user_id == current_user.id)
        .with_for_update()
    )
    if story is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Story not found")
    if story.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your story")
    now = datetime.now(timezone.utc)
    expires = story.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= now:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="This story has expired")

    if payload.title_id is not None and payload.title_id != story.content_title_id:
        new_title = db.scalar(select(ContentTitle).where(ContentTitle.id == payload.title_id))
        if new_title is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
        story.content_title_id = new_title.id
    # Caption can be set to null explicitly or trimmed to None if empty.
    if "caption" in payload.model_fields_set:
        trimmed = (payload.caption or "").strip()
        story.caption = trimmed or None
    db.commit()
    db.refresh(story)

    title = db.scalar(select(ContentTitle).where(ContentTitle.id == story.content_title_id))
    assert title is not None  # just resolved above
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


def _group(
    stories: list[tuple[SocialStory, ContentTitle, UserProfile | None, User]],
) -> list[StoryActorGroup]:
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

    following_ids = list(
        db.scalars(
            select(UserFollow.following_user_id).where(
                UserFollow.follower_user_id == current_user.id
            )
        ).all()
    )

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
            visible_profile_clause(SocialStory.user_id, current_user.id),
        )
        .order_by(SocialStory.user_id, SocialStory.created_at.desc(), SocialStory.id.desc())
    ).all()

    all_rows = [(s, t, p, u) for s, t, p, u in rows]
    groups = _group(all_rows)

    me = next((g for g in groups if g.user_id == current_user.id), None)
    others = [g for g in groups if g.user_id != current_user.id]
    return StoriesFeedResponse(me=me, others=others)
