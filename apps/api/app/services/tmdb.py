from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import quote
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.content import ContentAvailability, ContentTitle

TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500"
TMDB_BACKDROP_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w780"
SUPPORTED_PROVIDER_ALIASES = {
    "netflix": ("netflix", "Netflix"),
    "amazon prime video": ("prime_video", "Prime Video"),
    "prime video": ("prime_video", "Prime Video"),
    "apple tv plus": ("apple_tv_plus", "Apple TV+"),
    "appletv+": ("apple_tv_plus", "Apple TV+"),
    "apple tv+": ("apple_tv_plus", "Apple TV+"),
    "max": ("hbo_max", "HBO Max"),
    "hbo max": ("hbo_max", "HBO Max"),
    "disney plus": ("disney_plus", "Disney+"),
    "hulu": ("hulu", "Hulu"),
    "paramount plus": ("paramount_plus", "Paramount+"),
    "peacock premium": ("peacock", "Peacock"),
    "peacock": ("peacock", "Peacock"),
}
PROVIDER_LINK_TEMPLATES = {
    # Subscription streamers
    "netflix": {"app_url": None, "web_url": "https://www.netflix.com/search?q={query}"},
    "prime_video": {"app_url": None, "web_url": "https://www.amazon.com/s?k={query}&i=instant-video"},
    "amazon_prime_video": {"app_url": None, "web_url": "https://www.amazon.com/s?k={query}&i=instant-video"},
    "apple_tv_plus": {"app_url": None, "web_url": "https://tv.apple.com/search?term={query}"},
    "apple_tv": {"app_url": None, "web_url": "https://tv.apple.com/search?term={query}"},
    "hbo_max": {"app_url": None, "web_url": "https://play.max.com/search?q={query}"},
    "max": {"app_url": None, "web_url": "https://play.max.com/search?q={query}"},
    "disney_plus": {"app_url": None, "web_url": "https://www.disneyplus.com/search?q={query}"},
    "hulu": {"app_url": None, "web_url": "https://www.hulu.com/search?q={query}"},
    "paramount_plus": {"app_url": None, "web_url": "https://www.paramountplus.com/search/?query={query}"},
    "peacock": {"app_url": None, "web_url": "https://www.peacocktv.com/search?q={query}"},
    "peacock_premium": {"app_url": None, "web_url": "https://www.peacocktv.com/search?q={query}"},
    "starz": {"app_url": None, "web_url": "https://www.starz.com/us/en/search?q={query}"},
    "showtime": {"app_url": None, "web_url": "https://www.paramountplus.com/showtime/search/?query={query}"},
    "amc_plus": {"app_url": None, "web_url": "https://www.amcplus.com/search?q={query}"},
    "britbox": {"app_url": None, "web_url": "https://www.britbox.com/us/search/?q={query}"},
    "shudder": {"app_url": None, "web_url": "https://www.shudder.com/search?q={query}"},
    "criterion_channel": {"app_url": None, "web_url": "https://www.criterionchannel.com/search?q={query}"},
    "mubi": {"app_url": None, "web_url": "https://mubi.com/search?query={query}"},
    "crunchyroll": {"app_url": None, "web_url": "https://www.crunchyroll.com/search?q={query}"},
    # Rent / buy / transactional
    "amazon_video": {"app_url": None, "web_url": "https://www.amazon.com/s?k={query}&i=instant-video"},
    "youtube": {"app_url": None, "web_url": "https://www.youtube.com/results?search_query={query}+movie"},
    "youtube_movies": {"app_url": None, "web_url": "https://www.youtube.com/results?search_query={query}+movie"},
    "youtube_premium": {"app_url": None, "web_url": "https://www.youtube.com/results?search_query={query}"},
    "google_play_movies": {"app_url": None, "web_url": "https://play.google.com/store/search?q={query}&c=movies"},
    "microsoft_store": {"app_url": None, "web_url": "https://www.microsoft.com/en-us/search?q={query}"},
    "apple_tv_store": {"app_url": None, "web_url": "https://tv.apple.com/search?term={query}"},
    "fandango_at_home": {"app_url": None, "web_url": "https://athome.fandango.com/search?q={query}"},
    "vudu": {"app_url": None, "web_url": "https://athome.fandango.com/search?q={query}"},
    "spectrum_on_demand": {"app_url": None, "web_url": "https://ondemand.spectrum.net/search/{query}"},
    # Free / ad-supported
    "tubi": {"app_url": None, "web_url": "https://tubitv.com/search/{query}"},
    "pluto_tv": {"app_url": None, "web_url": "https://pluto.tv/en/search?query={query}"},
    "the_roku_channel": {"app_url": None, "web_url": "https://therokuchannel.roku.com/search?q={query}"},
    "freevee": {"app_url": None, "web_url": "https://www.amazon.com/s?k={query}&i=instant-video&rh=n:2858778011"},
    "kanopy": {"app_url": None, "web_url": "https://www.kanopy.com/en/search/{query}"},
    "hoopla": {"app_url": None, "web_url": "https://www.hoopladigital.com/search?q={query}&scope=everything"},
}


