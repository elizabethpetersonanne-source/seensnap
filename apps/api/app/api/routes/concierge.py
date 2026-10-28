"""Oct-18 build brief §4 Concierge decision endpoint.

Request is natural-language intent. Server:
  1. Reserves a Concierge slot (Free allowance / Premium unlimited).
  2. Calls the AI adapter to resolve typed constraints + grounded
     title suggestions.
  3. Finalizes the slot — successful only if the decision produced
     usable results. Errors / empty results / unavailable adapter
     release the slot rather than consume it.
  4. Returns a canonical response the client renders as hero-plus-four.

A refinement in the SAME decision does not consume a second slot —
the client passes `refinement_of_decision_id` and the service uses
the previously-reserved slot (bounded abuse / rate limits apply).
"""
from __future__ import annotations

from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.services.concierge import decision_to_dict, resolve_concierge_decision
from app.services.entitlements import (
    finalize_concierge_decision,
    reserve_concierge_decision,
    resolve_entitlement,
)


router = APIRouter()


class ConciergeDecisionRequest(BaseModel):
    intent: str = Field(min_length=1, max_length=2000)
    # If present, this request REFINES the given decision — does not
    # consume a second allowance slot.
    refinement_of_decision_id: UUID | None = None
    # Oct-27 Concierge chunk E: when the user picks a specific list
    # for a "from my saved list" ask, the client resolves that id
    # upfront and sends it here. Server validates ownership and
    # forces collection_scope="named_list".
    collection_list_id: UUID | None = None
    # Client-side generated UUID; retries use the same key.
    idempotency_key: str = Field(min_length=8, max_length=96)


class ConciergeTitleCard(BaseModel):
    title_id: UUID
    tmdb_id: int
    title: str
    poster_url: str | None
    backdrop_url: str | None
    year: int | None
    media_type: str
    overview: str | None


class ConciergeDecisionResponse(BaseModel):
    decision_id: UUID | None
    status: str  # "ready" | "partial" | "unavailable" | "empty" | "error" | "allowance_exhausted"
    status_detail: str = ""
    rationale: str = ""
    constraints: dict | None = None
    titles: list[ConciergeTitleCard] = []
    allowance_remaining: int | None = None
    allowance_cap: int | None = None
    resets_at: str | None = None
    # CON01/CON02/CON04: let the client distinguish an exhausted
    # retrieval from a display-cap stop, show "N of M requested"
    # partial state and offer Show more when more candidates exist.
    retrieval_exhausted: bool = True
    exact_match_count: int = 0
    requested_count: int = 5


def _hydrate_decision_titles(db, title_ids: list[UUID]) -> list[ConciergeTitleCard]:
    """Return ConciergeTitleCard rows in the service's order. UUIDs
    without a catalog row are silently dropped — the service already
    grounds every result, so a drop here only reflects a race with
    deletion."""
    if not title_ids:
        return []
    rows = {t.id: t for t in db.scalars(
        select(ContentTitle).where(ContentTitle.id.in_(title_ids))
    ).all()}
    out: list[ConciergeTitleCard] = []
    for tid in title_ids:
        t = rows.get(tid)
        if t is None:
            continue
        out.append(ConciergeTitleCard(
            title_id=t.id,
            tmdb_id=t.tmdb_id,
            title=t.title,
            poster_url=t.poster_url,
            backdrop_url=t.backdrop_url,
            year=t.release_date.year if t.release_date else None,
            media_type=t.content_type,
            overview=t.overview,
        ))
    return out


def _persist_decision_record(db, user_id: UUID, decision, intent: str):
    """Oct-27 Concierge chunk E: write the DecisionRecord so refinements
    can validate ownership + exclude already-shown titles."""
    from dataclasses import asdict
    from datetime import datetime, timezone
    from app.models.entitlements import ConciergeDecisionRecord
    rec = ConciergeDecisionRecord(
        user_id=user_id,
        original_intent=intent,
        current_intent=intent,
        constraints=asdict(decision.constraints),
        rationale=decision.rationale,
        status=decision.status,
        status_detail=decision.status_detail,
        latest_title_ids=[str(t) for t in decision.title_ids],
        shown_title_ids=[str(t) for t in decision.title_ids],
        featured_title_id=decision.title_ids[0] if decision.title_ids else None,
        turns=[{
            "turn_type": "initial",
            "intent": intent,
            "status": decision.status,
            "rationale": decision.rationale,
            "title_ids": [str(t) for t in decision.title_ids],
            "at": datetime.now(timezone.utc).isoformat(),
        }],
    )
    db.add(rec)
    db.flush()
    return rec


