from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models.content import ContentAvailability, ContentTitle
from app.models.social import FeedComment, FeedReaction, Rating, Review, TeamRanking, TeamTitle, UserFollow, Watchlist, WatchlistItem
from app.models.taste import RecommendationSignal, SwipeRecord, UserTasteProfile, WrappedStat
from app.models.user import User, UserPreferences, UserProfile
from app.schemas.content import RecommendationEvidence, RecommendationResponse
from app.schemas.taste import (
    GenreShiftResponse,
    HotTakeResponse,
    SceneDnaColdStartResponse,
    SceneDnaEvidenceTitle,
    SceneDnaFeedbackResponse,
    SceneDnaIdentityResponse,
    SceneDnaMovementResponse,
    SceneDnaResponse,
    SceneDnaSignalResponse,
    TasteAlignmentEntryResponse,
    TasteAlignmentResponse,
    TasteEvolutionResponse,
    TasteProfileResponse,
    TasteTitleReferenceResponse,
)
from app.services.teams import list_user_teams
from app.services.tmdb import TmdbConfigurationError, fetch_related_titles, fetch_trending_titles

THEME_KEYWORDS: dict[str, tuple[str, ...]] = {
    "Slow Burn": ("drama", "mystery", "thriller"),
    "Emotionally Intense": ("drama", "romance"),
    "Character Driven": ("drama", "indie"),
    "Visually Bold": ("sci-fi", "fantasy", "animation", "horror"),
    "High Stakes": ("action", "crime", "thriller"),
    "Comfort Rewatch": ("comedy", "family"),
}

LABEL_RULES: dict[str, dict[str, object]] = {
    "Prestige Drama": {"genres": {"Drama": 1.0, "TV Movie": 0.2}, "themes": {"Slow Burn", "Character Driven"}},
    "Awards Season Core": {"genres": {"Drama": 0.9, "History": 0.6}},
    "Character Study Fan": {"genres": {"Drama": 0.8, "Romance": 0.4}, "themes": {"Character Driven"}},
    "Emotional Realist": {"genres": {"Drama": 0.8}, "themes": {"Emotionally Intense"}},
    "Dark Crime": {"genres": {"Crime": 1.0, "Mystery": 0.7, "Thriller": 0.6}},
    "Psychological Thriller": {"genres": {"Thriller": 1.0, "Mystery": 0.6, "Crime": 0.5}},
    "Serial Killer TV": {"genres": {"Crime": 0.9, "Thriller": 0.7}},
    "Neo-Noir": {"genres": {"Crime": 0.9, "Thriller": 0.5}},
    "Comfort Comedy": {"genres": {"Comedy": 1.0, "Family": 0.3}, "themes": {"Comfort Rewatch"}},
    "Dry Humor": {"genres": {"Comedy": 0.9}},
    "Chaos Comedy": {"genres": {"Comedy": 1.0, "Action": 0.2}},
    "Sitcom Loyalist": {"genres": {"Comedy": 1.0}},
    "Cerebral Sci-Fi": {"genres": {"Science Fiction": 1.0, "Mystery": 0.3}, "themes": {"Slow Burn", "Visually Bold"}},
    "Space Opera": {"genres": {"Science Fiction": 1.0, "Adventure": 0.6, "Fantasy": 0.4}},
    "Dystopian Future": {"genres": {"Science Fiction": 0.9, "Thriller": 0.4}},
    "Time Loop Enthusiast": {"genres": {"Science Fiction": 0.9, "Fantasy": 0.4}},
    "A24-Core": {"genres": {"Drama": 0.7, "Horror": 0.5}, "themes": {"Visually Bold", "Character Driven"}},
    "Indie Darling": {"genres": {"Drama": 0.6, "Comedy": 0.3}, "themes": {"Character Driven"}},
    "Festival Circuit": {"genres": {"Drama": 0.7, "Documentary": 0.6}},
    "Cinematic Maximalist": {"genres": {"Action": 0.5, "Fantasy": 0.5, "Science Fiction": 0.5}, "themes": {"Visually Bold"}},
    "Elevated Horror": {"genres": {"Horror": 1.0, "Thriller": 0.5}, "themes": {"Slow Burn", "Visually Bold"}},
    "Atmospheric Horror": {"genres": {"Horror": 1.0, "Mystery": 0.5}, "themes": {"Slow Burn"}},
    "Camp Horror": {"genres": {"Horror": 0.9, "Comedy": 0.3}},
    "Survival Horror": {"genres": {"Horror": 0.9, "Action": 0.4, "Thriller": 0.5}},
}

SWIPE_DIRECTION_WEIGHTS: dict[str, float] = {
    "left": -3.5,
    "right": 5.0,
    "up": 8.0,
}


def refresh_taste_profile(db: Session, user_id: UUID) -> UserTasteProfile:
    profile = db.scalar(select(UserTasteProfile).where(UserTasteProfile.user_id == user_id))
    if profile is None:
        profile = UserTasteProfile(user_id=user_id)
        db.add(profile)
        db.flush()

    genre_scores, title_refs, release_years = _collect_title_signals(db, user_id)
    themes = _derive_themes(genre_scores)
    platforms = _derive_platforms(db, user_id)
    eras = _derive_eras(release_years)
    labels = _derive_labels(genre_scores, themes)
    # Prefer recency-weighted "current" obsessions per §27. Fall back to the
    # cumulative-weight list only when the user has no recent activity (brand
    # new accounts) so the card isn't empty.
    current_obsessions = _derive_current_obsessions_recent(db, user_id)
    if not current_obsessions:
        current_obsessions = _derive_current_obsessions(title_refs)
    posters = [item["poster_url"] for item in current_obsessions if item.get("poster_url")][:4]
    most_saved_genre = max(genre_scores.items(), key=lambda item: item[1])[0] if genre_scores else None
    signal_counts = _signal_counts(db, user_id)

    profile.top_genres = _serialize_genres(genre_scores)
    profile.top_themes = themes
    profile.top_platforms = platforms
    profile.favorite_eras = eras
    profile.taste_labels = labels
    profile.profile_summary = _build_summary(profile.top_genres, profile.top_themes, profile.taste_labels)
    profile.current_obsessions = current_obsessions
    profile.top_posters = posters
    profile.most_saved_genre = most_saved_genre
    profile.signal_counts = signal_counts
    profile.updated_at = datetime.now(timezone.utc)

    _refresh_wrapped_stat(db, user_id, profile)
    db.commit()
    db.refresh(profile)
    return profile


def get_taste_profile(db: Session, user_id: UUID, *, force_refresh: bool = False) -> UserTasteProfile:
    profile = db.scalar(select(UserTasteProfile).where(UserTasteProfile.user_id == user_id))
    if profile is None or force_refresh or _is_stale(profile.updated_at, hours=12):
        return refresh_taste_profile(db, user_id)
    return profile


def to_taste_profile_response(profile: UserTasteProfile) -> TasteProfileResponse:
    return TasteProfileResponse(
        user_id=profile.user_id,
        top_genres=profile.top_genres or [],
        top_themes=profile.top_themes or [],
        top_platforms=profile.top_platforms or [],
        favorite_eras=profile.favorite_eras or [],
        taste_labels=profile.taste_labels or [],
        profile_summary=profile.profile_summary,
        current_obsessions=[TasteTitleReferenceResponse(**item) for item in (profile.current_obsessions or [])],
        top_posters=profile.top_posters or [],
        most_saved_genre=profile.most_saved_genre,
        updated_at=profile.updated_at,
    )


# --- Swipe Intelligence recommendation types (spec §13) ---
REASON_TYPE_PICKS_SIMILARITY = "PICKS_SIMILARITY"
REASON_TYPE_PICKS_CLUSTER = "PICKS_CLUSTER"
REASON_TYPE_SCENEDNA_MATCH = "SCENEDNA_MATCH"
REASON_TYPE_PICKS_SCENEDNA_OVERLAP = "PICKS_SCENEDNA_OVERLAP"
REASON_TYPE_WATCH_TEAM = "WATCH_TEAM"
REASON_TYPE_TRENDING_PERSONALIZED = "TRENDING_PERSONALIZED"
REASON_TYPE_CREATOR_AFFINITY = "CREATOR_AFFINITY"
REASON_TYPE_TRENDING = "TRENDING_PERSONALIZED"  # cold-start alias
# Phase 2 additions per spec §17:
REASON_TYPE_HIDDEN_GEM = "HIDDEN_GEM"
REASON_TYPE_TASTE_NEIGHBORS = "TASTE_NEIGHBORS"
REASON_TYPE_SERENDIPITY = "SERENDIPITY"
# SceneDNA Personalization brief §11 + §34 additions — honest labels for
# Retained constants for schema/migration compat only — nothing in the current
# code path emits these. Any historical RecommendationImpression rows tagged
# with these values still resolve at query time; the copy layer below routes
# them to safe generic text so no legacy row leaks bad UI copy.
REASON_TYPE_GENERIC_TRENDING = "GENERIC_TRENDING"          # deprecated — not emitted
REASON_TYPE_GENERIC_HIDDEN_GEM = "GENERIC_HIDDEN_GEM"      # deprecated — not emitted


# Target mix per spec §17. Values are proportional; the blender treats them as soft
# quotas that gracefully degrade when a source runs dry (cold-start users have no
# picks/teams — SceneDNA + trending temporarily dominate).
FEED_MIX_TARGETS: dict[str, float] = {
    REASON_TYPE_PICKS_SIMILARITY: 0.35,
    REASON_TYPE_SCENEDNA_MATCH: 0.20,
    REASON_TYPE_PICKS_SCENEDNA_OVERLAP: 0.10,
    REASON_TYPE_TRENDING_PERSONALIZED: 0.10,
    REASON_TYPE_WATCH_TEAM: 0.05,
    REASON_TYPE_CREATOR_AFFINITY: 0.05,
    REASON_TYPE_HIDDEN_GEM: 0.05,
    REASON_TYPE_TASTE_NEIGHBORS: 0.05,
    REASON_TYPE_SERENDIPITY: 0.05,
}


def _title_creator_names(title: ContentTitle | None) -> set[str]:
    """Extract director + creator names from a ContentTitle's metadata_raw."""
    if title is None or not title.metadata_raw:
        return set()
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    credits = meta.get("credits") if isinstance(meta.get("credits"), dict) else {}
    crew = credits.get("crew") if isinstance(credits.get("crew"), list) else []
    names: set[str] = set()
    for person in crew:
        if isinstance(person, dict) and person.get("job") in ("Director", "Creator"):
            n = person.get("name")
            if isinstance(n, str) and n:
                names.add(n)
    for person in (meta.get("created_by") or []):
        if isinstance(person, dict) and isinstance(person.get("name"), str):
            names.add(person["name"])
    return names


def _title_top_actors(title: ContentTitle | None, limit: int = 5) -> list[str]:
    if title is None or not title.metadata_raw:
        return []
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    credits = meta.get("credits") if isinstance(meta.get("credits"), dict) else {}
    cast = credits.get("cast") if isinstance(credits.get("cast"), list) else []
    return [p.get("name") for p in cast[:limit] if isinstance(p, dict) and isinstance(p.get("name"), str)]