class TmdbConfigurationError(Exception):
    pass


def _tmdb_headers() -> dict[str, str]:
    if not settings.tmdb_api_key:
        raise TmdbConfigurationError("TMDB_API_KEY is not configured")
    return {
        "Authorization": f"Bearer {settings.tmdb_api_key}",
        "Accept": "application/json",
    }


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _poster_url(path: str | None) -> str | None:
    if not path:
        return None
    return f"{TMDB_IMAGE_BASE_URL}{path}"


def _backdrop_url(path: str | None) -> str | None:
    if not path:
        return None
    return f"{TMDB_BACKDROP_IMAGE_BASE_URL}{path}"


def _normalize_type(media_type: str | None) -> str | None:
    if media_type == "movie":
        return "movie"
    if media_type in {"tv", "series"}:
        return "series"
    return None


def build_provider_destination(service_id: str, title_name: str) -> tuple[str | None, str | None]:
    template = PROVIDER_LINK_TEMPLATES.get(service_id)
    if template is None:
        return None, None
    query = quote(title_name.strip())
    app_template = template.get("app_url")
    web_template = template.get("web_url")
    app_url = app_template.format(query=query) if isinstance(app_template, str) and app_template else None
    web_url = web_template.format(query=query) if isinstance(web_template, str) and web_template else None
    return app_url, web_url


def _upsert_title_from_tmdb_result(db: Session, item: dict[str, Any]) -> ContentTitle | None:
    media_type = _normalize_type(item.get("media_type") or item.get("content_type"))
    if media_type is None:
        return None

    tmdb_id = item["id"]
    title = db.scalar(select(ContentTitle).where(ContentTitle.tmdb_id == tmdb_id))
    if title is None:
        title = ContentTitle(
            tmdb_id=tmdb_id,
            content_type=media_type,
            title=item.get("title") or item.get("name") or "Untitled",
            original_title=item.get("original_title") or item.get("original_name"),
            overview=item.get("overview"),
            poster_url=_poster_url(item.get("poster_path")),
            backdrop_url=_backdrop_url(item.get("backdrop_path")),
            release_date=_parse_date(item.get("release_date") or item.get("first_air_date")),
            tmdb_vote_average=Decimal(str(round(item.get("vote_average") or 0, 1))),
            genres=[
                genre["name"] for genre in item.get("genres", []) if isinstance(genre, dict) and genre.get("name")
            ],
            runtime_minutes=item.get("runtime"),
            season_count=item.get("number_of_seasons"),
            metadata_raw=item,
        )
        db.add(title)
        db.flush()
        return title

    title.content_type = media_type
    title.title = item.get("title") or item.get("name") or title.title
    title.original_title = item.get("original_title") or item.get("original_name")
    title.overview = item.get("overview")
    title.poster_url = _poster_url(item.get("poster_path"))
    title.backdrop_url = _backdrop_url(item.get("backdrop_path"))
    title.release_date = _parse_date(item.get("release_date") or item.get("first_air_date"))
    title.tmdb_vote_average = Decimal(str(round(item.get("vote_average") or 0, 1)))
    title.genres = [
        genre["name"] for genre in item.get("genres", []) if isinstance(genre, dict) and genre.get("name")
    ]
    title.runtime_minutes = item.get("runtime")
    title.season_count = item.get("number_of_seasons")
    title.metadata_raw = item
    db.flush()
    return title