@router.post("/decision", response_model=ConciergeDecisionResponse)
def post_concierge_decision(
    payload: ConciergeDecisionRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> ConciergeDecisionResponse:
    entitlement = resolve_entitlement(db, current_user.id)

    # Enforce Free monthly allowance. Premium is unlimited (fair-use
    # ceiling can be added in config later). Refinements of an owned
    # decision never consume a slot; the decision_id must belong to
    # the current user, otherwise it's treated as a fresh request.
    is_refinement = payload.refinement_of_decision_id is not None
    if is_refinement:
        from app.models.entitlements import ConciergeDecisionRecord
        prior = db.scalar(
            select(ConciergeDecisionRecord).where(
                ConciergeDecisionRecord.id == payload.refinement_of_decision_id,
                ConciergeDecisionRecord.user_id == current_user.id,
            )
        )
        if prior is None:
            # Forged / foreign decision id — reject outright rather
            # than quietly treating it as a free request.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Decision not found or not owned by this user.",
            )
        allowance = None
    else:
        allowance = reserve_concierge_decision(
            db,
            current_user.id,
            idempotency_key=payload.idempotency_key,
        )
        if not allowance.allowed:
            return ConciergeDecisionResponse(
                decision_id=None,
                status="allowance_exhausted",
                status_detail=allowance.reason,
                allowance_remaining=0,
                allowance_cap=entitlement.concierge_monthly_cap,
                resets_at=allowance.resets_at.isoformat() if allowance.resets_at else None,
            )

    # Resolve intent via the AI adapter.
    decision = resolve_concierge_decision(
        db,
        current_user.id,
        payload.intent,
        collection_list_id=payload.collection_list_id,
    )

    # Successful means we actually produced grounded results.
    successful = decision.status == "ready" and bool(decision.title_ids)
    if allowance is not None and allowance.decision_id is not None:
        finalize_concierge_decision(
            db,
            current_user.id,
            allowance.decision_id,
            successful=successful,
        )

    # Chunk E: persist the decision record so follow-ups can resume
    # it. Even empty / clarification results are persisted — recovery
    # chips should refine the SAME decision rather than start over.
    record = _persist_decision_record(db, current_user.id, decision, payload.intent)
    db.commit()

    titles = _hydrate_decision_titles(db, decision.title_ids)

    decision_payload = decision_to_dict(decision)
    # Remaining allowance for the response — compute fresh so a
    # successful finalize is reflected immediately.
    remaining = allowance.remaining if allowance is not None else None
    cap = entitlement.concierge_monthly_cap

    return ConciergeDecisionResponse(
        decision_id=record.id,
        status=decision.status,
        status_detail=decision.status_detail,
        rationale=decision.rationale,
        constraints=decision_payload["constraints"],
        titles=titles,
        allowance_remaining=remaining,
        allowance_cap=cap,
        resets_at=allowance.resets_at.isoformat() if allowance and allowance.resets_at else None,
        retrieval_exhausted=decision.retrieval_exhausted,
        exact_match_count=decision.exact_match_count,
        requested_count=decision.requested_count,
    )


# ─── Decision refinement (Concierge chunk E) ──────────────────────────


class ConciergeRefineRequest(BaseModel):
    """A follow-up turn on an existing decision. The server resolves
    the refinement against the stored decision + its shown title set
    rather than starting a fresh search."""
    # "shorter" | "longer" | "different_options" | "more_like_selected"
    # | "custom" — the client sends the semantic intent; a custom
    # follow-up carries free-text in `prompt`.
    kind: str = Field(pattern="^(shorter|longer|different_options|more_like_selected|only_provider|edit|undo|custom)$")
    # Required for custom and only_provider. Ignored otherwise.
    prompt: str | None = Field(default=None, max_length=2000)
    # For more_like_selected / promote: the title the user tapped as
    # featured. Server validates it was in the decision's shown set.
    featured_title_id: UUID | None = None
    idempotency_key: str = Field(min_length=8, max_length=96)


