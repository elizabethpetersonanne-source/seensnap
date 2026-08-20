from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.social import Notification, NotificationOutbox, NotificationPreference
from app.models.user import Device, User, UserProfile

logger = logging.getLogger(__name__)

# Maps notification types to user-facing preference categories
_CATEGORY: dict[str, str] = {
    "team_invite": "team_activity",
    "team_member_joined": "team_activity",
    "team_comment_on_your_activity": "direct_engagement",
    "team_comment_reply": "direct_engagement",
    "team_reaction": "team_activity",
    # Social — Social brief §44-§46. Likes are grouped under direct_engagement
    # rather than team_activity so users can toggle push independently.
    "social_new_follower": "direct_engagement",
    "social_like_on_your_post": "direct_engagement",
    "social_comment_on_your_post": "direct_engagement",
    "social_reply_to_your_comment": "direct_engagement",
}


def _create_notification(
    db: Session,
    *,
    recipient_id: UUID,
    actor_id: UUID | None,
    notification_type: str,
    title: str,
    body: str,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    route: str | None = None,
    dedupe_key: str | None = None,
    is_demo: bool = False,
) -> Notification | None:
    if actor_id is not None and actor_id == recipient_id:
        return None

    if dedupe_key is not None:
        existing = db.scalar(
            select(Notification).where(
                Notification.user_id == recipient_id,
                Notification.dedupe_key == dedupe_key,
            )
        )
        if existing is not None:
            return existing

    notification = Notification(
        user_id=recipient_id,
        actor_user_id=actor_id,
        notification_type=notification_type,
        title=title,
        body=body,
        entity_type=entity_type,
        entity_id=entity_id,
        route=route,
        dedupe_key=dedupe_key,
        is_demo=is_demo,
        payload={},
    )
    db.add(notification)
    db.flush()
    return notification


def _enqueue_push(db: Session, notification: Notification) -> None:
    recipient = db.scalar(select(User).where(User.id == notification.user_id))
    if recipient is None or recipient.is_demo:
        return

    prefs = db.scalar(
        select(NotificationPreference).where(NotificationPreference.user_id == notification.user_id)
    )

    if prefs is not None:
        if not prefs.push_enabled:
            return
        category = _CATEGORY.get(notification.notification_type)
        if category == "team_activity" and not prefs.team_activity:
            return
        if category == "direct_engagement" and not prefs.direct_engagement:
            return

    devices = db.scalars(
        select(Device).where(
            Device.user_id == notification.user_id,
            Device.enabled.is_(True),
            Device.expo_push_token.is_not(None),
        )
    ).all()

    for device in devices:
        db.add(
            NotificationOutbox(
                notification_id=notification.id,
                device_id=device.id,
                provider="expo",
                status="pending",
            )
        )
    db.flush()


def notify_team_member_added(
    db: Session,
    *,
    actor: User,
    team_id: UUID,
    team_name: str,
    recipient_id: UUID,
    is_demo: bool = False,
) -> None:
    actor_profile = db.scalar(select(UserProfile).where(UserProfile.user_id == actor.id))
    actor_name = actor_profile.display_name if actor_profile else "Someone"

    notification = _create_notification(
        db,
        recipient_id=recipient_id,
        actor_id=actor.id,
        notification_type="team_invite",
        title=f"{actor_name} added you to {team_name}.",
        body="See what your Watch Team is considering.",
        entity_type="team",
        entity_id=team_id,
        route=f"/(tabs)/teams?team_id={team_id}",
        dedupe_key=f"team_invite:{team_id}:{recipient_id}:{actor.id}",
        is_demo=is_demo,
    )
    if notification is not None:
        _enqueue_push(db, notification)


def notify_team_member_joined(
    db: Session,
    *,
    joiner: User,
    team_id: UUID,
    team_name: str,
    existing_member_ids: list[UUID],
    is_demo: bool = False,
) -> None:
    joiner_profile = db.scalar(select(UserProfile).where(UserProfile.user_id == joiner.id))
    joiner_name = joiner_profile.display_name if joiner_profile else "Someone"

    for member_id in existing_member_ids:
        if member_id == joiner.id:
            continue
        notification = _create_notification(
            db,
            recipient_id=member_id,
            actor_id=joiner.id,
            notification_type="team_member_joined",
            title=f"{joiner_name} joined {team_name}.",
            body="Your Watch Team has a new perspective.",
            entity_type="team",
            entity_id=team_id,
            route=f"/(tabs)/teams?team_id={team_id}",
            dedupe_key=f"team_joined:{team_id}:{joiner.id}:{member_id}",
            is_demo=is_demo,
        )
        if notification is not None:
            _enqueue_push(db, notification)


