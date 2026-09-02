from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select

from sqlalchemy import delete, or_, update

from app.api.dependencies import CurrentUser, DbSession
from app.core.config import settings
from app.core.security import create_access_token
from app.db.session import SessionLocal
from app.core.limiter import limiter
from app.models.social import (
    AffiliateClick,
    Block,
    FeedComment,
    FeedEvent,
    FeedReaction,
    ListSave,
    ListShare,
    Notification,
    NotificationOutbox,
    NotificationPreference,
    PeopleDismissal,
    Rating,
    Report,
    Review,
    Share,
    Team,
    TeamActivity,
    TeamMember,
    TeamRanking,
    TeamTitle,
    UserFollow,
    Watchlist,
    WatchlistItem,
)
from app.models.taste import CompatibilityScore, RecommendationSignal, SwipeRecord, UserTasteProfile, WrappedStat
from app.models.user import AuthIdentity, Device, User, UserPreferences, UserProfile
from app.schemas.auth import AppleAuthRequest, DevAuthRequest, GoogleAuthRequest, SessionResponse, SessionUserResponse
from app.services.auth import (
    AppleAuthError,
    GoogleAuthError,
    _ensure_post_auth_state,
    authenticate_with_apple,
    authenticate_with_google,
)
from app.services.watchlists import ensure_default_watchlists  # noqa: F401  (re-exported for compat)

router = APIRouter()


@router.get("/me", response_model=SessionUserResponse, status_code=status.HTTP_200_OK)
def get_session_user(current_user: CurrentUser, db: DbSession) -> SessionUserResponse:
    ensure_default_watchlists(db, current_user.id)
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == current_user.id))
    return SessionUserResponse(
        user_id=current_user.id,
        email=current_user.email,
        display_name=profile.display_name if profile and profile.display_name else current_user.email.split("@", 1)[0],
        avatar_url=profile.avatar_url if profile else None,
    )


@router.post("/google", response_model=SessionResponse, status_code=status.HTTP_200_OK)
@limiter.limit("20/minute")
def google_auth(request: Request, payload: GoogleAuthRequest) -> SessionResponse:
    db = SessionLocal()
    try:
        return authenticate_with_google(db, payload.id_token)
    except GoogleAuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    finally:
        db.close()


