"""Oct-18 build brief §4 Concierge decision endpoint.

Request is natural-language intent. Server:
  1. Reserves a Concierge slot (Free allowance / Premium unlimited).
  2. Calls the AI adapter to resolve typed constraints + grounded
     title suggestions.
  3. Finalizes the slot — successful only if the decision produced
     usable results. Errors / empty results / unavailable adapter
     release the slot rather than consume it.
  4. Returns a canonical response the client renders as hero-plus-four.

Refinements use the owner's versioned decision endpoint and reuse its
allowance. Initial requests have durable, leased idempotency receipts.
"""
from __future__ import annotations

from uuid import UUID, uuid4
import hashlib
import httpx
import json

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle, ContentAvailability
from app.services.concierge import decision_to_dict, resolve_concierge_decision
from app.services.entitlements import (
    finalize_concierge_decision,
    resolve_entitlement,
)


from app.schemas.scenedna import TitleCompatibility
from app.services.title_compatibility import scorer_for_user

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


class ConciergeWatchOption(BaseModel):
    provider_code: str
    provider_name: str
    offer_type: str
    web_url: str | None


class ConciergeTitleCard(BaseModel):
    scenedna: TitleCompatibility | None = None
    title_id: UUID
    tmdb_id: int
    title: str
    poster_url: str | None
    backdrop_url: str | None
    year: int | None
    media_type: str
    overview: str | None
    watch_options: list[ConciergeWatchOption] = Field(default_factory=list)


class ConciergeDecisionResponse(BaseModel):
    request_id: UUID | None = None
    retry_after_seconds: int | None = None
    can_retry: bool = False
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
    # CON04 typed reason the result set is partial / empty.
    # One of: source_exhausted | metadata_unavailable | upstream_failure
    # | retrieval_budget_reached | pick_one_intentional | None.
    partial_reason: str | None = None
    # C16 per-title rationales keyed by title_id — client picks the
    # featured title's rationale so promoting a thumbnail changes it.
    title_rationales: dict[str, str] = {}
    version: int = 1


