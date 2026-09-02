"""Social endpoints — Social brief §56.

Includes:
  - GET  /social/feed                          — Following feed
  - POST /social/posts                         — create post (title / rating / list share)
  - DELETE /social/posts/{id}
  - POST /social/posts/{id}/likes              — toggle like
  - GET  /social/posts/{id}/comments
  - POST /social/posts/{id}/comments
  - DELETE /social/comments/{id}
  - GET  /social/users/search                  — user search
  - GET  /social/users/{id}/activity           — public profile activity
  - POST /social/users/{id}/block              — toggle block
  - POST /social/reports                       — moderation report
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.user import UserProfile
from app.services.social_feed import (
    create_comment,
    create_report,
    create_social_post,
    delete_comment,
    delete_social_post,
    following_feed,
    hydrate_feed_event,
    list_comments,
    search_users,
    toggle_block,
    toggle_like,
    user_activity_feed,
)

router = APIRouter()


# ─── Request/response schemas ────────────────────────────────────────────────


class PostCreateRequest(BaseModel):
    post_type: str = Field(pattern="^(title_share|rating_share|review_share|list_share|list_publish)$")
    title_id: UUID | None = None
    rating_id: UUID | None = None
    list_id: UUID | None = None
    caption: str | None = Field(default=None, max_length=500)
    visibility: str = Field(default="followers", pattern="^(public|followers|private)$")


class CommentCreateRequest(BaseModel):
    body: str = Field(min_length=1, max_length=500)


class ReportCreateRequest(BaseModel):
    reason: str = Field(pattern="^(harassment|hate|spam|inappropriate|impersonation|other)$")
    reported_user_id: UUID | None = None
    feed_event_id: UUID | None = None
    comment_id: UUID | None = None
    notes: str | None = Field(default=None, max_length=1000)


class UserSearchResult(BaseModel):
    user_id: UUID
    display_name: str | None = None
    username: str | None = None
    avatar_url: str | None = None
    bio: str | None = None


# ─── Feed ────────────────────────────────────────────────────────────────────


@router.get("/feed")
def get_following_feed(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(20, ge=1, le=50),
    before: datetime | None = Query(None, description="Cursor: return posts strictly older than this timestamp"),
) -> dict:
    events = following_feed(db, current_user.id, limit=limit, before_created_at=before)
    hydrated = [hydrate_feed_event(db, e, current_user.id) for e in events]
    next_cursor = events[-1].created_at.isoformat() if events else None
    return {
        "items": hydrated,
        "next_cursor": next_cursor,
        "has_more": len(events) == limit,
    }


# ─── Posts ───────────────────────────────────────────────────────────────────


@router.post("/posts", status_code=status.HTTP_201_CREATED)
def create_post(
    payload: PostCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    try:
        event = create_social_post(
            db,
            author_user_id=current_user.id,
            post_type=payload.post_type,
            title_id=payload.title_id,
            rating_id=payload.rating_id,
            list_id=payload.list_id,
            caption=payload.caption,
            visibility=payload.visibility,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return hydrate_feed_event(db, event, current_user.id)


@router.delete("/posts/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(post_id: UUID, current_user: CurrentUser, db: DbSession) -> None:
    try:
        delete_social_post(db, current_user.id, post_id)
    except PermissionError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the author may delete this post")


@router.post("/posts/{post_id}/likes")
def like_post(post_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    liked = toggle_like(db, current_user.id, post_id)
    return {"liked": liked}


# ─── Comments ────────────────────────────────────────────────────────────────


@router.get("/posts/{post_id}/comments")
def get_comments(post_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    comments = list_comments(db, post_id)
    author_ids = {c.user_id for c in comments}
    profiles = {
        p.user_id: p
        for p in db.scalars(
            select(UserProfile).where(UserProfile.user_id.in_(author_ids))
        ).all()
    }
    return {
        "items": [
            {
                "id": str(c.id),
                "body": c.body,
                "created_at": c.created_at.isoformat(),
                "author": {
                    "user_id": str(c.user_id),
                    "display_name": profiles.get(c.user_id).display_name if profiles.get(c.user_id) else None,
                    "username": profiles.get(c.user_id).username if profiles.get(c.user_id) else None,
                    "avatar_url": profiles.get(c.user_id).avatar_url if profiles.get(c.user_id) else None,
                },
            }
            for c in comments
        ]
    }


@router.post("/posts/{post_id}/comments", status_code=status.HTTP_201_CREATED)
def post_comment(
    post_id: UUID,
    payload: CommentCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    try:
        comment = create_comment(db, current_user.id, post_id, payload.body)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return {
        "id": str(comment.id),
        "body": comment.body,
        "created_at": comment.created_at.isoformat(),
    }


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_comment(comment_id: UUID, current_user: CurrentUser, db: DbSession) -> None:
    try:
        delete_comment(db, current_user.id, comment_id)
    except PermissionError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the author may delete this comment")


# ─── User search + activity ──────────────────────────────────────────────────


@router.get("/users/search", response_model=list[UserSearchResult])
def user_search(
    q: str,
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(20, ge=1, le=50),
) -> list[UserSearchResult]:
    rows = search_users(db, q, viewer_user_id=current_user.id, limit=limit)
    return [
        UserSearchResult(
            user_id=r.user_id,
            display_name=r.display_name,
            username=r.username,
            avatar_url=r.avatar_url,
            bio=r.bio,
        )
        for r in rows
    ]


@router.get("/users/{user_id}/activity")
def user_activity(
    user_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(30, ge=1, le=50),
) -> dict:
    events = user_activity_feed(db, user_id, current_user.id, limit=limit)
    return {"items": [hydrate_feed_event(db, e, current_user.id) for e in events]}


# ─── Blocks + reports ────────────────────────────────────────────────────────


@router.post("/users/{user_id}/block")
def block_user(user_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    try:
        blocked = toggle_block(db, current_user.id, user_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return {"blocked": blocked}


@router.post("/reports", status_code=status.HTTP_201_CREATED)
def submit_report(
    payload: ReportCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    try:
        report = create_report(
            db,
            current_user.id,
            reason=payload.reason,
            reported_user_id=payload.reported_user_id,
            feed_event_id=payload.feed_event_id,
            comment_id=payload.comment_id,
            notes=payload.notes,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return {"id": str(report.id), "status": report.status}


# ─── People Discovery (spec §11) ────────────────────────────────────────


@router.get("/people")
def get_people_discovery(
    current_user: CurrentUser,
    db: DbSession,
    section: str | None = Query(default=None),
    limit: int = Query(default=12, ge=1, le=50),
) -> dict:
    """Browse people. Without `section`, returns every non-empty section
    for the People screen. With `section`, returns the ranked candidate
    list for that section only (for pagination / dedicated views).
    """
    from app.services.people_discovery import (
        ALL_SECTIONS,
        SECTION_TITLES,
        _candidate_to_dict,
        get_all_sections,
        get_section,
    )

    if section:
        if section not in ALL_SECTIONS:
            raise HTTPException(status_code=400, detail=f"Unknown section: {section}")
        items = get_section(db, current_user.id, section=section, limit=limit)
        return {
            "section": {
                "id": section,
                "title": SECTION_TITLES[section],
                "items": [_candidate_to_dict(c) for c in items],
            }
        }
    return {"sections": get_all_sections(db, current_user.id, per_section_limit=limit)}


@router.post("/people/{candidate_user_id}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_person(
    candidate_user_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    """Record "Not interested" — candidate is suppressed from suggestion
    sections for 30 days per spec §10."""
    from app.services.people_discovery import dismiss_candidate

    dismiss_candidate(db, viewer_id=current_user.id, candidate_id=candidate_user_id)
    return None