def _copy_from_evidence(
    candidate: ContentTitle,
    reason_type: str,
    contributing_titles: list[str],
    contributing_traits: list[str],
) -> str:
    """Translate structured evidence into a short user-facing reason string. Multi-signal
    phrasing per spec §12. Era is only ever a supporting phrase, never a headline."""
    genres = [g.lower() for g in contributing_traits if not g[:1].isupper() or " " not in g][:2]
    labels = [t for t in contributing_traits if t[:1].isupper() and " " in t][:1]  # e.g. "Prestige Drama"

    if reason_type == REASON_TYPE_PICKS_SIMILARITY and contributing_titles:
        if labels and contributing_titles:
            return f"Shares the {labels[0].lower()} DNA of {contributing_titles[0]}."
        if genres and contributing_titles:
            return f"Same {genres[0]} lane as {contributing_titles[0]} — right in your saved territory."
        if contributing_titles:
            return f"Because you saved {contributing_titles[0]} — this shares its DNA."
    if reason_type == REASON_TYPE_PICKS_CLUSTER and contributing_titles:
        first_two = contributing_titles[:2]
        joined = " and ".join(first_two) if len(first_two) == 2 else first_two[0]
        trait = labels[0] if labels else (genres[0] if genres else "consistent taste")
        return f"You keep saving {trait.lower()} — {joined} pushed this higher."
    if reason_type == REASON_TYPE_SCENEDNA_MATCH:
        if labels:
            return f"Your SceneDNA leans {labels[0]}. This sits right in that lane."
        if genres:
            return f"Your SceneDNA leans into {genres[0]} — this fits the pattern."
        return "Matches the way your SceneDNA is trending."
    if reason_type == REASON_TYPE_PICKS_SCENEDNA_OVERLAP:
        titles_phrase = ", ".join(contributing_titles[:2]) if contributing_titles else "your saves"
        dna_phrase = labels[0] if labels else (genres[0] if genres else "your taste")
        return f"Your fingerprints are on this — {titles_phrase} and your {dna_phrase.lower()} SceneDNA agree."
    if reason_type == REASON_TYPE_WATCH_TEAM and contributing_titles:
        return f"Your Watch Team saved {contributing_titles[0]} — shared taste for this."
    if reason_type == REASON_TYPE_CREATOR_AFFINITY and contributing_titles:
        return f"Same creative team as {contributing_titles[0]} — you've followed this artist before."
    if reason_type == REASON_TYPE_TRENDING_PERSONALIZED:
        if labels:
            return f"Trending right now — overlaps with your {labels[0].lower()} SceneDNA."
        if genres:
            return f"Climbing this week — and it lands in your {genres[0]} lane."
        # Cold-start rotation: no taste signal yet, so vary the phrasing per candidate
        # so consecutive cards don't feel like the same recommendation repeated.
        cold_templates = [
            "Climbing on SeenSnap this week.",
            f"A lot of the crowd is watching {candidate.title} right now.",
            "This is having a moment.",
            "Currently a big pick across the platform.",
            "One of the week's most-saved titles.",
            "People keep coming back to this one.",
        ]
        return cold_templates[hash(str(candidate.id)) % len(cold_templates)]
    if reason_type == REASON_TYPE_HIDDEN_GEM:
        if labels or genres:
            trait = labels[0] if labels else genres[0]
            return f"A hidden pick — its {trait.lower()} fits your taste unusually well."
        return "A hidden pick that fits your taste unusually well."
    # Legacy GENERIC_* handling — historical impression rows may still carry
    # these reason_types. Route to safe fallback copy that doesn't leak the
    # word "generic" or "not personalized." Fresh recommendations no longer
    # emit these types.
    if reason_type in (REASON_TYPE_GENERIC_TRENDING, REASON_TYPE_GENERIC_HIDDEN_GEM):
        if genres:
            return f"Worth a look — a strong {genres[0]} pick."
        return "Worth a look on SeenSnap."
    if reason_type == REASON_TYPE_TASTE_NEIGHBORS:
        return "People who save many of the same films you do have been landing here."
    if reason_type == REASON_TYPE_SERENDIPITY:
        if labels or genres:
            trait = labels[0] if labels else genres[0]
            return f"Hear us out — one step outside your usual, but the {trait.lower()} pull is there."
        return "Hear us out — one step outside your usual lane, worth the detour."
    # Fallback that never invents connections.
    return f"Worth a look — matches your recent activity on SeenSnap."


# ============================================================================
# SOURCE STRATEGIES — each returns list[(candidate, evidence_dict)] with a
# structured evidence payload. NEVER invent evidence; only surface what we have.
# ============================================================================


def _source_picks_similarity(
    db: Session,
    user_id: UUID,
    exclude: set[UUID],
    limit: int,
    *,
    session_id: str | None = None,
) -> list[dict]:
    """PICKS_SIMILARITY — analyze the WHOLE My Picks corpus, not just the most
    recent saves. Per the Swipe Intelligence brief §2: "SeenSnap should analyze
    the collection of saved titles, not just make one-to-one recommendations."

    Sampling rules:
      - Fetch ALL saves grouped by list; rotate seed selection per session so
        different sessions hit different corners of the corpus.
      - Weight seed slots by list type (Favorites > default My Picks > custom).
      - Cap total TMDB calls per request (~12 seeds) for latency.
    """
    rows = db.execute(
        select(WatchlistItem, Watchlist, ContentTitle)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(Watchlist.owner_user_id == user_id)
    ).all()
    if not rows:
        return []

    # Group saves by list so we can sample diversely across the user's shelves.
    by_list: dict[UUID, list[tuple[Watchlist, ContentTitle]]] = defaultdict(list)
    for _, watchlist, seed in rows:
        by_list[watchlist.id].append((watchlist, seed))

    # Per-session rotation: a stable offset derived from session_id lets one
    # session start seeding at index N and the next start at N+K, so the same
    # user swiping through the deck twice doesn't get the identical seed set.
    rotation_offset = 0
    if session_id:
        rotation_offset = abs(hash(session_id)) % 100

    # Build a diversified seed list. Priority: 1 seed from each list first
    # (breadth), then more seeds from Favorites and My Picks (depth), then
    # tail-sample from custom lists.
    seeds: list[tuple[Watchlist, ContentTitle]] = []

    def _rotated(items: list, k: int) -> list:
        if not items:
            return []
        start = rotation_offset % len(items)
        return items[start:] + items[:start]

    def _list_priority(wl: Watchlist) -> int:
        name = (wl.name or "").lower()
        if name == "favorites":
            return 3
        if wl.is_default:
            return 2
        return 1

    lists_sorted = sorted(by_list.values(), key=lambda entries: -_list_priority(entries[0][0]))
    # Breadth pass — one seed from each list to guarantee ALL lists get dug into.
    for entries in lists_sorted:
        rotated = _rotated(entries, rotation_offset)
        seeds.append(rotated[0])
    # Depth pass — sample more seeds from Favorites + My Picks (list_priority >= 2).
    for entries in lists_sorted:
        if _list_priority(entries[0][0]) < 2:
            continue
        rotated = _rotated(entries, rotation_offset + 1)
        for item in rotated[1:4]:  # up to 3 more from priority lists
            if item not in seeds:
                seeds.append(item)
    # Tail pass — sample remaining seeds from any list to reach the cap.
    for entries in lists_sorted:
        rotated = _rotated(entries, rotation_offset + 2)
        for item in rotated:
            if item in seeds:
                continue
            seeds.append(item)
            if len(seeds) >= 12:
                break
        if len(seeds) >= 12:
            break
    seeds = seeds[:12]

    out: list[dict] = []
    seen: set[UUID] = set()
    for watchlist, seed in seeds:
        try:
            related = fetch_related_titles(db, seed, limit=6)
        except TmdbConfigurationError:
            continue
        except Exception:
            continue  # never let a single seed's TMDB failure block the deck
        list_bonus = 4 if (watchlist.name or "").lower() == "favorites" else 2 if watchlist.is_default else 1
        for idx, candidate in enumerate(related):
            if candidate.id in exclude or candidate.id in seen:
                continue
            seen.add(candidate.id)
            shared_genres = list(_title_genres_set(candidate) & _title_genres_set(seed))
            out.append({
                "title": candidate,
                "reason_type": REASON_TYPE_PICKS_SIMILARITY,
                "score": max(12 - idx, 3) + list_bonus,
                "contributing_titles": [seed.title],
                "contributing_traits": shared_genres[:2],
                "confidence": 0.75 if watchlist.is_default or (watchlist.name or "").lower() == "favorites" else 0.6,
            })
    return out[:limit]


def _source_picks_cluster(
    db: Session,
    user_id: UUID,
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """PICKS_CLUSTER — find candidates whose genres/creators overlap with MULTIPLE
    saved titles. Higher signal than one-to-one similarity."""
    rows = db.execute(
        select(WatchlistItem, ContentTitle)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(Watchlist.owner_user_id == user_id)
        .limit(24)
    ).all()
    saved = [t for _, t in rows if t is not None]
    if len(saved) < 3:
        return []
    # Count genre / creator occurrences across saves.
    genre_counts: dict[str, int] = defaultdict(int)
    creator_counts: dict[str, int] = defaultdict(int)
    for s in saved:
        for g in _title_genres_set(s):
            genre_counts[g] += 1
        for c in _title_creator_names(s):
            creator_counts[c] += 1
    dominant_genres = [g for g, n in genre_counts.items() if n >= 3][:3]
    dominant_creators = [c for c, n in creator_counts.items() if n >= 2][:2]
    if not dominant_genres and not dominant_creators:
        return []
    # Fetch related from the top 3 most recent saves and require overlap w/ dominant traits.
    out: list[dict] = []
    seen: set[UUID] = set()
    for seed in saved[:2]:
        try:
            related = fetch_related_titles(db, seed, limit=6)
        except TmdbConfigurationError:
            continue
        except Exception:
            continue
        for candidate in related:
            if candidate.id in exclude or candidate.id in seen:
                continue
            cand_genres = _title_genres_set(candidate)
            cand_creators = _title_creator_names(candidate)
            overlapping_genres = [g for g in dominant_genres if g in cand_genres]
            overlapping_creators = [c for c in dominant_creators if c in cand_creators]
            if not overlapping_genres and not overlapping_creators:
                continue
            seen.add(candidate.id)
            contributing = [t.title for t in saved if _title_genres_set(t) & set(overlapping_genres)][:2]
            out.append({
                "title": candidate,
                "reason_type": REASON_TYPE_PICKS_CLUSTER,
                "score": 14 + len(overlapping_genres) * 2 + len(overlapping_creators) * 4,
                "contributing_titles": contributing or [seed.title],
                "contributing_traits": overlapping_genres + overlapping_creators,
                "confidence": 0.85,
            })
    return out[:limit]


def _source_scene_dna_match(
    db: Session,
    user_id: UUID,
    taste_profile: UserTasteProfile,
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """SCENEDNA_MATCH — draw candidates from current_obsessions (already computed
    by refresh_taste_profile) and TMDB-related expansion, tagged with the user's
    top taste labels."""
    obsession_ids = [
        UUID(str(item["title_id"])) for item in (taste_profile.current_obsessions or [])
        if item.get("title_id")
    ]
    if not obsession_ids:
        return []
    seeds = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(obsession_ids))).all()
    out: list[dict] = []
    seen: set[UUID] = set()
    top_label = None
    if taste_profile.taste_labels:
        first = taste_profile.taste_labels[0]
        if isinstance(first, dict):
            top_label = first.get("label")
    for seed in seeds[:3]:
        try:
            related = fetch_related_titles(db, seed, limit=5)
        except TmdbConfigurationError:
            continue
        except Exception:
            continue
        for idx, candidate in enumerate(related):
            if candidate.id in exclude or candidate.id in seen:
                continue
            seen.add(candidate.id)
            shared = list(_title_genres_set(candidate) & _title_genres_set(seed))
            traits = ([top_label] if top_label else []) + shared[:2]
            out.append({
                "title": candidate,
                "reason_type": REASON_TYPE_SCENEDNA_MATCH,
                "score": max(10 - idx, 2),
                "contributing_titles": [],  # DNA-driven, not seed-driven
                "contributing_traits": [t for t in traits if t][:3],
                "confidence": 0.7,
            })
    return out[:limit]


def _source_picks_scenedna_overlap(
    db: Session,
    picks_recs: list[dict],
    dna_recs: list[dict],
    limit: int,
) -> list[dict]:
    """PICKS_SCENEDNA_OVERLAP — highest-confidence: candidate appeared in BOTH
    picks-based AND scene-DNA-based lists. Merge evidence from both sources."""
    dna_by_title: dict[UUID, dict] = {r["title"].id: r for r in dna_recs}
    out: list[dict] = []
    for pick in picks_recs:
        tid = pick["title"].id
        match = dna_by_title.get(tid)
        if match is None:
            continue
        merged_titles = list({*pick.get("contributing_titles", []), *match.get("contributing_titles", [])})[:2]
        merged_traits = list({*pick.get("contributing_traits", []), *match.get("contributing_traits", [])})[:3]
        out.append({
            "title": pick["title"],
            "reason_type": REASON_TYPE_PICKS_SCENEDNA_OVERLAP,
            "score": pick["score"] + match["score"] + 6,
            "contributing_titles": merged_titles,
            "contributing_traits": merged_traits,
            "confidence": 0.92,
        })
    return out[:limit]