def _hydrate_decision_titles(db, title_ids: list[UUID], user_id) -> list[ConciergeTitleCard]:
    """Return ConciergeTitleCard rows in the service's order. UUIDs
    without a catalog row are silently dropped — the service already
    grounds every result, so a drop here only reflects a race with
    deletion."""
    if not title_ids:
        return []
    rows = {t.id: t for t in db.scalars(
        select(ContentTitle).where(ContentTitle.id.in_(title_ids))
    ).all()}
    scorer = scorer_for_user(db, user_id, rows.values())
    from app.models.user import UserProfile, UserPreferences
    from datetime import datetime, timezone
    profile = db.get(UserProfile, user_id)
    prefs = db.get(UserPreferences, user_id)
    region = ((profile.country_code if profile else None) or ((prefs.preferred_regions or ["US"])[0] if prefs else "US")).upper()
    offers = list(db.scalars(select(ContentAvailability).where(
        ContentAvailability.content_title_id.in_(title_ids),
        ContentAvailability.region_code == region,
        ContentAvailability.expires_at > datetime.now(timezone.utc),
    ).order_by(ContentAvailability.provider_name, ContentAvailability.monetization_type)).all())
    out: list[ConciergeTitleCard] = []
    for tid in title_ids:
        t = rows.get(tid)
        if t is None:
            continue
        out.append(ConciergeTitleCard(
            scenedna=scorer.score(t),
            title_id=t.id,
            tmdb_id=t.tmdb_id,
            title=t.title,
            poster_url=t.poster_url,
            backdrop_url=t.backdrop_url,
            year=t.release_date.year if t.release_date else None,
            media_type=t.content_type,
            overview=t.overview,
            watch_options=[ConciergeWatchOption(provider_code=a.provider_code, provider_name=a.provider_name,
                offer_type=a.monetization_type, web_url=a.web_url) for a in offers if a.content_title_id == tid],
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
            **decision_to_dict(decision),
            "previous_turn_index": None,
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


def _validate_selected_list(db, user_id, list_id):
    if list_id is not None:
        from app.models.social import Watchlist
        if not db.scalar(select(Watchlist.id).where(Watchlist.id == list_id, Watchlist.owner_user_id == user_id)):
            raise HTTPException(404, detail="This list is no longer available.")


def _request_response(db, request):
    from datetime import datetime, timezone
    if request.state == "processing":
        expired = request.lease_expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc)
        return ConciergeDecisionResponse(decision_id=request.decision_id, request_id=request.id,
            status="processing", status_detail="request_interrupted" if expired else "request_in_progress",
            retry_after_seconds=3, can_retry=expired, retrieval_exhausted=False)
    response = ConciergeDecisionResponse.model_validate({**request.response, "request_id": str(request.id),
        "can_retry": request.state == "retryable"})
    response.titles = _hydrate_decision_titles(db, [t.title_id for t in response.titles], request.user_id)
    return response


@router.get("/requests/{request_key}", response_model=ConciergeDecisionResponse)
def get_concierge_request(request_key: str, current_user: CurrentUser, db: DbSession):
    from app.models.entitlements import ConciergeRequest
    request = db.scalar(select(ConciergeRequest).where(
        ConciergeRequest.user_id == current_user.id, ConciergeRequest.idempotency_key == request_key,
    ))
    if request is None:
        raise HTTPException(404, detail="Search request not found.")
    list_id = (request.response.get("constraints") or {}).get("collection_list_id")
    if list_id:
        _validate_selected_list(db, current_user.id, UUID(list_id))
    return _request_response(db, request)


@router.post("/decision", response_model=ConciergeDecisionResponse)
def post_concierge_decision(payload: ConciergeDecisionRequest, current_user: CurrentUser, db: DbSession):
    from app.services.concierge_requests import claim, lock_current
    from app.services.concierge_runtime import request_runtime, report, error_code, ConciergeDeadlineExceeded
    from app.services.concierge import ConciergeDecision, ConciergeConstraints
    from app.services.entitlements import _active_period_entries
    import httpx
    _validate_selected_list(db, current_user.id, payload.collection_list_id)
    if payload.refinement_of_decision_id:
        # All refinements must use stored constraints and optimistic versions.
        raise HTTPException(400, detail="Use the decision's refinement endpoint to update this search.")
    from app.services.watchlists import ensure_next_watch_list
    ensure_next_watch_list(db, current_user.id)
    entitlement = resolve_entitlement(db, current_user.id)
    request, run, allowance = claim(db, current_user.id, payload)
    if allowance is not None and not allowance.allowed:
        return ConciergeDecisionResponse(decision_id=None, status="allowance_exhausted",
            status_detail="monthly_cap_reached", allowance_remaining=0,
            allowance_cap=entitlement.concierge_monthly_cap,
            resets_at=allowance.resets_at.isoformat() if allowance.resets_at else None)
    if not run:
        list_id = (request.response.get("constraints") or {}).get("collection_list_id")
        if list_id: _validate_selected_list(db, current_user.id, UUID(list_id))
        return _request_response(db, request)
    request_id, lease_id, attempt = request.id, request.lease_id, request.attempt
    with request_runtime(request_id) as runtime:
        try:
            decision = resolve_concierge_decision(db, current_user.id, payload.intent,
                collection_list_id=payload.collection_list_id)
        except (ConciergeDeadlineExceeded, httpx.HTTPError) as error:
            decision = ConciergeDecision(None, ConciergeConstraints(raw_intent=payload.intent), "", [], "error",
                status_detail=error_code(error), partial_reason="retrieval_timeout" if error_code(error) == "request_timed_out" else "upstream_failure",
                retrieval_exhausted=False)
        except Exception:
            db.rollback()
            # The receipt remains recoverable; raw exception text may contain
            # a provider response or credentials and must never be returned.
            decision = ConciergeDecision(None, ConciergeConstraints(raw_intent=payload.intent), "", [], "error",
                status_detail="search_interrupted", partial_reason="upstream_failure", retrieval_exhausted=False)
        request = lock_current(db, current_user.id, request_id, lease_id)
        record = _persist_decision_record(db, current_user.id, decision, payload.intent)
        titles = _hydrate_decision_titles(db, decision.title_ids, current_user.id)
        successful = decision.status in ("ready", "partial") and bool(titles)
        if allowance and allowance.decision_id:
            finalize_concierge_decision(db, current_user.id, allowance.decision_id, successful=successful)
        db.flush()
        cap = entitlement.concierge_monthly_cap
        remaining = max(0, cap - len(_active_period_entries(db, current_user.id))) if cap is not None else None
        response = _response_from_turn(db, record.id, record.turns[-1], 1)
        response.request_id = request_id
        response.allowance_remaining, response.allowance_cap = remaining, cap
        response.resets_at = allowance.resets_at.isoformat() if allowance and allowance.resets_at else None
        response.can_retry = response.status in {"error", "unavailable"}
        request.decision_id = record.id
        request.response = response.model_dump(mode="json")
        request.state = "retryable" if response.can_retry else "completed"
        from datetime import datetime, timezone
        request.updated_at = datetime.now(timezone.utc)
        db.commit()
        report(runtime, status=response.status, code=response.status_detail,
            count=len(titles), attempt=attempt)
        return response


# ─── Decision refinement (Concierge chunk E) ──────────────────────────


class ConciergeRefineRequest(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    """A follow-up turn on an existing decision. The server resolves
    the refinement against the stored decision + its shown title set
    rather than starting a fresh search."""
    # "shorter" | "longer" | "different_options" | "more_like_selected"
    # | "custom" — the client sends the semantic intent; a custom
    # follow-up carries free-text in `prompt`.
    kind: str = Field(pattern="^(shorter|longer|different_options|continue_search|more_like_selected|only_provider|edit|undo|custom)$")
    # Required for custom and only_provider. Ignored otherwise.
    prompt: str | None = Field(default=None, max_length=2000)
    # For more_like_selected / promote: the title the user tapped as
    # featured. Server validates it was in the decision's shown set.
    featured_title_id: UUID | None = None
    idempotency_key: str = Field(min_length=8, max_length=96)



@router.post("/decision/{decision_id}/refine", response_model=ConciergeDecisionResponse)
def post_concierge_refinement(decision_id: UUID, payload: ConciergeRefineRequest,
    current_user: CurrentUser, db: DbSession) -> ConciergeDecisionResponse:
    from app.models.entitlements import ConciergeDecisionRecord, ConciergeRequest
    from app.services.concierge_requests import claim, lock_current
    from datetime import datetime, timezone
    if not db.scalar(select(ConciergeDecisionRecord.id).where(
        ConciergeDecisionRecord.id == decision_id, ConciergeDecisionRecord.user_id == current_user.id)):
        raise HTTPException(404, detail="Decision not found.")
    key = "refine-" + hashlib.sha256(f"{decision_id}:{payload.idempotency_key}".encode()).hexdigest()
    claim_payload = payload.model_copy(update={"idempotency_key": key})
    receipt, run, _ = claim(db, current_user.id, claim_payload, reserve_allowance=False)
    if not run:
        if receipt.state == "completed":
            return _request_response(db, receipt)
        raise HTTPException(429, detail={"code": "search_busy", "retryable": True}, headers={"Retry-After": "3"})
    receipt_id, lease_id = receipt.id, receipt.lease_id
    try:
        response = _post_concierge_refinement(decision_id, payload, current_user, db)
        receipt = lock_current(db, current_user.id, receipt_id, lease_id)
        receipt.response = response.model_dump(mode="json")
        receipt.state = "completed"
        # Keep decision_id null: only the initial receipt owns its billing slot.
        receipt.updated_at = datetime.now(timezone.utc)
        db.commit()
        return response
    except Exception:
        db.rollback()
        receipt = db.scalar(select(ConciergeRequest).where(ConciergeRequest.id == receipt_id).with_for_update())
        if receipt and receipt.lease_id == lease_id:
            receipt.state = "retryable"
            db.commit()
        raise


def _post_concierge_refinement(
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

    from dataclasses import fields
    from app.services.concierge import ConciergeConstraints
    from app.services.tmdb import SUPPORTED_PROVIDER_ALIASES

    turns = list(record.turns or [])
    version = len(turns)
    if not turns:
        raise HTTPException(409, detail="Start a new search to refine this older decision.")
    list_id = (record.constraints or {}).get("collection_list_id")
    if list_id: _validate_selected_list(db, current_user.id, UUID(list_id))
    fingerprint = hashlib.sha256(json.dumps(
        payload.model_dump(mode="json", exclude={"idempotency_key"}), sort_keys=True).encode()).hexdigest()
    for index, turn in enumerate(turns):
        if turn.get("idempotency_key") == payload.idempotency_key:
            if turn.get("request_fingerprint", fingerprint) != fingerprint:
                raise HTTPException(409, detail={"code": "request_key_conflict"})
            restored_list = (turn.get("constraints") or {}).get("collection_list_id")
            if restored_list: _validate_selected_list(db, current_user.id, UUID(restored_list))
            return _response_from_turn(db, record.id, turn, index + 1)
    if payload.expected_version is not None and payload.expected_version != version:
        raise HTTPException(409, detail={"code": "decision_version_conflict", "version": version})
    known = {f.name for f in fields(ConciergeConstraints)}
    effective = ConciergeConstraints(**{k: v for k, v in (record.constraints or {}).items() if k in known})
    new_intent = record.current_intent
    previous_index = len(turns) - 1
    excluded = []
    if payload.kind == "undo":
        previous_index = turns[-1].get("previous_turn_index") if turns else None
        if previous_index is None:
            return _response_from_turn(db, record.id, turns[-1], version)
        snapshot = dict(turns[previous_index])
        if "constraints" not in snapshot:
            raise HTTPException(409, detail="Start a new search to use Undo with this older decision.")
        # Recheck ownership of a saved-list scope before restoring a snapshot.
        cid = (snapshot.get("constraints") or {}).get("collection_list_id")
        if cid:
            from app.models.social import Watchlist
            if not db.scalar(select(Watchlist.id).where(Watchlist.id == UUID(cid), Watchlist.owner_user_id == current_user.id)):
                raise HTTPException(404, detail="This list is no longer available.")
        snapshot["previous_turn_index"] = turns[previous_index].get("previous_turn_index")
        new_intent = snapshot.get("intent", record.original_intent)
    else:
        if payload.kind in ("shorter", "longer"):
            current_max = effective.runtime_max
            if current_max is None:
                selected_id = str(payload.featured_title_id) if payload.featured_title_id else next(iter(record.latest_title_ids or []), None)
                if selected_id and selected_id not in (record.latest_title_ids or []):
                    raise HTTPException(400, detail="Select a title from the current results first.")
                selected = db.get(ContentTitle, UUID(selected_id)) if selected_id else None
                current_max = selected.runtime_minutes if selected else None
                if selected and selected.content_type == "series":
                    current_max = max((v for v in (selected.metadata_raw or {}).get("episode_run_time", []) if type(v) is int and v > 0), default=45)
                    effective.runtime_scope = "episode"
            effective.runtime_max = (90 if current_max is None else max(1, current_max - 30)) if payload.kind == "shorter" else (180 if current_max is None else min(1440, current_max + 30))
            if effective.runtime_min and effective.runtime_min > effective.runtime_max:
                raise HTTPException(400, detail="The requested duration conflicts with your minimum runtime.")
            new_intent = f"{record.current_intent}\nUpdated maximum duration: {effective.runtime_max} minutes."
        elif payload.kind in ("different_options", "continue_search"):
            excluded = list(record.shown_title_ids or [])
        elif payload.kind == "more_like_selected":
            if payload.featured_title_id is None or str(payload.featured_title_id) not in (record.latest_title_ids or []):
                raise HTTPException(400, detail="Select a title from the current results first.")
            anchor = db.get(ContentTitle, payload.featured_title_id)
            if anchor is None:
                raise HTTPException(404, detail="Title no longer available.")
            effective.like_anchors = [anchor.title]
            effective.anchor_title_ids = [str(anchor.id)]
            effective.anchor_evidence = []
            excluded = [str(anchor.id)]
            new_intent = f"{record.current_intent}\nFind alternatives with a similar feel to {anchor.title}."
        elif payload.kind == "only_provider":
            if not payload.prompt:
                raise HTTPException(400, detail="Choose a service first.")
            provider = payload.prompt.strip().lower()
            code = SUPPORTED_PROVIDER_ALIASES.get(provider, (provider.replace(" ", "_"), ""))[0]
            effective.required_providers = [code]
            new_intent = f"{record.current_intent}\nUse only {payload.prompt.strip()}."
        elif payload.kind in ("edit", "custom"):
            if not payload.prompt:
                raise HTTPException(400, detail="Enter your updated request.")
            new_intent = payload.prompt.strip() if payload.kind == "edit" else f"{record.current_intent}\nRefinement: {payload.prompt.strip()}"
            if payload.kind == "edit":
                effective = None
        from app.services.concierge_runtime import request_runtime, report, ConciergeDeadlineExceeded
        from app.services.concierge import ConciergeDecision, VertexConfigError
        # Only unchanged constraints can resume candidate/relevance work.
        continuation = turns[-1].get("retrieval_state") if payload.kind in ("different_options", "continue_search") else None
        with request_runtime(uuid4()) as runtime:
            try:
                if payload.kind == "custom":
                    from app.services.concierge_refinement import refine_constraints
                    from app.services.concierge_runtime import stage
                    with stage("refinement"):
                        effective = refine_constraints(db, effective, payload.prompt.strip(), record.latest_title_ids or [])
                decision = resolve_concierge_decision(db, current_user.id, new_intent,
                    effective_constraints=effective, excluded_title_ids=excluded,
                    collection_list_id=UUID(effective.collection_list_id) if effective and effective.collection_list_id else UUID(list_id) if effective is None and list_id else None,
                    retrieval_state=continuation)
            except ConciergeDeadlineExceeded:
                decision = ConciergeDecision(None, effective or ConciergeConstraints(raw_intent=new_intent), "", [],
                    "error", status_detail="request_timed_out", retrieval_exhausted=False, partial_reason="retrieval_timeout")
            except (ValueError, httpx.HTTPError, VertexConfigError):
                decision = ConciergeDecision(None, effective or ConciergeConstraints(raw_intent=new_intent), "", [],
                    "error", status_detail="refinement_unavailable", retrieval_exhausted=False, partial_reason="upstream_failure")
            report(runtime, status=decision.status, code=decision.status_detail, count=len(decision.title_ids), attempt=1)
        # Transient failures preserve the visible turn and can be retried with
        # the same key/version. An empty, resumable scan is a valid next turn.
        if decision.status in {"error", "unavailable"}:
            db.commit()  # retain catalog hydration, never replace the decision
            raise HTTPException(503, detail={"code": decision.status_detail, "retryable": True})
        snapshot = decision_to_dict(decision)
        snapshot["previous_turn_index"] = previous_index

    # A first successful continuation consumes the original search slot if
    # its initial empty response released it. No second slot for later turns.
    from app.models.user import User
    from app.models.entitlements import ConciergeRequest, ConciergeAllowanceEntry
    from app.services.entitlements import reserve_concierge_decision
    db.scalar(select(User.id).where(User.id == current_user.id).with_for_update())
    receipt = db.scalar(select(ConciergeRequest).where(
        ConciergeRequest.user_id == current_user.id, ConciergeRequest.decision_id == record.id))
    if receipt and snapshot.get("title_ids") and snapshot.get("status") in {"ready", "partial"}:
        entry = db.scalar(select(ConciergeAllowanceEntry).where(
            ConciergeAllowanceEntry.user_id == current_user.id,
            ConciergeAllowanceEntry.idempotency_key == receipt.idempotency_key))
        if entry is None or entry.state != "consumed":
            reservation = reserve_concierge_decision(db, current_user.id, idempotency_key=receipt.idempotency_key)
            if not reservation.allowed:
                raise HTTPException(429, detail={"code": "monthly_cap_reached"})
            finalize_concierge_decision(db, current_user.id, reservation.decision_id, successful=True)

    # Network/model work has finished. Lock and recheck before replacing state;
    # stale concurrent responses must not clobber a newer refinement.
    db.refresh(record, with_for_update=True)
    if len(record.turns or []) != version:
        raise HTTPException(409, detail={"code": "decision_version_conflict", "version": len(record.turns or [])})
    snapshot.update({"intent": new_intent, "turn_type": payload.kind,
                     "idempotency_key": payload.idempotency_key, "request_fingerprint": fingerprint,
                     "at": datetime.now(timezone.utc).isoformat()})
    titles = _hydrate_decision_titles(db, [UUID(t) for t in snapshot.get("title_ids", [])], current_user.id)
    snapshot["title_ids"] = [str(t.title_id) for t in titles]
    if len(titles) < snapshot.get("requested_count", 5) and snapshot.get("status") in ("ready", "partial"):
        snapshot["status"] = "partial" if titles else "empty"
    record.current_intent = new_intent[:2000]
    record.constraints = snapshot.get("constraints") or {}
    record.rationale = snapshot.get("rationale") or ""
    record.status = snapshot.get("status", "empty")
    record.status_detail = snapshot.get("status_detail") or ""
    record.latest_title_ids = snapshot["title_ids"]
    record.shown_title_ids = sorted(set(record.shown_title_ids or []) | set(record.latest_title_ids))
    record.featured_title_id = titles[0].title_id if titles else None
    record.turns = [*turns, snapshot]
    record.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _response_from_turn(db, record.id, snapshot, version + 1)


def _response_from_turn(db, decision_id, turn, version):
    allowed = set(ConciergeDecisionResponse.model_fields) - {"decision_id", "titles", "version"}
    values = {key: value for key, value in turn.items() if key in allowed}
    from app.models.entitlements import ConciergeDecisionRecord
    owner = db.get(ConciergeDecisionRecord, decision_id).user_id
    titles = _hydrate_decision_titles(db, [UUID(t) for t in turn.get("title_ids", [])], owner)
    values["exact_match_count"] = len(titles)
    if len(titles) < values.get("requested_count", 5) and values.get("status") == "ready":
        values["status"] = "partial" if titles else "empty"
    return ConciergeDecisionResponse(decision_id=decision_id, titles=titles, version=version, **values)


@router.get("/decision/{decision_id}", response_model=ConciergeDecisionResponse)
def get_concierge_decision(decision_id: UUID, current_user: CurrentUser, db: DbSession):
    from app.models.entitlements import ConciergeDecisionRecord
    record = db.scalar(select(ConciergeDecisionRecord).where(
        ConciergeDecisionRecord.id == decision_id, ConciergeDecisionRecord.user_id == current_user.id))
    if record is None or not record.turns:
        raise HTTPException(404, detail="Decision is no longer available.")
    list_id = (record.constraints or {}).get("collection_list_id")
    if list_id: _validate_selected_list(db, current_user.id, UUID(list_id))
    return _response_from_turn(db, record.id, record.turns[-1], len(record.turns))


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

    from app.services.watchlists import get_next_watch_list as _get_next_watch
    next_watch_list = _get_next_watch(db, uid)
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
