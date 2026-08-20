"""Collection management: seed, refresh, and resolve title members."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.content import Collection, ContentTitle
from app.services.tmdb import _tmdb_headers, _upsert_title_from_tmdb_result

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Seed data — 18 collections per spec
# ---------------------------------------------------------------------------

COLLECTION_SEED: list[dict[str, Any]] = [
    {
        "slug": "hidden-gems",
        "title": "Hidden Gems",
        "subtitle": "High-rated, below the obvious popularity tier",
        "thesis": "Great films that escaped the algorithm. High ratings, serious craft, and the distinct pleasure of telling someone about a movie they haven't seen.",
        "collection_type": "dynamic_discover",
        "media_scope": "mixed",
        "editorial_rank": 10,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "vote_count_gte": 800,
            "vote_count_lte": 6000,
            "vote_average_gte": 7.4,
            "limit": 20,
        },
    },
    {
        "slug": "90-minutes-or-less",
        "title": "90 Minutes or Less",
        "subtitle": "Strongly rated films that respect your time",
        "thesis": "A genuine decision shortcut. Great movies that fit inside an evening without asking for a commitment.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 11,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "runtime_lte": 90,
            "vote_count_gte": 500,
            "vote_average_gte": 7.0,
            "limit": 20,
        },
    },
    {
        "slug": "new-classics",
        "title": "New Classics",
        "subtitle": "Recent-era titles that will be taught in film school",
        "thesis": "Films from the last fifteen years earning their permanent place in the canon. High ratings, real audience conviction, no nostalgia required.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 12,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "primary_release_date_gte": "2010-01-01",
            "vote_count_gte": 2000,
            "vote_average_gte": 7.8,
            "limit": 20,
        },
    },
    {
        "slug": "international-essentials",
        "title": "International Essentials",
        "subtitle": "Non-English cinema that earns its subtitles",
        "thesis": "The best films in the world happen not to be in English. This rotates across languages so no one market dominates.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 13,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "with_original_language": "fr|ja|ko|es|it|de|pt|zh|da|sv|no",
            "vote_count_gte": 500,
            "vote_average_gte": 7.2,
            "limit": 20,
        },
    },
    {
        "slug": "underseen-sci-fi",
        "title": "Underseen Sci-Fi",
        "subtitle": "Science fiction with strong ratings and moderate visibility",
        "thesis": "Cerebral science fiction that didn't get the blockbuster marketing budget but got everything else right.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 20,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "with_genres": "878",  # TMDB Science Fiction genre ID
            "vote_count_gte": 300,
            "vote_count_lte": 5000,
            "vote_average_gte": 7.0,
            "limit": 20,
        },
    },
    {
        "slug": "horror-renaissance",
        "title": "Horror Renaissance",
        "subtitle": "Strong recent horror with real craft behind the dread",
        "thesis": "Horror got interesting again. This tracks the films with enough ratings conviction to mean they actually scared the right people.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 21,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "with_genres": "27",  # TMDB Horror
            "primary_release_date_gte": "2015-01-01",
            "vote_count_gte": 500,
            "vote_average_gte": 6.8,
            "limit": 20,
        },
    },
    {
        "slug": "psychological-thrillers",
        "title": "Psychological Thrillers",
        "subtitle": "Films that live inside the mind of the unreliable",
        "thesis": "Thrillers where the real danger is perception. Character psychology as plot engine.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 22,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "with_genres": "53|9648",  # Thriller | Mystery
            "vote_count_gte": 500,
            "vote_average_gte": 7.0,
            "limit": 20,
        },
    },
    {
        "slug": "1970s-paranoia",
        "title": "1970s Paranoia",
        "subtitle": "An era convinced something was very wrong — and it was right",
        "thesis": "The decade that made conspiracy feel cinematic. Thrillers and crime films from 1970–1979 with the staying power of genuine unease.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 30,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "primary_release_date_gte": "1970-01-01",
            "primary_release_date_lte": "1979-12-31",
            "with_genres": "80|53|9648",
            "vote_count_gte": 200,
            "vote_average_gte": 7.0,
            "limit": 20,
        },
    },
    {
        "slug": "before-1980-still-electric",
        "title": "Before 1980, Still Electric",
        "subtitle": "Highly rated older films built to fight recency bias",
        "thesis": "The pre-1980 films with enough votes to prove they haven't faded. Old cinema that still demands your full attention.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 31,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "primary_release_date_lte": "1979-12-31",
            "vote_count_gte": 1000,
            "vote_average_gte": 7.8,
            "limit": 20,
        },
    },
    {
        "slug": "one-perfect-night",
        "title": "One Perfect Night",
        "subtitle": "High-confidence movies under two hours — optimized for tonight",
        "thesis": "You want one excellent thing and you want it to fit. These are the films that deliver both.",
        "collection_type": "dynamic_discover",
        "media_scope": "movie",
        "editorial_rank": 14,
        "rule_config": {
            "media_type": "movie",
            "sort_by": "vote_average.desc",
            "runtime_lte": 115,
            "vote_count_gte": 1000,
            "vote_average_gte": 7.5,
            "limit": 20,
        },
    },
    # Manual / editorial collections
    {
        "slug": "slow-burns",
        "title": "Slow Burns",
        "subtitle": "Films that earn their patience",
        "thesis": "Intentionally paced cinema where the reward is proportional to your investment. Slow cinema is a taste concept that genre alone doesn't capture.",
        "collection_type": "manual",
        "media_scope": "mixed",
        "editorial_rank": 40,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # Hereditary, The Master, Portrait of a Lady on Fire, Jeanne Dielman, The Witch,
            # There Will Be Blood, Under the Skin, A Ghost Story, The Lighthouse, First Reformed
            139405, 64690, 504253, 47190, 266856, 1396, 227552, 439050, 458156, 427641
        ],
    },
    {
        "slug": "beautifully-weird",
        "title": "Beautifully Weird",
        "subtitle": "Surreal, singular, strange-but-great",
        "thesis": "Films that couldn't have been made any other way — formally strange, thematically bold, and impossible to shake.",
        "collection_type": "manual",
        "media_scope": "mixed",
        "editorial_rank": 41,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # Being John Malkovich, Eternal Sunshine, The Lobster, Sorry to Bother You,
            # Everything Everywhere All at Once, Swiss Army Man, Annihilation, Under the Silver Lake,
            # Suspiria (2018), Holy Motors
            2202, 38365, 254320, 480412, 545611, 370687, 312174, 506574, 453405, 69651
        ],
    },
    {
        "slug": "cult-classics",
        "title": "Cult Classics",
        "subtitle": "A maintained real-title set, not a popularity proxy",
        "thesis": "Films that found their audience late, on their own terms — and kept it. The definition of cult is a promise made between a film and the people who wouldn't stop talking about it.",
        "collection_type": "manual",
        "media_scope": "mixed",
        "editorial_rank": 42,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # The Big Lebowski, Donnie Darko, Mulholland Drive, Blue Velvet, Eraserhead,
            # The Room (not this...), Repo Man, Withnail and I, Harold and Maude, Pink Flamingos...
            # Using real quality cult films: Big Lebowski, Donnie Darko, Mulholland Drive, Blue Velvet,
            # Brazil, Videodrome, They Live, Heathers, Trainspotting, The Warriors
            115, 141, 1020, 14476, 68, 8583, 11584, 8869, 18148, 10567
        ],
    },
    {
        "slug": "comfort-watches",
        "title": "Comfort Watches",
        "subtitle": "Rewatchable, warm, low-friction — genuinely",
        "thesis": "Human-curated rewatchable titles. Not 'popular' or 'feel-good' as marketing copy — actually the kind of thing you put on when you need the world to be okay for two hours.",
        "collection_type": "manual",
        "media_scope": "mixed",
        "editorial_rank": 43,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # When Harry Met Sally, Clueless, Pride & Prejudice (2005), Notting Hill,
            # The Princess Bride, You've Got Mail, 10 Things I Hate About You, Amélie,
            # Roman Holiday, Paddington 2
            639, 9603, 4348, 1605, 2012, 8281, 9584, 194, 622, 346648
        ],
    },
    {
        "slug": "unreliable-narrators",
        "title": "Unreliable Narrators",
        "subtitle": "Films where the story's reliability is the story",
        "thesis": "Cinema built on the fundamental question of whether we can trust who's telling us what. The unreliable narrator as formal device, not twist gimmick.",
        "collection_type": "manual",
        "media_scope": "movie",
        "editorial_rank": 44,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # Gone Girl, Fight Club, Rashomon, Memento, Shutter Island, The Usual Suspects,
            # Atonement, A Beautiful Mind, American Psycho, Parasite
            70785, 550, 548, 77338, 22970, 629, 17971, 76, 1359, 496243
        ],
    },
    # Creator collections
    {
        "slug": "wes-anderson",
        "title": "The Wes Anderson Collection",
        "subtitle": "Symmetry, melancholy, and the architecture of nostalgia",
        "thesis": "Every frame a painting. Wes Anderson's filmography is one of the most distinctive bodies of work in American cinema — a visual and tonal world that is entirely his own.",
        "collection_type": "creator",
        "media_scope": "movie",
        "editorial_rank": 50,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # Bottle Rocket, Rushmore, The Royal Tenenbaums, The Life Aquatic, Darjeeling Limited,
            # Fantastic Mr. Fox, Moonrise Kingdom, The Grand Budapest Hotel, Isle of Dogs, The French Dispatch, Asteroid City
            17018, 11545, 9428, 10065, 11096, 39347, 83666, 120467, 399174, 640146, 786892
        ],
    },
    {
        "slug": "sofia-coppola",
        "title": "Sofia Coppola: Worlds Within Worlds",
        "subtitle": "Interiority, atmosphere, and the weight of privilege",
        "thesis": "Sofia Coppola's films are about what it feels like to be trapped inside a beautiful life. Her camera is patient, her silences say more than dialogue, and her sense of place is unmatched.",
        "collection_type": "creator",
        "media_scope": "movie",
        "editorial_rank": 51,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # The Virgin Suicides, Lost in Translation, Marie Antoinette, Somewhere, The Bling Ring,
            # The Beguiled, On the Rocks, Priscilla
            14685, 153, 1451, 38317, 155111, 399566, 674432, 882019
        ],
    },
    {
        "slug": "bong-joon-ho",
        "title": "Bong Joon Ho: Genre, Bent",
        "subtitle": "The director who refuses to let genre be comfortable",
        "thesis": "Bong Joon Ho uses genre — thriller, monster movie, sci-fi, heist — as a Trojan horse for class critique, social satire, and unexpected grief. No frame is accidental.",
        "collection_type": "creator",
        "media_scope": "movie",
        "editorial_rank": 52,
        "refresh_policy": "manual",
        "manual_tmdb_ids": [
            # Barking Dogs Never Bite, Memories of Murder, The Host, Mother, Snowpiercer,
            # Okja, Parasite, Mickey 17
            84867, 16869, 6957, 27001, 109424, 425597, 496243, 574475
        ],
    },
]


# ---------------------------------------------------------------------------
# Seed function
# ---------------------------------------------------------------------------

def seed_collections(db: Session) -> int:
    """Upsert the canonical collection definitions. Returns count inserted/updated."""
    count = 0
    for defn in COLLECTION_SEED:
        slug = defn["slug"]
        coll = db.scalar(select(Collection).where(Collection.slug == slug))
        if coll is None:
            coll = Collection(
                slug=slug,
                title=defn["title"],
                subtitle=defn.get("subtitle"),
                thesis=defn.get("thesis"),
                collection_type=defn["collection_type"],
                media_scope=defn.get("media_scope", "mixed"),
                rule_config=defn.get("rule_config", {}),
                manual_tmdb_ids=defn.get("manual_tmdb_ids", []),
                editorial_rank=defn.get("editorial_rank", 100),
                refresh_policy=defn.get("refresh_policy", "daily"),
                status="active",
            )
            db.add(coll)
            count += 1
        else:
            coll.title = defn["title"]
            coll.subtitle = defn.get("subtitle")
            coll.thesis = defn.get("thesis")
            coll.collection_type = defn["collection_type"]
            coll.media_scope = defn.get("media_scope", "mixed")
            coll.rule_config = defn.get("rule_config", {})
            coll.manual_tmdb_ids = defn.get("manual_tmdb_ids", [])
            coll.editorial_rank = defn.get("editorial_rank", 100)
            coll.refresh_policy = defn.get("refresh_policy", "daily")
    db.commit()
    return count


# ---------------------------------------------------------------------------
# Collection title resolver
# ---------------------------------------------------------------------------

def _fetch_tmdb_discover(rule_config: dict) -> list[dict]:
    """Execute a TMDB Discover call from rule_config. Returns raw TMDB results."""
    media_type = rule_config.get("media_type", "movie")
    endpoint = f"/discover/{media_type}" if media_type in {"movie", "tv"} else "/discover/movie"

    params: dict[str, Any] = {
        "language": "en-US",
        "include_adult": "false",
        "page": 1,
    }
    for key, value in rule_config.items():
        if key in {"media_type", "limit"}:
            continue
        # Map rule_config keys to TMDB param names
        tmdb_key = {
            "sort_by": "sort_by",
            "vote_count_gte": "vote_count.gte",
            "vote_count_lte": "vote_count.lte",
            "vote_average_gte": "vote_average.gte",
            "runtime_lte": "with_runtime.lte",
            "with_genres": "with_genres",
            "with_original_language": "with_original_language",
            "primary_release_date_gte": "primary_release_date.gte",
            "primary_release_date_lte": "primary_release_date.lte",
        }.get(key, key)
        params[tmdb_key] = value

    try:
        with httpx.Client(
            base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15
        ) as client:
            resp = client.get(endpoint, params=params)
            resp.raise_for_status()
            results = resp.json().get("results", [])
            for item in results:
                item.setdefault("media_type", media_type if media_type != "tv" else "tv")
            return results
    except Exception as exc:
        log.warning("TMDB discover failed for config %s: %s", json.dumps(rule_config), exc)
        return []


def _fetch_tmdb_by_ids(tmdb_ids: list[int]) -> list[dict]:
    """Fetch TMDB details for a list of IDs (tries movie, falls back to tv)."""
    results = []
    try:
        with httpx.Client(
            base_url=settings.tmdb_base_url, headers=_tmdb_headers(), timeout=15
        ) as client:
            for tmdb_id in tmdb_ids:
                try:
                    resp = client.get(f"/movie/{tmdb_id}", params={"language": "en-US"})
                    if resp.status_code == 200:
                        item = resp.json()
                        item["media_type"] = "movie"
                        results.append(item)
                        continue
                except Exception:
                    pass
                try:
                    resp = client.get(f"/tv/{tmdb_id}", params={"language": "en-US"})
                    if resp.status_code == 200:
                        item = resp.json()
                        item["media_type"] = "tv"
                        results.append(item)
                except Exception:
                    pass
    except Exception as exc:
        log.warning("TMDB bulk ID fetch failed: %s", exc)
    return results


def resolve_collection_titles(db: Session, collection: Collection, limit: int = 20) -> list[ContentTitle]:
    """Return ContentTitle rows for a collection, refreshing cache if stale."""
    from datetime import timedelta

    stale_after = {
        "hourly": timedelta(hours=1),
        "daily": timedelta(hours=24),
        "weekly": timedelta(days=7),
        "manual": timedelta(days=365),
    }
    ttl = stale_after.get(collection.refresh_policy, timedelta(hours=24))
    now = datetime.now(timezone.utc)
    is_stale = (
        not collection.cached_at
        or (now - collection.cached_at.replace(tzinfo=timezone.utc)) > ttl
    )

    if not is_stale and collection.cached_title_ids:
        rows = _load_titles_by_uuid_ids(db, collection.cached_title_ids[:limit])
        if rows:
            return rows

    # Refresh
    if collection.collection_type == "manual" or collection.collection_type == "creator":
        raw = _fetch_tmdb_by_ids(collection.manual_tmdb_ids)
    else:
        rule = dict(collection.rule_config or {})
        rule.setdefault("limit", limit)
        raw = _fetch_tmdb_discover(rule)

    titles: list[ContentTitle] = []
    seen: set[int] = set()
    for item in raw:
        tid = item.get("id")
        if not isinstance(tid, int) or tid in seen:
            continue
        seen.add(tid)
        t = _upsert_title_from_tmdb_result(db, item)
        if t is not None:
            titles.append(t)
        if len(titles) >= limit:
            break

    db.commit()

    # Update cache
    collection.cached_title_ids = [str(t.id) for t in titles]
    collection.cached_at = now
    collection.updated_at = now
    db.commit()

    return titles[:limit]


def _load_titles_by_uuid_ids(db: Session, ids: list[str]) -> list[ContentTitle]:
    import uuid as uuid_mod
    parsed = []
    for raw_id in ids:
        try:
            parsed.append(uuid_mod.UUID(raw_id))
        except ValueError:
            pass
    if not parsed:
        return []
    rows = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(parsed))).all()
    id_order = {uid: i for i, uid in enumerate(parsed)}
    return sorted(rows, key=lambda r: id_order.get(r.id, 999))


def get_active_collections(db: Session) -> list[Collection]:
    return list(
        db.scalars(
            select(Collection)
            .where(Collection.status == "active")
            .order_by(Collection.editorial_rank)
        ).all()
    )


def get_collection_by_slug(db: Session, slug: str) -> Collection | None:
    return db.scalar(select(Collection).where(Collection.slug == slug))