@router.post("/decision/{decision_id}/refine", response_model=ConciergeDecisionResponse)
def post_concierge_refinement(
    decision_id: UUID,
    payload: ConciergeRefineRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> ConciergeDecisionResponse:
    from app.models.entitlements import ConciergeDecisionRecord
    from datetime import datetime, timezone

    record = db.scalar(
        select(ConciergeDecisionRecord).where(
            ConciergeDecisionRecord.id == decision_id,
            ConciergeDecisionRecord.user_id == current_user.id,
        )
    )
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Decision not found or not owned by this user.",
        )

    entitlement = resolve_entitlement(db, current_user.id)

    # Chunk E: refinements do NOT consume a fresh allowance slot. The
    # same decision_id can be refined any number of times — allowance
    # is scoped to the INITIAL decision, not each turn.
    base_constraints = dict(record.constraints or {})
    new_intent = record.current_intent
    shown_ids_pre = set(record.shown_title_ids or [])
    turn_type = payload.kind

    # Translate the semantic refinement kind into a rewritten intent
    # that keeps every other constraint intact per spec.
    if payload.kind == "shorter":
        cur_max = base_constraints.get("runtime_max")
        new_max = 90 if cur_max is None else max(60, int(cur_max) - 30)
        new_intent = f"{record.original_intent} (shorter — under {new_max} minutes)"
    elif payload.kind == "longer":
        cur_max = base_constraints.get("runtime_max")
        new_max = 180 if cur_max is None else min(240, int(cur_max) + 30)
        new_intent = f"{record.original_intent} (longer — up to {new_max} minutes)"
    elif payload.kind == "different_options":
        # Append a short directive; the model still sees the original
        # constraints via the context block. The hard exclusion
        # happens below via shown_title_ids filtering.
        new_intent = f"{record.original_intent} (different options from before)"
    elif payload.kind == "more_like_selected":
        if payload.featured_title_id is None:
            raise HTTPException(status_code=400, detail="more_like_selected requires featured_title_id")
        if str(payload.featured_title_id) not in shown_ids_pre:
            raise HTTPException(status_code=400, detail="featured_title_id must come from a prior turn")
        anchor = db.scalar(select(ContentTitle).where(ContentTitle.id == payload.featured_title_id))
        if anchor is None:
            raise HTTPException(status_code=404, detail="Featured title not found")
        new_intent = f"Something I haven't watched like {anchor.title}, matching this earlier ask: {record.original_intent}"
    elif payload.kind == "only_provider":
        if not payload.prompt:
            raise HTTPException(status_code=400, detail="only_provider requires prompt")
        new_intent = f"{record.original_intent} (only on {payload.prompt.strip()})"
    elif payload.kind == "edit":
        if not payload.prompt:
            raise HTTPException(status_code=400, detail="edit requires prompt")
        new_intent = payload.prompt.strip()
    elif payload.kind == "undo":
        # Undo the latest turn by reverting current_intent to the prior
        # turn's intent (or original) and re-resolving. shown_title_ids
        # stays — "undo refinement" should NOT re-surface titles the
        # user has already dismissed in earlier turns.
        turns = list(record.turns or [])
        if len(turns) <= 1:
            new_intent = record.original_intent
        else:
            new_intent = turns[-2].get("intent") or record.original_intent
    elif payload.kind == "custom":
        if not payload.prompt:
            raise HTTPException(status_code=400, detail="custom requires prompt")
        new_intent = payload.prompt.strip()

    # Re-resolve against the (possibly rewritten) intent.
    decision = resolve_concierge_decision(db, current_user.id, new_intent)

    # Chunk E: hard-exclude titles already shown in this decision for
    # the "different options" kind. For other kinds we DEDUPE but
    # don't force-exclude — a "more like this" that returns the anchor
    # again is still useful context, just moved down.
    filtered_ids: list[UUID]
    if payload.kind == "different_options":
        filtered_ids = [t for t in decision.title_ids if str(t) not in shown_ids_pre]
    else:
        # Dedupe only against the LATEST turn, not the whole history.
        last_ids = set(record.latest_title_ids or [])
        filtered_ids = [t for t in decision.title_ids if str(t) not in last_ids] + [
            t for t in decision.title_ids if str(t) in last_ids
        ]

    titles = _hydrate_decision_titles(db, filtered_ids)

    # Update the record.
    from dataclasses import asdict
    new_shown = list(shown_ids_pre.union(str(t) for t in filtered_ids))
    record.current_intent = new_intent
    record.constraints = asdict(decision.constraints)
    record.rationale = decision.rationale
    record.status = decision.status
    record.status_detail = decision.status_detail
    record.latest_title_ids = [str(t) for t in filtered_ids]
    record.shown_title_ids = new_shown
    if payload.featured_title_id is not None:
        record.featured_title_id = payload.featured_title_id
    elif filtered_ids:
        record.featured_title_id = filtered_ids[0]
    turns = list(record.turns or [])
    turns.append({
        "turn_type": turn_type,
        "intent": new_intent,
        "status": decision.status,
        "rationale": decision.rationale,
        "title_ids": [str(t) for t in filtered_ids],
        "at": datetime.now(timezone.utc).isoformat(),
    })
    record.turns = turns
    record.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(record)

    decision_payload = decision_to_dict(decision)
    return ConciergeDecisionResponse(
        decision_id=record.id,
        status=decision.status,
        status_detail=decision.status_detail,
        rationale=decision.rationale,
        constraints=decision_payload["constraints"],
        titles=titles,
        allowance_remaining=None,
        allowance_cap=entitlement.concierge_monthly_cap,
        resets_at=None,
        retrieval_exhausted=decision.retrieval_exhausted,
        exact_match_count=decision.exact_match_count,
        requested_count=decision.requested_count,
    )


