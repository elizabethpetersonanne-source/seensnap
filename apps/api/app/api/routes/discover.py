"""Discover home and trending endpoints."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.schemas.content import TitleResponse
from app.services.collections import (
    get_active_collections,
    resolve_collection_titles,
    seed_collections,
)
from app.services.discover import get_trending
from app.services.discover_feed import build_discover_feed
from app.services.taste import get_social_recommendations, get_taste_profile

router = APIRouter()


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class TrendingResponse(BaseModel):
    source_mode: str
    display_label: str
    generated_at: str
    items: list[TitleResponse]


class CollectionItemResponse(BaseModel):
    slug: str
    title: str
    subtitle: str | None
    thesis: str | None
    collection_type: str
    media_scope: str
    poster_urls: list[str]


class DiscoverModule(BaseModel):
    module_type: str
    title: str
    subtitle: str | None = None
    source_mode: str | None = None
    items: list[TitleResponse] = []
    collections: list[CollectionItemResponse] = []
    see_all_route: str | None = None
    generated_at: str | None = None


class DiscoverHomeResponse(BaseModel):
    modules: list[DiscoverModule]
    generated_at: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_title_response(t: ContentTitle) -> TitleResponse:
    return TitleResponse(
        id=t.id,
        tmdb_id=t.tmdb_id,
        content_type=t.content_type,
        title=t.title,
        overview=t.overview,
        poster_url=t.poster_url,
        backdrop_url=t.backdrop_url,
        genres=t.genres or [],
        release_date=t.release_date,
        runtime_minutes=t.runtime_minutes,
        season_count=t.season_count,
        tmdb_rating=float(t.tmdb_vote_average) if t.tmdb_vote_average else None,
        language=t.metadata_raw.get("original_language") if t.metadata_raw else None,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/trending", response_model=TrendingResponse)
def discover_trending(
    db: DbSession,
    _user: CurrentUser,
    limit: int = Query(default=12, ge=4, le=20),
) -> TrendingResponse:
    result = get_trending(db, limit=limit)
    return TrendingResponse(
        source_mode=result["source_mode"],
        display_label=result["display_label"],
        generated_at=result["generated_at"],
        items=[_to_title_response(t) for t in result["items"]],
    )


@router.get("/home", response_model=DiscoverHomeResponse)
def discover_home(
    db: DbSession,
    current_user: CurrentUser,
    limit_trending: int = Query(default=8, ge=4, le=16),
    limit_for_you: int = Query(default=8, ge=4, le=16),
    limit_collections: int = Query(default=3, ge=1, le=5),
    limit_collection_titles: int = Query(default=6, ge=4, le=12),
) -> DiscoverHomeResponse:
    from datetime import datetime, timezone as tz
    now = datetime.now(tz.utc).isoformat()

    modules: list[DiscoverModule] = []

    # Module 1: Swipe / Scene DNA continuation (metadata only, no titles needed here)
    modules.append(DiscoverModule(
        module_type="swipe_cta",
        title="Keep discovering",
        subtitle="Build your Scene DNA with every swipe",
        see_all_route="/(tabs)/for-you",
    ))

    # Module 2: Trending
    trending_result = get_trending(db, limit=limit_trending)
    if trending_result["items"]:
        modules.append(DiscoverModule(
            module_type="trending",
            title=trending_result["display_label"],
            subtitle="48H · UPDATED REGULARLY",
            source_mode=trending_result["source_mode"],
            items=[_to_title_response(t) for t in trending_result["items"]],
            see_all_route=None,
            generated_at=trending_result["generated_at"],
        ))

    # Module 3: For Your Scene (personalized recommendations)
    try:
        recs = get_social_recommendations(db, user_id=current_user.id, limit=limit_for_you)
        if recs:
            # de-duplicate against trending
            trending_ids = {item.id for item in trending_result.get("items", [])}
            rec_items = [r for r in recs if r.title.id not in trending_ids][:limit_for_you]
            if rec_items:
                modules.append(DiscoverModule(
                    module_type="for_your_scene",
                    title="For Your Scene",
                    subtitle="Based on your taste profile",
                    items=[_to_title_response(r.title) for r in rec_items],
                    see_all_route="/(tabs)/for-you",
                ))
    except Exception:
        pass  # Graceful degradation — if no taste profile yet, skip module

    # Module 4–5: Featured Collections (2–3)
    all_collections = get_active_collections(db)
    featured_colls = all_collections[:limit_collections]

    seen_title_ids: set = set()
    for m in modules:
        for item in m.items:
            seen_title_ids.add(item.id)

    for coll in featured_colls:
        titles = resolve_collection_titles(db, coll, limit=limit_collection_titles)
        # de-duplicate against already-shown titles
        unique_titles = [t for t in titles if str(t.id) not in seen_title_ids][:limit_collection_titles]
        for t in unique_titles:
            seen_title_ids.add(str(t.id))

        poster_urls = [t.poster_url for t in titles[:4] if t.poster_url]

        modules.append(DiscoverModule(
            module_type="collection",
            title=coll.title,
            subtitle=coll.subtitle,
            collections=[CollectionItemResponse(
                slug=coll.slug,
                title=coll.title,
                subtitle=coll.subtitle,
                thesis=coll.thesis,
                collection_type=coll.collection_type,
                media_scope=coll.media_scope,
                poster_urls=poster_urls,
            )],
            items=[_to_title_response(t) for t in unique_titles],
            see_all_route=f"/collections/{coll.slug}",
        ))

    return DiscoverHomeResponse(modules=modules, generated_at=now)


@router.get("/feed")
def get_discover_feed(
    current_user: CurrentUser,
    db: DbSession,
    local_hour: int | None = Query(None, ge=0, le=23, description="Client's local hour of day"),
    is_weekend: bool | None = Query(None, description="Override weekend flag"),
) -> dict:
    """Structured Discover feed per brief §28. Backend returns modules; the
    client renders them. Every module is eligible (§27); absent modules did
    not qualify. Context is computed from local time + weekend flag +
    connected services + recent activity, then affects RANKING not just copy
    (§11)."""
    return build_discover_feed(
        db,
        current_user.id,
        local_hour=local_hour,
        is_weekend_override=is_weekend,
    )


@router.post("/admin/seed-collections", include_in_schema=False)
def admin_seed_collections(db: DbSession, _user: CurrentUser) -> dict:
    count = seed_collections(db)
    return {"seeded": count}
