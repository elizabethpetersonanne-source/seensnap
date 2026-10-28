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
from sqlalchemy import func, select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import FeedEvent, RankedFavorite, Rating


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
    # Real count of the user's ranked collection — not the row count
    # of this page. Oct-27 follow-up explicitly forbids reporting the
    # loaded page size as the total.
    total: int
    # Rendering hint. 500 is a soft limit on the write path; the read
    # path returns every row regardless.
    max_capacity: int = 500


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
    limit: int = Query(default=500, ge=1, le=1000),
) -> RankedFavoritesResponse:
    """Return the viewer's ordered favorites list. `limit` is a page
    size; the response always reports the real `total` from the
    collection, not the row count on this page."""
    favorites = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
        .limit(limit)
    ).all()
    # Real total of ALL rows for this user — never the page size.
    total = int(db.scalar(
        select(func.count()).select_from(RankedFavorite).where(RankedFavorite.user_id == current_user.id)
    ) or 0)
    return RankedFavoritesResponse(items=_hydrate(db, current_user.id, favorites), total=total)


class ReplaceOrderRequest(BaseModel):
    # Ordered list of title IDs. Position is derived from the index
    # (i+1). Max 500; duplicates rejected. Passing [] clears the list.
    title_ids: list[UUID] = Field(default_factory=list, max_length=500)


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
    to_position: int = Field(ge=1, le=1000)


class PublishRankChangeRequest(BaseModel):
    """Oct-27 spec SOC-01: a Social post representing a deliberate
    rank move. The viewer passes the previous_rank they saw in the UI;
    the server reads the current (post-move) rank from RankedFavorite.
    `visibility` matches the author's publishing default."""
    previous_rank: int | None = Field(default=None, ge=1, le=100)
    visibility: str = Field(default="followers", pattern="^(public|followers|private)$")


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


@router.post("/ranked/{title_id}/publish-rank-change")
def publish_rank_change(
    title_id: UUID,
    payload: PublishRankChangeRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    """SOC-01: emit a Social feed event capturing a deliberate rank
    move. previous_rank + new_rank are snapshotted on the event payload
    so the historical label never recomputes from the author's current
    ranking."""
    target = db.scalar(
        select(RankedFavorite).where(
            RankedFavorite.user_id == current_user.id,
            RankedFavorite.content_title_id == title_id,
        )
    )
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not in your ranked favorites")
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    event_payload = {
        "previous_rank": payload.previous_rank,
        "new_rank": target.position,
        "title_name_at_share": title.title,
        "poster_url_at_share": title.poster_url,
    }
    event = FeedEvent(
        id=uuid4(),
        actor_user_id=current_user.id,
        team_id=None,
        content_title_id=title_id,
        event_type="rank_change",
        source_type="social_post",
        source_id=None,
        visibility=payload.visibility,
        rating_id=None,
        list_id=None,
        payload=event_payload,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    from app.services.social_feed import hydrate_feed_event
    return hydrate_feed_event(db, event, current_user.id)


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
    position: int | None = Field(default=None, ge=1, le=1000)


# ─── Rated-but-not-ranked (Oct-27 follow-up R05–R06) ───────────────────


class UnplacedRow(BaseModel):
    title_id: UUID
    tmdb_id: int | None = None
    title: str
    poster_url: str | None = None
    year: int | None = None
    media_type: str
    personal_score: int


class UnplacedResponse(BaseModel):
    items: list[UnplacedRow]
    total: int


@router.get("/ranked/unplaced", response_model=UnplacedResponse)
def get_unplaced_rated(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=200, ge=1, le=500),
) -> UnplacedResponse:
    """Return rated titles the viewer hasn't placed in Ranked Favorites.
    Owner-only. Ordered by score desc, then updated_at desc.
    """
    ranked_ids = set(db.scalars(
        select(RankedFavorite.content_title_id).where(RankedFavorite.user_id == current_user.id)
    ).all())

    rated_rows = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == current_user.id)
        .order_by(Rating.score.desc(), Rating.updated_at.desc())
    ).all()

    unplaced: list[UnplacedRow] = []
    for r, t in rated_rows:
        if t.id in ranked_ids:
            continue
        unplaced.append(UnplacedRow(
            title_id=t.id,
            tmdb_id=t.tmdb_id,
            title=t.title,
            poster_url=t.poster_url,
            year=t.release_date.year if t.release_date else None,
            media_type=t.content_type,
            personal_score=int(round(float(r.score))),
        ))

    total = len(unplaced)
    return UnplacedResponse(items=unplaced[:limit], total=total)


class BulkAddRequest(BaseModel):
    """Append every unplaced rated title to the END of the user's
    current ranking, ordered by score desc + stable tie-breaker.
    Never reorders existing manually ranked titles."""
    # Optional subset — if omitted, append ALL unplaced rated titles.
    title_ids: list[UUID] | None = Field(default=None, max_length=500)


@router.post("/ranked/append-unplaced", response_model=RankedFavoritesResponse)
def append_unplaced_rated(
    payload: BulkAddRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RankedFavoritesResponse:
    """R06: Add remaining rated titles by score. Appends only — the
    existing manual positions are untouched."""
    ranked = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
    ).all()
    ranked_ids = {r.content_title_id for r in ranked}

    rated_rows = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == current_user.id)
        .order_by(Rating.score.desc(), Rating.updated_at.desc(), ContentTitle.id.asc())
    ).all()

    # Candidate list in canonical order (score desc, updated desc, id asc).
    candidate_ids: list[UUID] = []
    allowed_set: set[UUID] | None = set(payload.title_ids) if payload.title_ids else None
    for r, t in rated_rows:
        if t.id in ranked_ids:
            continue
        if allowed_set is not None and t.id not in allowed_set:
            continue
        candidate_ids.append(t.id)

    if not candidate_ids:
        return RankedFavoritesResponse(items=_hydrate(db, current_user.id, ranked), total=len(ranked))

    # Enforce the 500-row ranking cap when appending.
    remaining = 500 - len(ranked)
    if remaining <= 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ranked list is full (500 entries)")
    to_add = candidate_ids[:remaining]

    now = datetime.now(timezone.utc)
    next_position = len(ranked) + 1
    for tid in to_add:
        db.add(RankedFavorite(
            id=uuid4(),
            user_id=current_user.id,
            content_title_id=tid,
            position=next_position,
            version=1,
            created_at=now,
            updated_at=now,
        ))
        next_position += 1
    db.commit()

    final_rows = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == current_user.id)
        .order_by(RankedFavorite.position.asc())
    ).all()
    total = int(db.scalar(
        select(func.count()).select_from(RankedFavorite).where(RankedFavorite.user_id == current_user.id)
    ) or 0)
    return RankedFavoritesResponse(items=_hydrate(db, current_user.id, final_rows), total=total)


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
    if len(favorites) >= 500:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ranked list is full (500 entries)")

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
