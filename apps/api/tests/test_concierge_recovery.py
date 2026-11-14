from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4
import json
import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from app.api.routes import concierge as routes
from app.models.content import ContentTitle
from app.models.entitlements import ConciergeAllowanceEntry, ConciergeDecisionRecord, ConciergeRequest
from app.models.user import User
from app.services.concierge import ConciergeConstraints, ConciergeDecision
from app.services.concierge_requests import claim, lock_current
from app.services.concierge_runtime import error_code, request_runtime, report, ConciergeDeadlineExceeded, timeout_for
from app.services.entitlements import grant_beta_premium


def seed(db):
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    title = ContentTitle(id=uuid4(), tmdb_id=345, content_type="movie", title="A comedy")
    db.add_all([user, title]); db.commit()
    return user, title


def request(key="recover-0001", intent="A comedy"):
    return routes.ConciergeDecisionRequest(intent=intent, idempotency_key=key)


def test_success_replay_recovery_and_key_collision(db, monkeypatch):
    user, title = seed(db)
    calls = []
    def resolve(*args, **kwargs):
        calls.append(1)
        return ConciergeDecision(None, ConciergeConstraints(), "Matched", [title.id], "partial")
    monkeypatch.setattr(routes, "resolve_concierge_decision", resolve)
    first = routes.post_concierge_decision(request(), user, db)
    replay = routes.post_concierge_decision(request(), user, db)
    recovered = routes.get_concierge_request(request().idempotency_key, user, db)
    assert first.decision_id == replay.decision_id == recovered.decision_id
    assert len(calls) == 1 and first.allowance_remaining == 2
    assert db.scalar(select(func.count()).select_from(ConciergeDecisionRecord)) == 1
    assert db.scalar(select(ConciergeAllowanceEntry.state)) == "consumed"
    with pytest.raises(HTTPException) as error:
        routes.post_concierge_decision(request(intent="A thriller"), user, db)
    assert error.value.status_code == 409
    stranger = User(id=uuid4(), email="stranger@example.invalid", auth_provider="test")
    with pytest.raises(HTTPException) as error:
        routes.get_concierge_request(request().idempotency_key, stranger, db)
    assert error.value.status_code == 404


def test_failure_releases_slot_and_same_key_recovers(db, monkeypatch):
    user, title = seed(db)
    monkeypatch.setattr(routes, "resolve_concierge_decision", lambda *a, **k: (_ for _ in ()).throw(httpx.ReadTimeout("sensitive upstream body")))
    failed = routes.post_concierge_decision(request(), user, db)
    assert failed.status == "error" and failed.can_retry and failed.allowance_remaining == 3
    assert "sensitive" not in failed.model_dump_json()
    assert db.scalar(select(ConciergeAllowanceEntry.state)) == "released"
    monkeypatch.setattr(routes, "resolve_concierge_decision", lambda *a, **k: ConciergeDecision(None, ConciergeConstraints(), "", [title.id], "partial"))
    good = routes.post_concierge_decision(request(), user, db)
    assert good.status == "partial" and good.allowance_remaining == 2
    assert db.scalar(select(func.count()).select_from(ConciergeAllowanceEntry)) == 1
    assert db.scalar(select(ConciergeRequest.attempt)) == 2


def test_abandoned_lease_is_recoverable_and_old_worker_cannot_commit(db):
    user, _ = seed(db)
    receipt, run, allowance = claim(db, user.id, request())
    old_lease, receipt_id = receipt.lease_id, receipt.id
    duplicate, run, _ = claim(db, user.id, request())
    assert not run and duplicate.id == receipt_id
    assert routes.get_concierge_request(request().idempotency_key, user, db).status == "processing"
    receipt.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.commit()
    assert routes.get_concierge_request(request().idempotency_key, user, db).can_retry
    resumed, run, allowance = claim(db, user.id, request())
    assert run and resumed.lease_id != old_lease
    with pytest.raises(HTTPException) as error:
        lock_current(db, user.id, receipt_id, old_lease)
    assert error.value.status_code == 409
    assert lock_current(db, user.id, receipt_id, resumed.lease_id).attempt == 2


def test_parallel_claims_share_one_receipt_and_free_cap_is_atomic(db, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "concierge_max_concurrent_per_user", 20)  # isolate billing cap from operational protection
    if db.bind.dialect.name != "postgresql": pytest.skip("row locking requires PostgreSQL")
    user, _ = seed(db)
    uid, engine = user.id, db.get_bind()
    db.commit()
    def worker(key):
        with Session(engine) as session:
            receipt, run, allowance = claim(session, uid, request(key))
            return str(receipt.id) if receipt else None, run, allowance.allowed if allowance else True
    with ThreadPoolExecutor(max_workers=4) as pool:
        duplicate = list(pool.map(worker, ["parallel-same"] * 4))
    assert len({r[0] for r in duplicate}) == 1 and sum(r[1] for r in duplicate) == 1
    with ThreadPoolExecutor(max_workers=4) as pool:
        different = list(pool.map(worker, [f"parallel-{i}" for i in range(4)]))
    assert sum(r[2] for r in different) == 2  # one slot was already reserved


def test_expired_reservations_release_cap_and_beta_has_no_cap(db, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "concierge_max_concurrent_per_user", 20)  # isolate billing cap
    user, _ = seed(db)
    for i in range(3): claim(db, user.id, request(f"expire-{i:03}"))
    _, _, denied = claim(db, user.id, request("expire-four"))
    assert not denied.allowed
    for row in db.scalars(select(ConciergeAllowanceEntry)).all():
        row.reserved_at = datetime.now(timezone.utc) - timedelta(minutes=5)
    db.commit()
    _, run, allowed = claim(db, user.id, request("expire-four"))
    assert run and allowed.allowed
    grant_beta_premium(db, user.id); db.commit()
    for i in range(5):
        _, run, allowed = claim(db, user.id, request(f"beta-{i:04}"))
        assert run and allowed.allowed and allowed.remaining is None


