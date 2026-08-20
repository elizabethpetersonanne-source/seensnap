"""TitleFeatures — semantic metadata layer per SceneDNA brief §7 + §8.

Two enrichment stages:
  v0 (this pass) — deterministic derivation from TMDB metadata: genre, keyword
                   tokens, runtime, popularity. No LLM calls; runs on every
                   title we encounter. Good enough for mood-rail overlap
                   matching ("Dark & Cinematic" needs `tone contains 'dark'
                   AND visual_style contains 'cinematic'`).
  v1 (deferred)  — LLM-enriched. `enrich_with_llm(title)` is stubbed here;
                   plug in an OpenAI/Anthropic call to upgrade features.
                   Enrichment_version bumps so we can distinguish rows.

Controlled vocabularies live in this file so scoring elsewhere can compute
deterministic overlap. Never introduce free-text tags — every value must be
in the approved set.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.taste import TitleFeatures


# ─── Controlled vocabularies (brief §7) ──────────────────────────────────────

TONE_VOCAB = {
    "dark", "melancholic", "whimsical", "unsettling", "hopeful",
    "comforting", "irreverent", "cynical", "sentimental", "tense",
    "hyped", "warm",
}

PACING_VOCAB = {"slow", "medium", "propulsive"}

STORY_STYLE_VOCAB = {
    "character-driven", "plot-driven", "ensemble", "coming-of-age",
    "unreliable-narrator", "morally-ambiguous", "relationship-focused",
    "procedural", "mystery-box",
}

VISUAL_STYLE_VOCAB = {
    "atmospheric", "highly-stylized", "minimalist", "period", "surreal",
    "cinematic", "intimate",
}

VIEWING_CONTEXT_VOCAB = {
    "date-night", "background-comfort", "prestige-binge", "family",
    "late-night", "emotionally-heavy", "easy-watch", "movie-night",
}

# TMDB genre → tone hints. Multi-mapping — Drama can be dark OR hopeful; the
# derivation combines genre + keywords + rating for the final read.
GENRE_TONE_HINTS: dict[str, list[str]] = {
    "Horror": ["dark", "unsettling", "tense"],
    "Thriller": ["dark", "tense"],
    "Crime": ["dark", "tense", "cynical"],
    "Mystery": ["tense", "unsettling"],
    "Drama": ["melancholic"],
    "Romance": ["sentimental", "hopeful"],
    "Comedy": ["irreverent", "comforting"],
    "Family": ["comforting", "warm"],
    "Animation": ["warm", "whimsical"],
    "Adventure": ["hopeful"],
    "Action": ["tense", "hyped"],
    "Science Fiction": ["unsettling"],
    "Fantasy": ["whimsical", "hopeful"],
    "War": ["dark", "melancholic"],
    "Documentary": ["cynical"],
    "History": ["melancholic"],
}

GENRE_VISUAL_HINTS: dict[str, list[str]] = {
    "Horror": ["atmospheric", "highly-stylized"],
    "Thriller": ["atmospheric", "cinematic"],
    "Crime": ["cinematic", "atmospheric"],
    "Drama": ["intimate", "cinematic"],
    "Romance": ["intimate"],
    "Science Fiction": ["highly-stylized", "cinematic"],
    "Fantasy": ["highly-stylized"],
    "War": ["cinematic"],
    "Animation": ["highly-stylized"],
    "Comedy": ["minimalist"],
    "Family": ["minimalist"],
    "History": ["period"],
    "Western": ["cinematic", "period"],
}

GENRE_STORY_HINTS: dict[str, list[str]] = {
    "Drama": ["character-driven"],
    "Romance": ["relationship-focused", "character-driven"],
    "Crime": ["morally-ambiguous", "procedural"],
    "Thriller": ["plot-driven"],
    "Mystery": ["mystery-box", "plot-driven"],
    "Horror": ["plot-driven"],
    "Comedy": ["ensemble"],
    "Action": ["plot-driven"],
    "War": ["ensemble"],
    "Documentary": ["plot-driven"],
    "Family": ["ensemble"],
}

# Keyword tokens → tone/theme overrides. Applied on top of genre hints.
KEYWORD_TONE_OVERRIDES: dict[str, list[str]] = {
    "grief": ["melancholic", "sentimental"],
    "loss": ["melancholic"],
    "family": ["warm", "sentimental"],
    "hopeful": ["hopeful"],
    "dark comedy": ["dark", "irreverent"],
    "cult": ["cynical"],
    "coming of age": ["hopeful", "sentimental"],
    "slow burn": ["tense"],
    "psychological": ["unsettling"],
    "atmospheric": ["unsettling"],
    "revenge": ["dark", "tense"],
    "heartwarming": ["warm", "hopeful"],
    "wholesome": ["warm", "comforting"],
    "sad": ["melancholic"],
}


# ─── Derivation helpers ──────────────────────────────────────────────────────


def _title_keywords(title: ContentTitle) -> list[str]:
    """TMDB keywords are stored under metadata_raw.keywords depending on
    endpoint. Normalize into a lowercase token list; empty when missing."""
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    keywords_field = meta.get("keywords") or meta.get("Keywords") or {}
    if isinstance(keywords_field, dict):
        # TMDB shape: {"keywords": [{"id": .., "name": ".."}, ...]}
        items = keywords_field.get("keywords") or keywords_field.get("results") or []
    elif isinstance(keywords_field, list):
        items = keywords_field
    else:
        items = []
    out: list[str] = []
    for item in items:
        if isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str):
                out.append(name.lower())
        elif isinstance(item, str):
            out.append(item.lower())
    return out


def _title_runtime_minutes(title: ContentTitle) -> int | None:
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    runtime = meta.get("runtime")
    if isinstance(runtime, (int, float)):
        return int(runtime)
    # TV shows expose episode_run_time as a list.
    ert = meta.get("episode_run_time")
    if isinstance(ert, list) and ert:
        first = ert[0]
        if isinstance(first, (int, float)):
            return int(first)
    return None


def _derive_pacing(title: ContentTitle, keywords: list[str]) -> str | None:
    """Fast heuristic. Runtime alone isn't determinative for TV, so we blend
    with keyword hints when available."""
    if "slow burn" in keywords or "atmospheric" in keywords:
        return "slow"
    if "action-packed" in keywords or "fast-paced" in keywords or "propulsive" in keywords:
        return "propulsive"
    runtime = _title_runtime_minutes(title)
    if runtime is None:
        return None
    if runtime <= 95:
        return "propulsive"
    if runtime >= 140:
        return "slow"
    return "medium"


def _derive_comfort_level(title: ContentTitle, tones: set[str], genres: set[str]) -> Decimal | None:
    """0.0 = intense/dark, 1.0 = comfort food. Multi-signal blend."""
    # Base from genre.
    if genres & {"Horror", "Thriller", "War", "Crime"}:
        base = 0.15
    elif genres & {"Family", "Animation", "Comedy"}:
        base = 0.80
    elif genres & {"Romance", "Adventure", "Fantasy"}:
        base = 0.60
    elif genres & {"Drama", "Documentary"}:
        base = 0.40
    else:
        base = 0.50
    # Tone nudges.
    if "comforting" in tones or "warm" in tones:
        base = min(base + 0.15, 1.0)
    if "dark" in tones or "unsettling" in tones or "tense" in tones:
        base = max(base - 0.20, 0.0)
    return Decimal(f"{base:.2f}")


def _derive_viewing_contexts(comfort: Decimal | None, tones: set[str], runtime: int | None) -> list[str]:
    contexts: set[str] = set()
    if comfort is not None:
        c = float(comfort)
        if c >= 0.7:
            contexts.add("background-comfort")
            contexts.add("easy-watch")
        if c >= 0.55 and runtime and runtime <= 110:
            contexts.add("date-night")
        if c <= 0.3:
            contexts.add("emotionally-heavy")
    if "dark" in tones or "unsettling" in tones:
        contexts.add("late-night")
    if runtime and runtime >= 120:
        contexts.add("movie-night")
    return sorted(contexts)


def _resolve_genres(title: ContentTitle) -> set[str]:
    """Genre resolution with a fallback for titles that only carry TMDB
    `genre_ids` (early-imported rows). TMDB genre IDs are stable public
    constants — we can map the top ones without an API call."""
    from app.services.taste import _title_genres_set

    resolved = _title_genres_set(title)
    if resolved:
        return resolved

    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    ids = meta.get("genre_ids")
    if not isinstance(ids, list):
        return set()
    # TMDB genre IDs — movies + tv unified. Public constants.
    id_map: dict[int, str] = {
        28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
        80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
        14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
        9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
        10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
        10759: "Action & Adventure", 10762: "Kids", 10763: "News",
        10764: "Reality", 10765: "Science Fiction", 10766: "Soap",
        10767: "Talk", 10768: "War & Politics",
    }
    out: set[str] = set()
    for gid in ids:
        if isinstance(gid, int) and gid in id_map:
            out.add(id_map[gid])
    return out


def derive_features_from_tmdb(title: ContentTitle) -> dict:
    """v0 enrichment — deterministic derivation from TMDB metadata. Returns a
    dict matching the TitleFeatures schema. No LLM call; runs cheaply on any
    title. `_signal_names_for_title` in user_signals.py already reads similar
    fields, so this stays consistent with signal computation."""
    genres = _resolve_genres(title)
    keywords = _title_keywords(title)

    tones: set[str] = set()
    for g in genres:
        for t in GENRE_TONE_HINTS.get(g, []):
            tones.add(t)
    for kw in keywords:
        for t in KEYWORD_TONE_OVERRIDES.get(kw, []):
            tones.add(t)
    # Clamp to controlled vocab.
    tones &= TONE_VOCAB

    visual_style: set[str] = set()
    for g in genres:
        for v in GENRE_VISUAL_HINTS.get(g, []):
            visual_style.add(v)
    visual_style &= VISUAL_STYLE_VOCAB

    story_style: set[str] = set()
    for g in genres:
        for s in GENRE_STORY_HINTS.get(g, []):
            story_style.add(s)
    story_style &= STORY_STYLE_VOCAB

    pacing = _derive_pacing(title, keywords)
    if pacing not in PACING_VOCAB:
        pacing = None

    runtime = _title_runtime_minutes(title)
    comfort = _derive_comfort_level(title, tones, genres)
    viewing_context = _derive_viewing_contexts(comfort, tones, runtime)

    # Themes = intersection of keywords with what we consider first-class
    # thematic tokens. Kept small and stable so downstream matching is robust.
    themes: set[str] = set()
    for kw in keywords:
        if kw in {"grief", "loss", "family", "coming of age", "identity", "revenge", "isolation"}:
            themes.add(kw)

    return {
        "tone": sorted(tones),
        "pacing": pacing,
        "story_style": sorted(story_style),
        "themes": sorted(themes),
        "visual_style": sorted(visual_style),
        "viewing_context": viewing_context,
        "comfort_level": comfort,
        "embedding": None,
        "source": "tmdb_v0",
        "enrichment_version": 0,
        "enriched_at": datetime.now(timezone.utc),
    }


def enrich_with_llm(title: ContentTitle) -> dict | None:
    """v1 enrichment — placeholder. Wire this to a real LLM provider when
    the API key + budget are approved. Contract:
      - INPUT: title.title + title.overview + TMDB genres + keywords + cast[:5]
      - OUTPUT: same dict shape as `derive_features_from_tmdb`, but with
        richer tone/story_style/themes (LLM can pick up on nuance the
        heuristic misses).
      - REJECT anything outside the controlled vocabularies (post-validate
        the LLM response against *_VOCAB sets before persisting).
    Returns None when no LLM is configured — callers fall through to v0."""
    return None


def ensure_title_features(
    db: Session, title_id: UUID, *, force_refresh: bool = False
) -> TitleFeatures | None:
    """Return TitleFeatures for a title, deriving cheaply from TMDB metadata
    on first access. Idempotent — subsequent reads hit the cache."""
    existing = db.scalar(
        select(TitleFeatures).where(TitleFeatures.content_title_id == title_id)
    )
    if existing is not None and not force_refresh:
        return existing

    title = db.scalar(select(ContentTitle).where(ContentTitle.id == title_id))
    if title is None:
        return None

    # Prefer LLM enrichment when available; fall back to v0.
    payload = enrich_with_llm(title) or derive_features_from_tmdb(title)

    if existing is None:
        row = TitleFeatures(content_title_id=title_id, **payload)
        db.add(row)
    else:
        for key, value in payload.items():
            setattr(existing, key, value)
        row = existing
    db.commit()
    db.refresh(row)
    return row


def bulk_derive_features(db: Session, title_ids: list[UUID]) -> int:
    """Batch-derive v0 features for a list of titles. Skips those already
    cached. Returns the count of freshly-derived rows. Intended for backfill
    of the existing content_titles corpus."""
    if not title_ids:
        return 0
    existing_ids = set(
        db.scalars(
            select(TitleFeatures.content_title_id).where(TitleFeatures.content_title_id.in_(title_ids))
        ).all()
    )
    missing = [tid for tid in title_ids if tid not in existing_ids]
    if not missing:
        return 0
    titles = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(missing))).all()
    count = 0
    for title in titles:
        payload = derive_features_from_tmdb(title)
        db.add(TitleFeatures(content_title_id=title.id, **payload))
        count += 1
    db.commit()
    return count


def match_titles_by_features(
    db: Session,
    *,
    tone_any: set[str] | None = None,
    visual_style_any: set[str] | None = None,
    pacing: str | None = None,
    story_style_any: set[str] | None = None,
    viewing_context_any: set[str] | None = None,
    comfort_min: float | None = None,
    comfort_max: float | None = None,
    exclude: set[UUID] | None = None,
    limit: int = 200,
) -> list[TitleFeatures]:
    """Query TitleFeatures for titles matching mood/tone criteria. Uses
    JSONB containment (@>) for exact-membership tests. Callers can further
    personal-rank the returned rows against the user's UserSignal scores."""
    # JSONB "any of" is expressed with a chained OR of `@>` containment
    # tests: `tone @> '["dark"]' OR tone @> '["cinematic"]'`. `type_coerce`
    # tells SQLAlchemy to bind the RHS as JSONB (not text or JSON-as-text)
    # — this is the only form that actually round-trips correctly through
    # psycopg for the containment operator.
    from sqlalchemy import and_, or_, type_coerce
    from sqlalchemy.dialects.postgresql import JSONB as SA_JSONB

    query = select(TitleFeatures)
    conds = []

    def _any_of(column, values: set[str]):
        clauses = [column.op("@>")(type_coerce([v], SA_JSONB)) for v in values]
        return or_(*clauses) if clauses else None

    for column, values in (
        (TitleFeatures.tone, tone_any),
        (TitleFeatures.visual_style, visual_style_any),
        (TitleFeatures.story_style, story_style_any),
        (TitleFeatures.viewing_context, viewing_context_any),
    ):
        if values:
            clause = _any_of(column, values)
            if clause is not None:
                conds.append(clause)
    if pacing is not None:
        conds.append(TitleFeatures.pacing == pacing)
    if comfort_min is not None:
        conds.append(TitleFeatures.comfort_level >= Decimal(f"{comfort_min:.2f}"))
    if comfort_max is not None:
        conds.append(TitleFeatures.comfort_level <= Decimal(f"{comfort_max:.2f}"))
    if exclude:
        conds.append(~TitleFeatures.content_title_id.in_(exclude))

    if conds:
        query = query.where(and_(*conds))
    query = query.limit(limit)
    return list(db.scalars(query).all())
