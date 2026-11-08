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
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.user import User
from app.services.title_revisions import current_revision, advance_revision
from app.models.social import Rating, TitleWatchStatus, Watchlist, WatchlistItem


router = APIRouter()


VALID_STATES = {"want_to_watch", "watched"}


class RatingResponse(BaseModel):
    title_id: UUID
    score: int | None  # null = unrated
    watched_state: str  # "watched" | "want_to_watch"
    version: int
    updated_at: datetime | None
    in_next_watch: bool | None = None
    is_saved_anywhere: bool | None = None
    saved_list_ids: list[UUID] | None = None


class RatingUpsertRequest(BaseModel):
    score: int = Field(ge=1, le=10)
    # Optional expected-version — if supplied and different from the
    # server's current version, the write is rejected (409). Clients
    # that don't care about concurrency can omit it.
    expected_version: int | None = None


class WatchStatusRequest(BaseModel):
    expected_version: int | None = Field(default=None, ge=0)
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
    lists = db.execute(select(Watchlist.id, Watchlist.system_role).join(
        WatchlistItem, WatchlistItem.watchlist_id == Watchlist.id,
    ).where(Watchlist.owner_user_id == user_id, WatchlistItem.content_title_id == title_id)).all()
    membership = {"in_next_watch": any(role == "next_watch" for _, role in lists),
                  "is_saved_anywhere": bool(lists), "saved_list_ids": [lid for lid, _ in lists]}
    rating = db.scalar(select(Rating).where(Rating.user_id == user_id, Rating.content_title_id == title_id))
    if rating is not None:
        return RatingResponse(
            title_id=title_id,
            # Legacy rows may hold a Numeric(3,1) half-integer; normalize
            # to nearest whole 1-10 for the UI contract.
            score=int(round(float(rating.score))),
            watched_state=rating.watched_state or "watched",
            version=current_revision(db,user_id,title_id),
            updated_at=rating.updated_at,
            **membership,
        )
    ws = db.scalar(select(TitleWatchStatus).where(TitleWatchStatus.user_id == user_id, TitleWatchStatus.content_title_id == title_id))
    return RatingResponse(
        title_id=title_id,
        score=None,
        watched_state=(ws.watched_state if ws else "want_to_watch"),
        version=current_revision(db,user_id,title_id),
        updated_at=ws.updated_at if ws else None,
        **membership,
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
    from app.services.title_state import rate_title, TitleStateError
    try:
        rate_title(db, current_user.id, title_id, payload.score,
                   expected_version=payload.expected_version)
    except TitleStateError as exc:
        code = 409 if exc.code == "version_conflict" else 404 if exc.code == "title_not_found" else 400
        raise HTTPException(status_code=code, detail={"code": exc.code,
            "current": _read_state(db, current_user.id, title_id).model_dump(mode="json")}) from exc
    return _read_state(db, current_user.id, title_id)


@router.delete("/{title_id}", response_model=RatingResponse)
def clear_rating(title_id: UUID, current_user: CurrentUser, db: DbSession, expected_version: int | None = None) -> RatingResponse:
    from app.services.title_state import clear_rating as clear_title_rating, TitleStateError
    _resolve_title_id(db, title_id)
    try:
        clear_title_rating(db, current_user.id, title_id, expected_version=expected_version)
    except TitleStateError as exc:
        raise HTTPException(409, detail={"code": exc.code,
            "current": _read_state(db, current_user.id, title_id).model_dump(mode="json")}) from exc
    return _read_state(db, current_user.id, title_id)


@router.patch("/{title_id}/status", response_model=RatingResponse)
def set_watch_status(
    title_id: UUID,
    payload: WatchStatusRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RatingResponse:
    db.scalar(select(User.id).where(User.id==current_user.id).with_for_update())
    _resolve_title_id(db, title_id)
    if payload.expected_version is not None and payload.expected_version != current_revision(db, current_user.id, title_id):
        raise HTTPException(409, detail={"code": "version_conflict", "current": _read_state(db, current_user.id, title_id).model_dump(mode="json")})
    rating = db.scalar(select(Rating).where(
        Rating.user_id == current_user.id,
        Rating.content_title_id == title_id,
    ))

    if payload.watched_state == "watched":
        from app.services.title_state import mark_watched
        mark_watched(db, current_user.id, title_id)
        return _read_state(db, current_user.id, title_id)

    # want_to_watch — reversing a Watched-with-score needs explicit confirmation.
    if rating is not None and not payload.confirm_clear_rating:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "confirm_required",
                "reason": "changing_watched_to_want_erases_rating",
                "current_score": int(round(float(rating.score))),
                "current": _read_state(db, current_user.id, title_id).model_dump(mode="json"),
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
    advance_revision(db,current_user.id,title_id)
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
        resolved[str(tid)] = _read_state(db,current_user.id,tid)
    return BulkRatingsResponse(ratings=resolved)