def search_titles(db: Session, query: str) -> list[ContentTitle]:
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        response = client.get("/search/multi", params={"query": query, "include_adult": "false", "language": "en-US"})
        response.raise_for_status()

    items: list[ContentTitle] = []
    for item in response.json().get("results", []):
        media_type = _normalize_type(item.get("media_type"))
        if media_type is None:
            continue
        hydrated = _upsert_title_from_tmdb_result(db, item)
        if hydrated is not None:
            items.append(hydrated)

    db.commit()
    return items


def _pick_language_neutral_backdrop(images_response: dict[str, Any]) -> str | None:
    """Choose a TMDB backdrop with no embedded typography.

    TMDB's `/images` endpoint returns each backdrop with an `iso_639_1` field.
    A null value = language-neutral = the image contains no text overlay.
    English-tagged (or any language-tagged) backdrops usually feature the
    movie's title / campaign line painted onto the image, which competes with
    our own headline (root cause of the "Aftersun with embedded typography"
    audit defect).

    Preference order:
      1. Highest-voted language-neutral backdrop
      2. Highest-voted English backdrop (fallback — better than nothing)
      3. None — caller falls back to the default backdrop_path
    """
    backdrops = images_response.get("backdrops") or []
    if not isinstance(backdrops, list):
        return None
    language_neutral = [
        b for b in backdrops
        if isinstance(b, dict) and b.get("iso_639_1") is None and b.get("file_path")
    ]
    if language_neutral:
        # Sort by vote_average / vote_count so we pick the objectively best one.
        best = max(language_neutral, key=lambda b: (
            float(b.get("vote_average", 0)),
            int(b.get("vote_count", 0)),
        ))
        return best.get("file_path")
    english = [
        b for b in backdrops
        if isinstance(b, dict) and b.get("iso_639_1") == "en" and b.get("file_path")
    ]
    if english:
        best = max(english, key=lambda b: float(b.get("vote_average", 0)))
        return best.get("file_path")
    return None


def refresh_title_details(db: Session, title: ContentTitle) -> ContentTitle:
    endpoint = f"/movie/{title.tmdb_id}" if title.content_type == "movie" else f"/tv/{title.tmdb_id}"
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        response = client.get(
            endpoint,
            params={"language": "en-US", "append_to_response": "credits,images", "include_image_language": "en,null"},
        )
        response.raise_for_status()
    item = response.json()

    # Prefer a language-neutral backdrop over the default one. This avoids picking
    # backdrops with embedded title typography that would compete with our headers.
    images = item.get("images") if isinstance(item.get("images"), dict) else None
    if images:
        safe_backdrop = _pick_language_neutral_backdrop(images)
        if safe_backdrop:
            item["backdrop_path"] = safe_backdrop

    # TMDB detail endpoints omit media_type; inject from our stored content_type so upsert doesn't bail
    item.setdefault("media_type", "movie" if title.content_type == "movie" else "tv")
    refreshed = _upsert_title_from_tmdb_result(db, item)
    db.commit()
    return refreshed or title


