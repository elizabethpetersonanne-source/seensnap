from uuid import uuid4
from app.models.content import ContentTitle
from app.models.social import Watchlist, WatchlistItem, Rating
from app.models.user import User
from app.services import concierge
from app.services.concierge_retrieval import retrieve


def title(i, runtime=120):
    return ContentTitle(
        id=uuid4(),
        tmdb_id=i,
        content_type="movie",
        title=f"Title {i}",
        overview="A thoughtful comedy about family.",
        genres=["Comedy"],
        runtime_minutes=runtime,
        metadata_raw={},
    )


def fake_review(monkeypatch):
    def review(intent, **kwargs):
        import json

        candidates = json.loads(kwargs["prompt_override"].split("Candidates: ")[1])
        return {
            "matches": [
                {"title_id": r["title_id"], "relevance": 90, "reason": "A family comedy."}
                for r in candidates
            ]
        }

    monkeypatch.setattr(concierge, "_call_configured_model", review)


def test_named_list_uses_full_membership_before_budget(db, monkeypatch):
    user = User(id=uuid4(), email="collection@example.invalid", auth_provider="test")
    wl = Watchlist(id=uuid4(), owner_user_id=user.id, name="Weekend")
    db.add(user)
    db.flush()
    db.add(wl)
    db.flush()
    rows = [title(i, 80 if i >= 600 else 120) for i in range(605)]
    db.add_all(rows)
    db.flush()
    db.add_all(
        [WatchlistItem(watchlist_id=wl.id, content_title_id=t.id, added_via="test") for t in rows]
    )
    db.commit()
    fake_review(monkeypatch)
    result = retrieve(
        db,
        user_id=user.id,
        suggested_names=[],
        constraints=concierge.ConciergeConstraints(
            collection_scope="named_list",
            collection_list_id=str(wl.id),
            runtime_max=90,
            raw_intent="Comedy under 90 minutes from my list",
        ),
        context=concierge.PersonalContext(),
    )
    assert set(result.title_ids) == {t.id for t in rows[600:]}
    assert result.exhausted


def test_foreign_list_is_not_read_or_broadened(db, monkeypatch):
    owner = User(id=uuid4(), email="owner@example.invalid", auth_provider="test")
    wl = Watchlist(id=uuid4(), owner_user_id=owner.id, name="Secret")
    db.add(owner)
    db.flush()
    db.add(wl)
    db.commit()

    def fail(*a, **kw):
        raise AssertionError("Foreign list must not call the model")

    monkeypatch.setattr(concierge, "_call_configured_model", fail)
    result = retrieve(
        db,
        user_id=uuid4(),
        suggested_names=["Anything"],
        constraints=concierge.ConciergeConstraints(
            collection_scope="named_list", collection_list_id=str(wl.id)
        ),
        context=concierge.PersonalContext(),
    )
    assert result.title_ids == []


def test_different_options_excludes_before_refill(db, monkeypatch):
    user = User(id=uuid4(), email="next@example.invalid", auth_provider="test")
    wl = Watchlist(id=uuid4(), owner_user_id=user.id, name="Queue", system_role="next_watch")
    rows = [title(i) for i in range(12)]
    db.add_all([user, *rows])
    db.flush()
    db.add(wl)
    db.flush()
    db.add_all(
        [WatchlistItem(watchlist_id=wl.id, content_title_id=t.id, added_via="test") for t in rows]
    )
    db.add(Rating(user_id=user.id, content_title_id=rows[-1].id, score=9, watched_state="watched"))
    db.commit()
    fake_review(monkeypatch)
    c = concierge.ConciergeConstraints(
        collection_scope="my_next_watch", excluded_title_ids=[str(t.id) for t in rows[:5]]
    )
    result = retrieve(
        db,
        user_id=user.id,
        suggested_names=[],
        constraints=c,
        context=concierge.PersonalContext(),
        target=5,
    )
    assert len(result.title_ids) == 5
    assert not set(result.title_ids) & {t.id for t in rows[:5] + rows[-1:]}
