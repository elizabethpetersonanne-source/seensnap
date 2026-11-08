"""Current audience rules shared by links, feeds, profiles and recommendations."""
from uuid import UUID

from sqlalchemy import and_, exists, or_, select, true
from sqlalchemy.orm import Session, aliased

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


def visible_profile_clause(owner_id, viewer_id):
    from app.models.user import User, UserPreferences
    prefs = aliased(UserPreferences)
    follow = aliased(UserFollow)
    account = aliased(User)
    active = exists().where(account.id == owner_id, account.status == 'active')
    has_prefs = exists().where(prefs.user_id == owner_id)
    public = exists().where(prefs.user_id == owner_id, prefs.profile_visibility == 'public')
    following = exists().where(follow.following_user_id == owner_id, follow.follower_user_id == viewer_id)
    followers = exists().where(prefs.user_id == owner_id, prefs.profile_visibility == 'followers')
    audience = or_(~has_prefs, public, and_(followers,following)) if viewer_id is not None else or_(~has_prefs,public)
    return and_(active, unblocked_owner_clause(owner_id,viewer_id), or_(owner_id == viewer_id,audience) if viewer_id else audience)


def can_view_profile(db, owner_id, viewer_id):
    from app.models.user import UserProfile
    return db.scalar(select(UserProfile.user_id).where(UserProfile.user_id==owner_id,visible_profile_clause(UserProfile.user_id,viewer_id))) is not None
