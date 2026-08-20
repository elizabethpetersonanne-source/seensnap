from __future__ import annotations

from collections import Counter, defaultdict
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import FeedComment, FeedEvent, FeedReaction, Team, TeamMember, UserFollow
from app.models.user import User, UserProfile
from app.services.follows import ensure_follows_table


def _demo_actor_ids_subquery():
    """IDs of users flagged as demo. Used to exclude demo-owned entities from real-user views."""
    return select(User.id).where(User.is_demo.is_(True))


def _viewer_is_demo(db: Session, viewer_user_id: UUID) -> bool:
    return bool(db.scalar(select(User.is_demo).where(User.id == viewer_user_id)))


VALID_REACTIONS = {"fire", "heart", "thumbs_down", "tomato"}


def list_user_team_ids(db: Session, user_id: UUID) -> list[UUID]:
    return db.scalars(
        select(TeamMember.team_id)
        .join(Team, Team.id == TeamMember.team_id)
        .where(
            TeamMember.user_id == user_id,
            TeamMember.status == "active",
            Team.archived_at.is_(None),
        )
    ).all()


def create_feed_event(
    db: Session,
    *,
    actor_user_id: UUID,
    event_type: str,
    source_type: str,
    team_id: UUID | None = None,
    content_title_id: UUID | None = None,
    source_id: UUID | None = None,
    payload: dict | None = None,
) -> FeedEvent:
    event = FeedEvent(
        actor_user_id=actor_user_id,
        team_id=team_id,
        content_title_id=content_title_id,
        event_type=event_type,
        source_type=source_type,
        source_id=source_id,
        payload=payload or {},
    )
    db.add(event)
    db.flush()
    return event


def create_wall_post(
    db: Session,
    *,
    actor_user_id: UUID,
    content_title_id: UUID | None,
    caption: str | None,
    rating: float | None,
    share_to_team_id: UUID | None,
) -> FeedEvent:
    title = None
    if content_title_id is not None:
        title = db.scalar(select(ContentTitle).where(ContentTitle.id == content_title_id))
        if title is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    if share_to_team_id is not None:
        membership = db.scalar(
            select(TeamMember).where(
                TeamMember.team_id == share_to_team_id,
                TeamMember.user_id == actor_user_id,
                TeamMember.status == "active",
            )
        )
        if membership is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Team membership required")

    event = create_feed_event(
        db,
        actor_user_id=actor_user_id,
        team_id=share_to_team_id,
        content_title_id=content_title_id,
        event_type="wall_post",
        source_type="social_wall",
        payload={
            "caption": (caption or "").strip(),
            "body": (caption or "").strip(),
            "rating": rating,
            "destination": "watch_team" if share_to_team_id else "social_wall",
            "title_name": title.title if title is not None else None,
            "action_label": "rated a title" if title is not None and rating is not None else "shared an update",
        },
    )
    db.commit()
    db.refresh(event)
    return event


def require_event_access(db: Session, event: FeedEvent, user_id: UUID) -> None:
    if event.team_id is None:
        return
    membership = db.scalar(
        select(TeamMember).where(
            TeamMember.team_id == event.team_id,
            TeamMember.user_id == user_id,
            TeamMember.status == "active",
        )
    )
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Feed event not accessible")


def get_feed_event(db: Session, event_id: UUID) -> FeedEvent:
    event = db.scalar(select(FeedEvent).where(FeedEvent.id == event_id))
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feed event not found")
    return event


def set_reaction(db: Session, event: FeedEvent, user_id: UUID, reaction: str) -> FeedReaction:
    normalized = reaction.strip().lower()
    if normalized not in VALID_REACTIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reaction")

    existing = db.scalar(
        select(FeedReaction).where(FeedReaction.event_id == event.id, FeedReaction.user_id == user_id)
    )
    if existing is None:
        existing = FeedReaction(event_id=event.id, user_id=user_id, reaction=normalized)
        db.add(existing)
    else:
        existing.reaction = normalized
    db.commit()
    db.refresh(existing)
    return existing


