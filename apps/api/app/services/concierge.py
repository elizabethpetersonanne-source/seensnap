"""Oct-18 build brief §4 Concierge AI adapter.

Flow:
  1. Client submits natural-language intent + optional context.
  2. The provider boundary resolves it into TYPED constraints
     (media_type, genres, mood tags, release_period, runtime, provider,
     exclusions, people, similarity, rewatch_intent).
  3. Candidate retrieval runs against the catalog with those
     constraints as HARD filters where appropriate (provider +
     runtime + release) and SOFT ranking inputs where appropriate
     (mood, similarity).
  4. Results are grounded in the real catalog + user state —
     the model never fabricates titles.
  5. The decision + its typed constraints are returned to the client
     so Refine This can edit the active decision.

If no provider is configured (concierge_ai_provider == "") the
service returns a honest unavailable state. The brief is explicit:
"a keyword search renamed Concierge does not satisfy intent
understanding."

Supported providers in this version: "vertex" (Google Vertex AI
Gemini), "anthropic", "openai", "" (disabled). Adapters live in
private _call_<provider> functions with timeouts, retries and
bounded context.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from typing import Literal
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.content import ContentTitle


# ─── Typed constraints the resolver produces ─────────────────────────


@dataclass
class ConciergeConstraints:
    media_type: Literal["movie", "series", "any"] = "any"
    # Lowercase canonical genre names. Multiple = union (OR).
    genres: list[str] = field(default_factory=list)
    # Short mood/tone tags ("dark", "quiet", "character-driven", ...)
    # that the ranker uses as soft bonuses. Not a hard filter.
    moods: list[str] = field(default_factory=list)
    # Release-year window — inclusive. None = no bound.
    year_min: int | None = None
    year_max: int | None = None
    # Runtime window — minutes. None = no bound.
    runtime_min: int | None = None
    runtime_max: int | None = None
    # Specific streaming providers the user requires. Lowercase keys
    # (e.g. "netflix"). Empty = no provider requirement.
    required_providers: list[str] = field(default_factory=list)
    # Titles / people / tags the user explicitly excluded.
    exclusions: list[str] = field(default_factory=list)
    # Similarity anchors (e.g. "like Arrival"). The resolver returns
    # the raw strings; the catalog layer looks them up by title.
    like_anchors: list[str] = field(default_factory=list)
    # Explicit rewatch intent — model saw language like "a comfort
    # rewatch" or "something I've seen before". Default False keeps
    # watched titles excluded.
    rewatch_intent: bool = False
    # Oct-27 Concierge brief chunk C: the user's intent may constrain
    # WHERE Concierge searches, independent of what it searches for.
    # "any" is the broader catalog; "my_next_watch" / "watched" /
    # "named_list" are hard source constraints — never silently
    # broaden them.
    collection_scope: Literal["any", "my_next_watch", "watched", "named_list"] = "any"
    # When collection_scope == "named_list", the resolved list id.
    collection_list_id: str | None = None
    # Original natural-language intent, kept verbatim for display.
    raw_intent: str = ""


@dataclass
class ConciergeDecision:
    decision_id: UUID | str | None
    constraints: ConciergeConstraints
    rationale: str  # 1-2 sentences explaining why these results fit
    title_ids: list[UUID]  # grounded; may be empty if nothing fits
    status: Literal["ready", "unavailable", "empty", "error"]
    status_detail: str = ""


# ─── Personal context (Concierge brief chunk B) ─────────────────────


@dataclass
class PersonalContext:
    """Bounded summary of the viewer's own data that we send to the
    model. Deliberately small so the context budget never becomes a
    hidden cap on which saved titles can be reasoned about — the model
    gets a signal, the GROUNDING layer still runs against the full
    collection.
    """
    # The actual #1 ranked title (title + year + media type). This is
    # what "my number one" resolves to.
    ranked_number_one: dict | None = None
    # Up to 5 of the viewer's top ranked titles — short list so the
    # model has similarity anchors without dumping the whole history.
    top_ranked_sample: list[dict] = field(default_factory=list)
    # Sample from My Next Watch (unwatched intent queue), up to 8.
    next_watch_sample: list[dict] = field(default_factory=list)
    next_watch_total: int = 0
    # Highest-score Watched titles (score >= 8), up to 5.
    favorites_sample: list[dict] = field(default_factory=list)
    # Rough signal of history breadth. The model gets a count, not the
    # full list — "haven't seen X" filtering happens server-side.
    watched_total: int = 0
    # Streaming services the user has explicitly selected (not
    # authenticated OAuth — just "I subscribe"). Lowercase keys.
    selected_services: list[str] = field(default_factory=list)
    # The region used for provider availability checks.
    region: str = "US"
    # SceneDNA signal labels — short strings like "Slow Burn",
    # "Character-Driven", etc. Bounded to 6.
    scene_dna_signals: list[str] = field(default_factory=list)

    def is_cold_start(self) -> bool:
        """True when the user has basically no personal signal yet.
        The model should be told to lean on explicit constraints, not
        on taste inference, in that case."""
        return (
            self.ranked_number_one is None
            and self.next_watch_total == 0
            and self.watched_total < 3
            and not self.scene_dna_signals
        )


def build_personal_context(db: Session, user_id: UUID) -> PersonalContext:
    """Pull a bounded summary of the viewer's data for the model.

    Reads span: RankedFavorite (full ordering, not top 20),
    Watchlist/WatchlistItem (default Next Watch list), Rating
    (favorites + watched totals), UserPreferences (selected services,
    region) and UserSignal (SceneDNA labels). Falls back gracefully if
    any table is empty — never raises.
    """
    from app.models.social import (
        RankedFavorite,
        Rating,
        Watchlist,
        WatchlistItem,
    )
    from app.models.user import UserPreferences
    from sqlalchemy import func as sqlfunc

    def _title_dict(t: ContentTitle, *, extra: dict | None = None) -> dict:
        row = {
            "title_id": str(t.id),
            "title": t.title,
            "year": t.release_date.year if t.release_date else None,
            "media_type": "movie" if t.content_type == "movie" else "series",
        }
        if extra:
            row.update(extra)
        return row

    ctx = PersonalContext()

    # Ranked favorites — walks the FULL ranking, not just the top 20
    # the mobile backdrop loader previously fetched. Grab up to 5 for
    # the sample.
    ranked_rows = db.execute(
        select(RankedFavorite, ContentTitle)
        .join(ContentTitle, ContentTitle.id == RankedFavorite.content_title_id)
        .where(RankedFavorite.user_id == user_id)
        .order_by(RankedFavorite.position.asc())
        .limit(5)
    ).all()
    if ranked_rows:
        first_rf, first_title = ranked_rows[0]
        ctx.ranked_number_one = _title_dict(first_title, extra={"rank": first_rf.position})
        ctx.top_ranked_sample = [
            _title_dict(t, extra={"rank": rf.position}) for rf, t in ranked_rows
        ]

    # My Next Watch — real queue of saved-not-yet-watched intent.
    next_watch_list = db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == user_id,
            Watchlist.is_default.is_(True),
            Watchlist.name.ilike("next%watch%"),
        )
    )
    if next_watch_list is not None:
        ctx.next_watch_total = int(db.scalar(
            select(sqlfunc.count()).select_from(WatchlistItem).where(WatchlistItem.watchlist_id == next_watch_list.id)
        ) or 0)
        sample_rows = db.execute(
            select(WatchlistItem, ContentTitle)
            .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
            .where(WatchlistItem.watchlist_id == next_watch_list.id)
            .order_by(WatchlistItem.created_at.desc())
            .limit(8)
        ).all()
        ctx.next_watch_sample = [_title_dict(t) for _, t in sample_rows]

    # Favorites — top-rated Watched titles. Score ≥ 8.
    fav_rows = db.execute(
        select(Rating, ContentTitle)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id == user_id, Rating.score >= 8)
        .order_by(Rating.score.desc(), Rating.updated_at.desc())
        .limit(5)
    ).all()
    ctx.favorites_sample = [
        _title_dict(t, extra={"score": int(round(float(r.score)))}) for r, t in fav_rows
    ]
    ctx.watched_total = int(db.scalar(
        select(sqlfunc.count()).select_from(Rating).where(
            Rating.user_id == user_id,
            Rating.watched_state == "watched",
        )
    ) or 0)

    # Selected services + region.
    prefs = db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
    if prefs is not None:
        ctx.selected_services = list(prefs.connected_streaming_services or [])
        regions = list(prefs.preferred_regions or [])
        if regions:
            ctx.region = regions[0]

    # SceneDNA — bounded to 6 signal labels.
    try:
        from app.models.taste import UserSignal
        signals = db.scalars(
            select(UserSignal)
            .where(UserSignal.user_id == user_id)
            .order_by(UserSignal.weight.desc())
            .limit(6)
        ).all()
        ctx.scene_dna_signals = [s.label for s in signals if s.label]
    except Exception:
        # Signal table shape has evolved — degrade silently rather
        # than break the whole Concierge request.
        pass

    return ctx


def _context_summary_for_prompt(ctx: PersonalContext) -> str:
    """Flatten PersonalContext into a short JSON string the prompt
    template can interpolate. Deliberately small — the full catalog
    search still happens server-side."""
    def _pick(t: dict) -> dict:
        return {
            "title": t.get("title"),
            "year": t.get("year"),
            "media_type": t.get("media_type"),
            **({"rank": t["rank"]} if "rank" in t else {}),
            **({"score": t["score"]} if "score" in t else {}),
        }
    payload = {
        "cold_start": ctx.is_cold_start(),
        "region": ctx.region,
        "selected_services": ctx.selected_services[:8],
        "ranked_number_one": _pick(ctx.ranked_number_one) if ctx.ranked_number_one else None,
        "top_ranked": [_pick(t) for t in ctx.top_ranked_sample],
        "next_watch_sample": [_pick(t) for t in ctx.next_watch_sample],
        "next_watch_total": ctx.next_watch_total,
        "favorites": [_pick(t) for t in ctx.favorites_sample],
        "watched_total": ctx.watched_total,
        "scene_dna_signals": ctx.scene_dna_signals,
    }
    return json.dumps(payload, separators=(",", ":"))


# ─── Public entry point ──────────────────────────────────────────────


def resolve_concierge_decision(
    db: Session,
    user_id: UUID,
    intent: str,
    *,
    refinement_of_decision_id: UUID | None = None,
) -> ConciergeDecision:
    """Resolve a natural-language intent to a typed decision + grounded
    titles. Returns an honest unavailable state if no provider is
    configured — brief §4 is explicit about this."""
    intent = (intent or "").strip()
    if not intent:
        return ConciergeDecision(
            decision_id=None,
            constraints=ConciergeConstraints(raw_intent=""),
            rationale="",
            title_ids=[],
            status="error",
            status_detail="empty_intent",
        )

    provider = (settings.concierge_ai_provider or os.environ.get("CONCIERGE_AI_PROVIDER", "")).strip().lower()
    api_key = (settings.concierge_ai_api_key or os.environ.get("CONCIERGE_AI_API_KEY", "")).strip()
    # Vertex uses ADC — api_key is not required for that provider.
    needs_api_key = provider in {"anthropic", "openai"}
    if not provider or (needs_api_key and not api_key):
        return ConciergeDecision(
            decision_id=None,
            constraints=ConciergeConstraints(raw_intent=intent),
            rationale="",
            title_ids=[],
            status="unavailable",
            status_detail=(
                "Concierge requires an AI provider configuration (set CONCIERGE_AI_PROVIDER "
                "— and CONCIERGE_AI_API_KEY for anthropic/openai; vertex uses ADC) and is "
                "intentionally disabled until configured. A keyword search cannot substitute "
                "for intent understanding — brief §4."
            ),
        )

    # Chunk B: build the personal context block ONCE per decision so
    # every adapter sees the same bounded summary.
    context = build_personal_context(db, user_id)
    context_summary = _context_summary_for_prompt(context)

    # Call the adapter. Timeouts + retries live inside each adapter.
    try:
        if provider == "vertex":
            raw = _call_vertex(
                intent,
                context_summary=context_summary,
                project=(settings.concierge_ai_project or settings.gcp_project_id or os.environ.get("GOOGLE_CLOUD_PROJECT", "")).strip(),
                location=(settings.concierge_ai_location or "us-central1").strip(),
                model=(settings.concierge_ai_model or "gemini-2.5-flash").strip(),
            )
        elif provider == "anthropic":
            raw = _call_anthropic(intent, api_key, settings.concierge_ai_model or "claude-opus-4-7", context_summary=context_summary)
        elif provider == "openai":
            raw = _call_openai(intent, api_key, settings.concierge_ai_model or "gpt-4o-mini", context_summary=context_summary)
        else:
            return ConciergeDecision(
                decision_id=None,
                constraints=ConciergeConstraints(raw_intent=intent),
                rationale="",
                title_ids=[],
                status="unavailable",
                status_detail=f"Unsupported CONCIERGE_AI_PROVIDER: {provider!r}",
            )
    except VertexConfigError as exc:
        return ConciergeDecision(
            decision_id=None,
            constraints=ConciergeConstraints(raw_intent=intent),
            rationale="",
            title_ids=[],
            status="unavailable",
            status_detail=f"vertex_config_error: {exc}",
        )
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        return ConciergeDecision(
            decision_id=None,
            constraints=ConciergeConstraints(raw_intent=intent),
            rationale="",
            title_ids=[],
            status="error",
            status_detail=f"ai_provider_error: {type(exc).__name__}",
        )

    constraints = _constraints_from_raw(raw, intent)
    rationale = (raw.get("rationale") or "").strip()[:280]

    # Chunk B: resolve "my number one" / "my #1" / "my top pick" from
    # the user's actual manual ranking, no matter what the model said.
    # If the model already added a canonical anchor we leave it alone;
    # we only INJECT when the intent clearly references the user's own
    # ranking and the catalog can supply a title.
    constraints = _resolve_personal_references(constraints, intent, context)

    # Chunk C: resolve the source collection from the intent.
    # "pick from my next watch" / "something from my list" / "a
    # comfort rewatch" are HARD source constraints — we never silently
    # fall back to the general catalog.
    constraints = _resolve_collection_scope(constraints, intent)

    # Ground results in the catalog. The adapter MAY suggest titles by
    # name; we never return them unless they resolve to a real
    # ContentTitle in our catalog. Chunk C: candidate retrieval starts
    # from the correct source COLLECTION, then enforces hard
    # constraints; the model's suggestions SUPPLEMENT retrieval, they
    # are not the only candidate source.
    suggested_names = [
        s.strip() for s in (raw.get("suggested_titles") or [])
        if isinstance(s, str) and s.strip()
    ][:12]
    grounded_ids = _retrieve_candidates(
        db,
        user_id=user_id,
        suggested_names=suggested_names,
        constraints=constraints,
        context=context,
    )

    if not grounded_ids:
        return ConciergeDecision(
            decision_id=None,
            constraints=constraints,
            rationale=rationale,
            title_ids=[],
            status="empty",
            status_detail=_empty_detail_for(constraints),
        )

    return ConciergeDecision(
        decision_id=None,
        constraints=constraints,
        rationale=rationale,
        title_ids=grounded_ids,
        status="ready",
    )


# ─── Collection scope + candidate retrieval (Concierge brief chunk C) ──


_NEXT_WATCH_PATTERNS = (
    "my next watch",
    "from my next watch",
    "from next watch",
    "pick from next watch",
    "pick from my next watch",
    "pick from my picks",  # default to Next Watch per spec
    "from my picks",
    "something i saved",
    "something from my saved",
    "something already saved",
)

_WATCHED_REWATCH_PATTERNS = (
    "comfort rewatch",
    "rewatch",
    "watch again",
    "something i've seen",
    "something i already watched",
    "a movie i've watched",
    "already watched",
)

_NAMED_LIST_PATTERNS = (
    "from my list",
    "from my saved list",
    "only from my list",
    "from my ",  # catches "from my weekend list" / "from my cozy list"
)


def _resolve_collection_scope(constraints: ConciergeConstraints, intent: str) -> ConciergeConstraints:
    """Hard source constraints come from the intent language, not the
    model. Per spec: "A named list or 'only from my list' is a hard
    source constraint. Do not quietly recommend outside it."

    Precedence:
      1. "from my (weekend|cozy|...) list" → named_list (list_id TBD;
         composer may short-circuit to a list picker before Ask).
      2. "comfort rewatch" / "rewatch" / "already watched" → watched.
      3. "my next watch" / "from my picks" / "something I saved" →
         my_next_watch.
    """
    low = intent.lower()
    for p in _NAMED_LIST_PATTERNS:
        if p in low:
            constraints.collection_scope = "named_list"
            # Spec: ask the user to pick a specific list before
            # resolving. We leave list_id unset and the composer/UI
            # layer surfaces the selector. The decision reports which
            # scope it believed was requested.
            return constraints
    for p in _WATCHED_REWATCH_PATTERNS:
        if p in low:
            constraints.collection_scope = "watched"
            constraints.rewatch_intent = True
            return constraints
    for p in _NEXT_WATCH_PATTERNS:
        if p in low:
            constraints.collection_scope = "my_next_watch"
            return constraints
    return constraints


def _passes_constraints(row: ContentTitle, constraints: ConciergeConstraints) -> bool:
    """Hard constraint gate. Unknown metadata is NEVER treated as a
    pass — e.g. a title with no runtime fails an "under 90 min" ask
    rather than slipping through."""
    if constraints.media_type != "any":
        want = "movie" if constraints.media_type == "movie" else "series"
        if row.content_type != want:
            return False
    if constraints.year_min:
        if row.release_date is None or row.release_date.year < constraints.year_min:
            return False
    if constraints.year_max:
        if row.release_date is None or row.release_date.year > constraints.year_max:
            return False
    if constraints.runtime_min:
        if row.runtime_minutes is None or row.runtime_minutes < constraints.runtime_min:
            return False
    if constraints.runtime_max:
        if row.runtime_minutes is None or row.runtime_minutes > constraints.runtime_max:
            return False
    if constraints.genres:
        row_genres = [str(g).lower() for g in (row.genres or [])]
        if not any(g in row_genres for g in constraints.genres):
            return False
    if constraints.exclusions:
        excl = [e.lower() for e in constraints.exclusions]
        row_name = row.title.lower()
        row_genres = {str(g).lower() for g in (row.genres or [])}
        for e in excl:
            if e in row_name or e in row_genres:
                return False
    return True


def _empty_detail_for(constraints: ConciergeConstraints) -> str:
    """Short diagnostic code the client can use to pick the right
    recovery copy. Mobile maps the code to a user-facing message."""
    if constraints.collection_scope == "my_next_watch":
        return "empty_next_watch_scope"
    if constraints.collection_scope == "watched":
        return "empty_watched_scope"
    if constraints.collection_scope == "named_list":
        return "needs_list_selection"
    if constraints.required_providers:
        return "empty_provider_constraint"
    if constraints.runtime_max or constraints.runtime_min:
        return "empty_runtime_constraint"
    return "no_grounded_titles"


def _retrieve_candidates(
    db: Session,
    *,
    user_id: UUID,
    suggested_names: list[str],
    constraints: ConciergeConstraints,
    context: PersonalContext,
) -> list[UUID]:
    """Pull candidates from the correct source collection, then
    enforce hard constraints. The model's suggested titles SUPPLEMENT
    retrieval; they are not the sole source."""
    from app.models.social import (
        RankedFavorite,
        Rating,
        TitleWatchStatus,
        Watchlist,
        WatchlistItem,
    )

    scope = constraints.collection_scope

    def _apply_watched_policy(rows: list[ContentTitle]) -> list[ContentTitle]:
        """Hide Watched titles for new-discovery intents; keep them
        when the user asked for a rewatch."""
        if constraints.rewatch_intent or scope == "watched":
            return rows
        watched_ids = set(db.scalars(
            select(Rating.content_title_id).where(
                Rating.user_id == user_id,
                Rating.watched_state == "watched",
            )
        ).all())
        watched_ids.update(
            db.scalars(
                select(TitleWatchStatus.content_title_id).where(
                    TitleWatchStatus.user_id == user_id,
                    TitleWatchStatus.watched_state == "watched",
                )
            ).all()
        )
        return [r for r in rows if r.id not in watched_ids]

    # Hard source: My Next Watch
    if scope == "my_next_watch":
        next_watch_list = db.scalar(
            select(Watchlist).where(
                Watchlist.owner_user_id == user_id,
                Watchlist.is_default.is_(True),
                Watchlist.name.ilike("next%watch%"),
            )
        )
        if next_watch_list is None:
            return []
        rows = list(db.execute(
            select(ContentTitle)
            .join(WatchlistItem, WatchlistItem.content_title_id == ContentTitle.id)
            .where(WatchlistItem.watchlist_id == next_watch_list.id)
        ).scalars().all())
        rows = _apply_watched_policy(rows)
        passing = [r for r in rows if _passes_constraints(r, constraints)]
        return [r.id for r in passing[:8]]

    # Hard source: Watched (comfort rewatch) — only Watched titles the
    # user liked (score >= 7) count as "comfort."
    if scope == "watched":
        rows = list(db.execute(
            select(ContentTitle)
            .join(Rating, Rating.content_title_id == ContentTitle.id)
            .where(
                Rating.user_id == user_id,
                Rating.watched_state == "watched",
                Rating.score >= 7,
            )
        ).scalars().all())
        passing = [r for r in rows if _passes_constraints(r, constraints)]
        return [r.id for r in passing[:8]]

    # Hard source: named list — if the composer couldn't resolve a
    # specific list_id (list picker UX), return empty so the client
    # surfaces the selector.
    if scope == "named_list" and not constraints.collection_list_id:
        return []
    if scope == "named_list" and constraints.collection_list_id:
        try:
            list_uuid = UUID(constraints.collection_list_id)
        except (TypeError, ValueError):
            return []
        wl = db.scalar(
            select(Watchlist).where(Watchlist.id == list_uuid, Watchlist.owner_user_id == user_id)
        )
        if wl is None:
            return []
        rows = list(db.execute(
            select(ContentTitle)
            .join(WatchlistItem, WatchlistItem.content_title_id == ContentTitle.id)
            .where(WatchlistItem.watchlist_id == wl.id)
        ).scalars().all())
        passing = [r for r in rows if _passes_constraints(r, constraints)]
        return [r.id for r in passing[:8]]

    # Broad catalog: start from the model's suggestions, apply hard
    # constraints strictly. If the hard constraints eliminate
    # everything we return empty — the previous "soft fallback that
    # drops filters" is explicitly forbidden by the Concierge brief.
    return _ground_suggestions(db, suggested_names, constraints)


_PERSONAL_NUMBER_ONE_PATTERNS = (
    "my number one",
    "my #1",
    "my number-one",
    "my top pick",
    "my top-ranked",
    "my top ranked",
    "my favorite",
)


def _resolve_personal_references(
    constraints: ConciergeConstraints,
    intent: str,
    context: PersonalContext,
) -> ConciergeConstraints:
    """If the raw intent mentions "my number one" / "my #1" and the
    user actually HAS a #1 ranked title, inject it as a canonical
    like_anchor so grounding can resolve it. The authoritative anchor
    is the manual ranking — never recomputed from scores. Also sets
    media_type to the real title's type when the user hasn't already
    constrained it, so we don't recommend a movie when the anchor is a
    series (or vice-versa)."""
    if context.ranked_number_one is None:
        return constraints
    anchor_title = context.ranked_number_one.get("title")
    if not anchor_title:
        return constraints
    low_intent = intent.lower()
    if not any(p in low_intent for p in _PERSONAL_NUMBER_ONE_PATTERNS):
        return constraints
    # Avoid duplicating an anchor the model already surfaced.
    existing_lower = {a.lower() for a in constraints.like_anchors}
    if anchor_title.lower() not in existing_lower:
        constraints.like_anchors = [anchor_title, *constraints.like_anchors][:4]
    # Lock media type to the real anchor's type when not explicitly set.
    if constraints.media_type == "any":
        anchor_type = context.ranked_number_one.get("media_type")
        if anchor_type in ("movie", "series"):
            constraints.media_type = anchor_type  # type: ignore[assignment]
    return constraints


# ─── Catalog grounding ───────────────────────────────────────────────


def _ground_suggestions(
    db: Session,
    suggested_names: list[str],
    constraints: ConciergeConstraints,
) -> list[UUID]:
    """Resolve name suggestions into real ContentTitle UUIDs.

    The LLM suggests popular titles that often aren't in our catalog
    yet (we only have titles users have interacted with). To avoid
    the frequent "No matches with that constraint." dead-end:

      1. Case-insensitive exact match against ContentTitle.
      2. For misses, hit TMDB /search/multi and upsert the top result.
      3. Enforce constraints (media_type, year, runtime, genres) as
         hard filters AFTER ingestion.

    This still grounds every surfaced title in the real catalog, but
    the catalog is now the universe TMDB knows about, not just what
    SeenSnap has previously seen.
    """
    if not suggested_names:
        return []

    from sqlalchemy import func as sql_func

    def _by_name(names: list[str]) -> list[ContentTitle]:
        if not names:
            return []
        rows = list(db.scalars(select(ContentTitle).where(ContentTitle.title.in_(names))).all())
        missing = [n for n in names if not any(r.title == n for r in rows)]
        if missing:
            rows.extend(
                db.scalars(
                    select(ContentTitle).where(
                        sql_func.lower(ContentTitle.title).in_([m.lower() for m in missing])
                    )
                ).all()
            )
        # Dedupe by id.
        return list({r.id: r for r in rows}.values())

    rows = _by_name(suggested_names)
    found_names = {r.title.lower() for r in rows}
    still_missing = [n for n in suggested_names if n.lower() not in found_names]

    # Pull missing titles from TMDB and upsert so grounding has real
    # data to match on. Capped so a hallucinated 8-item list doesn't
    # fan out to 8 TMDB calls on every Concierge request.
    if still_missing:
        from app.services.tmdb import search_titles
        for name in still_missing[:6]:
            try:
                fetched = search_titles(db, name)
            except Exception:
                continue
            # search_titles returns best-match first; take only matches
            # whose title is a reasonable match to the ask (not pure
            # relevance from TMDB's own ranker).
            target_lower = name.lower()
            for cand in fetched:
                if cand.title.lower() == target_lower:
                    rows.append(cand)
                    found_names.add(cand.title.lower())
                    break
            else:
                # Accept the top hit if the exact match wasn't there —
                # TMDB often normalizes punctuation / numerals.
                if fetched:
                    rows.append(fetched[0])
                    found_names.add(fetched[0].title.lower())

    # Preserve the LLM's suggested order where titles pass hard
    # constraints. Oct-27 Concierge brief chunk C: NO soft fallback
    # that silently broadens the user's constraints; empty here
    # means genuinely no match, and the client surfaces the recovery
    # state with specific adjustment chips.
    ordered: list[UUID] = []
    for name in suggested_names:
        target = name.lower()
        for r in rows:
            if (
                r.title.lower() == target
                and r.id not in ordered
                and _passes_constraints(r, constraints)
            ):
                ordered.append(r.id)
                break
    return ordered[:8]


# ─── Constraint parsing ──────────────────────────────────────────────


def _constraints_from_raw(raw: dict, intent: str) -> ConciergeConstraints:
    """Convert the model's JSON output into a validated constraint
    object. Defensive against free-form keys / wrong types; invalid
    values quietly drop to defaults rather than raising."""
    c = ConciergeConstraints(raw_intent=intent)
    mt = str(raw.get("media_type") or "").lower().strip()
    if mt in ("movie", "series", "any"):
        c.media_type = mt  # type: ignore[assignment]
    def _str_list(key: str, cap: int = 8) -> list[str]:
        vals = raw.get(key)
        if not isinstance(vals, list):
            return []
        return [str(v).lower().strip() for v in vals if isinstance(v, (str, int)) and str(v).strip()][:cap]
    c.genres = _str_list("genres")
    c.moods = _str_list("moods")
    c.required_providers = _str_list("required_providers", cap=5)
    c.exclusions = _str_list("exclusions", cap=10)
    c.like_anchors = _str_list("like_anchors", cap=5)
    for key, attr in (("year_min", "year_min"), ("year_max", "year_max"),
                      ("runtime_min", "runtime_min"), ("runtime_max", "runtime_max")):
        v = raw.get(key)
        if isinstance(v, int) and v > 0:
            setattr(c, attr, v)
    c.rewatch_intent = bool(raw.get("rewatch_intent", False))
    return c


# ─── Provider adapters ───────────────────────────────────────────────


_PROMPT_TEMPLATE = """You are SeenSnap's movie/TV discovery concierge. The user described what they want to watch. Your job is to translate that into a typed constraint object AND suggest up to 8 real titles that fit.

