"""Ranked favorites — Sep-22 execution brief §14.

  GET  /me/favorites/ranked                   → viewer's full ordered list
  PUT  /me/favorites/ranked                   → replace the whole order atomically
  POST /me/favorites/ranked/rebuild-draft     → build a draft from watched/rated titles
  POST /me/favorites/ranked/{title_id}/move   → move an entry to a specific position
  DELETE /me/favorites/ranked/{title_id}      → remove an entry

  GET  /profiles/{user_id}/favorites/ranked   → public/follower-visible view

The single ordered collection has up to 100 entries. Top 20 is
"first 20"; Top 100 is "first 100". They cannot disagree because
they read the same rows.

Rating edits do NOT silently re-order once the user has customized —
this is a manual list. The dedicated rebuild endpoint replaces the
current list from watched+rated titles when the user explicitly
requests it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import RankedFavorite, Rating


router = APIRouter()


class RankedFavoriteRow(BaseModel):
    position: int
    title_id: UUID
    tmdb_id: int
    title: str
    poster_url: str | None
    year: int | None
    media_type: str
    personal_score: int | None  # viewer's own rating, if any
    version: int


class RankedFavoritesResponse(BaseModel):
    items: list[RankedFavoriteRow]
    total: int
    max_capacity: int = 100


def _fetch_titles(db, ids: list[UUID]) -> dict[UUID, ContentTitle]:
    if not ids:
        return {}
    rows = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(ids))).all()
    return {t.id: t for t in rows}


def _ratings_map(db, user_id: UUID, title_ids: list[UUID]) -> dict[UUID, int]:
    if not title_ids:
        return {}
    rows = db.scalars(
        select(Rating).where(Rating.user_id == user_id, Rating.content_title_id.in_(title_ids))
    ).all()
    return {r.content_title_id: int(round(float(r.score))) for r in rows}


def _hydrate(db, user_id: UUID, favorites: list[RankedFavorite]) -> list[RankedFavoriteRow]:
    title_ids = [f.content_title_id for f in favorites]
    titles = _fetch_titles(db, title_ids)
    scores = _ratings_map(db, user_id, title_ids)
    out: list[RankedFavoriteRow] = []
    for f in favorites:
        t = titles.get(f.content_title_id)
        if t is None:
            continue
        out.append(
            RankedFavoriteRow(
                position=f.position,
                title_id=t.id,
                tmdb_id=t.tmdb_id,
                title=t.title,
                poster_url=t.poster_url,
                year=t.release_date.year if t.release_date else None,
                media_type=t.content_type,
                personal_score=scores.get(t.id),
                version=f.version,
            )
        )
    return out


@router.get("/ranked", response_model=RankedFavoritesResponse)
def get_ranked_favorites(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=100, ge=1, le=100),
) -> RankedFavoritesResponse:
    """Return the viewer's ordered favorites list. `limit` selects
    Top 20 vs Top 100; the underlying rows are identical."""
    favorites = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
        .limit(limit)
    ).all()
    return RankedFavoritesResponse(items=_hydrate(db, current_user.id, favorites), total=len(favorites))


class ReplaceOrderRequest(BaseModel):
    # Ordered list of title IDs. Position is derived from the index
    # (i+1). Max 100; duplicates rejected. Passing [] clears the list.
    title_ids: list[UUID] = Field(default_factory=list, max_length=100)


@router.put("/ranked", response_model=RankedFavoritesResponse)
def replace_ranked_favorites(
    payload: ReplaceOrderRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RankedFavoritesResponse:
    """Atomic replace-all. Wipes the current rows and rewrites them in
    the supplied order. The deferrable unique constraint on (user_id,
    position) allows both the delete + inserts to happen inside a
    single transaction without collision — commit reconciles."""
    if len(set(payload.title_ids)) != len(payload.title_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Duplicate title in ranked list")
    # Validate every title exists (rejects arbitrary UUIDs from clients).
    existing = _fetch_titles(db, payload.title_ids)
    for tid in payload.title_ids:
        if tid not in existing:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Title not found: {tid}")

    # Wipe + insert. Deferrable per-user-position constraint lets us
    # order these operations without a temporary conflict.
    db.execute(
        RankedFavorite.__table__.delete().where(RankedFavorite.user_id == current_user.id)
    )
    for idx, tid in enumerate(payload.title_ids, start=1):
        db.add(
            RankedFavorite(
                id=uuid4(),
                user_id=current_user.id,
                content_title_id=tid,
                position=idx,
                version=1,
            )
        )
    db.commit()
    favorites = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
    ).all()
    return RankedFavoritesResponse(items=_hydrate(db, current_user.id, favorites), total=len(favorites))


class RebuildDraftResponse(BaseModel):
    draft: list[RankedFavoriteRow]  # unsaved — client must PUT to persist
    would_replace: int


@router.post("/ranked/rebuild-draft", response_model=RebuildDraftResponse)
def rebuild_from_ratings(
    current_user: CurrentUser,
    db: DbSession,
) -> RebuildDraftResponse:
    """Build a draft ranked list from the viewer's watched/rated titles
    sorted by score desc. Ties broken by most-recent-rated, then by
    stable title UUID. Returns the draft WITHOUT saving — the client
    is expected to preview it and PUT the final order.

    Sep-22 brief §14: rating edits must not silently overwrite an
    already-customized order — hence this is opt-in and never runs
    automatically.
    """
    rated_rows = db.scalars(
        select(Rating)
        .where(Rating.user_id == current_user.id, Rating.watched_state == "watched")
        .order_by(Rating.score.desc(), Rating.updated_at.desc())
        .limit(100)
    ).all()
    # Deterministic secondary sort: (score desc, updated_at desc, title_id asc).
    rated_rows_sorted = sorted(
        rated_rows,
        key=lambda r: (
            -int(round(float(r.score))),
            -(r.updated_at.timestamp() if r.updated_at else 0),
            str(r.content_title_id),
        ),
    )[:100]

    title_ids = [r.content_title_id for r in rated_rows_sorted]
    titles = _fetch_titles(db, title_ids)
    scores = _ratings_map(db, current_user.id, title_ids)
    draft: list[RankedFavoriteRow] = []
    for idx, r in enumerate(rated_rows_sorted, start=1):
        t = titles.get(r.content_title_id)
        if t is None:
            continue
        draft.append(
            RankedFavoriteRow(
                position=idx,
                title_id=t.id,
                tmdb_id=t.tmdb_id,
                title=t.title,
                poster_url=t.poster_url,
                year=t.release_date.year if t.release_date else None,
                media_type=t.content_type,
                personal_score=scores.get(t.id),
                version=0,  # unsaved
            )
        )
    would_replace = db.scalar(
        select(RankedFavorite).where(RankedFavorite.user_id == current_user.id).limit(1)
    )
    return RebuildDraftResponse(draft=draft, would_replace=len(draft) if would_replace is None else 1)


class MoveRequest(BaseModel):
    to_position: int = Field(ge=1, le=100)


@router.post("/ranked/{title_id}/move", response_model=RankedFavoritesResponse)
def move_ranked_favorite(
    title_id: UUID,
    payload: MoveRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RankedFavoritesResponse:
    """Move a title to a specific position, shifting others in between
    by one. Idempotent to the requested position."""
    favorites = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
    ).all()
    target = next((f for f in favorites if f.content_title_id == title_id), None)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not in your ranked favorites")

    to_position = min(payload.to_position, len(favorites))
    if target.position == to_position:
        return RankedFavoritesResponse(items=_hydrate(db, current_user.id, favorites), total=len(favorites))

    # Pull the target out, insert at new position, renumber contiguously.
    ordered = [f for f in favorites if f.id != target.id]
    ordered.insert(to_position - 1, target)
    now = datetime.now(timezone.utc)
    for idx, f in enumerate(ordered, start=1):
        if f.position != idx:
            f.position = idx
            f.updated_at = now
            f.version += 1
    db.commit()
    return RankedFavoritesResponse(items=_hydrate(db, current_user.id, ordered), total=len(ordered))


@router.delete("/ranked/{title_id}", response_model=RankedFavoritesResponse)
def remove_ranked_favorite(
    title_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> RankedFavoritesResponse:
    favorites = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
    ).all()
    target = next((f for f in favorites if f.content_title_id == title_id), None)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not in your ranked favorites")
    remaining = [f for f in favorites if f.id != target.id]
    db.delete(target)
    now = datetime.now(timezone.utc)
    for idx, f in enumerate(remaining, start=1):
        if f.position != idx:
            f.position = idx
            f.updated_at = now
            f.version += 1
    db.commit()
    return RankedFavoritesResponse(items=_hydrate(db, current_user.id, remaining), total=len(remaining))


class AddRequest(BaseModel):
    title_id: UUID
    position: int | None = Field(default=None, ge=1, le=100)


@router.post("/ranked", response_model=RankedFavoritesResponse)
def add_ranked_favorite(
    payload: AddRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RankedFavoritesResponse:
    """Add a title. Defaults to appending at the end; supplying
    `position` inserts at that slot (shifting others down)."""
    existing = _fetch_titles(db, [payload.title_id])
    if payload.title_id not in existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
    favorites = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
    ).all()
    if any(f.content_title_id == payload.title_id for f in favorites):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already in ranked favorites")
    if len(favorites) >= 100:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ranked list is full (100 entries)")

    insert_position = payload.position if payload.position is not None else len(favorites) + 1
    insert_position = min(insert_position, len(favorites) + 1)

    new_row = RankedFavorite(
        id=uuid4(),
        user_id=current_user.id,
        content_title_id=payload.title_id,
        position=insert_position,
        version=1,
    )
    ordered = list(favorites)
    ordered.insert(insert_position - 1, new_row)
    db.add(new_row)
    now = datetime.now(timezone.utc)
    for idx, f in enumerate(ordered, start=1):
        if f.id != new_row.id and f.position != idx:
            f.position = idx
            f.updated_at = now
            f.version += 1
    db.commit()
    return RankedFavoritesResponse(items=_hydrate(db, current_user.id, ordered), total=len(ordered))
