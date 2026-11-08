"""Real-source Discover collections with owner-scoped, replayable continuation."""

import copy
from datetime import datetime, timedelta, timezone
from uuid import UUID
import httpx
from fastapi import HTTPException
from sqlalchemy import select
from app.core.config import settings
from app.models.content import ContentTitle
from app.models.discovery import DiscoverySession
from app.models.user import UserProfile
from app.services.tmdb import _tmdb_headers, _upsert_title_from_tmdb_result, TmdbConfigurationError
from app.services.title_compatibility import scorer_for_user
from app.services.discovery_decisions import excluded_title_ids


def source_page(db, key, media, region, page):
    path = f"/trending/{media}/week" if key == "trending" else "/movie/now_playing"
    params = {"page": page, "language": "en-US"}
    if key == "now-in-theaters":
        params["region"] = region
    with httpx.Client(
        base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15
    ) as client:
        response = client.get(path, params=params)
        response.raise_for_status()
        payload = response.json()
    rows = []
    for item in payload.get("results", []):
        kind = "movie" if key == "now-in-theaters" else media
        if kind == "all":
            kind = item.get("media_type")
        if kind not in ("movie", "tv"):
            continue
        row = _upsert_title_from_tmdb_result(db, {**item, "media_type": kind})
        if row and row.poster_url:
            rows.append(row)
    return rows, page < min(500, int(payload.get("total_pages") or page))


def region_for_user(db, user_id):
    profile = db.get(UserProfile, user_id)
    return ((profile.country_code if profile else None) or "US").upper()


def source_landing(db, user_id, key, media, limit, region=None):
    from app.api.routes.discover import _to_title_response

    region = region or region_for_user(db, user_id)
    rows = []
    for page in range(1, 4):
        found, more = source_page(db, key, media, region, page)
        rows.extend(found)
        if len(rows) >= limit or not more:
            break
    db.commit()
    return dict(
        source_mode="tmdb_trending" if key == "trending" else "now_in_theaters",
        display_label="Trending this week" if key == "trending" else f"In theaters now · {region}",
        generated_at=datetime.now(timezone.utc).isoformat(),
        items=[_to_title_response(t) for t in rows[:limit]],
    )


def collection_page(db, user_id, key, media="movie", cursor=None, limit=20):
    from app.api.routes.discover import _to_title_response

    if key not in {"for-you", "trending", "now-in-theaters"}:
        raise HTTPException(404, detail="Collection not found")
    if key == "now-in-theaters":
        media = "movie"
    region = region_for_user(db, user_id)
    fingerprint = f"collection_v1:{key}:{media}:{region}"
    now = datetime.now(timezone.utc)
    if cursor:
        try:
            sid, version = cursor.split(":")
            sid = UUID(sid)
            version = int(version)
        except (ValueError, TypeError):
            raise HTTPException(409, detail="Refresh this collection to continue.")
        session = db.scalar(
            select(DiscoverySession)
            .where(DiscoverySession.id == sid, DiscoverySession.user_id == user_id)
            .with_for_update()
        )
        if (
            session is None
            or session.fingerprint != fingerprint
            or now - session.created_at.replace(tzinfo=timezone.utc) > timedelta(hours=24)
        ):
            raise HTTPException(
                409, detail="Your collection or region changed. Refresh to continue."
            )
        if version == session.version - 1 and session.last_response:
            response = copy.deepcopy(session.last_response)
            excluded = excluded_title_ids(db, user_id) if key == "for-you" else set()
            rows = db.scalars(
                select(ContentTitle).where(
                    ContentTitle.id.in_([UUID(item["id"]) for item in response["items"]])
                )
            ).all()
            by_id = {str(t.id): t for t in rows if t.id not in excluded}
            scorer = scorer_for_user(db, user_id, by_id.values())
            response["items"] = [item for item in response["items"] if item["id"] in by_id]
            for item in response["items"]:
                match = scorer.score(by_id[item["id"]]).model_dump(mode="json")
                previous = item.get("scenedna") or {}
                if {k: v for k, v in previous.items() if k != "computed_at"} != {
                    k: v for k, v in match.items() if k != "computed_at"
                }:
                    item["scenedna"] = match
            return response
        if version != session.version:
            raise HTTPException(409, detail="Refresh this collection to continue.")
    else:
        state = {"pending": [], "served": [], "page": 1, "more": True}
        if key == "for-you":
            from app.services.for_you import for_you_recommendations

            recs = for_you_recommendations(
                db,
                user_id,
                preferred_type="movie" if media == "movie" else "show",
                all_candidates=True,
            )
            state.update(pending=[str(r.title.id) for r in recs], more=False)
        session = DiscoverySession(user_id=user_id, fingerprint=fingerprint, state=state)
        db.add(session)
        db.flush()
    state = copy.deepcopy(session.state)
    # Continue the real TMDB source; never pad with unrelated local titles.
    for _ in range(3):
        if len(state["pending"]) >= limit or not state["more"]:
            break
        rows, more = source_page(db, key, media, region, state["page"])
        seen = set(state["pending"]) | set(state["served"])
        for row in rows:
            if str(row.id) not in seen:
                state["pending"].append(str(row.id))
                seen.add(str(row.id))
        state["more"] = more
        state["page"] += 1
    excluded = excluded_title_ids(db, user_id) if key == "for-you" else set()
    items = []
    while state["pending"] and len(items) < limit:
        key_id = state["pending"].pop(0)
        state["served"].append(key_id)
        title = db.get(ContentTitle, UUID(key_id))
        if title is not None and title.id not in excluded:
            items.append(title)
    scorer = scorer_for_user(db, user_id, items)
    result_items = []
    for title in items:
        dto = _to_title_response(title)
        dto.scenedna = scorer.score(title)
        result_items.append(dto.model_dump(mode="json"))
    session.version += 1
    more = bool(state["pending"] or state["more"])
    response = {
        "items": result_items,
        "next_cursor": f"{session.id}:{session.version}" if more else None,
        "has_more": more,
        "region": region,
        "media": media,
        "collection": key,
        "source_mode": "scenedna"
        if key == "for-you"
        else "tmdb_trending"
        if key == "trending"
        else "now_in_theaters",
        "display_label": "For You"
        if key == "for-you"
        else "Trending this week"
        if key == "trending"
        else f"In theaters now · {region}",
    }
    session.state = state
    session.last_response = response
    db.commit()
    return response
