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
    # SOC-01: expose a short label so the client can show "Followed",
    # "90%+ match", "80–89% match" chips on the mixed-source feed
    # without inventing bands on the client. Derived from the viewer's
    # following set + compatibility scores at query time.
    from app.models.social import UserFollow
    from app.models.taste import CompatibilityScore
    from sqlalchemy import or_ as _or

    following_ids = set(
        db.scalars(
            select(UserFollow.following_user_id).where(
                UserFollow.follower_user_id == current_user.id,
            )
        ).all()
    )
    following_ids.add(current_user.id)
    compat_map: dict = {}
    for a, b, c in db.execute(
        select(CompatibilityScore.user_a_id, CompatibilityScore.user_b_id, CompatibilityScore.compatibility)
        .where(
            _or(
                CompatibilityScore.user_a_id == current_user.id,
                CompatibilityScore.user_b_id == current_user.id,
            )
        )
    ).all():
        compat_map[b if a == current_user.id else a] = c

    def _source_label(actor_id):
        if actor_id in following_ids:
            return "followed"
        c = compat_map.get(actor_id)
        if c is None:
            return "unknown"
        if c >= 90:
            return "match_90"
        if c >= 80:
            return "match_80"
        return "unknown"

    for item, event in zip(hydrated, events):
        item["source_label"] = _source_label(event.actor_user_id)
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


class EditPostRequest(BaseModel):
    """Oct-27 spec EDIT-01/02: owner-only edit of caption + audience.
    Subject TitleRef, historical snapshot, reactions and created_at
    are preserved — editing a published caption must not rewrite the
    historical claim others reacted to."""
    caption: str | None = Field(default=None, max_length=1000)
    visibility: str | None = Field(default=None, pattern="^(public|followers|private)$")


