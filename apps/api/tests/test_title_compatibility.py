from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4
from decimal import Decimal
import pytest
from app.core.scenedna_config import WEIGHTS
from app.models.content import ContentTitle
from app.models.social import Rating, RankedFavorite, Watchlist, WatchlistItem
from app.models.taste import SwipeRecord
from app.models.user import User
from app.services.title_compatibility import (
    Evidence,
    TitleScorer,
    effective_evidence,
    title_features,
    scorer_for_user,
)


def title(number=1, **kwargs):
    values = dict(
        id=uuid4(),
        tmdb_id=number,
        title=f"Title {number}",
        content_type="series",
        genres=["Comedy"],
        release_date=date(2020, 1, 1),
        metadata_raw={
            "original_language": "en",
            "keywords": {"results": [{"id": 7, "name": "friendship"}]},
            "credits": {
                "cast": [{"id": 10, "order": 0}],
                "crew": [{"id": 20, "job": "Director"}, {"id": 30, "job": "Screenplay"}],
            },
            "production_companies": [{"id": 40}],
        },
    )
    return ContentTitle(**(values | kwargs))


def test_effective_signal_supersedes_duplicates_and_neutral_actions():
    a, b, c, d, e, f = [uuid4() for _ in range(6)]
    evidence, count = effective_evidence(
        {a: 1, b: 6},
        {a: 1, c: 40},
        {a, b, c, d},
        {a: {"right"}, b: {"down"}, d: {"right"}, e: {"left"}, f: {"up", "right"}},
        {f},
    )
    assert count == 2 and len(evidence) == 3
    assert evidence[a].utility == -1 and evidence[a].boost == 1
    assert b not in evidence and e not in evidence and f not in evidence
    assert evidence[c].utility == 0.3 and 1 < evidence[c].boost <= 1.2
    assert evidence[d].utility == 0.3
    without, _ = effective_evidence({a: None}, {}, {}, {a: {"right"}}, set())
    assert without[a].utility == 0.2


def test_missing_metadata_is_unavailable_and_genre_inference_is_not_semantic_evidence():
    t = title(metadata_raw={}, release_date=None)
    heuristic = SimpleNamespace(
        source="tmdb_v0", enrichment_version=0, tone=["dark"], pacing="slow"
    )
    features = title_features(t, heuristic)
    assert not features["exemplars"] and not features["language"] and not features["directors"]
    assert features["format"] == {"series": 1.0}
    assert sum(WEIGHTS.values()) == 100
    model = TitleScorer({t.id: Evidence(t.id, 1, "rating")}, 1, {t.id: features})
    result = model.score_features(features)
    assert result.percentage is None and result.learning
    assert set(result.available_dimensions) == {"genres", "format"}
    assert result.score > 50


def test_credits_use_person_company_ids_roles_and_normalized_contributions():
    t = title(
        metadata_raw={
            "created_by": [{"id": 99}],
            "credits": {
                "cast": [{"id": i + 1, "order": i} for i in range(30)],
                "crew": [
                    {"id": 40, "job": "Creator"},
                    {"id": 41, "job": "Director"},
                    {"id": 42, "job": "Screenplay"},
                    {"id": 43, "job": "Writer"},
                ],
            },
            "production_companies": [{"id": 44}, {"id": 45}],
        }
    )
    f = title_features(t)
    assert len(f["actors"]) == 8 and sum(f["actors"].values()) == 1
    assert f["directors"] == {"41": 1} and f["writers"] == {"42": 0.5, "43": 0.5}
    assert f["studios"] == {"44": 0.5, "45": 0.5}
    assert "99" not in f["directors"]


def test_coverage_and_sign_are_conservative_and_versioned():
    titles = [title(i) for i in range(12)]
    features = {t.id: title_features(t) for t in titles}
    candidate = title_features(title(99))
    positive = TitleScorer(
        {t.id: Evidence(t.id, 1, "rating") for t in titles}, 12, features
    ).score_features(candidate)
    negative = TitleScorer(
        {t.id: Evidence(t.id, -1, "rating") for t in titles}, 12, features
    ).score_features(candidate)
    assert 50 < positive.percentage < 100 and 0 < negative.percentage < 50
    assert positive.confidence >= 0.35 and positive.evidence_count == 12
    assert positive.score_version == "scenedna_title_v1"
    cold = TitleScorer({}, 0, {}).score_features(candidate)
    assert cold.score is None and cold.percentage is None and cold.confidence == 0
    custom = dict(WEIGHTS)
    custom["genres"] += 10
    custom["exemplars"] -= 10
    revised = TitleScorer(
        {t.id: Evidence(t.id, 1, "rating") for t in titles},
        12,
        features,
        version="experiment_v2",
        weights=custom,
    ).score_features(candidate)
    assert revised.score_version == "experiment_v2"
    with pytest.raises(ValueError):
        TitleScorer({}, 0, {}, weights=dict(WEIGHTS) | {"genres": 0})