@router.post("/apple", response_model=SessionResponse, status_code=status.HTTP_200_OK)
@limiter.limit("20/minute")
def apple_auth(request: Request, payload: AppleAuthRequest) -> SessionResponse:
    db = SessionLocal()
    try:
        return authenticate_with_apple(db, payload.identity_token, display_name=payload.display_name)
    except AppleAuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    finally:
        db.close()


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(current_user: CurrentUser, db: DbSession) -> None:
    uid = current_user.id

    # Nullify parent_comment_id on replies that reference this user's comments
    user_comment_ids = list(db.scalars(select(FeedComment.id).where(FeedComment.user_id == uid)))
    if user_comment_ids:
        db.execute(
            update(FeedComment)
            .where(FeedComment.parent_comment_id.in_(user_comment_ids))
            .values(parent_comment_id=None)
        )

    # Social content — bottom-up FK order
    db.execute(delete(FeedComment).where(FeedComment.user_id == uid))
    db.execute(delete(FeedReaction).where(FeedReaction.user_id == uid))
    db.execute(delete(Share).where(Share.user_id == uid))
    db.execute(delete(Review).where(Review.user_id == uid))
    db.execute(delete(Rating).where(Rating.user_id == uid))
    db.execute(delete(FeedEvent).where(FeedEvent.actor_user_id == uid))
    db.execute(delete(TeamActivity).where(TeamActivity.actor_user_id == uid))
    db.execute(delete(TeamTitle).where(TeamTitle.added_by_user_id == uid))
    db.execute(delete(TeamMember).where(TeamMember.user_id == uid))
    db.execute(delete(AffiliateClick).where(AffiliateClick.user_id == uid))
    # Notification outbox for this user's devices, then notifications
    user_device_ids = list(db.scalars(select(Device.id).where(Device.user_id == uid)))
    if user_device_ids:
        db.execute(delete(NotificationOutbox).where(NotificationOutbox.device_id.in_(user_device_ids)))
    user_notification_ids = list(db.scalars(select(Notification.id).where(Notification.user_id == uid)))
    if user_notification_ids:
        db.execute(delete(NotificationOutbox).where(NotificationOutbox.notification_id.in_(user_notification_ids)))
    db.execute(delete(Notification).where(Notification.user_id == uid))
    db.execute(delete(NotificationPreference).where(NotificationPreference.user_id == uid))
    db.execute(
        delete(UserFollow).where(
            or_(UserFollow.follower_user_id == uid, UserFollow.following_user_id == uid)
        )
    )

    # ListShare / ListSave records the user owns (or created) — no
    # CASCADE on their user FK, so must be cleaned before Watchlist
    # rows go (ListShare.watchlist_id refs watchlists).
    db.execute(delete(ListSave).where(ListSave.user_id == uid))
    db.execute(delete(ListShare).where(ListShare.created_by_user_id == uid))

    # People discovery / moderation records without CASCADE. Blocks and
    # PeopleDismissal DO have CASCADE, but delete explicitly so the
    # transaction stays predictable and doesn't depend on DB-level
    # semantics silently doing the right thing.
    db.execute(delete(PeopleDismissal).where(
        or_(PeopleDismissal.viewer_user_id == uid, PeopleDismissal.candidate_user_id == uid)
    ))
    db.execute(delete(Block).where(
        or_(Block.blocker_user_id == uid, Block.blocked_user_id == uid)
    ))
    db.execute(delete(Report).where(Report.reporter_user_id == uid))
    # Reports about the user get the reported_user_id nulled (that FK
    # is already SET NULL at the schema level, but nulling explicitly
    # keeps the moderation record for audit purposes without pointing
    # at a deleted user id).
    db.execute(
        update(Report)
        .where(Report.reported_user_id == uid)
        .values(reported_user_id=None)
    )

    # Watchlist items then watchlists — ListShare + ListSave above
    # already covered the shares that referenced these watchlists.
    user_watchlist_ids = db.scalars(
        select(Watchlist.id).where(Watchlist.owner_user_id == uid)
    ).all()
    if user_watchlist_ids:
        db.execute(delete(WatchlistItem).where(WatchlistItem.watchlist_id.in_(user_watchlist_ids)))
        # Any list_shares that referenced these lists but were minted
        # by a DIFFERENT user (rare, but possible) also need to go so
        # the Watchlist delete doesn't hit an FK violation.
        db.execute(delete(ListShare).where(ListShare.watchlist_id.in_(user_watchlist_ids)))
        db.execute(delete(ListSave).where(ListSave.watchlist_id.in_(user_watchlist_ids)))
    db.execute(delete(Watchlist).where(Watchlist.owner_user_id == uid))

    # Teams owned by this user — cascade-delete the team and everything
    # attached to it. Deleting a team also removes other members'
    # access to it; that's intentional for "delete my account". Members
    # still keep their picks / SceneDNA — only the shared team is gone.
    owned_team_ids = db.scalars(select(Team.id).where(Team.owner_user_id == uid)).all()
    if owned_team_ids:
        db.execute(delete(TeamActivity).where(TeamActivity.team_id.in_(owned_team_ids)))
        db.execute(delete(TeamTitle).where(TeamTitle.team_id.in_(owned_team_ids)))
        db.execute(delete(TeamMember).where(TeamMember.team_id.in_(owned_team_ids)))
        db.execute(delete(TeamRanking).where(TeamRanking.team_id.in_(owned_team_ids)))
        # FeedEvent and Share can reference teams too via team_id (SET NULL
        # at schema level, but delete explicitly to keep the transaction
        # cleanup ordered and dialect-agnostic).
        db.execute(update(FeedEvent).where(FeedEvent.team_id.in_(owned_team_ids)).values(team_id=None))
        db.execute(update(Share).where(Share.team_id.in_(owned_team_ids)).values(team_id=None))
        db.execute(delete(Team).where(Team.id.in_(owned_team_ids)))

    # Taste data
    db.execute(delete(RecommendationSignal).where(RecommendationSignal.user_id == uid))
    db.execute(
        delete(CompatibilityScore).where(
            or_(CompatibilityScore.user_a_id == uid, CompatibilityScore.user_b_id == uid)
        )
    )
    db.execute(delete(SwipeRecord).where(SwipeRecord.user_id == uid))
    db.execute(delete(UserTasteProfile).where(UserTasteProfile.user_id == uid))
    db.execute(delete(WrappedStat).where(WrappedStat.user_id == uid))

    # User core
    db.execute(delete(Device).where(Device.user_id == uid))
    db.execute(delete(UserPreferences).where(UserPreferences.user_id == uid))
    db.execute(delete(AuthIdentity).where(AuthIdentity.user_id == uid))
    db.execute(delete(UserProfile).where(UserProfile.user_id == uid))
    db.execute(delete(User).where(User.id == uid))
    db.commit()


@router.post("/dev", response_model=SessionResponse, status_code=status.HTTP_200_OK)
@limiter.limit("10/minute")
def dev_auth(request: Request, payload: DevAuthRequest) -> SessionResponse:
    if not settings.dev_auth_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    db = SessionLocal()
    try:
        email = payload.email.strip().lower() or "dev@seensnap.local"
        display_name = payload.display_name.strip() or "Local Dev"

        user = db.scalar(select(User).where(func.lower(User.email) == email))
        if user is None:
            user = User(email=email, auth_provider="dev")
            db.add(user)
            db.flush()

        profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
        if profile is None:
            profile = UserProfile(
                user_id=user.id,
                username=email.split("@", 1)[0][:32] or "local-dev",
                display_name=display_name,
                avatar_url=None,
                favorite_genres=[],
                country_code="US",
            )
            db.add(profile)

        auth_identity = db.scalar(
            select(AuthIdentity).where(
                AuthIdentity.provider == "dev",
                AuthIdentity.provider_subject == email,
            )
        )
        if auth_identity is None:
            db.add(
                AuthIdentity(
                    user_id=user.id,
                    provider="dev",
                    provider_subject=email,
                    email=email,
                )
            )

        _ensure_post_auth_state(db, user)
        db.commit()

        return SessionResponse(
            access_token=create_access_token(user.id, user.email, "dev"),
            user=SessionUserResponse(
                user_id=user.id,
                email=user.email,
                display_name=profile.display_name,
                avatar_url=profile.avatar_url,
            ),
        )
    finally:
        db.close()
