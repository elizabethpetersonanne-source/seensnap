from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.social import UserFollow
from app.models.user import User


def ensure_follows_table(db: Session) -> None:
    # Table is now managed by Alembic migration 20260818_0007_user_follows.
    # This function is kept for call-site compatibility but is a no-op.
    pass


def follow_user(db: Session, follower_user_id: UUID, following_user_id: UUID) -> None:
    ensure_follows_table(db)
    if follower_user_id == following_user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot follow yourself")

    target_exists = db.scalar(select(User.id).where(User.id == following_user_id))
    if target_exists is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    existing = db.scalar(
        select(UserFollow).where(
            UserFollow.follower_user_id == follower_user_id,
            UserFollow.following_user_id == following_user_id,
        )
    )
    if existing is None:
        db.add(
            UserFollow(
                follower_user_id=follower_user_id,
                following_user_id=following_user_id,
            )
        )
        db.flush()
        # Notify the followed user — dedup key inside the notification
        # service prevents follow/unfollow/refollow spam.
        follower = db.scalar(select(User).where(User.id == follower_user_id))
        if follower is not None:
            from app.services.notifications import notify_social_new_follower
            notify_social_new_follower(
                db,
                follower=follower,
                followed_user_id=following_user_id,
                is_demo=follower.is_demo,
            )
        db.commit()


def unfollow_user(db: Session, follower_user_id: UUID, following_user_id: UUID) -> None:
    ensure_follows_table(db)
    existing = db.scalar(
        select(UserFollow).where(
            UserFollow.follower_user_id == follower_user_id,
            UserFollow.following_user_id == following_user_id,
        )
    )
    if existing is None:
        return
    db.delete(existing)
    db.commit()


def is_following(db: Session, follower_user_id: UUID, following_user_id: UUID) -> bool:
    ensure_follows_table(db)
    return (
        db.scalar(
            select(UserFollow.id).where(
                UserFollow.follower_user_id == follower_user_id,
                UserFollow.following_user_id == following_user_id,
            )
        )
        is not None
    )


def list_following_ids(db: Session, follower_user_id: UUID) -> set[UUID]:
    ensure_follows_table(db)
    return set(
        db.scalars(select(UserFollow.following_user_id).where(UserFollow.follower_user_id == follower_user_id)).all()
    )


def get_follow_counts(db: Session, user_id: UUID) -> tuple[int, int]:
    ensure_follows_table(db)
    followers = db.scalar(
        select(func.count(UserFollow.id)).where(UserFollow.following_user_id == user_id)
    ) or 0
    following = db.scalar(
        select(func.count(UserFollow.id)).where(UserFollow.follower_user_id == user_id)
    ) or 0
    return int(followers), int(following)