def _source_watch_team(
    db: Session,
    team_ids: list[UUID],
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """WATCH_TEAM — titles multiple team members have saved."""
    if not team_ids:
        return []
    rows = db.execute(
        select(TeamTitle.content_title_id, func.count(TeamTitle.id).label("uses"))
        .where(TeamTitle.team_id.in_(team_ids))
        .group_by(TeamTitle.content_title_id)
        .order_by(func.count(TeamTitle.id).desc())
        .limit(limit * 2)
    ).all()
    if not rows:
        return []
    title_map = {
        t.id: t for t in db.scalars(
            select(ContentTitle).where(ContentTitle.id.in_([tid for tid, _ in rows]))
        ).all()
    }
    out: list[dict] = []
    for tid, uses in rows:
        if tid in exclude:
            continue
        title = title_map.get(tid)
        if title is None:
            continue
        out.append({
            "title": title,
            "reason_type": REASON_TYPE_WATCH_TEAM,
            "score": int(uses) * 6,
            "contributing_titles": [title.title],
            "contributing_traits": list(_title_genres_set(title))[:2],
            "confidence": min(0.6 + int(uses) * 0.1, 0.9),
        })
    return out[:limit]


def _source_creator_affinity(
    db: Session,
    user_id: UUID,
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """CREATOR_AFFINITY — find titles by directors/creators of the user's saves."""
    rows = db.execute(
        select(WatchlistItem, ContentTitle)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(Watchlist.owner_user_id == user_id)
        .limit(20)
    ).all()
    saved = [t for _, t in rows if t is not None]
    creator_to_seed: dict[str, ContentTitle] = {}
    for s in saved:
        for c in _title_creator_names(s):
            creator_to_seed.setdefault(c, s)
    if not creator_to_seed:
        return []
    # For each seed, fetch related — same director often appears in TMDB related.
    out: list[dict] = []
    seen: set[UUID] = set()
    for creator, seed in list(creator_to_seed.items())[:2]:
        try:
            related = fetch_related_titles(db, seed, limit=4)
        except TmdbConfigurationError:
            continue
        except Exception:
            continue
        for candidate in related:
            if candidate.id in exclude or candidate.id in seen:
                continue
            if creator not in _title_creator_names(candidate):
                continue
            seen.add(candidate.id)
            out.append({
                "title": candidate,
                "reason_type": REASON_TYPE_CREATOR_AFFINITY,
                "score": 10,
                "contributing_titles": [seed.title],
                "contributing_traits": [creator],
                "confidence": 0.8,
            })
    return out[:limit]


def _source_trending_personalized(
    db: Session,
    taste_profile: UserTasteProfile,
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """TRENDING_PERSONALIZED — TMDB trending filtered by user's top genres so it's
    not blind trending. Per spec: 'Do not simply display whatever is trending.'"""
    try:
        trending = fetch_trending_titles(db, limit=limit * 3)
    except TmdbConfigurationError:
        return []
    user_top_genres = _user_top_genres(taste_profile)
    top_label = None
    if taste_profile.taste_labels:
        first = taste_profile.taste_labels[0]
        if isinstance(first, dict):
            top_label = first.get("label")
    out: list[dict] = []
    for candidate in trending:
        if candidate.id in exclude:
            continue
        cand_genres = _title_genres_set(candidate)
        overlap = list(cand_genres & user_top_genres)
        # Prefer trending that overlaps user genres; keep some pure-trending for cold start.
        score = 6 + len(overlap) * 2
        traits = ([top_label] if top_label else []) + overlap[:2]
        out.append({
            "title": candidate,
            "reason_type": REASON_TYPE_TRENDING_PERSONALIZED,
            "score": score,
            "contributing_titles": [],
            "contributing_traits": [t for t in traits if t][:3],
            "confidence": 0.5 + len(overlap) * 0.1,
        })
        if len(out) >= limit:
            break
    return out


def _source_hidden_gem(
    db: Session,
    taste_profile: UserTasteProfile,
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """HIDDEN_GEM — lower-popularity + high-rating titles that overlap the user's
    top genres. Per spec §9: "You probably weren't going to find this by scrolling
    Netflix." Uses local ContentTitle inventory + tmdb_vote_average filter — we
    don't want to fetch a fresh TMDB endpoint here since we're inside the same
    request. Threshold: vote_average >= 7.2 (well-reviewed) and title.metadata_raw
    popularity < 50 (below the mainstream discovery bar)."""
    user_top_genres = _user_top_genres(taste_profile)
    # No cold-start bail — even without a taste profile, surface well-rated
    # low-popularity titles as HIDDEN_GEMs so new users get variety, not
    # 100% trending. If we have taste, we'll additionally filter for genre
    # overlap below.

    # Pull candidates from local inventory — real TMDB-backed titles the user
    # hasn't seen. Order by rating so we surface the best hidden picks first.
    rows = db.scalars(
        select(ContentTitle)
        .where(
            ContentTitle.tmdb_vote_average.is_not(None),
            ContentTitle.tmdb_vote_average >= 7.2,
        )
        .order_by(ContentTitle.tmdb_vote_average.desc())
        .limit(200)
    ).all()

    label_names = [
        (l.get("label") if isinstance(l, dict) else None)
        for l in (taste_profile.taste_labels or [])
    ]
    top_label = next((n for n in label_names if n), None)

    out: list[dict] = []
    for candidate in rows:
        if candidate.id in exclude:
            continue
        cand_genres = _title_genres_set(candidate)
        overlap = list(cand_genres & user_top_genres)
        # Personalized-only. Cold-start users (no top_genres) get NOTHING
        # from this source — better a shorter deck than a GENERIC label
        # leaking into the UI ("Well-reviewed but not personalized to you").
        # The prior GENERIC_HIDDEN_GEM branch has been removed per user
        # directive: no GENERIC_* reason_types on any user-visible surface.
        if not user_top_genres or not overlap:
            continue
        # Filter for actual hidden-gem popularity — TMDB stores this in metadata_raw.
        meta = candidate.metadata_raw if isinstance(candidate.metadata_raw, dict) else {}
        pop = meta.get("popularity")
        if isinstance(pop, (int, float)) and pop >= 50:
            continue  # too mainstream — save Trending source for those
        traits = ([top_label] if top_label else []) + overlap[:2]
        out.append({
            "title": candidate,
            "reason_type": REASON_TYPE_HIDDEN_GEM,
            "score": 8 + len(overlap) * 2,
            "contributing_titles": [],
            "contributing_traits": [t for t in traits if t][:3],
            "confidence": 0.7,
        })
        if len(out) >= limit:
            break
    return out


def _source_taste_neighbors(
    db: Session,
    user_id: UUID,
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """TASTE_NEIGHBORS — lightweight collaborative filtering. Find other real users
    who share a meaningful chunk of saved titles with this user, then surface
    titles those neighbors saved that this user hasn't. Per spec §7: never expose
    similarity percentages or make it feel algorithmically creepy."""
    my_saves = set(db.scalars(
        select(WatchlistItem.content_title_id)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.owner_user_id == user_id)
    ).all())
    if len(my_saves) < 3:
        # Not enough taste signal to define "neighbors" — skip.
        return []

    # Find other non-demo users who share at least 2 of my saves.
    neighbor_rows = db.execute(
        select(Watchlist.owner_user_id, func.count(WatchlistItem.content_title_id).label("overlap"))
        .join(WatchlistItem, WatchlistItem.watchlist_id == Watchlist.id)
        .join(User, User.id == Watchlist.owner_user_id)
        .where(
            WatchlistItem.content_title_id.in_(my_saves),
            Watchlist.owner_user_id != user_id,
            User.is_demo.is_(False),
        )
        .group_by(Watchlist.owner_user_id)
        .having(func.count(WatchlistItem.content_title_id) >= 2)
        .order_by(func.count(WatchlistItem.content_title_id).desc())
        .limit(20)
    ).all()
    if not neighbor_rows:
        return []
    neighbor_ids = [row[0] for row in neighbor_rows]

    # What have those neighbors saved that I haven't?
    candidate_rows = db.execute(
        select(WatchlistItem.content_title_id, func.count(WatchlistItem.id).label("saves"))
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(
            Watchlist.owner_user_id.in_(neighbor_ids),
            ~WatchlistItem.content_title_id.in_(my_saves | exclude),
        )
        .group_by(WatchlistItem.content_title_id)
        .order_by(func.count(WatchlistItem.id).desc())
        .limit(limit * 2)
    ).all()
    if not candidate_rows:
        return []

    title_map = {
        t.id: t for t in db.scalars(
            select(ContentTitle).where(ContentTitle.id.in_([row[0] for row in candidate_rows]))
        ).all()
    }
    out: list[dict] = []
    for tid, save_count in candidate_rows:
        title = title_map.get(tid)
        if title is None:
            continue
        out.append({
            "title": title,
            "reason_type": REASON_TYPE_TASTE_NEIGHBORS,
            "score": 6 + int(save_count),
            "contributing_titles": [],
            "contributing_traits": list(_title_genres_set(title))[:2],
            "confidence": min(0.55 + int(save_count) * 0.05, 0.85),
        })
        if len(out) >= limit:
            break
    return out


def _source_serendipity(
    db: Session,
    taste_profile: UserTasteProfile,
    exclude: set[UUID],
    limit: int,
) -> list[dict]:
    """SERENDIPITY — controlled taste-stretch. Picks titles ONE STEP OUTSIDE the
    user's established genre graph so the algorithm doesn't become a filter bubble
    (spec §10). NOT random — we intersect adjacent genres with the user's actual
    taste and pick well-rated candidates."""
    user_top_genres = _user_top_genres(taste_profile)
    if not user_top_genres:
        return []

    # Adjacent-genre map — deliberately conservative pairs so the stretch feels
    # earned rather than random.
    ADJACENT: dict[str, list[str]] = {
        "Drama": ["Documentary", "Music"],
        "Thriller": ["Horror", "Mystery"],
        "Mystery": ["Crime", "Thriller"],
        "Science Fiction": ["Fantasy", "Adventure"],
        "Fantasy": ["Science Fiction", "Adventure"],
        "Comedy": ["Romance", "Family"],
        "Romance": ["Comedy", "Drama"],
        "Action": ["Adventure", "Crime"],
        "Horror": ["Thriller", "Mystery"],
        "Documentary": ["Drama"],
        "Animation": ["Family", "Fantasy"],
        "Crime": ["Mystery", "Thriller"],
    }
    stretch_targets: set[str] = set()
    for g in user_top_genres:
        for adjacent in ADJACENT.get(g, []):
            if adjacent not in user_top_genres:
                stretch_targets.add(adjacent)
    if not stretch_targets:
        return []

    # Find well-rated candidates in the stretch genres.
    rows = db.scalars(
        select(ContentTitle)
        .where(
            ContentTitle.tmdb_vote_average.is_not(None),
            ContentTitle.tmdb_vote_average >= 7.0,
        )
        .order_by(ContentTitle.tmdb_vote_average.desc())
        .limit(150)
    ).all()

    out: list[dict] = []
    for candidate in rows:
        if candidate.id in exclude:
            continue
        cand_genres = _title_genres_set(candidate)
        stretch_matches = list(cand_genres & stretch_targets)
        if not stretch_matches:
            continue
        # Bonus: candidate also carries at least one of the user's core genres —
        # softer landing, still feels connected.
        overlap = list(cand_genres & user_top_genres)
        out.append({
            "title": candidate,
            "reason_type": REASON_TYPE_SERENDIPITY,
            "score": 6 + len(stretch_matches) * 2 + len(overlap),
            "contributing_titles": [],
            "contributing_traits": stretch_matches[:1] + overlap[:1],
            "confidence": 0.5,
        })
        if len(out) >= limit:
            break
    return out


def _blend_and_diversify(
    buckets: dict[str, list[dict]],
    limit: int,
) -> list[dict]:
    """Merge source buckets per FEED_MIX_TARGETS, deduplicate, and enforce simple
    diversity constraints (no 3 consecutive same-genre / same-reason-type)."""
    # Assign quota per source, floor at 1 if source has any items.
    quotas: dict[str, int] = {}
    for reason_type, ratio in FEED_MIX_TARGETS.items():
        raw = round(limit * ratio)
        quotas[reason_type] = max(1, raw) if buckets.get(reason_type) else 0
    total = sum(quotas.values())
    # If quotas don't fill the deck, distribute leftover proportional to available inventory.
    # Loop until slack absorbed or no bucket has capacity — one pass isn't enough when
    # the primary source (My Picks similarity) has 15+ candidates and other sources are cold.
    #
    # HARD CAP: no single bucket can exceed 40% of the deck via slack absorption.
    # Prior implementation had no cap — when a low-relevance bucket happened to
    # have many candidates (e.g. HIDDEN_GEM returning 20 items during a bad-fix
    # regression) it could eat 100% of the deck. Cap protects against future
    # source misbehavior swallowing the whole recommendation surface.
    slack = max(limit - total, 0)
    max_per_bucket = max(int(limit * 0.4), 2)
    while slack > 0:
        progressed = False
        for reason_type, items in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
            if slack <= 0:
                break
            current_quota = quotas.get(reason_type, 0)
            if len(items) > current_quota and current_quota < max_per_bucket:
                quotas[reason_type] = current_quota + 1
                slack -= 1
                progressed = True
        if not progressed:
            break  # every bucket exhausted OR at cap; deck may be short

    # Take top-N from each bucket by score.
    selected_by_bucket: dict[str, list[dict]] = {}
    seen: set[UUID] = set()
    for reason_type, items in buckets.items():
        q = quotas.get(reason_type, 0)
        if q <= 0:
            continue
        sorted_items = sorted(items, key=lambda x: x["score"], reverse=True)
        picked: list[dict] = []
        for item in sorted_items:
            tid = item["title"].id
            if tid in seen:
                continue
            picked.append(item)
            seen.add(tid)
            if len(picked) >= q:
                break
        if picked:
            selected_by_bucket[reason_type] = picked

    # Interleave buckets so we get variety, not "all picks then all DNA then all trending".
    interleaved: list[dict] = []
    max_len = max((len(v) for v in selected_by_bucket.values()), default=0)
    for i in range(max_len):
        for reason_type in FEED_MIX_TARGETS.keys():
            bucket = selected_by_bucket.get(reason_type)
            if bucket and i < len(bucket):
                interleaved.append(bucket[i])

    # Diversity pass: don't allow 3 consecutive same-reason-type or same primary genre.
    diversified: list[dict] = []
    for item in interleaved:
        if len(diversified) >= 2:
            last_two = diversified[-2:]
            if all(x["reason_type"] == item["reason_type"] for x in last_two):
                # Try to defer this one to later in the sequence
                continue
            item_g = next(iter(_title_genres_set(item["title"])), None)
            if item_g and all(
                item_g in _title_genres_set(x["title"]) for x in last_two
            ):
                continue
        diversified.append(item)
        if len(diversified) >= limit:
            break
    # If diversity filter left us short, fall back to interleaved order to fill.
    if len(diversified) < limit:
        for item in interleaved:
            if item in diversified:
                continue
            diversified.append(item)
            if len(diversified) >= limit:
                break
    return diversified[:limit]


def _session_boost_traits(db: Session, user_id: UUID, session_id: str | None) -> set[str]:
    """Extract the trait signals from the last 8 positive swipes in this session.
    Enables session-level adaptation per spec §15: repeated More Like This tunes
    the next 10–20 cards toward whatever category the user is responding to.
    SceneDNA remains the durable model; this is only a lightweight session layer."""
    if not session_id:
        return set()
    rows = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(
            SwipeRecord.user_id == user_id,
            SwipeRecord.session_id == session_id,
            SwipeRecord.direction.in_(("right", "up")),
        )
        .order_by(SwipeRecord.created_at.desc())
        .limit(8)
    ).all()
    traits: set[str] = set()
    for _, t in rows:
        if t is None:
            continue
        traits.update(_title_genres_set(t))
        traits.update(_title_creator_names(t))
    return traits


def _apply_session_boost(buckets: dict[str, list[dict]], boost_traits: set[str]) -> None:
    """Bump the score of any candidate whose genres/creators/traits overlap with
    the session's recent positive-swipe traits. Mutates in place."""
    if not boost_traits:
        return
    for items in buckets.values():
        for item in items:
            cand_traits = set(item.get("contributing_traits") or [])
            cand_traits |= _title_genres_set(item["title"])
            cand_traits |= _title_creator_names(item["title"])
            overlap = len(cand_traits & boost_traits)
            if overlap:
                item["score"] = item.get("score", 0) + overlap * 3


def _recent_negative_traits(db: Session, user_id: UUID, *, limit: int = 30) -> set[str]:
    """Genres + creators from the user's recent LEFT swipes (brief §14: PASS is
    a negative signal). Used to demote candidates that carry the same traits,
    so the model visibly reacts to dislikes within a session."""
    rows = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == user_id, SwipeRecord.direction == "left")
        .order_by(SwipeRecord.created_at.desc())
        .limit(limit)
    ).all()
    traits: set[str] = set()
    for _, t in rows:
        if t is None:
            continue
        traits.update(_title_genres_set(t))
        traits.update(_title_creator_names(t))
    return traits


def _apply_negative_penalty(buckets: dict[str, list[dict]], negative_traits: set[str]) -> None:
    """Demote candidates whose genres/creators overlap with recent left-swipe
    traits. Not an outright exclude — the user might have passed on ONE thriller
    but still like thrillers in general. A -2 per overlapping trait moves them
    down the ranking without banning the source outright. Mutates in place."""
    if not negative_traits:
        return
    for items in buckets.values():
        for item in items:
            cand_traits = _title_genres_set(item["title"]) | _title_creator_names(item["title"])
            overlap = len(cand_traits & negative_traits)
            if overlap:
                item["score"] = item.get("score", 0) - overlap * 2


def get_social_recommendations(
    db: Session,
    user_id: UUID,
    *,
    limit: int = 24,
    preferred_type: str | None = None,
    session_id: str | None = None,
) -> list[RecommendationResponse]:
    """Blended Swipe recommendation engine. Evidence-first per spec §20:
    each source strategy returns structured evidence (contributing_titles,
    contributing_traits, confidence). A copy layer translates the winning
    evidence into user-facing reason text — copy never invents relationships
    that the evidence doesn't support.
    """
    taste_profile = get_taste_profile(db, user_id)

    # Exclusion set — never recommend a title the user already saved, dismissed,
    # or explicitly passed on.
    saved_ids = set(db.scalars(
        select(WatchlistItem.content_title_id)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.owner_user_id == user_id)
    ).all())
    # Only exclude RECENT left-swipes. Older dismisses accumulate over time and,
    # for heavy users (demo especially), end up blocking every candidate every
    # source produces. A dismiss from months ago shouldn't be a permanent ban —
    # taste evolves. Cap at the 60 most recent dismisses so newer decks stay fresh.
    dismissed_rows = db.execute(
        select(SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == user_id, SwipeRecord.direction == "left")
        .order_by(SwipeRecord.created_at.desc())
        .limit(60)
    ).all()
    exclude: set[UUID] = saved_ids | {row[0] for row in dismissed_rows if row[0] is not None}

    # Recently-shown exclude — brief §16, §21: users should rarely feel that
    # consecutive cards are variations of the same recommendation. Anything
    # served in the last 6 hours stays out of the deck so we don't recycle
    # the same 30 titles every reload. Old signals (>6h) are eligible again.
    recycle_cutoff = datetime.now(timezone.utc) - timedelta(hours=6)
    recently_shown_rows = db.execute(
        select(RecommendationSignal.content_title_id)
        .where(
            RecommendationSignal.user_id == user_id,
            RecommendationSignal.created_at >= recycle_cutoff,
        )
    ).all()
    recently_shown: set[UUID] = {row[0] for row in recently_shown_rows if row[0] is not None}
    exclude = exclude | recently_shown

    team_ids = [team.id for team, _ in list_user_teams(db, user_id)]

    # Prune stale RecommendationSignal rows (older than the recycle window)
    # so the table doesn't grow unbounded. Anything within the window stays
    # for the recently-shown lookup on the next request.
    db.query(RecommendationSignal).filter(
        RecommendationSignal.user_id == user_id,
        RecommendationSignal.created_at < recycle_cutoff,
    ).delete(synchronize_session=False)

    # --- Fan out to each source strategy ---
    per_source_cap = max(limit, 8)
    picks_recs = _source_picks_similarity(db, user_id, exclude, per_source_cap, session_id=session_id)
    cluster_recs = _source_picks_cluster(db, user_id, exclude, per_source_cap // 2)
    dna_recs = _source_scene_dna_match(db, user_id, taste_profile, exclude, per_source_cap)
    overlap_recs = _source_picks_scenedna_overlap(db, picks_recs, dna_recs, per_source_cap // 2)
    team_recs = _source_watch_team(db, team_ids, exclude, per_source_cap // 2)
    creator_recs = _source_creator_affinity(db, user_id, exclude, per_source_cap // 2)
    trending_recs = _source_trending_personalized(db, taste_profile, exclude, per_source_cap)
    hidden_gem_recs = _source_hidden_gem(db, taste_profile, exclude, per_source_cap // 2)
    neighbor_recs = _source_taste_neighbors(db, user_id, exclude, per_source_cap // 2)
    serendipity_recs = _source_serendipity(db, taste_profile, exclude, per_source_cap // 2)

    # Merge PICKS_CLUSTER into PICKS_SIMILARITY bucket (both are "from your saves").
    for item in cluster_recs:
        # Higher-confidence cluster entries outrank plain similarity for the same title.
        picks_recs.append(item)

    buckets: dict[str, list[dict]] = {
        REASON_TYPE_PICKS_SIMILARITY: picks_recs,
        REASON_TYPE_SCENEDNA_MATCH: dna_recs,
        REASON_TYPE_PICKS_SCENEDNA_OVERLAP: overlap_recs,
        REASON_TYPE_WATCH_TEAM: team_recs,
        REASON_TYPE_CREATOR_AFFINITY: creator_recs,
        REASON_TYPE_TRENDING_PERSONALIZED: trending_recs,
        REASON_TYPE_HIDDEN_GEM: hidden_gem_recs,
        REASON_TYPE_TASTE_NEIGHBORS: neighbor_recs,
        REASON_TYPE_SERENDIPITY: serendipity_recs,
    }

    # --- Type-filter (movie/series) before blending, so quota math holds. ---
    if preferred_type in ("movie", "show"):
        want = "movie" if preferred_type == "movie" else "series"
        for key in list(buckets.keys()):
            buckets[key] = [x for x in buckets[key] if x["title"].content_type == want]

    # --- Session adaptation (spec §15) — bump candidates matching the traits
    # the user has been swiping right on this session. SceneDNA remains durable;
    # this is a light layer that tunes the next 10–20 cards toward what the user
    # is CURRENTLY responding to. ---
    boost_traits = _session_boost_traits(db, user_id, session_id)
    _apply_session_boost(buckets, boost_traits)
    # Learn from left swipes — demote candidates matching recent dismisses.
    negative_traits = _recent_negative_traits(db, user_id)
    _apply_negative_penalty(buckets, negative_traits)

    # --- Blend + diversity pass ---
    chosen = _blend_and_diversify(buckets, limit)

    # NO cold-start / trending pad. Prior implementation appended TMDB
    # trending titles tagged GENERIC_TRENDING to fill any gap between the
    # personalized deck and `limit`, and the copy layer surfaced them as
    # "Trending on SeenSnap this week." That silently dumped unpersonalized
    # catalog data into what the UI treats as a personal recommendation
    # deck — user-visible, dominating heavy users' feeds after ~20 swipes.
    #
    # Per SceneDNA brief §34 + user directive: never inject GENERIC content
    # into a personalized surface. If real sources come up short, return a
    # short deck — the client's Swipe empty state ("That's the fresh set
    # for now") already handles this honestly.
    #
    # Cold-start users (no interactions) will get a genuinely empty deck
    # until they interact. That's the correct experience; onboarding is the
    # place to seed initial taste, not the recommendation engine.

    # --- Emit signals + build responses ---
    results: list[RecommendationResponse] = []
    from app.api.routes.titles import _to_title_response  # local import — avoids cycle

    for item in chosen:
        reason_type: str = item["reason_type"]
        contributing_titles: list[str] = item.get("contributing_titles", []) or []
        contributing_traits: list[str] = item.get("contributing_traits", []) or []
        confidence: float = float(item.get("confidence", 0.5))
        reason = _copy_from_evidence(item["title"], reason_type, contributing_titles, contributing_traits)

        db.add(
            RecommendationSignal(
                user_id=user_id,
                content_title_id=item["title"].id,
                signal_type=reason_type,
                weight=int(item.get("score", 0)),
                reason=reason,
                metadata_json={
                    "reason_type": reason_type,
                    "contributing_titles": contributing_titles,
                    "contributing_traits": contributing_traits,
                    "confidence": confidence,
                    "preferred_type": preferred_type,
                },
            )
        )
        results.append(
            RecommendationResponse(
                title=_to_title_response(item["title"]),
                reason=reason,
                seed_title_id=None,
                reason_type=reason_type,
                evidence=RecommendationEvidence(
                    contributing_titles=contributing_titles,
                    contributing_traits=contributing_traits,
                    confidence=confidence,
                ),
            )
        )
    db.commit()
    return results


def _user_top_genres(taste_profile: UserTasteProfile) -> set[str]:
    """Normalized read of top_genres — the JSONB stores each entry as
    `{"genre": "Drama", "score": N}`. Older shapes also handled for safety."""
    out: set[str] = set()
    for g in (taste_profile.top_genres or []):
        if isinstance(g, dict):
            name = g.get("genre") or g.get("name")
            if isinstance(name, str) and name:
                out.add(name)
        elif isinstance(g, str) and g:
            out.add(g)
    return out


def _title_genres_set(title: ContentTitle | None) -> set[str]:
    if title is None or not title.genres:
        return set()
    return {g for g in title.genres if g}


def _find_evidence_titles(
    db: Session,
    user_id: UUID,
    candidate_genres: set[str],
    limit: int = 2,
) -> list[SceneDnaEvidenceTitle]:
    """Return up to `limit` previously-positive titles that share genres with the candidate.
    Used as concrete evidence in feedback copy so users see WHY a rec fits."""
    if not candidate_genres:
        return []
    positive_dirs = ("right", "up")
    rows = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(
            SwipeRecord.user_id == user_id,
            SwipeRecord.direction.in_(positive_dirs),
        )
        .order_by(SwipeRecord.created_at.desc())
        .limit(60)
    ).all()
    seen: set[UUID] = set()
    out: list[SceneDnaEvidenceTitle] = []
    for _, t in rows:
        if t.id in seen:
            continue
        if _title_genres_set(t) & candidate_genres:
            seen.add(t.id)
            out.append(SceneDnaEvidenceTitle(title_id=t.id, title_name=t.title))
            if len(out) >= limit:
                break
    return out


_HEADLINES_STRONG = ("Very you.", "That tracks.", "SceneDNA locked in.")
_HEADLINES_MEDIUM = ("Makes sense.", "This fits.", "Right in your lane.")
_HEADLINES_LOW = ("New territory.", "Interesting pick.", "Worth exploring.")


def _build_scene_dna_feedback(
    db: Session,
    user_id: UUID,
    candidate: ContentTitle,
) -> SceneDnaFeedbackResponse | None:
    """Evidence-first feedback for a positive swipe. Per Swipe Intelligence spec §11
    signal hierarchy:
      Very Strong: saved-title clusters + high ratings + repeated positive swipes + strong DNA traits
      Strong:      multiple related saved titles / directors / themes / subgenres
      Supporting:  actors / country / language
      Weak:        release year / era ONLY (never a headline)

    We produce headline + body + signal chips from real evidence — never combine an
    invented "why" with a generic streak line.
    """
    profile = db.scalar(select(UserTasteProfile).where(UserTasteProfile.user_id == user_id))
    candidate_genres = _title_genres_set(candidate)
    candidate_creators = _title_creator_names(candidate)
    candidate_actors = set(_title_top_actors(candidate, limit=4))

    # --- STRONG signals ---
    # Evidence: user's prior saves/positive swipes that share genres, creators, or actors.
    saved_rows = db.execute(
        select(WatchlistItem, ContentTitle)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(Watchlist.owner_user_id == user_id)
        .order_by(WatchlistItem.created_at.desc())
        .limit(40)
    ).all()
    saved_titles = [t for _, t in saved_rows if t is not None]
    positive_swipe_titles = [
        t for _, t in db.execute(
            select(SwipeRecord, ContentTitle)
            .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
            .where(SwipeRecord.user_id == user_id, SwipeRecord.direction.in_(("right", "up")))
            .order_by(SwipeRecord.created_at.desc())
            .limit(40)
        ).all() if t is not None
    ]

    # Titles the user has expressed positive intent for that share DNA with this candidate.
    evidence_titles: list[SceneDnaEvidenceTitle] = []
    matched_by: set[str] = set()  # which dimensions matched (genre / creator / actor)
    for t in saved_titles + positive_swipe_titles:
        if t.id == candidate.id:
            continue
        matched = False
        if _title_genres_set(t) & candidate_genres:
            matched = True
            matched_by.add("genre")
        if _title_creator_names(t) & candidate_creators:
            matched = True
            matched_by.add("creator")
        if set(_title_top_actors(t, limit=4)) & candidate_actors:
            matched = True
            matched_by.add("actor")
        if matched and not any(e.title_id == t.id for e in evidence_titles):
            evidence_titles.append(SceneDnaEvidenceTitle(title_id=t.id, title_name=t.title))
        if len(evidence_titles) >= 2:
            break

    # --- VERY STRONG: taste label overlap with candidate genres ---
    label_names: list[str] = []
    if profile and profile.taste_labels:
        for entry in profile.taste_labels[:3]:
            name = entry.get("label") if isinstance(entry, dict) else None
            if name:
                label_names.append(name)
    # Genre overlap with user's top genres
    user_top_genres: list[str] = []
    if profile and profile.top_genres:
        for g in profile.top_genres:
            if isinstance(g, dict) and g.get("name"):
                user_top_genres.append(g["name"])
            elif isinstance(g, str):
                user_top_genres.append(g)
    overlap_genres = [g for g in user_top_genres if g in candidate_genres][:2]

    # --- Score signal strength (era intentionally NOT a headline signal per spec) ---
    strong_signal_count = (
        (2 if len(evidence_titles) >= 2 else 0)          # multi-title cluster is very strong
        + (1 if evidence_titles else 0)
        + len(overlap_genres)
        + (2 if "creator" in matched_by else 0)          # creator overlap is strong
        + (1 if label_names and overlap_genres else 0)   # label + genre alignment
    )

    if strong_signal_count == 0:
        # Truthful low-signal fallback — never invent a why.
        return SceneDnaFeedbackResponse(
            headline=_HEADLINES_LOW[hash(str(candidate.id)) % len(_HEADLINES_LOW)],
            body="Your SceneDNA is still forming — swipes like this help sharpen it.",
            signal_labels=[],
            evidence_titles=[],
        )

    # --- Compose the multi-signal body (spec §12: combine dimensions) ---
    pieces: list[str] = []
    # Lead with the strongest available: label + genres + evidence titles.
    if label_names and evidence_titles:
        titles = " and ".join(e.title_name for e in evidence_titles[:2])
        pieces.append(
            f"You keep gravitating toward {label_names[0].lower()} — {titles} pushed that signal higher"
        )
    elif len(evidence_titles) >= 2 and overlap_genres:
        titles = " and ".join(e.title_name for e in evidence_titles[:2])
        genre = overlap_genres[0].lower()
        pieces.append(f"You've been saving {genre} that lands like this — {titles} shaped it")
    elif evidence_titles and overlap_genres:
        pieces.append(
            f"Same {overlap_genres[0].lower()} DNA that pulled you to {evidence_titles[0].title_name}"
        )
    elif evidence_titles:
        pieces.append(f"Sits in the lane of {evidence_titles[0].title_name}")
    elif overlap_genres:
        genres = " and ".join(g.lower() for g in overlap_genres)
        pieces.append(f"Your SceneDNA leans into {genres}")
    elif label_names:
        pieces.append(f"Your SceneDNA leans {label_names[0]}")

    # Creator affinity is a strong secondary signal.
    if "creator" in matched_by and candidate_creators:
        creator_name = next(iter(candidate_creators))
        pieces.append(f"and {creator_name} keeps showing up in what you save")

    body = ". ".join(p.rstrip(".") for p in pieces if p) + "."

    # Headline tier
    if strong_signal_count >= 4:
        headlines = _HEADLINES_STRONG
    elif strong_signal_count >= 2:
        headlines = _HEADLINES_MEDIUM
    else:
        headlines = _HEADLINES_LOW
    headline = headlines[hash(str(candidate.id)) % len(headlines)]

    # Signal chips: prioritize label (e.g. "Prestige Drama"), then overlap genres.
    signal_labels: list[str] = []
    if label_names:
        signal_labels.append(label_names[0])
    for g in overlap_genres:
        if g not in signal_labels:
            signal_labels.append(g)
    signal_labels = signal_labels[:3]

    return SceneDnaFeedbackResponse(
        headline=headline,
        body=body,
        signal_labels=signal_labels,
        evidence_titles=evidence_titles,
    )


def build_swipe_feedback(
    db: Session,
    user_id: UUID,
    title_id: UUID,
    direction: str,
) -> SceneDnaFeedbackResponse | None:
    """Public wrapper: returns feedback only for positive swipes (right/up)."""
    if direction not in ("right", "up"):
        return None
    candidate = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if candidate is None:
        return None
    return _build_scene_dna_feedback(db, user_id, candidate)


def record_swipe(
    db: Session,
    user_id: UUID,
    *,
    title_id: UUID,
    direction: str,
    pause_ms: int | None = None,
    session_id: str | None = None,
    reason: str | None = None,
    source_surface: str | None = None,
) -> SwipeRecord:
    if direction not in SWIPE_DIRECTION_WEIGHTS:
        raise ValueError(f"Unsupported swipe direction: {direction}")

    record = SwipeRecord(
        user_id=user_id,
        content_title_id=title_id,
        direction=direction,
        pause_ms=pause_ms,
        session_id=session_id,
        reason=reason,
        source_surface=source_surface,
    )
    db.add(record)
    db.flush()
    _prune_old_swipes(db, user_id)
    refresh_taste_profile(db, user_id)
    db.refresh(record)
    return record


def _collect_title_signals(db: Session, user_id: UUID) -> tuple[defaultdict[str, float], list[dict], list[int]]:
    genre_scores: defaultdict[str, float] = defaultdict(float)
    title_refs: dict[UUID, dict] = {}
    release_years: list[int] = []
    team_ids = [team.id for team, _ in list_user_teams(db, user_id)]

    def apply_title(title: ContentTitle | None, weight: float) -> None:
        if title is None:
            return
        for genre in _title_genres(title):
            genre_scores[genre] += weight
        if title.id not in title_refs:
            title_refs[title.id] = {
                "title_id": str(title.id),
                "title_name": title.title,
                "poster_url": title.poster_url,
                "weight": 0.0,
            }
        title_refs[title.id]["weight"] += weight
        if title.release_date is not None:
            release_years.append(title.release_date.year)

    ratings = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == user_id)
    ).all()
    for rating, title in ratings:
        apply_title(title, max(float(rating.score) - 4.5, 0.5) * 6)

    reviews = db.execute(
        select(Review, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Review.content_title_id)
        .where(Review.user_id == user_id)
    ).all()
    for review, title in reviews:
        apply_title(title, 5 if review.body else 3)

    watchlist_items = db.execute(
        select(WatchlistItem, Watchlist, ContentTitle)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(Watchlist.owner_user_id == user_id)
    ).all()
    for item, watchlist, title in watchlist_items:
        bonus = 14 if watchlist.name.lower() == "favorites" else 10 if watchlist.is_default else 8
        if item.position is not None:
            bonus += max(10 - item.position, 1)
        apply_title(title, bonus)

    team_rankings = (
        db.execute(
            select(TeamRanking, ContentTitle)
            .join(ContentTitle, ContentTitle.id == TeamRanking.content_title_id)
            .where(TeamRanking.team_id.in_(team_ids))
        ).all()
        if team_ids
        else []
    )
    for ranking, title in team_rankings:
        apply_title(title, max(12 - ranking.rank, 2) + float(ranking.score))

    reactions = db.scalar(select(func.count(FeedReaction.id)).where(FeedReaction.user_id == user_id)) or 0
    if reactions and genre_scores:
        lead_genre = max(genre_scores.items(), key=lambda item: item[1])[0]
        genre_scores[lead_genre] += reactions * 0.35

    comments = db.scalar(select(func.count(FeedComment.id)).where(FeedComment.user_id == user_id)) or 0
    if comments and genre_scores:
        lead_genre = max(genre_scores.items(), key=lambda item: item[1])[0]
        genre_scores[lead_genre] += comments * 0.5

    swipe_rows = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == user_id)
        .order_by(SwipeRecord.created_at.desc())
        .limit(250)
    ).all()
    for swipe, title in swipe_rows:
        if title is None:
            continue
        weight = SWIPE_DIRECTION_WEIGHTS.get(swipe.direction, 0.0)
        if weight > 0:
            apply_title(title, weight)
            continue
        for genre in _title_genres(title):
            genre_scores[genre] += weight
            if genre_scores[genre] < 0:
                genre_scores[genre] = 0

    ordered_titles = sorted(title_refs.values(), key=lambda item: item["weight"], reverse=True)
    return genre_scores, ordered_titles, release_years


def _derive_themes(genre_scores: dict[str, float]) -> list[str]:
    themes: list[tuple[str, float]] = []
    lowered = {genre.lower(): score for genre, score in genre_scores.items()}
    for theme, matches in THEME_KEYWORDS.items():
        score = sum(value for genre, value in lowered.items() if any(token in genre for token in matches))
        if score > 0:
            themes.append((theme, score))
    return [name for name, _ in sorted(themes, key=lambda item: item[1], reverse=True)[:3]]


def _title_genres(title: ContentTitle) -> list[str]:
    if title.genres:
        return [genre for genre in title.genres if genre]
    metadata = title.metadata_raw or {}
    if isinstance(metadata, dict):
        raw_genres = metadata.get("genres")
        if isinstance(raw_genres, list):
            extracted: list[str] = []
            for item in raw_genres:
                if isinstance(item, str) and item:
                    extracted.append(item)
                elif isinstance(item, dict) and isinstance(item.get("name"), str):
                    extracted.append(item["name"])
            if extracted:
                return extracted
    overview = (title.overview or "").lower()
    heuristic_map = {
        "Drama": ("family", "relationship", "career", "marriage"),
        "Thriller": ("murder", "conspiracy", "investigation", "danger"),
        "Comedy": ("funny", "comedy", "awkward", "satire"),
        "Science Fiction": ("space", "future", "technology", "dystopian"),
        "Horror": ("haunted", "terror", "curse", "horror"),
        "Crime": ("crime", "detective", "cartel", "serial killer"),
        "Romance": ("love", "romance", "relationship"),
    }
    guessed = [genre for genre, tokens in heuristic_map.items() if any(token in overview for token in tokens)]
    return guessed


def _derive_platforms(db: Session, user_id: UUID) -> list[str]:
    preferences = db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
    provider_counts = Counter()
    rows = db.execute(
        select(ContentAvailability.provider_name)
        .join(ContentTitle, ContentTitle.id == ContentAvailability.content_title_id)
        .join(WatchlistItem, WatchlistItem.content_title_id == ContentTitle.id)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.owner_user_id == user_id)
    ).all()
    for (provider_name,) in rows:
        if provider_name:
            provider_counts[provider_name] += 1
    ordered = [name for name, _ in provider_counts.most_common(3)]
    if preferences is not None:
        for service in preferences.connected_streaming_services or []:
            normalized = service.replace("_", " ").title()
            if normalized not in ordered:
                ordered.append(normalized)
    return ordered[:3]


def _derive_eras(years: list[int]) -> list[str]:
    if not years:
        return []
    buckets = Counter()
    for year in years:
        decade = f"{year // 10 * 10}s"
        buckets[decade] += 1
        if year >= 2010:
            buckets["Modern Prestige TV"] += 0.4
        elif year >= 1990:
            buckets["Late Century Essentials"] += 0.25
    return [name for name, _ in buckets.most_common(2)]


def _derive_labels(genre_scores: dict[str, float], themes: list[str]) -> list[dict]:
    if not genre_scores:
        return []
    genre_total = sum(genre_scores.values()) or 1
    normalized = {genre: value / genre_total for genre, value in genre_scores.items()}
    theme_set = set(themes)
    results: list[dict] = []
    for label, rule in LABEL_RULES.items():
        score = 0.0
        for genre, weight in (rule.get("genres") or {}).items():
            score += normalized.get(genre, 0.0) * float(weight) * 100
        if theme_set.intersection(rule.get("themes") or set()):
            score += 12
        confidence = min(int(round(score)), 99)
        if confidence >= 35:
            results.append({"label": label, "confidence": confidence})
    return sorted(results, key=lambda item: item["confidence"], reverse=True)[:4]


def _derive_current_obsessions(title_refs: list[dict]) -> list[dict]:
    """Cumulative-weight fallback. Kept for backward compat when the new
    recency-aware query returns nothing (brand new users). Real callers now
    prefer `_derive_current_obsessions_recent()`."""
    return [
        {
            "title_id": item.get("title_id"),
            "title_name": item.get("title_name", "Untitled"),
            "poster_url": item.get("poster_url"),
        }
        for item in title_refs[:4]
    ]


def _derive_current_obsessions_recent(
    db: Session, user_id: UUID, *, days: int = 30, limit: int = 4
) -> list[dict]:
    """"Currently obsessing over" — the copy on the SceneDNA card promises
    titles "living rent-free in your head," which reads as RECENT focus, not
    lifetime top saves. Prior implementation returned the top-4 by cumulative
    interaction weight (never changed unless the user's whole history
    shifted). This version scores per-title weight from interactions in the
    last {days} days only, with recency + explicit-signal boosts, so the rail
    genuinely reflects what the user is engaging with RIGHT NOW.

    Signals used (recency-weighted per SceneDNA brief §27):
      * Save (past N days)          → +6
      * Rating 9-10                 → +8
      * Rating 7-8                  → +4
      * Swipe right in session      → +3
      * Swipe up / "more like this" → +5

    Returns [] when the user has no qualifying recent interactions."""
    from datetime import datetime, timedelta, timezone

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    weights: dict[UUID, float] = defaultdict(float)
    title_index: dict[UUID, ContentTitle] = {}

    saves = db.execute(
        select(WatchlistItem, ContentTitle)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(Watchlist.owner_user_id == user_id, WatchlistItem.created_at >= cutoff)
    ).all()
    for item, title in saves:
        if title is None:
            continue
        weights[title.id] += 6.0
        title_index[title.id] = title

    ratings = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == user_id, Rating.created_at >= cutoff)
    ).all()
    for rating, title in ratings:
        if title is None:
            continue
        score = float(rating.score) if rating.score is not None else 0.0
        if score >= 9:
            weights[title.id] += 8.0
        elif score >= 7:
            weights[title.id] += 4.0
        elif score <= 4:
            weights[title.id] -= 4.0  # a recent bad rating IS a taste signal
        title_index[title.id] = title

    swipes = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == user_id, SwipeRecord.created_at >= cutoff)
    ).all()
    for swipe, title in swipes:
        if title is None:
            continue
        if swipe.direction == "up":
            weights[title.id] += 5.0
        elif swipe.direction == "right":
            weights[title.id] += 3.0
        elif swipe.direction == "left":
            weights[title.id] -= 2.0
        title_index[title.id] = title

    ordered = sorted(
        ((tid, w) for tid, w in weights.items() if w > 0),
        key=lambda pair: pair[1],
        reverse=True,
    )[:limit]

    out: list[dict] = []
    for tid, _ in ordered:
        title = title_index.get(tid)
        if title is None:
            continue
        out.append({
            "title_id": str(title.id),
            "title_name": title.title,
            "poster_url": title.poster_url,
        })
    return out