def refresh_streaming_options(db: Session, title: ContentTitle, region: str = "US") -> list[ContentAvailability]:
    endpoint = (
        f"/movie/{title.tmdb_id}/watch/providers"
        if title.content_type == "movie"
        else f"/tv/{title.tmdb_id}/watch/providers"
    )
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        response = client.get(endpoint)
        response.raise_for_status()

    region_results = response.json().get("results", {}).get(region, {})

    # Delete existing rows for this title+region
    existing = db.scalars(
        select(ContentAvailability).where(
            ContentAvailability.content_title_id == title.id,
            ContentAvailability.region_code == region,
        )
    ).all()
    for row in existing:
        db.delete(row)
    db.flush()

    expires = datetime.now(timezone.utc) + timedelta(hours=24)
    created: list[ContentAvailability] = []
    seen: set[tuple[int, str]] = set()  # (tmdb_provider_id, monetization_type)

    for mono_type in ("flatrate", "free", "ads", "rent", "buy"):
        for provider in region_results.get(mono_type, []):
            tmdb_pid = provider.get("provider_id")
            if not isinstance(tmdb_pid, int):
                continue
            key = (tmdb_pid, mono_type)
            if key in seen:
                continue
            seen.add(key)

            provider_name = provider.get("provider_name") or "Unknown"
            logo_path = provider.get("logo_path")

            # Try to map to our canonical code; fall back to slugified name
            normalized = SUPPORTED_PROVIDER_ALIASES.get(str(provider_name).strip().lower())
            if normalized:
                provider_code, canonical_name = normalized
            else:
                provider_code = provider_name.lower().replace(" ", "_").replace("+", "_plus")[:64]
                canonical_name = provider_name

            app_url, web_url = build_provider_destination(provider_code, title.title)
            # Per spec: never fall back to a TMDB URL for consumer CTAs. If we don't have a
            # provider-specific search/direct link, leave web_url null so the watch-options
            # route can suppress the action rather than pointing users to TMDB.

            row = ContentAvailability(
                content_title_id=title.id,
                provider_code=provider_code,
                provider_name=canonical_name,
                region_code=region,
                monetization_type=mono_type,
                tmdb_provider_id=tmdb_pid,
                logo_path=logo_path,
                deeplink_url=app_url,
                web_url=web_url,
                is_connected_priority=False,
                expires_at=expires,
            )
            db.add(row)
            created.append(row)

    db.commit()
    return created


def fetch_title_videos(title: ContentTitle) -> list[dict[str, str]]:
    endpoint = f"/movie/{title.tmdb_id}/videos" if title.content_type == "movie" else f"/tv/{title.tmdb_id}/videos"
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=10) as client:
        response = client.get(endpoint, params={"language": "en-US"})
        response.raise_for_status()
    results = response.json().get("results", [])
    videos: list[dict[str, str]] = []
    for item in results:
        if item.get("site") != "YouTube":
            continue
        video_type = item.get("type", "")
        if video_type not in {"Trailer", "Teaser", "Featurette", "Clip"}:
            continue
        videos.append({
            "key": item.get("key", ""),
            "site": "YouTube",
            "type": video_type,
            "name": item.get("name", ""),
            "official": str(item.get("official", False)),
        })
    # Sort: official trailers first, then teasers, then others
    type_rank = {"Trailer": 0, "Teaser": 1, "Featurette": 2, "Clip": 3}
    videos.sort(key=lambda v: (0 if v["official"] == "True" else 1, type_rank.get(v["type"], 9)))
    return videos


def fetch_title_gallery(title: ContentTitle, limit: int = 12) -> list[dict[str, Any]]:
    endpoint = f"/movie/{title.tmdb_id}/images" if title.content_type == "movie" else f"/tv/{title.tmdb_id}/images"
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        response = client.get(endpoint)
        response.raise_for_status()

    data = response.json()
    gallery: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for item in data.get("backdrops", []):
        url = _backdrop_url(item.get("file_path"))
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        gallery.append(
            {
                "url": url,
                "kind": "backdrop",
                "width": item.get("width"),
                "height": item.get("height"),
            }
        )
        if len(gallery) >= limit:
            return gallery

    for item in data.get("posters", []):
        url = _poster_url(item.get("file_path"))
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        gallery.append(
            {
                "url": url,
                "kind": "poster",
                "width": item.get("width"),
                "height": item.get("height"),
            }
        )
        if len(gallery) >= limit:
            return gallery

    return gallery