def test_empty_then_successful_continuation_consumes_only_original_slot(db, monkeypatch):
    user, title = seed(db)
    monkeypatch.setattr(routes, "resolve_concierge_decision", lambda *a, **k: ConciergeDecision(None, ConciergeConstraints(), "", [], "empty", retrieval_exhausted=False, retrieval_state={"pending_ids": [str(title.id)]}))
    empty = routes.post_concierge_decision(request(), user, db)
    assert empty.allowance_remaining == 3
    captured = []
    def continued(*a, **k):
        captured.append(k)
        return ConciergeDecision(None, k["effective_constraints"], "", [title.id], "partial")
    monkeypatch.setattr(routes, "resolve_concierge_decision", continued)
    payload = routes.ConciergeRefineRequest(kind="continue_search", expected_version=1, idempotency_key="continue-01")
    good = routes.post_concierge_refinement(empty.decision_id, payload, user, db)
    assert captured[0]["retrieval_state"]["pending_ids"] == [str(title.id)]
    assert good.titles[0].title_id == title.id
    assert db.scalar(select(ConciergeAllowanceEntry.state)) == "consumed"
    replay = routes.post_concierge_refinement(empty.decision_id, payload, user, db)
    assert replay.version == 2 and len(captured) == 1
    payload.kind = "shorter"
    with pytest.raises(HTTPException) as error:
        routes.post_concierge_refinement(empty.decision_id, payload, user, db)
    assert error.value.status_code == 409


def test_failed_refinement_preserves_results_and_version(db, monkeypatch):
    user, title = seed(db)
    record = routes._persist_decision_record(db, user.id, ConciergeDecision(None, ConciergeConstraints(), "", [title.id], "partial"), "Comedy")
    db.commit()
    monkeypatch.setattr(routes, "resolve_concierge_decision", lambda *a, **k: ConciergeDecision(None, ConciergeConstraints(), "", [], "error", status_detail="request_timed_out"))
    with pytest.raises(HTTPException) as error:
        routes.post_concierge_refinement(record.id, routes.ConciergeRefineRequest(kind="shorter", idempotency_key="failure-01"), user, db)
    assert error.value.status_code == 503
    current = routes.get_concierge_decision(record.id, user, db)
    assert current.version == 1 and current.titles[0].title_id == title.id


@pytest.mark.parametrize("status,code", [(401,"provider_authentication_failed"), (403,"provider_authentication_failed"), (429,"provider_rate_limited"), (500,"provider_request_failed")])
def test_provider_errors_have_safe_distinct_codes(status, code):
    response = httpx.Response(status, request=httpx.Request("POST", "https://provider.invalid"))
    assert error_code(httpx.HTTPStatusError("secret body", request=response.request, response=response)) == code


def test_budget_and_structured_diagnostics(caplog):
    import logging
    with request_runtime("safe-server-id", seconds=0) as runtime:
        with pytest.raises(ConciergeDeadlineExceeded): timeout_for(10)
        with caplog.at_level(logging.INFO): report(runtime, status="error", code="request_timed_out", count=0, attempt=2)
    data = json.loads(caplog.records[-1].message)
    assert data["event"] == "concierge_request" and data["attempt"] == 2
    assert set(data) == {"event", "request_id", "status", "code", "result_count", "attempt", "elapsed_ms", "stages_ms"}


def test_recovered_results_recheck_deleted_list_ownership(db, monkeypatch):
    from app.models.social import Watchlist
    user, title = seed(db)
    wl = Watchlist(owner_user_id=user.id, name="Private list")
    db.add(wl); db.commit()
    constraints = ConciergeConstraints(collection_scope="named_list", collection_list_id=str(wl.id))
    monkeypatch.setattr(routes, "resolve_concierge_decision", lambda *a, **k: ConciergeDecision(None, constraints, "", [title.id], "partial"))
    payload = request(); payload.collection_list_id = wl.id
    result = routes.post_concierge_decision(payload, user, db)
    db.delete(wl); db.commit()
    for read in (
        lambda: routes.get_concierge_request(payload.idempotency_key, user, db),
        lambda: routes.get_concierge_decision(result.decision_id, user, db),
        lambda: routes.post_concierge_decision(payload, user, db),
    ):
        with pytest.raises(HTTPException) as error: read()
        assert error.value.status_code == 404


def test_more_like_selected_keeps_canonical_anchor_over_personal_number_one(db, monkeypatch):
    from app.services import concierge
    user, selected = seed(db)
    personal = ContentTitle(id=uuid4(), tmdb_id=346, content_type="series", title=selected.title)
    db.add(personal); db.commit()
    constraints = ConciergeConstraints(raw_intent="More like my number one", like_anchors=[selected.title], anchor_title_ids=[str(selected.id)])
    monkeypatch.setattr(concierge.settings, "concierge_ai_provider", "vertex")
    monkeypatch.setattr(concierge, "build_personal_context", lambda *a: concierge.PersonalContext(
        ranked_number_one={"title_id": str(personal.id), "title": personal.title, "media_type": "series"}))
    def retrieve(*a, **kwargs):
        assert kwargs["constraints"].anchor_title_ids == [str(selected.id)]
        return concierge.RetrievalResult([], True)
    monkeypatch.setattr(concierge, "_retrieve_candidates", retrieve)
    result = concierge.resolve_concierge_decision(db, user.id, "More like my number one; similar to selected", effective_constraints=constraints)
    assert result.constraints.anchor_title_ids == [str(selected.id)]
