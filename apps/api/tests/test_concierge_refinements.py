from uuid import uuid4
import pytest
from fastapi import HTTPException
from app.api.routes import concierge as routes
from app.models.content import ContentTitle
from app.models.user import User
from app.services.concierge import ConciergeConstraints, ConciergeDecision


def test_refinement_chain_undo_replay_and_stale_write(db, monkeypatch):
    user = User(id=uuid4(), email="refine@example.invalid", auth_provider="test")
    title = ContentTitle(id=uuid4(), tmdb_id=87, content_type="movie", title="A comedy")
    db.add_all([user, title])
    db.flush()
    constraints = ConciergeConstraints(genres=["comedy"], runtime_max=150, raw_intent="A comedy")
    decision = ConciergeDecision(None, constraints, "A comedy", [title.id], "partial")
    record = routes._persist_decision_record(db, user.id, decision, "A comedy")
    db.commit()
    calls = []

    def resolve(db, user_id, intent, **kwargs):
        calls.append(kwargs)
        return ConciergeDecision(
            None, kwargs["effective_constraints"], "Matched", [title.id], "partial"
        )

    monkeypatch.setattr(routes, "resolve_concierge_decision", resolve)
    shorter = routes.post_concierge_refinement(
        record.id,
        routes.ConciergeRefineRequest(
            kind="shorter", expected_version=1, idempotency_key="shorter-1"
        ),
        user,
        db,
    )
    assert shorter.constraints["runtime_max"] == 120
    provider = routes.post_concierge_refinement(
        record.id,
        routes.ConciergeRefineRequest(
            kind="only_provider", prompt="Netflix", expected_version=2, idempotency_key="provider-1"
        ),
        user,
        db,
    )
    assert provider.constraints["runtime_max"] == 120
    assert provider.constraints["required_providers"] == ["netflix"]
    assert provider.constraints["genres"] == ["comedy"]
    undo_request = routes.ConciergeRefineRequest(
        kind="undo", expected_version=3, idempotency_key="undo-0001"
    )
    undone = routes.post_concierge_refinement(record.id, undo_request, user, db)
    assert undone.version == 4 and undone.constraints["runtime_max"] == 120
    assert undone.constraints["required_providers"] == []
    assert len(calls) == 2  # Undo restores the actual snapshot, without generation.
    replay = routes.post_concierge_refinement(record.id, undo_request, user, db)
    assert replay.version == 4 and len(record.turns) == 4
    with pytest.raises(HTTPException) as error:
        routes.post_concierge_refinement(
            record.id,
            routes.ConciergeRefineRequest(
                kind="shorter", expected_version=2, idempotency_key="stale-0001"
            ),
            user,
            db,
        )
    assert error.value.status_code == 409 and len(calls) == 2


def test_foreign_decision_is_not_read(db):
    user = User(id=uuid4(), email="other@example.invalid", auth_provider="test")
    db.add(user)
    db.commit()
    with pytest.raises(HTTPException) as error:
        routes.post_concierge_refinement(
            uuid4(),
            routes.ConciergeRefineRequest(kind="undo", idempotency_key="foreign-1"),
            user,
            db,
        )
    assert error.value.status_code == 404
