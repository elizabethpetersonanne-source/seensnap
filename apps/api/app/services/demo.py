from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.social import Watchlist
from app.models.user import User, UserPreferences, UserProfile

DEMO_EMAIL = "seensnap.demo@demo.seensnap.local"
DEMO_TOKEN = "expo-go-demo-session"
LEGACY_DEMO_EMAILS = ("demo@seensnap.app", "seensnap_demo@demo.seensnap.local")
DEMO_USERNAME = "seensnap.demo"
DEMO_DISPLAY_NAME = "SeenSnap Demo"


def ensure_demo_user(db: Session) -> User:
    user = db.scalar(select(User).where(func.lower(User.email) == DEMO_EMAIL.lower()))
    if user is None:
        for legacy_email in LEGACY_DEMO_EMAILS:
            user = db.scalar(select(User).where(func.lower(User.email) == legacy_email.lower()))
            if user is not None:
                user.email = DEMO_EMAIL
                user.auth_provider = "demo"
                user.is_demo = True
                break
    if user is None:
        user = User(email=DEMO_EMAIL, auth_provider="demo", is_demo=True)
        db.add(user)
        db.flush()

        db.add(
            UserProfile(
                user_id=user.id,
                username=DEMO_USERNAME,
                display_name=DEMO_DISPLAY_NAME,
                favorite_genres=[],
                country_code="US",
            )
        )
        db.add(UserPreferences(user_id=user.id))
        db.add(Watchlist(owner_user_id=user.id, name="My Picks", is_default=True))
        db.commit()
        db.refresh(user)
        return user

    if not user.is_demo:
        user.is_demo = True

    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    if profile is None:
        db.add(
            UserProfile(
                user_id=user.id,
                username=DEMO_USERNAME,
                display_name=DEMO_DISPLAY_NAME,
                favorite_genres=[],
                country_code="US",
            )
        )
    else:
        profile.username = DEMO_USERNAME
        profile.display_name = DEMO_DISPLAY_NAME
    preferences = db.scalar(select(UserPreferences).where(UserPreferences.user_id == user.id))
    if preferences is None:
        db.add(UserPreferences(user_id=user.id))
    watchlist = db.scalar(
        select(Watchlist).where(Watchlist.owner_user_id == user.id, Watchlist.is_default.is_(True))
    )
    if watchlist is None:
        db.add(Watchlist(owner_user_id=user.id, name="My Picks", is_default=True))
    db.commit()
    db.refresh(user)
    return user
