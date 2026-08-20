"""Global search across TMDB content, collections, and user-owned objects."""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.core.config import settings
from app.models.social import TeamMember, Watchlist
from app.models.content import ContentTitle
from app.services.collections import get_active_collections
from app.services.tmdb import (
    _tmdb_headers,
    _upsert_title_from_tmdb_result,
)

router = APIRouter()

TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w185"


class SearchResultItem(BaseModel):
    entity_type: str       # movie | series | person | collection | list | team
    entity_id: str
    title: str
    subtitle: str | None = None
    artwork: str | None = None     # poster/profile image
    year: int | None = None
    media_type: str | None = None  # movie | series | person | collection
    route: str                      # deep-link route for the mobile client
    source: str                    # tmdb | local


class SearchResponse(BaseModel):
    query: str
    movies: list[SearchResultItem]
    series: list[SearchResultItem]
    people: list[SearchResultItem]
    collections: list[SearchResultItem]
    my_stuff: list[SearchResultItem]


def _tmdb_multi_search(query: str) -> list[dict[str, Any]]:
    try:
        with httpx.Client(
            base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15
        ) as client:
            resp = client.get(
                "/search/multi",
                params={"query": query, "include_adult": "false", "language": "en-US"},
            )
            resp.raise_for_status()
            return resp.json().get("results", [])
    except Exception:
        return []


def _person_route(tmdb_id: int) -> str:
    return f"/person/{tmdb_id}"


def _title_route(content_type: str, tmdb_id: int) -> str:
    if content_type == "movie":
        return f"/titles/{tmdb_id}"
    return f"/titles/{tmdb_id}"


@router.get("/global", response_model=SearchResponse)
def global_search(
    q: str,
    db: DbSession,
    current_user: CurrentUser,
    type: str | None = Query(default=None, pattern="^(movie|series|people|collections)$"),
) -> SearchResponse:
    q = q.strip()
    if not q:
        return SearchResponse(
            query=q, movies=[], series=[], people=[], collections=[], my_stuff=[]
        )

    movies: list[SearchResultItem] = []
    series: list[SearchResultItem] = []
    people: list[SearchResultItem] = []
    collections_results: list[SearchResultItem] = []
    my_stuff: list[SearchResultItem] = []

    # ── TMDB fan-out ────────────────────────────────────────────────────────
    raw_results = _tmdb_multi_search(q)

    for item in raw_results:
        media_type = item.get("media_type")

        if media_type in {"movie", "tv"} and type in {None, "movie" if media_type == "movie" else "series", None}:
            # Upsert into local DB for cache purposes
            try:
                upserted = _upsert_title_from_tmdb_result(db, item)
                if upserted:
                    release_year = None
                    if upserted.release_date:
                        release_year = upserted.release_date.year
                    entity_type = "movie" if media_type == "movie" else "series"
                    result_item = SearchResultItem(
                        entity_type=entity_type,
                        entity_id=str(upserted.id),
                        title=upserted.title,
                        subtitle=", ".join((upserted.genres or [])[:2]) or None,
                        artwork=upserted.poster_url,
                        year=release_year,
                        media_type=entity_type,
                        route=_title_route(upserted.content_type, upserted.tmdb_id),
                        source="tmdb",
                    )
                    if media_type == "movie":
                        if type in {None, "movie"}:
                            movies.append(result_item)
                    else:
                        if type in {None, "series"}:
                            series.append(result_item)
            except Exception:
                pass

        elif media_type == "person" and type in {None, "people"}:
            name = item.get("name") or ""
            tmdb_id = item.get("id")
            profile_path = item.get("profile_path")
            known_for = item.get("known_for_department", "")
            if not name or not tmdb_id:
                continue
            known_titles = [
                kf.get("title") or kf.get("name")
                for kf in item.get("known_for", [])
                if kf.get("title") or kf.get("name")
            ]
            subtitle = f"{known_for}" + (f" · {', '.join(known_titles[:2])}" if known_titles else "")
            artwork = f"{TMDB_IMAGE_BASE}{profile_path}" if profile_path else None
            people.append(SearchResultItem(
                entity_type="person",
                entity_id=str(tmdb_id),
                title=name,
                subtitle=subtitle or None,
                artwork=artwork,
                year=None,
                media_type="person",
                route=_person_route(tmdb_id),
                source="tmdb",
            ))

    try:
        db.commit()
    except Exception:
        pass

    # ── Local collections ────────────────────────────────────────────────────
    if type in {None, "collections"}:
        q_lower = q.lower()
        for coll in get_active_collections(db):
            if q_lower in coll.title.lower() or (coll.subtitle and q_lower in coll.subtitle.lower()):
                collections_results.append(SearchResultItem(
                    entity_type="collection",
                    entity_id=coll.slug,
                    title=coll.title,
                    subtitle=coll.subtitle,
                    artwork=None,
                    year=None,
                    media_type="collection",
                    route=f"/collections/{coll.slug}",
                    source="local",
                ))

    # ── User's own objects (lists + teams) ───────────────────────────────────
    if type is None:
        # User's watchlists/lists
        user_lists = db.scalars(
            select(Watchlist).where(Watchlist.owner_user_id == current_user.id)
        ).all()
        q_lower = q.lower()
        for wl in user_lists:
            if q_lower in wl.name.lower():
                my_stuff.append(SearchResultItem(
                    entity_type="list",
                    entity_id=str(wl.id),
                    title=wl.name,
                    subtitle="Your list",
                    artwork=None,
                    year=None,
                    media_type=None,
                    route=f"/lists/{wl.id}",
                    source="local",
                ))

        # User's teams
        from app.models.social import Team
        team_ids = db.scalars(
            select(TeamMember.team_id).where(TeamMember.user_id == current_user.id)
        ).all()
        if team_ids:
            teams = db.scalars(select(Team).where(Team.id.in_(team_ids))).all()
            for team in teams:
                if q_lower in team.name.lower():
                    my_stuff.append(SearchResultItem(
                        entity_type="team",
                        entity_id=str(team.id),
                        title=team.name,
                        subtitle="Watch Team",
                        artwork=None,
                        year=None,
                        media_type=None,
                        route=f"/teams/{team.id}",
                        source="local",
                    ))

    return SearchResponse(
        query=q,
        movies=movies[:20],
        series=series[:20],
        people=people[:10],
        collections=collections_results[:10],
        my_stuff=my_stuff[:10],
    )