def fetch_related_titles(db: Session, title: ContentTitle, limit: int = 10) -> list[ContentTitle]:
    endpoint_root = "movie" if title.content_type == "movie" else "tv"
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        rec_response = client.get(
            f"/{endpoint_root}/{title.tmdb_id}/recommendations",
            params={"language": "en-US", "page": 1},
        )
        rec_response.raise_for_status()
        sim_response = client.get(
            f"/{endpoint_root}/{title.tmdb_id}/similar",
            params={"language": "en-US", "page": 1},
        )
        sim_response.raise_for_status()

    hydrated: list[ContentTitle] = []
    seen_tmdb_ids: set[int] = set()
    for item in [*rec_response.json().get("results", []), *sim_response.json().get("results", [])]:
        tmdb_id = item.get("id")
        if not isinstance(tmdb_id, int) or tmdb_id in seen_tmdb_ids:
            continue
        seen_tmdb_ids.add(tmdb_id)
        item["media_type"] = "movie" if endpoint_root == "movie" else "tv"
        row = _upsert_title_from_tmdb_result(db, item)
        if row is not None:
            hydrated.append(row)
        if len(hydrated) >= limit:
            break

    db.commit()
    return hydrated


def fetch_trending_titles(db: Session, limit: int = 20) -> list[ContentTitle]:
    hydrated: list[ContentTitle] = []
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        for page in range(1, 4):  # up to 3 pages = up to 60 trending items
            if len(hydrated) >= limit:
                break
            response = client.get("/trending/all/week", params={"language": "en-US", "page": page})
            response.raise_for_status()
            results = response.json().get("results", [])
            if not results:
                break
            for item in results:
                row = _upsert_title_from_tmdb_result(db, item)
                if row is not None:
                    hydrated.append(row)
                if len(hydrated) >= limit:
                    break
    db.commit()
    return hydrated


def list_tmdb_genres() -> list[str]:
    movie_map = _fetch_genre_map("movie")
    tv_map = _fetch_genre_map("tv")
    merged = sorted({*movie_map.values(), *tv_map.values()})
    return merged


def discover_titles_by_genre(
    db: Session,
    genre: str,
    media_type: str = "all",
    limit: int = 40,
) -> list[ContentTitle]:
    genre = genre.strip().lower()
    if not genre:
        return []

    requested = {"all", "movie", "show"}
    if media_type not in requested:
        media_type = "all"

    movie_map = _fetch_genre_map("movie")
    tv_map = _fetch_genre_map("tv")
    movie_id = _match_genre_id(movie_map, genre)
    tv_id = _match_genre_id(tv_map, genre)

    if media_type == "movie" and movie_id is None:
        return []
    if media_type == "show" and tv_id is None:
        return []
    if media_type == "all" and movie_id is None and tv_id is None:
        return []

    fetched: list[ContentTitle] = []
    seen_tmdb_ids: set[int] = set()
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        if media_type in {"all", "movie"} and movie_id is not None:
            response = client.get(
                "/discover/movie",
                params={
                    "language": "en-US",
                    "sort_by": "popularity.desc",
                    "include_adult": "false",
                    "include_video": "false",
                    "with_genres": str(movie_id),
                    "page": 1,
                },
            )
            response.raise_for_status()
            for item in response.json().get("results", []):
                tmdb_id = item.get("id")
                if not isinstance(tmdb_id, int) or tmdb_id in seen_tmdb_ids:
                    continue
                seen_tmdb_ids.add(tmdb_id)
                item["media_type"] = "movie"
                item["genres"] = [
                    {"name": movie_map[g]} for g in item.get("genre_ids", []) if isinstance(g, int) and g in movie_map
                ]
                hydrated = _upsert_title_from_tmdb_result(db, item)
                if hydrated is not None:
                    fetched.append(hydrated)
                if len(fetched) >= limit:
                    db.commit()
                    return fetched[:limit]

        if media_type in {"all", "show"} and tv_id is not None:
            response = client.get(
                "/discover/tv",
                params={
                    "language": "en-US",
                    "sort_by": "popularity.desc",
                    "include_adult": "false",
                    "with_genres": str(tv_id),
                    "page": 1,
                },
            )
            response.raise_for_status()
            for item in response.json().get("results", []):
                tmdb_id = item.get("id")
                if not isinstance(tmdb_id, int) or tmdb_id in seen_tmdb_ids:
                    continue
                seen_tmdb_ids.add(tmdb_id)
                item["media_type"] = "tv"
                item["genres"] = [
                    {"name": tv_map[g]} for g in item.get("genre_ids", []) if isinstance(g, int) and g in tv_map
                ]
                hydrated = _upsert_title_from_tmdb_result(db, item)
                if hydrated is not None:
                    fetched.append(hydrated)
                if len(fetched) >= limit:
                    db.commit()
                    return fetched[:limit]

    db.commit()
    return fetched[:limit]