def test_database_score_deduplicates_memberships_and_updates_without_stale_cache(db):
    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    titles = [title(i) for i in range(12)]
    candidate = title(900)
    db.add_all([user, *titles, candidate])
    db.flush()
    for t in titles:
        db.add(
            Rating(
                user_id=user.id,
                content_title_id=t.id,
                score=Decimal(10),
                watched_state="watched",
                version=1,
            )
        )
    db.commit()
    before = scorer_for_user(db, user.id, [candidate]).score(candidate)
    for n in range(3):
        wl = Watchlist(owner_user_id=user.id, name=f"List {n}")
        db.add(wl)
        db.flush()
        db.add(WatchlistItem(watchlist_id=wl.id, content_title_id=titles[0].id, added_via="test"))
    for n in range(3):
        db.add(
            SwipeRecord(
                user_id=user.id, content_title_id=titles[0].id, direction="right", action_version=2
            )
        )
    db.commit()
    assert scorer_for_user(db, user.id, [candidate]).score(candidate).score == before.score
    for r in db.query(Rating).filter_by(user_id=user.id):
        r.score = Decimal(1)
    db.commit()
    assert scorer_for_user(db, user.id, [candidate]).score(candidate).score < 50


def test_tv_for_you_responds_to_two_real_users_and_keeps_movie_pool_out(db):
    from app.services.for_you import for_you_recommendations

    comedy_user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    doc_user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    training = [title(1000 + i, genres=["Comedy"] if i < 6 else ["Documentary"]) for i in range(12)]
    candidates = [
        title(
            2000 + i,
            genres=["Comedy"] if i < 2 else ["Documentary"],
            poster_url="https://image.invalid/poster",
            overview="A real synopsis",
        )
        for i in range(4)
    ]
    movies = [
        title(
            3000 + i,
            content_type="movie",
            poster_url="https://image.invalid/poster",
            overview="Popular movie",
            metadata_raw={"popularity": 9999},
        )
        for i in range(405)
    ]
    db.add_all([comedy_user, doc_user, *training, *candidates, *movies])
    db.flush()
    for t in training[:6]:
        db.add(
            Rating(
                user_id=comedy_user.id,
                content_title_id=t.id,
                score=Decimal(10),
                watched_state="watched",
            )
        )
    for t in training[6:]:
        db.add(
            Rating(
                user_id=doc_user.id,
                content_title_id=t.id,
                score=Decimal(10),
                watched_state="watched",
            )
        )
    db.commit()
    a = for_you_recommendations(db, comedy_user.id, preferred_type="show", limit=2)
    b = for_you_recommendations(db, doc_user.id, preferred_type="show", limit=2)
    assert all(r.title.content_type == "series" for r in a + b)
    assert all("Comedy" in r.title.genres for r in a)
    assert all("Documentary" in r.title.genres for r in b)
    assert a[0].title.scenedna.score_version == "scenedna_title_v1"
    again = scorer_for_user(db, comedy_user.id, [db.get(ContentTitle, a[0].title.id)]).score(
        db.get(ContentTitle, a[0].title.id)
    )
    assert again.score == a[0].title.scenedna.score