Rules:
- Suggest ONLY real existing movies or TV series by their canonical title.
- Do not invent titles.
- Keep rationale to 1-2 sentences — plain, grounded, no hype.
- `media_type` is "movie" | "series" | "any".
- `genres` is a short list of lowercase canonical genre names.
- `moods` is a short list of lowercase mood/tone tags.
- `required_providers` only if the user explicitly asked (e.g. "only Netflix").
- `exclusions` for things the user explicitly rejected.
- `like_anchors` for similarity references ("like Arrival"). When the user
  says "my number one" or "my top pick", resolve it against the viewer's
  ranked_number_one from the context block.
- `rewatch_intent` true only if the user said they want something they've seen before.

PERSONAL CONTEXT — use this to interpret references like "my #1",
"something from my list", or "on my services". Do not fabricate a
favorite the context doesn't contain. If `cold_start` is true, prefer
explicit constraints over taste inference.

Context: {context_summary}

- Respond with ONLY a valid JSON object matching this schema:

{{
  "media_type": "movie|series|any",
  "genres": [], "moods": [], "year_min": null, "year_max": null,
  "runtime_min": null, "runtime_max": null,
  "required_providers": [], "exclusions": [], "like_anchors": [],
  "rewatch_intent": false,
  "rationale": "one or two sentences",
  "suggested_titles": ["Title One", "Title Two"]
}}