def _fetch_genre_map(kind: str) -> dict[int, str]:
    with httpx.Client(base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15) as client:
        response = client.get(f"/genre/{kind}/list", params={"language": "en-US"})
        response.raise_for_status()
    return {
        int(item["id"]): str(item["name"])
        for item in response.json().get("genres", [])
        if isinstance(item, dict) and isinstance(item.get("id"), int) and isinstance(item.get("name"), str)
    }


def _match_genre_id(mapping: dict[int, str], target: str) -> int | None:
    normalized = target.lower()
    for genre_id, name in mapping.items():
        if name.lower() == normalized:
            return genre_id
    return None


def fetch_person_details(person_id: int) -> dict[str, Any]:
    """Fetch person biography + combined credits from TMDB."""
    headers = _tmdb_headers()
    base_url = settings.tmdb_base_url or "https://api.themoviedb.org/3"

    person_resp = httpx.get(f"{base_url}/person/{person_id}", headers=headers, timeout=10)
    person_resp.raise_for_status()
    person_data = person_resp.json()

    credits_resp = httpx.get(f"{base_url}/person/{person_id}/combined_credits", headers=headers, timeout=10)
    credits_resp.raise_for_status()
    credits_data = credits_resp.json()

    profile_path = person_data.get("profile_path")
    profile_url = f"https://image.tmdb.org/t/p/w342{profile_path}" if profile_path else None

    all_credits: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for credit in (credits_data.get("cast") or []) + (credits_data.get("crew") or []):
        cid = credit.get("id")
        if not isinstance(cid, int) or cid in seen_ids:
            continue
        seen_ids.add(cid)
        poster = credit.get("poster_path")
        all_credits.append({
            "tmdb_id": cid,
            "title": credit.get("title") or credit.get("name") or "",
            "media_type": credit.get("media_type", "movie"),
            "poster_url": f"https://image.tmdb.org/t/p/w342{poster}" if poster else None,
            "release_date": credit.get("release_date") or credit.get("first_air_date"),
            "character": credit.get("character"),
            "job": credit.get("job"),
        })

    # Sort by popularity/vote_count descending
    all_credits.sort(key=lambda c: credits_data.get("id", 0), reverse=True)

    return {
        "tmdb_person_id": person_id,
        "name": person_data.get("name", ""),
        "profile_url": profile_url,
        "biography": person_data.get("biography") or None,
        "known_for_department": person_data.get("known_for_department"),
        "birthday": str(person_data["birthday"]) if person_data.get("birthday") else None,
        "place_of_birth": person_data.get("place_of_birth"),
        "credits": all_credits[:24],
    }
