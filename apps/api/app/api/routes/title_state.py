"""Oct-18 build brief §5: canonical title state endpoint.

One place for every surface (Swipe, Preview, Discover card, title
modal, Social feed, My Picks, Teams) to mutate the viewer's
relationship to a title. The response is the full
TitleStateSnapshot projection so clients can reconcile every cached
rendering with a single write.

    POST   /me/title-state/{id}/save
    DELETE /me/title-state/{id}/save
    POST   /me/title-state/{id}/watched
    POST   /me/title-state/{id}/rate     body: {score, expected_version?}
    DELETE /me/title-state/{id}/rate
    GET    /me/title-state/{id}

The existing /me/ratings endpoints are preserved for back-compat;
new clients should prefer this canonical surface.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.api.dependencies import CurrentUser, DbSession
from app.services.title_state import (
    TitleStateError,
    clear_rating,
    mark_watched,
    rate_title,
    save_title,
    unsave_title,
    _snapshot,
)


router = APIRouter()


class TitleStateResponse(BaseModel):
    title_id: UUID
    saved: bool
    watched: bool
    rating: int | None
    favorite: bool
    ranked_position: int | None
    rank_origin: str | None
    version: int
    updated_at: datetime


class RateRequest(BaseModel):
    score: int = Field(ge=1, le=10)
    expected_version: int | None = None


def _to_response(snap) -> TitleStateResponse:
    return TitleStateResponse(
        title_id=snap.title_id,
        saved=snap.saved,
        watched=snap.watched,
        rating=snap.rating,
        favorite=snap.favorite,
        ranked_position=snap.ranked_position,
        rank_origin=snap.rank_origin,
        version=snap.version,
        updated_at=snap.updated_at,
    )


def _translate(err: TitleStateError) -> HTTPException:
    if err.code == "title_not_found":
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=err.message)
    if err.code == "version_conflict":
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": err.code, "message": err.message})
    if err.code == "invalid_score":
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.message)
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.message)


@router.get("/{title_id}", response_model=TitleStateResponse)
def get_state(title_id: UUID, current_user: CurrentUser, db: DbSession) -> TitleStateResponse:
    return _to_response(_snapshot(db, current_user.id, title_id))


@router.post("/{title_id}/save", response_model=TitleStateResponse)
def save(title_id: UUID, current_user: CurrentUser, db: DbSession) -> TitleStateResponse:
    try:
        return _to_response(save_title(db, current_user.id, title_id))
    except TitleStateError as e:
        raise _translate(e)


@router.delete("/{title_id}/save", response_model=TitleStateResponse)
def unsave(title_id: UUID, current_user: CurrentUser, db: DbSession) -> TitleStateResponse:
    try:
        return _to_response(unsave_title(db, current_user.id, title_id))
    except TitleStateError as e:
        raise _translate(e)


@router.post("/{title_id}/watched", response_model=TitleStateResponse)
def watched(title_id: UUID, current_user: CurrentUser, db: DbSession) -> TitleStateResponse:
    try:
        return _to_response(mark_watched(db, current_user.id, title_id))
    except TitleStateError as e:
        raise _translate(e)


@router.post("/{title_id}/rate", response_model=TitleStateResponse)
def rate(
    title_id: UUID,
    payload: RateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TitleStateResponse:
    try:
        return _to_response(rate_title(
            db, current_user.id, title_id,
            payload.score,
            expected_version=payload.expected_version,
        ))
    except TitleStateError as e:
        raise _translate(e)


@router.delete("/{title_id}/rate", response_model=TitleStateResponse)
def unrate(title_id: UUID, current_user: CurrentUser, db: DbSession) -> TitleStateResponse:
    try:
        return _to_response(clear_rating(db, current_user.id, title_id))
    except TitleStateError as e:
        raise _translate(e)
