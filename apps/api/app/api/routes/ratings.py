"""Personal 1-10 ratings + watch status.

Sep-22 execution brief §7 canonical service:

  GET  /me/ratings/{title_id}      → current viewer's rating + status
  PUT  /me/ratings/{title_id}      → upsert a 1-10 integer rating
  DELETE /me/ratings/{title_id}    → clear rating (keeps Watched state)
  PATCH /me/ratings/{title_id}/status → set watched / want_to_watch

The rating is the canonical personal-score record. Every title-bearing
surface reads from here so a single rating updates everywhere.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import Rating, TitleWatchStatus


router = APIRouter()


VALID_STATES = {"want_to_watch", "watched"}


class RatingResponse(BaseModel):
    title_id: UUID
    score: int | None  # null = unrated
    watched_state: str  # "watched" | "want_to_watch"
    version: int
    updated_at: datetime | None


class RatingUpsertRequest(BaseModel):
    score: int = Field(ge=1, le=10)
    # Optional expected-version — if supplied and different from the
    # server's current version, the write is rejected (409). Clients
    # that don't care about concurrency can omit it.
    expected_version: int | None = None


class WatchStatusRequest(BaseModel):
    watched_state: str = Field(pattern="^(want_to_watch|watched)$")
    # Sep-22 brief §7 rated-to-unwatched correction: if the user
    # changes a Watched title back to Want to Watch and there IS a
    # score, the client should have shown an explicit confirmation and
    # then send confirm_clear_rating=True. Without that flag, we
    # refuse the transition rather than silently erasing the rating.
    confirm_clear_rating: bool = False


def _resolve_title_id(db, title_id: UUID) -> ContentTitle:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
    return title


def _read_state(db, user_id: UUID, title_id: UUID) -> RatingResponse:
    rating = db.scalar(select(Rating).where(Rating.user_id == user_id, Rating.content_title_id == title_id))
    if rating is not None:
        return RatingResponse(
            title_id=title_id,
            # Legacy rows may hold a Numeric(3,1) half-integer; normalize
            # to nearest whole 1-10 for the UI contract.
            score=int(round(float(rating.score))),
            watched_state=rating.watched_state or "watched",
            version=rating.version,
            updated_at=rating.updated_at,
        )
    ws = db.scalar(select(TitleWatchStatus).where(TitleWatchStatus.user_id == user_id, TitleWatchStatus.content_title_id == title_id))
    return RatingResponse(
        title_id=title_id,
        score=None,
        watched_state=(ws.watched_state if ws else "want_to_watch"),
        version=0,
        updated_at=ws.updated_at if ws else None,
    )


@router.get("/{title_id}", response_model=RatingResponse)
def get_rating(title_id: UUID, current_user: CurrentUser, db: DbSession) -> RatingResponse:
    _resolve_title_id(db, title_id)
    return _read_state(db, current_user.id, title_id)


@router.put("/{title_id}", response_model=RatingResponse)
def upsert_rating(
    title_id: UUID,
    payload: RatingUpsertRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RatingResponse:
    _resolve_title_id(db, title_id)
    existing = db.scalar(select(Rating).where(
        Rating.user_id == current_user.id,
        Rating.content_title_id == title_id,
    ))
    if existing is not None:
        if payload.expected_version is not None and payload.expected_version != existing.version:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "version_conflict",
                    "server_version": existing.version,
                },
            )
        existing.score = Decimal(str(payload.score))
        existing.watched_state = "watched"  # submitting a rating implies watched
        existing.version += 1
        existing.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
    else:
        existing = Rating(
            id=uuid4(),
            user_id=current_user.id,
            content_title_id=title_id,
            score=Decimal(str(payload.score)),
            watched_state="watched",
            version=1,
        )
        db.add(existing)
        # Clean up any Want-to-Watch stub — the rating now supersedes it.
        db.execute(
            TitleWatchStatus.__table__.delete().where(
                TitleWatchStatus.user_id == current_user.id,
                TitleWatchStatus.content_title_id == title_id,
            )
        )
        db.commit()
        db.refresh(existing)
    return _read_state(db, current_user.id, title_id)


@router.delete("/{title_id}", response_model=RatingResponse)
def clear_rating(title_id: UUID, current_user: CurrentUser, db: DbSession) -> RatingResponse:
    """Clear the numeric score but preserve Watched state per brief §7."""
    _resolve_title_id(db, title_id)
    rating = db.scalar(select(Rating).where(
        Rating.user_id == current_user.id,
        Rating.content_title_id == title_id,
    ))
    if rating is None:
        return _read_state(db, current_user.id, title_id)
    # Move to a Watched TitleWatchStatus row and delete the numeric Rating.
    db.execute(
        TitleWatchStatus.__table__.delete().where(
            TitleWatchStatus.user_id == current_user.id,
            TitleWatchStatus.content_title_id == title_id,
        )
    )
    db.add(
        TitleWatchStatus(
            id=uuid4(),
            user_id=current_user.id,
            content_title_id=title_id,
            watched_state="watched",
        )
    )
    db.delete(rating)
    db.commit()
    return _read_state(db, current_user.id, title_id)


@router.patch("/{title_id}/status", response_model=RatingResponse)
def set_watch_status(
    title_id: UUID,
    payload: WatchStatusRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RatingResponse:
    _resolve_title_id(db, title_id)
    rating = db.scalar(select(Rating).where(
        Rating.user_id == current_user.id,
        Rating.content_title_id == title_id,
    ))

    if payload.watched_state == "watched":
        # Preserve or create a Watched status. If there's already a
        # rating, keep it — Watched is implied.
        if rating is not None:
            rating.watched_state = "watched"
            rating.updated_at = datetime.now(timezone.utc)
            rating.version += 1
            db.commit()
            db.refresh(rating)
            return _read_state(db, current_user.id, title_id)
        ws = db.scalar(select(TitleWatchStatus).where(
            TitleWatchStatus.user_id == current_user.id,
            TitleWatchStatus.content_title_id == title_id,
        ))
        if ws is None:
            db.add(TitleWatchStatus(
                id=uuid4(),
                user_id=current_user.id,
                content_title_id=title_id,
                watched_state="watched",
            ))
        else:
            ws.watched_state = "watched"
            ws.updated_at = datetime.now(timezone.utc)
        db.commit()
        return _read_state(db, current_user.id, title_id)

    # want_to_watch — reversing a Watched-with-score needs explicit confirmation.
    if rating is not None and not payload.confirm_clear_rating:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "confirm_required",
                "reason": "changing_watched_to_want_erases_rating",
                "current_score": int(round(float(rating.score))),
            },
        )
    if rating is not None:
        db.delete(rating)
    ws = db.scalar(select(TitleWatchStatus).where(
        TitleWatchStatus.user_id == current_user.id,
        TitleWatchStatus.content_title_id == title_id,
    ))
    if ws is None:
        db.add(TitleWatchStatus(
            id=uuid4(),
            user_id=current_user.id,
            content_title_id=title_id,
            watched_state="want_to_watch",
        ))
    else:
        ws.watched_state = "want_to_watch"
        ws.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _read_state(db, current_user.id, title_id)


class BulkRatingsResponse(BaseModel):
    ratings: dict[str, RatingResponse]


@router.get("", response_model=BulkRatingsResponse)
def get_bulk_ratings(
    current_user: CurrentUser,
    db: DbSession,
    ids: str = Query(..., description="Comma-separated title UUIDs, up to 100"),
) -> BulkRatingsResponse:
    """Batch endpoint so a feed / grid render can hydrate every visible
    title's rating in one call instead of N HTTP round trips."""
    raw_ids = [x.strip() for x in ids.split(",") if x.strip()][:100]
    resolved: dict[str, RatingResponse] = {}
    for raw in raw_ids:
        try:
            tid = UUID(raw)
        except ValueError:
            continue
        # Only return rows the user has — no need to 404 for unknown ids
        # in a batch; the client just gets a missing key.
        rating = db.scalar(select(Rating).where(Rating.user_id == current_user.id, Rating.content_title_id == tid))
        ws = db.scalar(select(TitleWatchStatus).where(TitleWatchStatus.user_id == current_user.id, TitleWatchStatus.content_title_id == tid))
        if rating is None and ws is None:
            continue
        if rating is not None:
            resolved[str(tid)] = RatingResponse(
                title_id=tid,
                score=int(round(float(rating.score))),
                watched_state=rating.watched_state or "watched",
                version=rating.version,
                updated_at=rating.updated_at,
            )
        else:
            assert ws is not None
            resolved[str(tid)] = RatingResponse(
                title_id=tid,
                score=None,
                watched_state=ws.watched_state,
                version=0,
                updated_at=ws.updated_at,
            )
    return BulkRatingsResponse(ratings=resolved)