def _serialize_genres(genre_scores: dict[str, float]) -> list[dict]:
    if not genre_scores:
        return []
    top = sorted(genre_scores.items(), key=lambda item: item[1], reverse=True)[:4]
    max_score = top[0][1] or 1
    return [{"genre": genre, "score": int(round(score / max_score * 100))} for genre, score in top]


def _build_summary(top_genres: list[dict], themes: list[str], labels: list[dict]) -> str | None:
    if not top_genres and not labels:
        return None
    label_text = ", ".join(item["label"] for item in labels[:2])
    genre_text = ", ".join(item["genre"] for item in top_genres[:2])
    theme_text = ", ".join(themes[:2])
    if label_text and theme_text:
        return f"You gravitate toward {label_text.lower()} stories with {theme_text.lower()} energy."
    if genre_text and theme_text:
        return f"You keep coming back to {genre_text.lower()} with a strong pull toward {theme_text.lower()} storytelling."
    if label_text:
        return f"Your taste leans clearly toward {label_text.lower()}."
    return f"Your taste currently centers on {genre_text.lower()}."


def _signal_counts(db: Session, user_id: UUID) -> dict:
    return {
        "ratings": int(db.scalar(select(func.count(Rating.id)).where(Rating.user_id == user_id)) or 0),
        "reviews": int(db.scalar(select(func.count(Review.id)).where(Review.user_id == user_id)) or 0),
        "saves": int(
            db.scalar(
                select(func.count(WatchlistItem.id))
                .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
                .where(Watchlist.owner_user_id == user_id)
            )
            or 0
        ),
        "reactions": int(db.scalar(select(func.count(FeedReaction.id)).where(FeedReaction.user_id == user_id)) or 0),
        "comments": int(db.scalar(select(func.count(FeedComment.id)).where(FeedComment.user_id == user_id)) or 0),
        "swipes": int(db.scalar(select(func.count(SwipeRecord.id)).where(SwipeRecord.user_id == user_id)) or 0),
    }


