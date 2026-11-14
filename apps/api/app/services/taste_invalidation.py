"""Invalidate derived summaries in the same transaction as a personal change."""
from datetime import datetime, timezone
from sqlalchemy import update
from app.models.taste import UserSignal, UserTasteProfile
from app.models.user import User


def invalidate_taste(db, user_id):
    db.execute(update(User).where(User.id == user_id).values(taste_version=User.taste_version + 1))
    stale = datetime(1970, 1, 1, tzinfo=timezone.utc)
    db.execute(update(UserTasteProfile).where(UserTasteProfile.user_id == user_id).values(updated_at=stale))
    db.execute(update(UserSignal).where(UserSignal.user_id == user_id).values(last_updated=stale))