# ─── Suggested prompts (Chunk A of Concierge brief) ─────────────────────


class SuggestedPrompt(BaseModel):
    """A single Try asking chip.

    `label` is the short chip caption. `prompt` is the editable text
    inserted into the Concierge input when the chip is tapped. Both
    reflect real personal data when it exists (e.g. "More like Arrival"
    for the user's actual #1), otherwise they fall back to honest
    general starters so we never claim a favorite the user doesn't have.
    """
    id: str
    label: str
    prompt: str
    # Diagnostic — which personal collection the chip assumes exists.
    # Clients may hide a chip whose required_context is already stale
    # (e.g. if Next Watch becomes empty between prompt load and tap).
    required_context: str | None = None
    # When the chip is anchored to a specific title (e.g. "More like
    # Arrival"), carry the title id so the follow-up decision can
    # resolve it without re-parsing the label.
    reference_title_id: UUID | None = None


class SuggestedPromptsResponse(BaseModel):
    headline: str
    placeholder: str
    prompts: list[SuggestedPrompt]
    # True iff at least one chip is personalised (vs. all generic
    # new-user starters). Clients can show "Try asking" vs a different
    # eyebrow for the generic case.
    personalised: bool = False


@router.get("/prompts", response_model=SuggestedPromptsResponse)
def get_suggested_prompts(
    current_user: CurrentUser,
    db: DbSession,
) -> SuggestedPromptsResponse:
    """Return 6–8 suggested prompts tailored to the viewer's data.

    Deterministic templates — no model call, no allowance consumed.
    A chip is only emitted when the required personal data actually
    exists; otherwise we fall back to an honest general starter.
    """
    from app.models.social import (
        RankedFavorite,
        Rating,
        Watchlist,
        WatchlistItem,
    )
    from app.models.user import UserPreferences
    from sqlalchemy import func as sqlfunc

    uid = current_user.id

    # ── Personal evidence probes ──────────────────────────────────────
    top_ranked_title = db.scalar(
        select(ContentTitle)
        .join(RankedFavorite, RankedFavorite.content_title_id == ContentTitle.id)
        .where(RankedFavorite.user_id == uid)
        .order_by(RankedFavorite.position.asc())
        .limit(1)
    )

    next_watch_list = db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == uid,
            Watchlist.is_default.is_(True),
            Watchlist.name.ilike("next%watch%"),
        )
    )
    next_watch_count = 0
    if next_watch_list is not None:
        next_watch_count = int(db.scalar(
            select(sqlfunc.count()).select_from(WatchlistItem).where(WatchlistItem.watchlist_id == next_watch_list.id)
        ) or 0)

    watched_rated_count = int(db.scalar(
        select(sqlfunc.count()).select_from(Rating).where(
            Rating.user_id == uid,
            Rating.watched_state == "watched",
            Rating.score >= 7,
        )
    ) or 0)

    # Any non-default custom list — "a saved list" chip gates on this.
    custom_list = db.scalar(
        select(Watchlist).where(
            Watchlist.owner_user_id == uid,
            Watchlist.is_default.is_(False),
            Watchlist.is_system_list.is_(False),
        ).limit(1)
    )

    prefs = db.scalar(select(UserPreferences).where(UserPreferences.user_id == uid))
    services: list[str] = list(prefs.connected_streaming_services) if prefs else []

    prompts: list[SuggestedPrompt] = []
    personalised = False

    if next_watch_count > 0:
        prompts.append(SuggestedPrompt(
            id="next_watch_pick",
            label="Pick from My Next Watch",
            prompt="Choose something from My Next Watch that I would enjoy tonight.",
            required_context="my_next_watch_nonempty",
        ))
        personalised = True

    if top_ranked_title is not None:
        prompts.append(SuggestedPrompt(
            id="like_number_one",
            label=f"More like {top_ranked_title.title}",
            prompt=(
                f"Find something I haven't watched with a similar feel to "
                f"{top_ranked_title.title}, my number-one ranked pick."
            ),
            required_context="ranked_favorite_1",
            reference_title_id=top_ranked_title.id,
        ))
        personalised = True

    prompts.append(SuggestedPrompt(
        id="hidden_gem",
        label="A hidden gem for me",
        prompt="Find an overlooked movie that fits my taste.",
    ))

    prompts.append(SuggestedPrompt(
        id="under_90",
        label="Under 90 minutes",
        prompt="Find a movie I'd enjoy that is under 90 minutes.",
    ))

    if services:
        prompts.append(SuggestedPrompt(
            id="on_my_services",
            label="On my services",
            prompt=(
                "Find something I haven't watched that is included with one "
                "of my selected streaming services."
            ),
            required_context="connected_services_nonempty",
        ))
        personalised = True

    if watched_rated_count >= 3:
        prompts.append(SuggestedPrompt(
            id="comfort_rewatch",
            label="A comfort rewatch",
            prompt="Pick a comforting rewatch from titles I've watched and enjoyed.",
            required_context="rated_watched_positive",
        ))
        personalised = True

    if custom_list is not None:
        prompts.append(SuggestedPrompt(
            id="from_saved_list",
            label="From my saved list",
            prompt="Help me choose from one of my saved lists.",
            required_context="custom_list_exists",
        ))
        personalised = True

    prompts.append(SuggestedPrompt(
        id="surprise_me",
        label="Surprise me",
        prompt="Find something outside my usual taste that I might enjoy.",
    ))

    # New-user fallback — if we have very little personal signal, swap
    # in honest generic starters so the row isn't padded with chips
    # whose context would mislead.
    if not personalised:
        prompts = [
            SuggestedPrompt(id="funny", label="Something funny", prompt="Something funny."),
            SuggestedPrompt(id="thriller", label="A gripping thriller", prompt="A gripping thriller."),
            SuggestedPrompt(id="easy", label="An easy watch", prompt="An easy watch."),
            SuggestedPrompt(id="doc", label="A great documentary", prompt="A great documentary."),
            SuggestedPrompt(id="under_90", label="Under 90 minutes", prompt="A movie under 90 minutes."),
            SuggestedPrompt(id="surprise_me", label="Surprise me", prompt="Find something I might enjoy."),
        ]

    return SuggestedPromptsResponse(
        headline="Tell me what you're in the mood for—or let me pick from My Picks.",
        placeholder="A movie, a mood, or something from your list…",
        prompts=prompts[:8],
        personalised=personalised,
    )