def _refresh_wrapped_stat(db: Session, user_id: UUID, profile: UserTasteProfile) -> None:
    current_year = datetime.now(timezone.utc).year
    wrapped = db.scalar(select(WrappedStat).where(WrappedStat.user_id == user_id, WrappedStat.year == current_year))
    if wrapped is None:
        wrapped = WrappedStat(user_id=user_id, year=current_year)
        db.add(wrapped)
        db.flush()
    wrapped.top_genre = (profile.top_genres or [{}])[0].get("genre") if profile.top_genres else None
    wrapped.favorite_platform = (profile.top_platforms or [None])[0]
    wrapped.titles_saved = int(profile.signal_counts.get("saves", 0))
    wrapped.reactions_count = int(profile.signal_counts.get("reactions", 0))
    wrapped.top_label = (profile.taste_labels or [{}])[0].get("label") if profile.taste_labels else None
    wrapped.most_saved_title = (profile.current_obsessions or [{}])[0].get("title_name") if profile.current_obsessions else None
    wrapped.stats = {
        "top_themes": profile.top_themes or [],
        "favorite_eras": profile.favorite_eras or [],
        "profile_summary": profile.profile_summary,
    }
    wrapped.updated_at = datetime.now(timezone.utc)


def _is_stale(updated_at: datetime | None, *, hours: int) -> bool:
    if updated_at is None:
        return True
    return (datetime.now(timezone.utc) - updated_at).total_seconds() > hours * 3600


