"""Social feed service — Social brief §5–§8 + §16 + §24–§32 + §55.

The Following feed reads FeedEvents from users the viewer follows, filtered by
visibility, block relationships, and dedup. Every post references canonical
source data (rating / list / title) rather than embedding — deletion of the
source cascades cleanly.

Post creation happens through this module too so we can enforce visibility +
block rules server-side (§57 — server determines actor identity).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import (
    Block,
    FeedComment,
    FeedEvent,
    FeedReaction,
    ListSave,
    Rating,
    Report,
    UserFollow,
    Watchlist,
    WatchlistItem,
)
from app.models.user import User, UserProfile


# Social post types (Social brief §24 enumerated `post_type`). Enforced in
# the service layer since `event_type` on FeedEvent stays String() for
# backward compat with team-scoped events.
SOCIAL_POST_TYPES: set[str] = {
    "title_share",
    "rating_share",
    "review_share",
    "list_share",
    "list_publish",
}

# Visibility levels for social posts. `team` is used only by team activity
# (existing rows). New social posts use `public` | `followers` | `private`.
SOCIAL_VISIBILITIES: set[str] = {"public", "followers", "private"}


def _visible_to_viewer_clause(viewer_user_id: UUID | None):
    """SQL condition — a viewer can see a FeedEvent when:
      - visibility='public', OR
      - visibility='followers' AND viewer follows the author, OR
      - visibility='private' AND viewer IS the author

    Team-scoped events (visibility='team') are NEVER returned by the social
    feed — they belong to the team's own pulse.
    """
    if viewer_user_id is None:
        return FeedEvent.visibility == "public"

    followers_ok = and_(
        FeedEvent.visibility == "followers",
        exists().where(
            and_(
                UserFollow.follower_user_id == viewer_user_id,
                UserFollow.following_user_id == FeedEvent.actor_user_id,
            )
        ),
    )
    private_own = and_(
        FeedEvent.visibility == "private",
        FeedEvent.actor_user_id == viewer_user_id,
    )
    return or_(FeedEvent.visibility == "public", followers_ok, private_own)


def _block_exclusion_clause(viewer_user_id: UUID | None):
    """Exclude posts whose author has blocked the viewer OR whom the viewer
    has blocked (bidirectional invisibility per §23)."""
    if viewer_user_id is None:
        return None
    blocked_by_actor = exists().where(
        and_(
            Block.blocker_user_id == FeedEvent.actor_user_id,
            Block.blocked_user_id == viewer_user_id,
        )
    )
    blocked_actor = exists().where(
        and_(
            Block.blocker_user_id == viewer_user_id,
            Block.blocked_user_id == FeedEvent.actor_user_id,
        )
    )
    return and_(~blocked_by_actor, ~blocked_actor)


# ─── Post creation (Social brief §41 unified composer contract) ──────────────


def create_social_post(
    db: Session,
    author_user_id: UUID,
    *,
    post_type: str,
    title_id: UUID | None = None,
    rating_id: UUID | None = None,
    list_id: UUID | None = None,
    caption: str | None = None,
    visibility: str = "followers",
) -> FeedEvent:
    """Create a social post referencing canonical source data. Server enforces
    identity (author_user_id comes from the session, never the client per §57)
    and validates the type + visibility."""
    if post_type not in SOCIAL_POST_TYPES:
        raise ValueError(f"Unsupported social post_type: {post_type}")
    if visibility not in SOCIAL_VISIBILITIES:
        raise ValueError(f"Unsupported visibility: {visibility}")

    payload: dict[str, Any] = {}
    if caption:
        payload["caption"] = caption.strip()[:500]

    # Snapshot minimal presentation state per §26 comment (some cached
    # snapshots ok for performance) so if the source is later deleted the
    # feed card can still show what existed when posted.
    if title_id is not None:
        title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
        if title is None:
            raise ValueError("title_id references a title that does not exist")
        payload["title_name_at_share"] = title.title
        payload["poster_url_at_share"] = title.poster_url
    if list_id is not None:
        watchlist = db.scalar(select(Watchlist).where(Watchlist.id == list_id))
        if watchlist is None or watchlist.owner_user_id != author_user_id:
            raise ValueError("list_id must reference a list you own")
        payload["list_name_at_share"] = watchlist.name
    if rating_id is not None:
        rating = db.scalar(select(Rating).where(Rating.id == rating_id))
        if rating is None or rating.user_id != author_user_id:
            raise ValueError("rating_id must reference a rating you own")
        payload["rating_score_at_share"] = float(rating.score) if rating.score is not None else None

    event = FeedEvent(
        id=uuid4(),
        actor_user_id=author_user_id,
        team_id=None,
        content_title_id=title_id,
        event_type=post_type,
        source_type="social_post",
        source_id=None,
        visibility=visibility,
        rating_id=rating_id,
        list_id=list_id,
        payload=payload,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


def delete_social_post(db: Session, viewer_user_id: UUID, event_id: UUID) -> None:
    """Only the author may delete a post (§58 authorization)."""
    event = db.scalar(select(FeedEvent).where(FeedEvent.id == event_id))
    if event is None:
        return
    if event.actor_user_id != viewer_user_id:
        raise PermissionError("Only the author may delete this post")
    # Delete associated reactions + comments so the post disappears fully.
    from sqlalchemy import delete as sa_delete

    db.execute(sa_delete(FeedReaction).where(FeedReaction.event_id == event_id))
    db.execute(sa_delete(FeedComment).where(FeedComment.event_id == event_id))
    db.execute(sa_delete(FeedEvent).where(FeedEvent.id == event_id))
    db.commit()


# ─── Feed queries (§27 feed-service abstraction, §28 pagination) ─────────────


def following_feed(
    db: Session,
    viewer_user_id: UUID,
    *,
    limit: int = 20,
    before_created_at: datetime | None = None,
) -> list[FeedEvent]:
    """Return posts from users the viewer follows, ordered by recency.
    Cursor-based pagination via `before_created_at` per §28 — offset-based
    would produce duplicates as new posts insert."""
    following_subq = (
        select(UserFollow.following_user_id)
        .where(UserFollow.follower_user_id == viewer_user_id)
        .subquery()
    )
    conds = [
        FeedEvent.actor_user_id.in_(select(following_subq)),
        FeedEvent.event_type.in_(SOCIAL_POST_TYPES),
        _visible_to_viewer_clause(viewer_user_id),
    ]
    block_clause = _block_exclusion_clause(viewer_user_id)
    if block_clause is not None:
        conds.append(block_clause)
    if before_created_at is not None:
        conds.append(FeedEvent.created_at < before_created_at)

    return list(
        db.scalars(
            select(FeedEvent)
            .where(and_(*conds))
            .order_by(FeedEvent.created_at.desc())
            .limit(limit)
        ).all()
    )


def user_activity_feed(
    db: Session,
    profile_user_id: UUID,
    viewer_user_id: UUID | None,
    *,
    limit: int = 30,
) -> list[FeedEvent]:
    """Public / follower-visible posts on a user's profile Activity tab
    (§70). Enforces the same visibility + block rules as the following feed
    but scoped to a single author."""
    conds = [
        FeedEvent.actor_user_id == profile_user_id,
        FeedEvent.event_type.in_(SOCIAL_POST_TYPES),
        _visible_to_viewer_clause(viewer_user_id),
    ]
    block_clause = _block_exclusion_clause(viewer_user_id)
    if block_clause is not None:
        conds.append(block_clause)
    return list(
        db.scalars(
            select(FeedEvent)
            .where(and_(*conds))
            .order_by(FeedEvent.created_at.desc())
            .limit(limit)
        ).all()
    )


# ─── Engagement (§33 likes, §34 comments) ────────────────────────────────────


def toggle_like(db: Session, viewer_user_id: UUID, event_id: UUID) -> bool:
    """Idempotent toggle — returns the new liked state. Uses FeedReaction
    with reaction='like'. On the like transition, fires a notification to
    the post author (dedup by (liker, post) so a rapid unlike/relike doesn't
    spam)."""
    from app.services.notifications import notify_social_like

    existing = db.scalar(
        select(FeedReaction).where(
            FeedReaction.event_id == event_id,
            FeedReaction.user_id == viewer_user_id,
            FeedReaction.reaction == "like",
        )
    )
    if existing is not None:
        db.delete(existing)
        db.commit()
        return False
    db.add(
        FeedReaction(
            event_id=event_id,
            user_id=viewer_user_id,
            reaction="like",
        )
    )
    # Notify post author. Runs after the reaction insert so the author's
    # notification badge count reflects the new state.
    event = db.scalar(select(FeedEvent).where(FeedEvent.id == event_id))
    liker = db.scalar(select(User).where(User.id == viewer_user_id))
    if event is not None and liker is not None:
        title = None
        if event.content_title_id is not None:
            title = db.scalar(
                select(ContentTitle).where(ContentTitle.id == event.content_title_id)
            )
        summary = (title.title if title else None) or (event.payload or {}).get("caption")
        notify_social_like(
            db,
            liker=liker,
            post_author_id=event.actor_user_id,
            post_id=event.id,
            post_summary=summary,
            is_demo=liker.is_demo,
        )
    db.commit()
    return True


def list_comments(db: Session, event_id: UUID, *, limit: int = 100) -> list[FeedComment]:
    return list(
        db.scalars(
            select(FeedComment)
            .where(FeedComment.event_id == event_id)
            .order_by(FeedComment.created_at.asc())
            .limit(limit)
        ).all()
    )


def create_comment(
    db: Session, viewer_user_id: UUID, event_id: UUID, body: str
) -> FeedComment:
    """Insert a new comment + notify the post author (not deduped — every
    fresh comment is a fresh notification per §45)."""
    from app.services.notifications import notify_social_comment

    body = (body or "").strip()
    if not body:
        raise ValueError("Comment body may not be empty")
    if len(body) > 500:
        body = body[:500]
    comment = FeedComment(
        event_id=event_id,
        user_id=viewer_user_id,
        parent_comment_id=None,
        body=body,
    )
    db.add(comment)
    db.flush()

    event = db.scalar(select(FeedEvent).where(FeedEvent.id == event_id))
    commenter = db.scalar(select(User).where(User.id == viewer_user_id))
    if event is not None and commenter is not None:
        notify_social_comment(
            db,
            commenter=commenter,
            post_author_id=event.actor_user_id,
            post_id=event.id,
            comment_id=comment.id,
            excerpt=body,
            is_demo=commenter.is_demo,
        )
    db.commit()
    db.refresh(comment)
    return comment


def delete_comment(db: Session, viewer_user_id: UUID, comment_id: UUID) -> None:
    comment = db.scalar(select(FeedComment).where(FeedComment.id == comment_id))
    if comment is None:
        return
    if comment.user_id != viewer_user_id:
        raise PermissionError("Only the author may delete this comment")
    db.delete(comment)
    db.commit()


# ─── Blocks + reports (§23, §52) ─────────────────────────────────────────────


def toggle_block(db: Session, blocker_id: UUID, blocked_id: UUID) -> bool:
    """Returns the new blocked state. Blocking supersedes follow — removes
    any active UserFollow rows in either direction."""
    if blocker_id == blocked_id:
        raise ValueError("You cannot block yourself")
    existing = db.scalar(
        select(Block).where(
            Block.blocker_user_id == blocker_id,
            Block.blocked_user_id == blocked_id,
        )
    )
    if existing is not None:
        db.delete(existing)
        db.commit()
        return False
    # Remove the follow relationships so blocked users disappear cleanly.
    from sqlalchemy import delete as sa_delete

    db.execute(
        sa_delete(UserFollow).where(
            or_(
                and_(
                    UserFollow.follower_user_id == blocker_id,
                    UserFollow.following_user_id == blocked_id,
                ),
                and_(
                    UserFollow.follower_user_id == blocked_id,
                    UserFollow.following_user_id == blocker_id,
                ),
            )
        )
    )
    db.add(
        Block(
            blocker_user_id=blocker_id,
            blocked_user_id=blocked_id,
        )
    )
    db.commit()
    return True


def create_report(
    db: Session,
    reporter_id: UUID,
    *,
    reason: str,
    reported_user_id: UUID | None = None,
    feed_event_id: UUID | None = None,
    comment_id: UUID | None = None,
    notes: str | None = None,
) -> Report:
    valid_reasons = {"harassment", "hate", "spam", "inappropriate", "impersonation", "other"}
    if reason not in valid_reasons:
        raise ValueError(f"Unsupported report reason: {reason}")
    if reported_user_id is None and feed_event_id is None and comment_id is None:
        raise ValueError("Report must target a user, post, or comment")
    report = Report(
        reporter_user_id=reporter_id,
        reported_user_id=reported_user_id,
        feed_event_id=feed_event_id,
        comment_id=comment_id,
        reason=reason,
        notes=(notes or "")[:1000] or None,
        status="open",
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


# ─── User search (§19) ───────────────────────────────────────────────────────


def search_users(
    db: Session,
    query: str,
    *,
    viewer_user_id: UUID | None = None,
    limit: int = 20,
    include_demo: bool = False,
) -> list[UserProfile]:
    """Search by display_name or username. Excludes blocked users + the
    viewer themselves. Case-insensitive contains matching.

    Per Social brief §4 + §73 no-fake-data rule: demo/seed accounts are
    filtered out unless the caller explicitly opts in (dev tools / test
    fixtures). Prevents "Demo Reactor 001" and other seeded users from
    appearing in production user search results."""
    q = (query or "").strip()
    if len(q) < 2:
        return []
    like = f"%{q.lower()}%"
    query_obj = (
        select(UserProfile)
        .join(User, User.id == UserProfile.user_id)
        .where(
            or_(
                UserProfile.display_name.ilike(like),
                UserProfile.username.ilike(like),
            )
        )
    )
    if not include_demo:
        query_obj = query_obj.where(User.is_demo.is_(False))
    rows = db.scalars(query_obj.limit(limit * 2)).all()

    # Filter blocks + self out post-query (small pool; simpler than adding a
    # NOT EXISTS join for a search endpoint).
    if viewer_user_id is not None:
        blocked_pairs = db.scalars(
            select(Block.blocked_user_id).where(Block.blocker_user_id == viewer_user_id)
        ).all()
        blocked_by = db.scalars(
            select(Block.blocker_user_id).where(Block.blocked_user_id == viewer_user_id)
        ).all()
        excluded = set(blocked_pairs) | set(blocked_by) | {viewer_user_id}
        rows = [r for r in rows if r.user_id not in excluded]
    return rows[:limit]


# ─── Hydration helpers (§84 normalized feed object contract) ─────────────────


def hydrate_feed_event(
    db: Session,
    event: FeedEvent,
    viewer_user_id: UUID | None,
) -> dict:
    """One post → complete dict the client can render directly. Batched
    variant should be preferred for N > 1 (avoids N+1); this is fine for
    single-post detail lookups."""
    from app.models.social import FeedComment as FC

    author_profile = db.scalar(
        select(UserProfile).where(UserProfile.user_id == event.actor_user_id)
    )
    title = None
    if event.content_title_id is not None:
        title = db.scalar(select(ContentTitle).where(ContentTitle.id == event.content_title_id))
    rating = None
    if event.rating_id is not None:
        rating = db.scalar(select(Rating).where(Rating.id == event.rating_id))
    watchlist = None
    list_items_preview: list[dict] = []
    if event.list_id is not None:
        watchlist = db.scalar(select(Watchlist).where(Watchlist.id == event.list_id))
        if watchlist is not None:
            preview_rows = db.execute(
                select(WatchlistItem, ContentTitle)
                .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
                .where(WatchlistItem.watchlist_id == watchlist.id)
                .order_by(WatchlistItem.created_at.desc())
                .limit(5)
            ).all()
            for _, t in preview_rows:
                if t is None:
                    continue
                list_items_preview.append({
                    "title_id": str(t.id),
                    "title_name": t.title,
                    "poster_url": t.poster_url,
                })

    like_count = int(
        db.scalar(
            select(FeedReaction.id).where(
                FeedReaction.event_id == event.id,
                FeedReaction.reaction == "like",
            ).limit(1000).with_only_columns(FeedReaction.id)
        )
        or 0
    )
    # Actual count via scalar aggregate — the .limit(1000) above returns
    # a scalar id, so re-query with func.count for accuracy.
    from sqlalchemy import func as sqlfunc

    like_count = int(
        db.scalar(
            select(sqlfunc.count(FeedReaction.id)).where(
                FeedReaction.event_id == event.id,
                FeedReaction.reaction == "like",
            )
        )
        or 0
    )
    comment_count = int(
        db.scalar(
            select(sqlfunc.count(FC.id)).where(FC.event_id == event.id)
        )
        or 0
    )
    viewer_liked = False
    viewer_following_author = False
    if viewer_user_id is not None:
        viewer_liked = (
            db.scalar(
                select(FeedReaction.id).where(
                    FeedReaction.event_id == event.id,
                    FeedReaction.user_id == viewer_user_id,
                    FeedReaction.reaction == "like",
                )
            )
            is not None
        )
        viewer_following_author = (
            db.scalar(
                select(UserFollow.id).where(
                    UserFollow.follower_user_id == viewer_user_id,
                    UserFollow.following_user_id == event.actor_user_id,
                )
            )
            is not None
        )

    return {
        "id": str(event.id),
        "post_type": event.event_type,
        "visibility": event.visibility,
        "caption": (event.payload or {}).get("caption") if isinstance(event.payload, dict) else None,
        "created_at": event.created_at.isoformat(),
        "author": {
            "user_id": str(event.actor_user_id),
            "display_name": author_profile.display_name if author_profile else None,
            "username": author_profile.username if author_profile else None,
            "avatar_url": author_profile.avatar_url if author_profile else None,
        },
        "title": {
            "id": str(title.id),
            "title": title.title,
            "content_type": title.content_type,
            "poster_url": title.poster_url,
            "backdrop_url": title.backdrop_url,
        } if title else None,
        "rating": {
            "id": str(rating.id),
            "score": float(rating.score) if rating.score is not None else None,
        } if rating else None,
        "list": {
            "id": str(watchlist.id),
            "name": watchlist.name,
            "description": watchlist.description,
            "item_count": len(list_items_preview),
            "preview": list_items_preview,
        } if watchlist else None,
        "engagement": {
            "like_count": like_count,
            "comment_count": comment_count,
        },
        "viewer_state": {
            "liked": viewer_liked,
            "following_author": viewer_following_author,
            "is_author": viewer_user_id == event.actor_user_id if viewer_user_id else False,
        },
    }
