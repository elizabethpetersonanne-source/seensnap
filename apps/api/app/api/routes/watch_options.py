"""Watch Now grouped availability endpoint."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentAvailability, ContentTitle
from app.models.user import UserPreferences
from app.services.tmdb import refresh_streaming_options, TmdbConfigurationError

router = APIRouter()

TMDB_LOGO_BASE = "https://image.tmdb.org/t/p/original"


class WatchAction(BaseModel):
    intent: str          # watch | rent | buy | subscribe | search
    label: str
    destination_quality: str  # direct_title | provider_template | tmdb_watch_page | search_fallback
    outbound_url: str | None = None  # resolved destination


class WatchProvider(BaseModel):
    provider_id: int | None
    provider_code: str
    provider_name: str
    logo_url: str | None    # full resolved logo URL (TMDB image base + logo_path)
    logo_path: str | None   # raw TMDB path for client-side resolution
    availability_types: list[str]
    subscription_cta_allowed: bool = False
    actions: list[WatchAction]


class WatchOptionsResponse(BaseModel):
    content_id: str
    region: str
    source: str
    source_attribution: str
    fetched_at: str | None
    groups: dict[str, list[WatchProvider]]  # my_services, free, rent_buy, other_subscriptions


def _resolve_logo_url(logo_path: str | None) -> str | None:
    if not logo_path:
        return None
    return f"{TMDB_LOGO_BASE}{logo_path}"


def _destination_quality(web_url: str | None, deeplink_url: str | None) -> str:
    if deeplink_url:
        return "direct_title"
    if web_url and "themoviedb.org" in (web_url or ""):
        return "tmdb_watch_page"
    if web_url:
        return "provider_template"
    return "search_fallback"


def _make_action(intent: str, label: str, web_url: str | None, deeplink_url: str | None) -> WatchAction | None:
    """Build a WatchAction. Returns None when we can't route the user to the actual
    provider — the client should not render a CTA that leads to TMDB."""
    # Never route users to TMDB.
    if web_url and "themoviedb.org" in web_url:
        web_url = None
    url = deeplink_url or web_url
    if not url:
        # No valid destination — suppress this CTA per spec (rule 4:
        # "Only show the CTA if the destination is valid").
        return None
    dq = _destination_quality(web_url, deeplink_url)
    return WatchAction(intent=intent, label=label, destination_quality=dq, outbound_url=url)


@router.get("/{title_id}/watch-options", response_model=WatchOptionsResponse)
def get_watch_options(
    title_id: str,
    db: DbSession,
    current_user: CurrentUser,
    region: str = Query(default="US", min_length=2, max_length=2),
) -> WatchOptionsResponse:
    from uuid import UUID

    try:
        uid = UUID(title_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    title = db.scalar(select(ContentTitle).where(ContentTitle.id == uid))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    # Refresh if stale or missing
    avail_rows = db.scalars(
        select(ContentAvailability).where(
            ContentAvailability.content_title_id == uid,
            ContentAvailability.region_code == region,
        )
    ).all()

    is_stale = not avail_rows or any(
        row.expires_at is None or row.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc)
        for row in avail_rows
    )
    if is_stale:
        try:
            avail_rows = refresh_streaming_options(db, title, region=region)
        except (TmdbConfigurationError, Exception):
            pass  # Use stale data if refresh fails

    fetched_at = max((r.last_synced_at or r.created_at for r in avail_rows), default=None)
    fetched_at_str = fetched_at.isoformat() if fetched_at else None

    # Get user's preferred services
    prefs = db.scalar(select(UserPreferences).where(UserPreferences.user_id == current_user.id))
    my_service_codes: set[str] = set(getattr(prefs, "connected_streaming_services", None) or [])

    # Group by provider+type
    provider_map: dict[str, dict[str, Any]] = {}  # provider_code -> data
    for row in avail_rows:
        key = row.provider_code
        if key not in provider_map:
            provider_map[key] = {
                "provider_id": row.tmdb_provider_id,
                "provider_code": row.provider_code,
                "provider_name": row.provider_name,
                "logo_path": row.logo_path,
                "logo_url": _resolve_logo_url(row.logo_path),
                "web_url": row.web_url,
                "deeplink_url": row.deeplink_url,
                "types": set(),
            }
        provider_map[key]["types"].add(row.monetization_type)

    my_services: list[WatchProvider] = []
    free: list[WatchProvider] = []
    rent_buy: list[WatchProvider] = []
    other_subs: list[WatchProvider] = []

    for data in provider_map.values():
        types = data["types"]
        web_url = data["web_url"]
        dl_url = data["deeplink_url"]
        is_my_service = data["provider_code"] in my_service_codes

        actions: list[WatchAction] = []
        avail_types = sorted(types)

        def _add(intent: str, label: str) -> None:
            action = _make_action(intent, label, web_url, dl_url)
            if action is not None:
                actions.append(action)

        if "flatrate" in types:
            if is_my_service:
                _add("watch", "Watch")
            else:
                _add("subscribe", "Start subscription")
        if "free" in types:
            _add("watch", "Watch Free")
        if "ads" in types:
            _add("watch", "Watch with Ads")
        if "rent" in types:
            _add("rent", "Rent")
        if "buy" in types:
            _add("buy", "Buy")

        # Per spec rule 4: don't surface a provider row that has no valid destination for any action.
        if not actions:
            continue

        provider = WatchProvider(
            provider_id=data["provider_id"],
            provider_code=data["provider_code"],
            provider_name=data["provider_name"],
            logo_url=data["logo_url"],
            logo_path=data["logo_path"],
            availability_types=avail_types,
            subscription_cta_allowed=("flatrate" in types and not is_my_service),
            actions=actions,
        )

        if is_my_service and "flatrate" in types:
            my_services.append(provider)
        elif "free" in types or "ads" in types:
            free.append(provider)
        elif "rent" in types or "buy" in types:
            rent_buy.append(provider)
        elif "flatrate" in types:
            other_subs.append(provider)

    return WatchOptionsResponse(
        content_id=title_id,
        region=region,
        source="tmdb_watch_providers",
        source_attribution="JustWatch",
        fetched_at=fetched_at_str,
        groups={
            "my_services": my_services,
            "free": free,
            "rent_buy": rent_buy,
            "other_subscriptions": other_subs,
        },
    )