def _prune_old_swipes(db: Session, user_id: UUID, *, keep: int = 500) -> None:
    rows = db.scalars(
        select(SwipeRecord.id)
        .where(SwipeRecord.user_id == user_id)
        .order_by(SwipeRecord.created_at.desc())
        .offset(keep)
    ).all()
    if rows:
        db.execute(delete(SwipeRecord).where(SwipeRecord.id.in_(rows)))


# ─── Phase 2 insight functions ────────────────────────────────────────────────


def get_hot_takes(db: Session, user_id: UUID) -> list[HotTakeResponse]:
    rows = db.execute(
        select(SwipeRecord, ContentTitle)
        .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
        .where(SwipeRecord.user_id == user_id)
        .order_by(SwipeRecord.created_at.desc())
        .limit(150)
    ).all()

    if not rows:
        return []

    liked = [(s, t) for s, t in rows if s.direction in ("right", "up")]
    disliked = [(s, t) for s, t in rows if s.direction == "left"]
    total_liked = max(len(liked), 1)

    takes: list[HotTakeResponse] = []

    rejected_high = [(s, t) for s, t in disliked if t.tmdb_vote_average and float(t.tmdb_vote_average) > 7.5]
    if rejected_high:
        count = len(rejected_high)
        example = rejected_high[0][1].title
        strength = min(int(count / max(len(disliked), 1) * 100), 100)
        takes.append(HotTakeResponse(
            statement=f"You've turned down {count} title{'s' if count > 1 else ''} rated 8+ on TMDB — {example} didn't make the cut. Real contrarian energy.",
            type="contrarian",
            strength=strength,
        ))

    liked_low = [(s, t) for s, t in liked if t.tmdb_vote_average and float(t.tmdb_vote_average) < 6.5]
    if liked_low:
        count = len(liked_low)
        example = liked_low[0][1].title
        strength = min(int(count / total_liked * 100), 100)
        takes.append(HotTakeResponse(
            statement=f"You've championed {count} underrated title{'s' if count > 1 else ''} that most people scroll past — {example} included. You're ahead of the curve.",
            type="hidden_gem",
            strength=strength,
        ))

    genre_counts: Counter[str] = Counter()
    for _, title in liked:
        for genre in _title_genres(title):
            genre_counts[genre] += 1
    if genre_counts:
        top_genre, top_count = genre_counts.most_common(1)[0]
        if top_count >= 3:
            pct = int(top_count / total_liked * 100)
            takes.append(HotTakeResponse(
                statement=f"{pct}% of everything you've liked falls under {top_genre}. You're not a casual fan — you're {top_genre.lower()} built.",
                type="genre_devotee",
                strength=min(pct, 100),
            ))

    liked_high = [(s, t) for s, t in liked if t.tmdb_vote_average and float(t.tmdb_vote_average) > 7.5]
    if liked_high and len(liked_high) / total_liked > 0.6:
        pct = int(len(liked_high) / total_liked * 100)
        takes.append(HotTakeResponse(
            statement=f"{pct}% of your picks are critically acclaimed. You talk like you have niche taste, but you trust the consensus more than you think.",
            type="crowd_pleaser",
            strength=min(pct, 100),
        ))

    return sorted(takes, key=lambda t: t.strength, reverse=True)[:3]