def test_service_affinity_requires_positive_resolved_viewing_not_subscriptions(db):
    from app.models.content import ContentAvailability
    from app.models.user import UserProfile
    from app.models.watch_handoff import WatchHandoff

    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    watched, candidate = title(10), title(11)
    db.add_all([user, watched, candidate])
    db.flush()
    db.add(
        UserProfile(user_id=user.id, username=user.id.hex, country_code="CA", display_name="Viewer")
    )
    db.add(Rating(user_id=user.id, content_title_id=watched.id, score=9))
    db.add(
        ContentAvailability(
            content_title_id=candidate.id,
            provider_code="netflix",
            provider_name="Netflix",
            region_code="CA",
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
    )
    db.commit()
    assert (
        "services"
        not in scorer_for_user(db, user.id, [candidate]).score(candidate).available_dimensions
    )
    handoff = WatchHandoff(
        user_id=user.id,
        content_title_id=watched.id,
        provider_code="netflix",
        resolved_action="not_yet",
    )
    db.add(handoff)
    db.commit()
    assert (
        "services"
        not in scorer_for_user(db, user.id, [candidate]).score(candidate).available_dimensions
    )
    handoff.resolved_action = "watched"
    handoff.resolved_at = datetime.now(timezone.utc)
    db.commit()
    assert (
        "services"
        in scorer_for_user(db, user.id, [candidate]).score(candidate).available_dimensions
    )
    db.query(Rating).filter_by(user_id=user.id).one().score = 2
    db.commit()
    assert (
        "services"
        not in scorer_for_user(db, user.id, [candidate]).score(candidate).available_dimensions
    )


def test_influence_correction_survives_pruned_history_and_is_owner_only(db, monkeypatch):
    from app.models.discovery import DiscoveryDecision
    from app.api.routes.scene_dna import disable_signal, enable_signal, list_signals
    from fastapi import HTTPException

    monkeypatch.setattr("app.services.user_signals.compute_user_signals", lambda *a: None)
    monkeypatch.setattr("app.services.taste.refresh_taste_profile", lambda *a: None)
    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    other = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    t = title()
    db.add_all([user, other, t])
    db.flush()
    swipe = SwipeRecord(
        id=uuid4(), user_id=user.id, content_title_id=t.id, direction="down", action_version=2
    )
    decision = DiscoveryDecision(
        id=swipe.id, user_id=user.id, content_title_id=t.id, direction="down", action_version=2
    )
    db.add_all([swipe, decision])
    db.commit()
    assert scorer_for_user(db, user.id, [t]).score(t).score < 50
    disable_signal(decision.id, user, db)
    db.delete(swipe)
    db.commit()
    assert scorer_for_user(db, user.id, [t]).score(t).score is None
    listing = list_signals(user, db, limit=30, offset=0)
    assert listing.total == 1 and not listing.items[0].influence_active
    with pytest.raises(HTTPException) as denied:
        enable_signal(decision.id, other, db)
    assert denied.value.status_code == 404
    enable_signal(decision.id, user, db)
    assert scorer_for_user(db, user.id, [t]).score(t).score < 50
    decision.undone_at = datetime.now(timezone.utc)
    db.commit()
    assert list_signals(user, db, limit=30, offset=0).total == 0


def test_compatibility_http_uses_authenticated_owner_and_concierge_same_base(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.dependencies import get_db, get_current_user
    from app.api.routes.title_compatibility import router
    from app.api.routes.concierge import _hydrate_decision_titles

    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    other = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    watched, candidate = title(10), title(11)
    db.add_all([user, other, watched, candidate])
    db.flush()
    db.add(Rating(user_id=user.id, content_title_id=watched.id, score=10))
    db.commit()
    app = FastAPI()
    app.include_router(router, prefix="/me/title-compatibility")
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    assert client.get(f"/me/title-compatibility/{candidate.id}").status_code == 401
    app.dependency_overrides[get_current_user] = lambda: user
    direct = client.get(f"/me/title-compatibility/{candidate.id}?user_id={other.id}").json()
    batch = client.post("/me/title-compatibility", json={"title_ids": [str(candidate.id)]}).json()[
        str(candidate.id)
    ]
    concierge = _hydrate_decision_titles(db, [candidate.id], user.id)[0].scenedna
    assert direct["score"] == batch["score"] == concierge.score
    assert direct["percentage"] is None and direct["learning"]
    assert (
        client.post(
            "/me/title-compatibility", json={"title_ids": [str(candidate.id)] * 101}
        ).status_code
        == 422
    )
    app.dependency_overrides[get_current_user] = lambda: other
    assert client.get(f"/me/title-compatibility/{candidate.id}").json()["score"] is None


def test_legacy_mode_response_keeps_shared_score_and_honest_cold_start(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Legacy semantic query needs PostgreSQL")
    from app.services.recommendation_service import recommend_for_user

    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    candidate = title(1, tmdb_vote_average=Decimal("8.5"))
    db.add_all([user, candidate])
    db.commit()
    result = recommend_for_user(db, user.id, limit=5)
    assert len(result) == 1 and result[0]["confidence"] == "cold-start"
    assert result[0]["scenedna"].score is None and result[0]["scenedna"].percentage is None
    assert result[0]["score"] == 0.5