@router.patch("/posts/{post_id}")
def edit_post(
    post_id: UUID,
    payload: EditPostRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    from app.models.social import FeedEvent as _FeedEvent
    event = db.scalar(select(_FeedEvent).where(_FeedEvent.id == post_id))
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found")
    if event.actor_user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the author may edit this post")
    changed = False
    if payload.caption is not None:
        new_caption = payload.caption.strip()
        payload_dict = dict(event.payload) if isinstance(event.payload, dict) else {}
        payload_dict["caption"] = new_caption or None
        payload_dict["body"] = new_caption or None
        payload_dict["edited"] = True
        event.payload = payload_dict
        changed = True
    if payload.visibility is not None and payload.visibility != event.visibility:
        # List-share audience cannot exceed the underlying list's visibility.
        # For simple posts, store as-is.
        event.visibility = payload.visibility
        changed = True
    if changed:
        db.commit()
        db.refresh(event)
    return hydrate_feed_event(db, event, current_user.id)


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


# ─── Your Taste Matches carousel (Oct-27 follow-up S01–S04) ─────────────


class TasteMatchCard(BaseModel):
    user_id: UUID
    username: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    # 0–100 units. Null = "Learning" — not enough evidence.
    compatibility: int | None = None
    # One concise, viewer-safe reason label. Only populated from
    # evidence the viewer is allowed to know (shared public genres /
    # count of shared favorite titles). Never leaks private team or
    # list membership.
    reason: str | None = None


class TasteMatchesDiagnostics(BaseModel):
    """Non-privacy-sensitive counts so a user who sees an empty
    carousel can report what's actually zero. These are counts,
    never names — safe to surface in the UI."""
    eligible_total: int = 0
    scored_total: int = 0
    scored_with_evidence: int = 0
    scored_learning: int = 0
    viewer_rated_count: int = 0


class TasteMatchesResponse(BaseModel):
    items: list[TasteMatchCard]
    has_evidence: bool = True
    # MATCH02: distinguish empty states so the mobile copy is honest.
    # "ok"               — items present (len(items) > 0)
    # "no_eligible"      — viewer has evidence, no candidates match
    # "viewer_cold"      — viewer has <5 rated titles → "Rate more"
    # "no_candidates"    — zero eligible candidates (new user with
    #                      no discoverable people)
    empty_state: str = "ok"
    diagnostics: TasteMatchesDiagnostics = TasteMatchesDiagnostics()


@router.get("/people/taste-matches", response_model=TasteMatchesResponse)
def get_taste_matches(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=10, ge=1, le=30),
) -> TasteMatchesResponse:
    """Carousel immediately below the Social header. Reuses the
    existing people-discovery eligibility filter and scores each
    candidate via the canonical `get_compatibility` service.
    """
    from app.services.compatibility import get_compatibility, to_compatibility_response
    from app.services.people_discovery import _eligible_candidate_ids
    from app.models.social import Rating as _Rating
    from sqlalchemy import func as _func

    # Viewer-side evidence check. If the viewer has barely rated
    # anything, no amount of candidate scoring will produce
    # meaningful matches — the honest answer is "Rate a few titles."
    viewer_rated_count = int(db.scalar(
        select(_func.count()).select_from(_Rating).where(_Rating.user_id == current_user.id)
    ) or 0)

    eligible = _eligible_candidate_ids(db, current_user.id, exclude_followed=True)
    # Also peek at the pool INCLUDING followed users so we can tell
    # the user "You already follow all your eligible matches" when
    # that's the actual reason the new-connections carousel is empty.
    eligible_including_followed = _eligible_candidate_ids(
        db, current_user.id, exclude_followed=False,
    )
    if not eligible:
        empty = "viewer_cold" if viewer_rated_count < 5 else "no_candidates"
        if eligible_including_followed and empty == "no_candidates":
            empty = "all_followed"
        return TasteMatchesResponse(
            items=[],
            has_evidence=False,
            empty_state=empty,
            diagnostics=TasteMatchesDiagnostics(
                eligible_total=0,
                scored_total=0,
                scored_with_evidence=0,
                scored_learning=0,
                viewer_rated_count=viewer_rated_count,
            ),
        )

    # Preselect candidates who are themselves "scorable" — users with
    # at least one rated title. This prevents us from spending our
    # 60-candidate budget on inactive accounts whose compatibility
    # will inevitably come back empty.
    scorable_ids = set(
        db.scalars(
            select(_Rating.user_id)
            .where(_Rating.user_id.in_(eligible))
            .group_by(_Rating.user_id)
            .limit(200)
        ).all()
    )
    # If the viewer has lots of eligible candidates but none have
    # rated anything, fall through to the full eligible set so a
    # beta cold-start pool with no ratings still gets Learning cards.
    pool = sorted(scorable_ids) if scorable_ids else sorted(eligible)
    candidate_ids = pool[:60]

    profiles = {
        p.user_id: p
        for p in db.scalars(
            select(UserProfile).where(UserProfile.user_id.in_(candidate_ids))
        ).all()
    }

    # (compat_int|None, user_id, shared_genres, shared_title_count)
    scored: list[tuple[int | None, UUID, list[str], int]] = []
    for cid in candidate_ids:
        profile = profiles.get(cid)
        if profile is None:
            continue
        try:
            record = get_compatibility(db, current_user.id, cid)
            resp = to_compatibility_response(record, current_user.id, cid)
        except Exception:
            # Non-fatal: skip this candidate but keep scoring the rest.
            continue
        scored.append((
            resp.compatibility,
            cid,
            resp.top_shared_genres[:1],
            len(resp.top_shared_titles),
        ))

    # Rank: real scores first (desc), then Learning (null) cards,
    # then stable tie-break by uuid string. Learning cards are
    # surfaced only when there aren't enough real scores to fill
    # the limit — otherwise they'd crowd out the signal.
    real = [s for s in scored if s[0] is not None]
    learning = [s for s in scored if s[0] is None]
    real.sort(key=lambda row: (-(row[0] or 0), str(row[1])))
    learning.sort(key=lambda row: str(row[1]))
    ordered: list[tuple[int | None, UUID, list[str], int]] = real + learning

    items: list[TasteMatchCard] = []
    for compat, cid, shared_genres, shared_title_count in ordered[:limit]:
        profile = profiles.get(cid)
        if profile is None:
            continue
        if compat is not None and shared_title_count >= 2:
            reason = f"{shared_title_count} shared favorites"
        elif compat is not None and shared_genres:
            reason = f"You both like {shared_genres[0]}"
        elif compat is None:
            reason = "Still learning your taste"
        else:
            reason = None
        items.append(
            TasteMatchCard(
                user_id=cid,
                username=profile.username,
                display_name=profile.display_name,
                avatar_url=profile.avatar_url,
                compatibility=compat,
                reason=reason,
            )
        )
    scored_with_evidence = sum(1 for s in scored if s[0] is not None)
    scored_learning = sum(1 for s in scored if s[0] is None)
    empty_state = (
        "ok" if items
        else "viewer_cold" if viewer_rated_count < 5
        else "no_eligible"
    )
    return TasteMatchesResponse(
        items=items,
        has_evidence=len(items) > 0,
        empty_state=empty_state,
        diagnostics=TasteMatchesDiagnostics(
            eligible_total=len(eligible),
            scored_total=len(scored),
            scored_with_evidence=scored_with_evidence,
            scored_learning=scored_learning,
            viewer_rated_count=viewer_rated_count,
        ),
    )