def get_taste_evolution(db: Session, user_id: UUID) -> TasteEvolutionResponse:
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=14)
    prev_start = now - timedelta(days=28)

    def _window_genre_scores(start: datetime, end: datetime) -> Counter[str]:
        scores: Counter[str] = Counter()
        swipe_rows = db.execute(
            select(SwipeRecord, ContentTitle)
            .join(ContentTitle, ContentTitle.id == SwipeRecord.content_title_id)
            .where(
                SwipeRecord.user_id == user_id,
                SwipeRecord.created_at >= start,
                SwipeRecord.created_at < end,
                SwipeRecord.direction.in_(["right", "up"]),
            )
        ).all()
        for swipe, title in swipe_rows:
            weight = int(SWIPE_DIRECTION_WEIGHTS.get(swipe.direction, 1.0))
            for genre in _title_genres(title):
                scores[genre] += weight

        wl_rows = db.execute(
            select(WatchlistItem, ContentTitle)
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
            .where(
                Watchlist.owner_user_id == user_id,
                WatchlistItem.created_at >= start,
                WatchlistItem.created_at < end,
            )
        ).all()
        for _, title in wl_rows:
            for genre in _title_genres(title):
                scores[genre] += 8
        return scores

    current = _window_genre_scores(window_start, now)
    previous = _window_genre_scores(prev_start, window_start)

    if not current and not previous:
        return TasteEvolutionResponse(
            period_label="last 14 days",
            comparison_label="vs previous 14 days",
            shifts=[],
            summary="Not enough data yet to track your taste evolution. Keep swiping.",
            has_data=False,
        )

    all_genres = set(current.keys()) | set(previous.keys())
    current_total = sum(current.values()) or 1
    previous_total = sum(previous.values()) or 1

    shifts: list[GenreShiftResponse] = []
    for genre in all_genres:
        cur_share = current.get(genre, 0) / current_total
        prev_share = previous.get(genre, 0) / previous_total
        delta = cur_share - prev_share
        if abs(delta) < 0.03:
            continue
        shifts.append(GenreShiftResponse(
            genre=genre,
            delta=round(delta * 100, 1),
            direction="rising" if delta > 0 else "falling",
            current_share=round(cur_share * 100, 1),
            previous_share=round(prev_share * 100, 1),
        ))

    shifts.sort(key=lambda s: abs(s.delta), reverse=True)
    shifts = shifts[:5]

    rising = [s.genre for s in shifts if s.direction == "rising"]
    falling = [s.genre for s in shifts if s.direction == "falling"]
    parts: list[str] = []
    if rising:
        parts.append(f"moving toward {' and '.join(rising[:2])}")
    if falling:
        parts.append(f"away from {' and '.join(falling[:2])}")
    summary = f"Your taste is {', '.join(parts)}." if parts else "Your taste profile has been remarkably stable this month."

    return TasteEvolutionResponse(
        period_label="last 14 days",
        comparison_label="vs previous 14 days",
        shifts=shifts,
        summary=summary,
        has_data=bool(shifts),
    )


def get_taste_alignment(db: Session, user_id: UUID, *, limit: int = 5) -> TasteAlignmentResponse:
    following_ids = db.scalars(
        select(UserFollow.following_user_id)
        .join(User, User.id == UserFollow.following_user_id)
        .where(UserFollow.follower_user_id == user_id, User.is_demo.is_(False))
        .limit(50)
    ).all()

    if not following_ids:
        return TasteAlignmentResponse(entries=[], has_data=False)

    my_profile = get_taste_profile(db, user_id)
    my_genres: dict[str, float] = {g["genre"]: float(g["score"]) for g in (my_profile.top_genres or [])}
    if not my_genres:
        return TasteAlignmentResponse(entries=[], has_data=False)

    their_profiles = db.scalars(
        select(UserTasteProfile).where(UserTasteProfile.user_id.in_(following_ids))
    ).all()

    profile_map: dict[UUID, UserProfile] = {
        p.user_id: p
        for p in db.scalars(select(UserProfile).where(UserProfile.user_id.in_(following_ids))).all()
    }

    my_label_set = {lbl["label"] for lbl in (my_profile.taste_labels or [])}

    entries: list[TasteAlignmentEntryResponse] = []
    for taste in their_profiles:
        their_genres: dict[str, float] = {g["genre"]: float(g["score"]) for g in (taste.top_genres or [])}
        if not their_genres:
            continue
        score = _cosine_similarity(my_genres, their_genres)
        shared_genres = sorted(set(my_genres) & set(their_genres), key=lambda g: my_genres.get(g, 0), reverse=True)[:3]
        their_label_set = {lbl["label"] for lbl in (taste.taste_labels or [])}
        shared_labels = sorted(my_label_set & their_label_set)
        user_profile = profile_map.get(taste.user_id)
        if user_profile is None:
            continue
        entries.append(TasteAlignmentEntryResponse(
            user_id=taste.user_id,
            display_name=user_profile.display_name,
            avatar_url=user_profile.avatar_url,
            alignment_score=int(round(score * 100)),
            top_shared_genres=shared_genres,
            shared_label=shared_labels[0] if shared_labels else None,
        ))

    entries.sort(key=lambda e: e.alignment_score, reverse=True)
    return TasteAlignmentResponse(entries=entries[:limit], has_data=bool(entries))


def _cosine_similarity(a: dict[str, float], b: dict[str, float]) -> float:
    keys = set(a) | set(b)
    dot = sum(a.get(k, 0.0) * b.get(k, 0.0) for k in keys)
    mag_a = math.sqrt(sum(v * v for v in a.values()))
    mag_b = math.sqrt(sum(v * v for v in b.values()))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


# ─── SceneDNA unified builder (UX Overhaul brief §3, §7, §8) ─────────────────
# Assembles the canonical SceneDnaResponse from the durable UserTasteProfile
# + live signal counts. Copy is deterministic — no LLM invention — so the
# same taste always produces the same identity string.

# Confidence thresholds are calibrated against typical demo/heavy accounts:
#   strong   → user has clearly declared a taste (35+ signals)
#   emerging → enough to name a leaning but hedge it (10+ signals)
#   early    → any activity below emerging is presented as "early signal"
_SCENEDNA_STRONG_TOTAL = 35
_SCENEDNA_EMERGING_TOTAL = 10
# Cold-start unlock — brief §8 example: "Save 5 titles · Rate 3 · Swipe 10".
_COLDSTART_SAVES_TARGET = 5
_COLDSTART_RATINGS_TARGET = 3
_COLDSTART_SWIPES_TARGET = 10


def _confidence_tier(signal_totals: dict) -> str:
    total = int(signal_totals.get("saves", 0)) + int(signal_totals.get("swipes", 0)) + int(signal_totals.get("ratings", 0))
    if total >= _SCENEDNA_STRONG_TOTAL:
        return "strong"
    if total >= _SCENEDNA_EMERGING_TOTAL:
        return "emerging"
    return "early"


def _is_coldstart(signal_totals: dict) -> bool:
    saves = int(signal_totals.get("saves", 0))
    ratings = int(signal_totals.get("ratings", 0))
    swipes = int(signal_totals.get("swipes", 0))
    return saves < _COLDSTART_SAVES_TARGET and (ratings < _COLDSTART_RATINGS_TARGET or swipes < _COLDSTART_SWIPES_TARGET)


def _scene_dna_archetype(profile: UserTasteProfile) -> tuple[str, str]:
    """Compose a single headline archetype from the strongest declared labels
    or a fallback shaped by top genres. Returns (archetype, one_line)."""
    labels = [lbl.get("label") for lbl in (profile.taste_labels or []) if isinstance(lbl, dict) and lbl.get("label")]
    top_genres = _user_top_genres(profile)
    top_genre_list = sorted(top_genres)[:3] if top_genres else []

    if labels:
        primary = labels[0]
        if len(labels) >= 2 and labels[1] != primary:
            # brief example: "Prestige Drama with a Chaos Streak" — combine
            # primary label with secondary flavor label as a "streak."
            secondary = labels[1]
            archetype = f"{primary} with a {secondary} Streak"
        else:
            archetype = f"{primary} Devotee"
    elif top_genre_list:
        archetype = f"{top_genre_list[0]} Explorer"
    else:
        archetype = "Curious Explorer"

    # One-line explanation, kept short and human. Prefer profile_summary if
    # present (already a full sentence); otherwise synthesize.
    if profile.profile_summary:
        one_line = profile.profile_summary.strip()
    elif labels and top_genre_list:
        one_line = f"Drawn to {labels[0].lower()} storytelling with a {top_genre_list[0].lower()} pull."
    elif top_genre_list:
        one_line = f"Circling {top_genre_list[0].lower()} lately — with room to expand."
    else:
        one_line = "Your taste is still coming into focus."
    return archetype, one_line


def _signal_genre_set(label: str) -> set[str]:
    """Genres that constitute this signal — used to filter the user's actual
    interacted titles down to those that ACTUALLY carry the signal, so
    "Prestige Drama" evidence isn't the same three titles as "Dark Humor"
    evidence. Falls back to the label itself as a genre (works for signals
    whose label is already a plain TMDB genre like "Drama")."""
    rule = LABEL_RULES.get(label)
    if isinstance(rule, dict):
        genres = rule.get("genres")
        if isinstance(genres, dict):
            return {g for g in genres.keys() if isinstance(g, str)}
    # Theme signals — reuse THEME_KEYWORDS which maps themes to genre substrings.
    theme_rule = THEME_KEYWORDS.get(label)
    if isinstance(theme_rule, tuple):
        return {str(t).title() for t in theme_rule}
    # Fallback: assume the label itself IS the genre (e.g. "Drama", "Crime").
    return {label}


def _load_user_interacted_titles(db: Session, user_id: UUID, limit: int = 30) -> list[ContentTitle]:
    """Load the ContentTitle rows for this user's top interactions — saves,
    ratings, right-swipes. Ordered by rating desc + save recency. Used to
    build per-signal evidence lists."""
    # Join across watchlist_items, ratings, and right-swipe records; distinct
    # title ids ordered by max engagement recency. Batched into a single query
    # so we don't do N+1 for the signal evidence lookup.
    from sqlalchemy import union_all, literal

    saves_q = (
        select(WatchlistItem.content_title_id, WatchlistItem.created_at)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.owner_user_id == user_id)
    )
    ratings_q = (
        select(Rating.content_title_id, Rating.created_at)
        .where(Rating.user_id == user_id, Rating.score >= 7)
    )
    swipes_q = (
        select(SwipeRecord.content_title_id, SwipeRecord.created_at)
        .where(
            SwipeRecord.user_id == user_id,
            SwipeRecord.direction.in_(("right", "up")),
        )
    )
    interacted_ids = db.execute(
        union_all(
            saves_q,
            ratings_q,
            swipes_q,
        )
    ).all()
    if not interacted_ids:
        return []
    # Dedupe title_id, keeping most-recent interaction. Load ContentTitle rows.
    latest_by_title: dict[UUID, datetime] = {}
    for tid, ts in interacted_ids:
        if tid is None:
            continue
        prev = latest_by_title.get(tid)
        if prev is None or (ts and ts > prev):
            latest_by_title[tid] = ts
    if not latest_by_title:
        return []
    ordered_ids = sorted(latest_by_title.keys(), key=lambda t: latest_by_title[t], reverse=True)[:limit]
    rows = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(ordered_ids))).all()
    id_index = {r.id: r for r in rows}
    return [id_index[tid] for tid in ordered_ids if tid in id_index]


def _evidence_titles_for_signal(
    label: str,
    interacted: list[ContentTitle],
    limit: int = 3,
    already_used: set[UUID] | None = None,
) -> list[TasteTitleReferenceResponse]:
    """Filter the user's interacted titles down to those that carry the
    signal's genre set. When `already_used` is provided, prefer titles that
    haven't been shown as evidence for a prior signal — so consecutive
    signals feel distinct even when a user's taste is genre-concentrated.
    Falls back to reusing titles when the fresh pool is exhausted."""
    signal_genres = _signal_genre_set(label)
    already_used = already_used or set()
    matches: list[TasteTitleReferenceResponse] = []
    reused_candidates: list[ContentTitle] = []
    for title in interacted:
        title_genres = _title_genres_set(title)
        if not (signal_genres & title_genres):
            continue
        if title.id in already_used:
            reused_candidates.append(title)
            continue
        matches.append(
            TasteTitleReferenceResponse(
                title_id=title.id,
                title_name=title.title,
                poster_url=title.poster_url,
            )
        )
        if len(matches) >= limit:
            return matches
    # Not enough unique matches — top up from already-shown titles so the
    # signal still has evidence. Rotate the reuse pool by hash(label) so
    # different signals showing the same reused corpus at least DISPLAY the
    # titles in a different order (real fix needs a larger interacted
    # corpus — captured under Phase 3 UserSignal task #56).
    if reused_candidates:
        offset = abs(hash(label)) % len(reused_candidates)
        rotated = reused_candidates[offset:] + reused_candidates[:offset]
        for title in rotated:
            matches.append(
                TasteTitleReferenceResponse(
                    title_id=title.id,
                    title_name=title.title,
                    poster_url=title.poster_url,
                )
            )
            if len(matches) >= limit:
                return matches
    return matches