def notify_team_comment(
    db: Session,
    *,
    commenter: User,
    team_id: UUID,
    team_name: str,
    activity_id: UUID,
    activity_actor_id: UUID,
    comment_excerpt: str,
    is_demo: bool = False,
) -> None:
    if activity_actor_id == commenter.id:
        return

    commenter_profile = db.scalar(select(UserProfile).where(UserProfile.user_id == commenter.id))
    commenter_name = commenter_profile.display_name if commenter_profile else "Someone"

    excerpt = comment_excerpt.strip()[:120] if comment_excerpt else "New comment on your activity."
    notification = _create_notification(
        db,
        recipient_id=activity_actor_id,
        actor_id=commenter.id,
        notification_type="team_comment_on_your_activity",
        title=f"{commenter_name} commented in {team_name}.",
        body=f'"{excerpt}"' if excerpt else "New comment on your activity.",
        entity_type="team_activity",
        entity_id=activity_id,
        route=f"/(tabs)/teams?team_id={team_id}&activity_id={activity_id}",
        dedupe_key=None,
        is_demo=is_demo,
    )
    if notification is not None:
        _enqueue_push(db, notification)


# ─── Social notifications (Social brief §44–§46) ─────────────────────────────


def notify_social_new_follower(
    db: Session,
    *,
    follower: User,
    followed_user_id: UUID,
    is_demo: bool = False,
) -> None:
    """Fired when someone starts following you. Deduped per follower — if the
    same person follows/unfollows/follows again we don't spam."""
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == follower.id))
    name = profile.display_name if profile else "Someone"
    handle = profile.username if profile else None
    notification = _create_notification(
        db,
        recipient_id=followed_user_id,
        actor_id=follower.id,
        notification_type="social_new_follower",
        title=f"{name} followed you.",
        body=f"@{handle} joined your circle." if handle else "New follower on SeenSnap.",
        entity_type="user",
        entity_id=follower.id,
        route=f"/profile/{follower.id}",
        dedupe_key=f"follow:{follower.id}:{followed_user_id}",
        is_demo=is_demo,
    )
    if notification is not None:
        _enqueue_push(db, notification)


def notify_social_like(
    db: Session,
    *,
    liker: User,
    post_author_id: UUID,
    post_id: UUID,
    post_summary: str | None = None,
    is_demo: bool = False,
) -> None:
    """Fired when someone likes your post. Not deduped by liker — repeat
    likes (unlike + relike) create a fresh notification so the recipient
    sees the current state."""
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == liker.id))
    name = profile.display_name if profile else "Someone"
    summary = post_summary.strip()[:80] if post_summary else "your post"
    notification = _create_notification(
        db,
        recipient_id=post_author_id,
        actor_id=liker.id,
        notification_type="social_like_on_your_post",
        title=f"{name} liked your post.",
        body=f'"{summary}"' if summary else "New like on your post.",
        entity_type="social_post",
        entity_id=post_id,
        route=f"/post/{post_id}",
        # Rolling dedupe key by liker + post so a rapid like/unlike/like loop
        # doesn't multiply notifications.
        dedupe_key=f"like:{liker.id}:{post_id}",
        is_demo=is_demo,
    )
    if notification is not None:
        _enqueue_push(db, notification)


def notify_social_comment(
    db: Session,
    *,
    commenter: User,
    post_author_id: UUID,
    post_id: UUID,
    comment_id: UUID,
    excerpt: str | None = None,
    is_demo: bool = False,
) -> None:
    """Fired when someone comments on your post. Each new comment IS a fresh
    notification (no dedupe by commenter — repeat comments are meaningful)."""
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == commenter.id))
    name = profile.display_name if profile else "Someone"
    body = (excerpt or "").strip()[:120] if excerpt else "New comment on your post."
    notification = _create_notification(
        db,
        recipient_id=post_author_id,
        actor_id=commenter.id,
        notification_type="social_comment_on_your_post",
        title=f"{name} commented on your post.",
        body=f'"{body}"' if body else "New comment on your post.",
        entity_type="social_post",
        entity_id=post_id,
        route=f"/post/{post_id}",
        dedupe_key=None,
        is_demo=is_demo,
    )
    if notification is not None:
        _enqueue_push(db, notification)
