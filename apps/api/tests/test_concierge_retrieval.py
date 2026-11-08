from uuid import UUID, uuid4
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


def test_semantic_search_continues_after_budget_without_rechecking_old_titles(db, monkeypatch):
    import json
    from datetime import datetime, timezone, timedelta
    from app.services.concierge_retrieval import MAX_REVIEW_BATCHES, REVIEW_BATCH_SIZE
    user = User(id=uuid4(), email="deep@example.invalid", auth_provider="test")
    wl = Watchlist(id=uuid4(), owner_user_id=user.id, name="Deep list")
    count = MAX_REVIEW_BATCHES * REVIEW_BATCH_SIZE + 10
    rows = [title(i) for i in range(count)]
    db.add_all([user, *rows]); db.flush(); db.add(wl); db.flush()
    now = datetime.now(timezone.utc)
    db.add_all([WatchlistItem(watchlist_id=wl.id, content_title_id=t.id, added_via="test", created_at=now-timedelta(seconds=i)) for i,t in enumerate(rows)])
    db.commit()
    reviewed = []
    def review(intent, **kwargs):
        candidates = json.loads(kwargs["prompt_override"].split("Candidates: ")[1])
        reviewed.extend(c["title_id"] for c in candidates)
        return {"matches": [{"title_id": c["title_id"], "relevance": 90 if int(c["title"].split()[-1]) >= count-10 else 10, "reason": "Verified synopsis evidence"} for c in candidates]}
    monkeypatch.setattr(concierge, "_call_configured_model", review)
    c = concierge.ConciergeConstraints(collection_scope="named_list", collection_list_id=str(wl.id), raw_intent="Specific theme from my list")
    first = retrieve(db, user_id=user.id, suggested_names=[], constraints=c, context=concierge.PersonalContext())
    assert first.title_ids == [] and not first.exhausted and first.partial_reason == "retrieval_budget_reached"
    second = retrieve(db, user_id=user.id, suggested_names=[], constraints=c, context=concierge.PersonalContext(), continuation=first.retrieval_state)
    assert len(second.title_ids) == 5 and len(reviewed) == count and len(set(reviewed)) == count
    # Remove one cached match; continuation must recheck live membership.
    cached = next(iter(second.retrieval_state["approved"]))
    db.query(WatchlistItem).filter(WatchlistItem.watchlist_id == wl.id, WatchlistItem.content_title_id == UUID(cached)).delete()
    db.commit()
    c.excluded_title_ids = [str(t) for t in second.title_ids]
    third = retrieve(db, user_id=user.id, suggested_names=[], constraints=c, context=concierge.PersonalContext(), continuation=second.retrieval_state)
    assert len(third.title_ids) == 4 and third.exhausted
    assert cached not in [str(t) for t in third.title_ids] and len(reviewed) == count


def test_omitted_relevance_assessment_cannot_pass():
    import pytest
    from app.services.concierge_retrieval import validated_matches
    rows = [title(1), title(2)]
    with pytest.raises(ValueError):
        validated_matches({"matches": [{"title_id": str(rows[0].id), "relevance": 90, "reason": "Only one reviewed"}]}, rows)