def _scene_dna_signals(
    db: Session,
    user_id: UUID,
    profile: UserTasteProfile,
) -> list[SceneDnaSignalResponse]:
    """Top 3–5 signals grounded in real evidence PER SIGNAL. Per SceneDNA
    Personalization brief §14 + §18: each signal must show its OWN evidence,
    not the same top-3 obsessions for every signal. We now load the user's
    interacted-title corpus once, then filter per signal by genre overlap."""
    out: list[SceneDnaSignalResponse] = []
    interacted = _load_user_interacted_titles(db, user_id, limit=30)
    # Track evidence titles already used by earlier signals so each rail
    # feels visibly distinct (brief §14, §18: signals must show their own
    # evidence). Fresh matches lead; reused ones fill only when needed.
    used_evidence: set[UUID] = set()

    def _confidence_from_score(score: int, ceiling: int = 100) -> str:
        # taste_labels store 0–100 confidence; anything above 60 reads strong,
        # 30–60 emerging, below early.
        if score >= 60:
            return "strong"
        if score >= 30:
            return "emerging"
        return "early"

    def _build_signal(label: str, confidence_score: int, tier: str | None = None) -> SceneDnaSignalResponse:
        signal_evidence = _evidence_titles_for_signal(
            label, interacted, limit=3, already_used=used_evidence
        )
        # Any freshly-selected evidence titles are marked used so the next
        # signal reaches for different ones.
        for t in signal_evidence:
            if t.title_id is not None:
                used_evidence.add(t.title_id)
        return SceneDnaSignalResponse(
            label=label,
            confidence_tier=tier or _confidence_from_score(confidence_score),
            # Evidence count = titles in the user's history that carry this
            # signal, not a made-up denominator. Falls back to normalized
            # taste-label confidence when we can't attribute titles yet.
            evidence_count=len(signal_evidence) if signal_evidence else max(confidence_score // 10, 1),
            contributing_titles=signal_evidence,
        )

    for lbl in profile.taste_labels or []:
        if not isinstance(lbl, dict):
            continue
        label = lbl.get("label")
        if not isinstance(label, str) or not label:
            continue
        confidence = int(lbl.get("confidence") or 0)
        out.append(_build_signal(label, confidence))
        if len(out) >= 5:
            return out

    for theme in profile.top_themes or []:
        if len(out) >= 5:
            break
        label = str(theme)
        if any(sig.label.lower() == label.lower() for sig in out):
            continue
        out.append(_build_signal(label, 40, tier="emerging"))

    for genre_entry in profile.top_genres or []:
        if len(out) >= 5:
            break
        genre_name = genre_entry.get("genre") or genre_entry.get("name") if isinstance(genre_entry, dict) else None
        if not isinstance(genre_name, str) or not genre_name:
            continue
        if any(sig.label.lower() == genre_name.lower() for sig in out):
            continue
        score = int(genre_entry.get("score") or 0) if isinstance(genre_entry, dict) else 0
        out.append(_build_signal(genre_name, score))
    return out[:5]


def _scene_dna_movement(evolution: TasteEvolutionResponse) -> list[SceneDnaMovementResponse]:
    """Convert taste-evolution shifts into the SceneDNA movement schema.
    Only surface material movement (delta magnitude threshold from evolution)
    — the raw shifts list is already sorted by magnitude."""
    out: list[SceneDnaMovementResponse] = []
    for shift in evolution.shifts[:3]:
        # sample_size derives from current_share × total universe; we don't
        # have that exact number here so estimate from delta as a proxy
        # (frontend can show as an approximate count with the detail line).
        sample = max(int(round(shift.current_share * 20)), 1)
        if shift.direction == "up":
            detail = f"{shift.genre} is up — {sample} recent saves, roughly {int(round(shift.current_share * 100))}% of your feed."
            direction = "rising"
        elif shift.direction == "down":
            detail = f"{shift.genre} is fading — down to about {int(round(shift.current_share * 100))}% of your recent saves."
            direction = "fading"
        else:
            detail = f"{shift.genre} entered your top 5 this month."
            direction = "entering_top5"
        out.append(
            SceneDnaMovementResponse(
                direction=direction,
                label=shift.genre,
                sample_size=sample,
                detail=detail,
            )
        )
    return out


def _scene_dna_based_on(signal_totals: dict) -> str:
    """Human-readable freshness / credibility line — brief §4 priority #4."""
    parts: list[str] = []
    saves = int(signal_totals.get("saves", 0))
    swipes = int(signal_totals.get("swipes", 0))
    ratings = int(signal_totals.get("ratings", 0))
    if saves:
        parts.append(f"{saves} save{'s' if saves != 1 else ''}")
    if swipes:
        parts.append(f"{swipes} swipe{'s' if swipes != 1 else ''}")
    if ratings:
        parts.append(f"{ratings} rating{'s' if ratings != 1 else ''}")
    if not parts:
        return "Not enough signal yet"
    return "Based on " + ", ".join(parts)


def _scene_dna_hero_backdrops(
    db: Session,
    profile: UserTasteProfile,
    limit: int = 4,
) -> list[str]:
    """Backdrop collage sourced from titles that actually contributed to the
    DNA (brief §4 priority #2 — data-driven, not decorative).

    Requires REAL landscape backdrops — never a stretched portrait poster.
    Reads the actual `backdrop_url` from ContentTitle for the user's
    current_obsessions so we don't rely on the (frequently null) backdrop
    field stored in the derived taste-profile summary. Silently skips
    titles that have no landscape backdrop rather than falling back to a
    poster."""
    obsession_ids: list[UUID] = []
    for item in (profile.current_obsessions or []):
        if not isinstance(item, dict):
            continue
        tid = item.get("title_id")
        if not tid:
            continue
        try:
            obsession_ids.append(UUID(str(tid)))
        except (ValueError, TypeError):
            continue

    urls: list[str] = []
    if obsession_ids:
        rows = db.scalars(
            select(ContentTitle).where(ContentTitle.id.in_(obsession_ids))
        ).all()
        # Preserve original weight-desc order.
        by_id = {r.id: r for r in rows}
        for tid in obsession_ids:
            row = by_id.get(tid)
            if row is None or not row.backdrop_url:
                continue
            if row.backdrop_url not in urls:
                urls.append(row.backdrop_url)
            if len(urls) >= limit:
                return urls
    return urls


def _scene_dna_signals_from_user_signals(
    db: Session,
    user_id: UUID,
) -> list[SceneDnaSignalResponse]:
    """Read pre-computed UserSignal rows and translate into the SceneDNA
    response shape. Preferred over the legacy taste_labels derivation
    because UserSignal carries per-signal contributing titles (positive_evidence).
    Returns [] when no signals exist so callers can fall back."""
    from app.models.taste import UserSignal as _UserSignal

    # Prioritize label + theme signals for the Strongest Signals rail — they
    # read more human than raw genre. Genre signals are still available via
    # /me/scene-dna/signals/{name} for the detail drawer.
    rows = db.scalars(
        select(_UserSignal)
        .where(_UserSignal.user_id == user_id, _UserSignal.signal_type.in_(("label", "theme", "genre")))
        .order_by(_UserSignal.score.desc())
        .limit(15)
    ).all()
    if not rows:
        return []

    # De-dupe by signal_name in case label+theme collide. Also track titles
    # already used as evidence so consecutive signal cards show DIFFERENT
    # posters even when signals share overlapping positive_evidence lists
    # (heavy users have many drama titles that ground multiple label signals).
    seen_names: set[str] = set()
    used_titles: set[UUID] = set()
    out: list[SceneDnaSignalResponse] = []
    for r in rows:
        name = r.signal_name
        if name in seen_names:
            continue
        seen_names.add(name)
        # Load candidate titles from positive_evidence; prefer titles that
        # haven't already been used as evidence for a prior signal card.
        candidate_ids: list[UUID] = []
        for tid_str in (r.positive_evidence or [])[:12]:
            try:
                candidate_ids.append(UUID(str(tid_str)))
            except (ValueError, TypeError):
                continue
        titles = (
            db.scalars(select(ContentTitle).where(ContentTitle.id.in_(candidate_ids))).all()
            if candidate_ids
            else []
        )
        # Preserve the original positive_evidence order so highest-weighted
        # titles surface first.
        title_index = {t.id: t for t in titles}
        ordered_titles = [title_index[tid] for tid in candidate_ids if tid in title_index]

        # Pick up to 3 titles: fresh (unused) first, then reused as needed.
        fresh: list[ContentTitle] = []
        reused: list[ContentTitle] = []
        for t in ordered_titles:
            if t.id in used_titles:
                reused.append(t)
            else:
                fresh.append(t)
        picked = (fresh + reused)[:3]
        for t in picked:
            used_titles.add(t.id)

        contributing = [
            TasteTitleReferenceResponse(
                title_id=t.id,
                title_name=t.title,
                poster_url=t.poster_url,
            )
            for t in picked
        ]
        out.append(
            SceneDnaSignalResponse(
                label=name,
                confidence_tier=r.confidence_tier,
                evidence_count=len(r.positive_evidence or []),
                contributing_titles=contributing,
            )
        )
        if len(out) >= 5:
            break
    return out


def build_scene_dna_response(db: Session, user_id: UUID) -> SceneDnaResponse:
    """Assemble the canonical SceneDNA response per brief §3 IA. Always
    returns a coherent object; cold-start users get the meter instead of a
    fabricated identity."""
    profile = get_taste_profile(db, user_id, force_refresh=True)
    signal_totals = _signal_counts(db, user_id)

    if _is_coldstart(signal_totals):
        saves = int(signal_totals.get("saves", 0))
        ratings = int(signal_totals.get("ratings", 0))
        swipes = int(signal_totals.get("swipes", 0))
        if saves < _COLDSTART_SAVES_TARGET:
            hint = f"Save {_COLDSTART_SAVES_TARGET - saves} more title{'s' if _COLDSTART_SAVES_TARGET - saves != 1 else ''} to start shaping your DNA."
        elif ratings < _COLDSTART_RATINGS_TARGET:
            hint = f"Rate {_COLDSTART_RATINGS_TARGET - ratings} more thing{'s' if _COLDSTART_RATINGS_TARGET - ratings != 1 else ''} — how you felt matters."
        else:
            hint = f"Try {_COLDSTART_SWIPES_TARGET - swipes} more swipe{'s' if _COLDSTART_SWIPES_TARGET - swipes != 1 else ''} to unlock your first snapshot."
        return SceneDnaResponse(
            identity=None,
            signals=[],
            movement=[],
            has_signal=False,
            cold_start=SceneDnaColdStartResponse(
                saves_current=saves,
                saves_target=_COLDSTART_SAVES_TARGET,
                ratings_current=ratings,
                ratings_target=_COLDSTART_RATINGS_TARGET,
                swipes_current=swipes,
                swipes_target=_COLDSTART_SWIPES_TARGET,
                next_action_hint=hint,
            ),
        )

    archetype, one_line = _scene_dna_archetype(profile)
    identity = SceneDnaIdentityResponse(
        archetype=archetype,
        one_line=one_line,
        confidence_tier=_confidence_tier(signal_totals),
        updated_at=profile.updated_at,
        based_on_summary=_scene_dna_based_on(signal_totals),
        hero_backdrops=_scene_dna_hero_backdrops(db, profile),
    )

    # Prefer first-class UserSignal rows when they exist (SceneDNA brief §15).
    # Falls back to the legacy derivation for accounts before the intelligence
    # foundation landed. UserSignal path has per-signal evidence + tier + trend.
    signals = _scene_dna_signals_from_user_signals(db, user_id) or _scene_dna_signals(db, user_id, profile)
    try:
        evolution = get_taste_evolution(db, user_id)
        movement = _scene_dna_movement(evolution)
    except Exception:
        movement = []

    return SceneDnaResponse(
        identity=identity,
        signals=signals,
        movement=movement,
        has_signal=True,
        cold_start=None,
    )
