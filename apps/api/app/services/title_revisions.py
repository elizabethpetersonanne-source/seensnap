"""Revision tombstones remain after a rating is removed. Call writers under the user lock."""

from datetime import datetime, timezone
from sqlalchemy import select
from app.models.social import Rating
from app.models.user_state import UserTitleRevision


def current_revision(db, user_id, title_id):
    revision = db.get(UserTitleRevision, (user_id, title_id), populate_existing=True)
    legacy = (
        db.scalar(
            select(Rating.version).where(
                Rating.user_id == user_id, Rating.content_title_id == title_id
            )
        )
        or 0
    )
    return max(revision.version if revision else 0, legacy)


def advance_revision(db, user_id, title_id):
    version = current_revision(db, user_id, title_id) + 1
    row = db.get(UserTitleRevision, (user_id, title_id))
    if row is None:
        row = UserTitleRevision(user_id=user_id, content_title_id=title_id, version=version)
        db.add(row)
    else:
        row.version = version
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return version