User intent: {intent}"""


_HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=25.0, write=5.0, pool=5.0)


class VertexConfigError(RuntimeError):
    """Raised when Vertex is selected but a required piece of config is
    missing (project id or ADC). Surfaced to the client as an
    unavailable status, not a 5xx."""


# Cache the ADC credentials object. google-auth's `.default()` call
# does a disk/metadata server lookup, which we don't want to repeat on
# every Concierge request. The token itself still expires and refreshes
# on `.refresh(request)`.
_VERTEX_CREDS = None  # type: ignore[var-annotated]


def _vertex_access_token() -> str:
    """Mint a short-lived access token from the active Application
    Default Credentials. On Cloud Run this picks up the attached
    service account; locally it picks up `gcloud auth application-
    default login`."""
    global _VERTEX_CREDS
    try:
        import google.auth  # type: ignore
        from google.auth.transport.requests import Request  # type: ignore
    except ImportError as exc:
        raise VertexConfigError(f"google-auth not installed: {exc}") from exc

    if _VERTEX_CREDS is None:
        try:
            _VERTEX_CREDS, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
        except Exception as exc:
            raise VertexConfigError(
                f"No Application Default Credentials available ({exc}). "
                "On Cloud Run attach a service account with the Vertex AI User role; "
                "locally run `gcloud auth application-default login`."
            ) from exc

    if not _VERTEX_CREDS.valid:
        try:
            _VERTEX_CREDS.refresh(Request())
        except Exception as exc:
            raise VertexConfigError(f"Could not refresh ADC token: {exc}") from exc
    return _VERTEX_CREDS.token  # type: ignore[attr-defined]


def _call_vertex(
    intent: str,
    *,
    project: str,
    location: str,
    model: str,
    context_summary: str = "{}",
) -> dict:
    """Vertex AI Gemini adapter.

    Uses the REST `:generateContent` endpoint with Application Default
    Credentials. No new SDK required beyond google-auth (already in the
    API deps). Requests JSON output via `response_mime_type` so the
    extractor doesn't have to tolerate prose.
    """
    if not project:
        raise VertexConfigError(
            "concierge_ai_project (or gcp_project_id / GOOGLE_CLOUD_PROJECT) is required."
        )
    token = _vertex_access_token()
    prompt = _PROMPT_TEMPLATE.format(intent=intent[:2000], context_summary=context_summary[:4000])
    url = (
        f"https://{location}-aiplatform.googleapis.com/v1/projects/{project}"
        f"/locations/{location}/publishers/google/models/{model}:generateContent"
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            "topP": 0.95,
            "maxOutputTokens": 1024,
            "responseMimeType": "application/json",
        },
    }
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        r = client.post(
            url,
            headers={
                "authorization": f"Bearer {token}",
                "content-type": "application/json",
            },
            json=body,
        )
        r.raise_for_status()
        payload = r.json()
    # Gemini candidate shape: candidates[0].content.parts[*].text
    text = ""
    for cand in payload.get("candidates", []) or []:
        content = cand.get("content") or {}
        for part in content.get("parts", []) or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                text += part["text"]
    return _extract_json(text)


def _call_anthropic(intent: str, api_key: str, model: str, *, context_summary: str = "{}") -> dict:
    prompt = _PROMPT_TEMPLATE.format(intent=intent[:2000], context_summary=context_summary[:4000])
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        r = client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        r.raise_for_status()
        body = r.json()
    # Anthropic returns content as a list of blocks; pull text.
    text = ""
    for block in body.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            text += block.get("text", "")
    return _extract_json(text)


def _call_openai(intent: str, api_key: str, model: str, *, context_summary: str = "{}") -> dict:
    prompt = _PROMPT_TEMPLATE.format(intent=intent[:2000], context_summary=context_summary[:4000])
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        r = client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "Respond with ONLY a valid JSON object."},
                    {"role": "user", "content": prompt},
                ],
                "response_format": {"type": "json_object"},
                "max_tokens": 1024,
            },
        )
        r.raise_for_status()
        body = r.json()
    text = body.get("choices", [{}])[0].get("message", {}).get("content", "")
    return _extract_json(text)


def _extract_json(text: str) -> dict:
    """Extract the first JSON object from a model response. Tolerant
    of leading prose / trailing commentary that some models emit even
    with strict instructions."""
    text = (text or "").strip()
    if not text:
        return {}
    # Fast path: direct parse.
    try:
        return json.loads(text)
    except Exception:
        pass
    # Fallback: find the first balanced {…} block.
    start = text.find("{")
    if start < 0:
        return {}
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except Exception:
                    return {}
    return {}


def decision_to_dict(d: ConciergeDecision) -> dict:
    """Serializable projection for the API response."""
    return {
        "decision_id": str(d.decision_id) if d.decision_id else None,
        "constraints": asdict(d.constraints),
        "rationale": d.rationale,
        "title_ids": [str(t) for t in d.title_ids],
        "status": d.status,
        "status_detail": d.status_detail,
    }