def clear_reaction(db: Session, event: FeedEvent, user_id: UUID) -> None:
    existing = db.scalar(
        select(FeedReaction).where(FeedReaction.event_id == event.id, FeedReaction.user_id == user_id)
    )
    if existing is None:
        return
    db.delete(existing)
    db.commit()


def add_comment(
    db: Session,
    *,
    event: FeedEvent,
    user_id: UUID,
    body: str,
    parent_comment_id: UUID | None = None,
) -> FeedComment:
    text = body.strip()
    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Comment cannot be empty")

    if parent_comment_id is not None:
        parent = db.scalar(
            select(FeedComment).where(FeedComment.id == parent_comment_id, FeedComment.event_id == event.id)
        )
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent comment not found")

    comment = FeedComment(
        event_id=event.id,
        user_id=user_id,
        body=text,
        parent_comment_id=parent_comment_id,
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return comment


def delete_feed_event(db: Session, *, event: FeedEvent, requester_user_id: UUID) -> None:
    if event.actor_user_id != requester_user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the author can delete this post")
    db.query(FeedReaction).filter(FeedReaction.event_id == event.id).delete(synchronize_session=False)
    db.query(FeedComment).filter(FeedComment.event_id == event.id).delete(synchronize_session=False)
    db.delete(event)
    db.commit()


def delete_feed_comment(db: Session, *, comment: FeedComment, requester_user_id: UUID) -> None:
    if comment.user_id != requester_user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the author can delete this comment")
    db.query(FeedComment).filter(FeedComment.parent_comment_id == comment.id).delete(synchronize_session=False)
    db.delete(comment)
    db.commit()


def list_comments(db: Session, event_id: UUID) -> list[FeedComment]:
    return db.scalars(
        select(FeedComment).where(FeedComment.event_id == event_id).order_by(FeedComment.created_at.asc())
    ).all()


def list_feed_for_you(db: Session, user_id: UUID, limit: int = 50) -> list[FeedEvent]:
    ensure_follows_table(db)
    team_ids = list_user_team_ids(db, user_id)
    segment = FeedEvent.payload["segment"].astext
    stmt = (
        select(FeedEvent)
        .where(
            ((FeedEvent.team_id.is_(None)) & ((segment != "discover") | segment.is_(None)))
            | (FeedEvent.team_id.in_(team_ids))
        )
        .order_by(FeedEvent.created_at.desc())
        .limit(limit)
    )
    if not _viewer_is_demo(db, user_id):
        stmt = stmt.where(FeedEvent.actor_user_id.not_in(_demo_actor_ids_subquery()))
    events = db.scalars(stmt).all()
    return _sort_for_you(db, user_id, team_ids, events)


def list_feed_watch_teams(db: Session, user_id: UUID, team_id: UUID | None, limit: int = 50) -> list[FeedEvent]:
    team_ids = list_user_team_ids(db, user_id)
    if team_id is not None and team_id not in set(team_ids):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Team membership required")

    selected = [team_id] if team_id is not None else team_ids
    if not selected:
        return []
    stmt = (
        select(FeedEvent)
        .where(FeedEvent.team_id.in_(selected))
        .order_by(FeedEvent.created_at.desc())
        .limit(limit)
    )
    if not _viewer_is_demo(db, user_id):
        stmt = stmt.where(FeedEvent.actor_user_id.not_in(_demo_actor_ids_subquery()))
    return db.scalars(stmt).all()


def list_feed_discover(db: Session, viewer_user_id: UUID, limit: int = 50) -> list[FeedEvent]:
    stmt = (
        select(FeedEvent)
        .where(
            FeedEvent.team_id.is_(None),
            FeedEvent.payload["segment"].astext == "discover",
        )
        .order_by(FeedEvent.created_at.desc())
        .limit(limit)
    )
    if not _viewer_is_demo(db, viewer_user_id):
        stmt = stmt.where(FeedEvent.actor_user_id.not_in(_demo_actor_ids_subquery()))
    return db.scalars(stmt).all()


def _sort_for_you(db: Session, user_id: UUID, team_ids: list[UUID], events: list[FeedEvent]) -> list[FeedEvent]:
    if not events:
        return []
    ensure_follows_table(db)

    actor_ids = {event.actor_user_id for event in events}
    following_ids = set(
        db.scalars(select(UserFollow.following_user_id).where(UserFollow.follower_user_id == user_id)).all()
    )
    shared_counts: dict[UUID, int] = {}
    if team_ids and actor_ids:
        rows = db.execute(
            select(TeamMember.user_id, func.count(TeamMember.team_id))
            .where(TeamMember.team_id.in_(team_ids), TeamMember.status == "active")
            .group_by(TeamMember.user_id)
        ).all()
        shared_counts = {actor_id: count for actor_id, count in rows}

    event_ids = [event.id for event in events]
    reaction_counts = dict(
        db.execute(select(FeedReaction.event_id, func.count(FeedReaction.id)).where(FeedReaction.event_id.in_(event_ids)).group_by(FeedReaction.event_id)).all()
    )
    comment_counts = dict(
        db.execute(select(FeedComment.event_id, func.count(FeedComment.id)).where(FeedComment.event_id.in_(event_ids)).group_by(FeedComment.event_id)).all()
    )

    now = datetime.now(UTC)

    def score(event: FeedEvent) -> float:
        age_hours = max((now - event.created_at).total_seconds() / 3600.0, 0.0)
        recency_score = max(72.0 - age_hours, 0.0)
        engagement = reaction_counts.get(event.id, 0) + comment_counts.get(event.id, 0)
        relationship = shared_counts.get(event.actor_user_id, 0)
        following_boost = 9.0 if event.actor_user_id in following_ids else 0.0
        self_boost = 4.0 if event.actor_user_id == user_id else 0.0
        return recency_score + engagement * 3.0 + relationship * 2.0 + following_boost + self_boost

    return sorted(events, key=lambda e: (score(e), e.created_at), reverse=True)


def build_feed_response_data(
    db: Session,
    events: list[FeedEvent],
    viewer_user_id: UUID,
) -> tuple[
    dict[UUID, UserProfile],
    dict[UUID, ContentTitle],
    dict[UUID, Counter],
    dict[UUID, str],
    dict[UUID, int],
    set[UUID],
]:
    ensure_follows_table(db)
    event_ids = [event.id for event in events]
    actor_ids = {event.actor_user_id for event in events}
    title_ids = {event.content_title_id for event in events if event.content_title_id is not None}

    profiles = db.scalars(select(UserProfile).where(UserProfile.user_id.in_(actor_ids))).all()
    titles = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(title_ids))).all() if title_ids else []
    reactions = (
        db.scalars(select(FeedReaction).where(FeedReaction.event_id.in_(event_ids))).all() if event_ids else []
    )
    comments = (
        db.execute(select(FeedComment.event_id, func.count(FeedComment.id)).where(FeedComment.event_id.in_(event_ids)).group_by(FeedComment.event_id)).all()
        if event_ids
        else []
    )

    reaction_counts: dict[UUID, Counter] = defaultdict(Counter)
    my_reactions: dict[UUID, str] = {}
    for reaction in reactions:
        reaction_counts[reaction.event_id][reaction.reaction] += 1
        if reaction.user_id == viewer_user_id:
            my_reactions[reaction.event_id] = reaction.reaction

    comment_counts = {event_id: count for event_id, count in comments}
    following_ids = set(
        db.scalars(select(UserFollow.following_user_id).where(UserFollow.follower_user_id == viewer_user_id)).all()
    )
    return (
        {profile.user_id: profile for profile in profiles},
        {title.id: title for title in titles},
        reaction_counts,
        my_reactions,
        comment_counts,
        following_ids,
    )
