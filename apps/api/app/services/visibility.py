"""Current audience rules shared by links, feeds, profiles and recommendations."""
from uuid import UUID

from sqlalchemy import and_, exists, or_, select, true
from sqlalchemy.orm import Session

from app.models.social import Block, UserFollow, Watchlist


def unblocked_owner_clause(owner_id, viewer_id: UUID | None):
    if viewer_id is None:
        return true()
    return ~exists().where(or_(
        and_(Block.blocker_user_id == owner_id, Block.blocked_user_id == viewer_id),
        and_(Block.blocker_user_id == viewer_id, Block.blocked_user_id == owner_id),
    ))


def visible_list_clause(viewer_id: UUID | None):
    public = Watchlist.visibility == "public"
    if viewer_id is None:
        return public
    follows = exists().where(
        UserFollow.follower_user_id == viewer_id,
        UserFollow.following_user_id == Watchlist.owner_user_id,
    )
    return and_(unblocked_owner_clause(Watchlist.owner_user_id, viewer_id), or_(
        Watchlist.owner_user_id == viewer_id,
        public,
        and_(Watchlist.visibility == "followers", follows),
    ))


def can_view_list(db: Session, list_id: UUID, viewer_id: UUID | None) -> bool:
    return db.scalar(select(Watchlist.id).where(
        Watchlist.id == list_id, visible_list_clause(viewer_id),
    )) is not None


def can_view_profile(db, owner_id, viewer_id):
    from app.models.user import UserProfile, UserPreferences
    profile = db.scalar(select(UserProfile.user_id).where(
        UserProfile.user_id == owner_id, unblocked_owner_clause(UserProfile.user_id, viewer_id),
    ))
    if profile is None:
        return False
    preferences = db.get(UserPreferences, owner_id)
    if owner_id == viewer_id or preferences is None or preferences.profile_visibility == "public":
        return True
    return preferences.profile_visibility == "followers" and db.scalar(select(UserFollow.id).where(
        UserFollow.following_user_id == owner_id, UserFollow.follower_user_id == viewer_id,
    )) is not None
