from datetime import date
from uuid import uuid4
import httpx
import pytest
from app.models.content import ContentTitle
from app.models.user import User
from app.models.social import Watchlist, WatchlistItem
from app.models.discovery import DiscoveryDecision
from app.services import concierge, concierge_retrieval as retrieval
from app.services.concierge_refinement import refine_constraints


def test_language_and_tv_genres_are_hard_constraints():
    row = ContentTitle(id=uuid4(), title="Series", content_type="series", genres=["Sci-Fi & Fantasy"], metadata_raw={"original_language": "fr"})
    c = concierge.ConciergeConstraints(media_type="series", genres=["science fiction"], original_language="fr")
    assert concierge._passes_constraints(row, c)
    assert not retrieval.definitely_outside_request(row, c)
    c.original_language = "ja"
    assert not concierge._passes_constraints(row, c) and retrieval.definitely_outside_request(row, c)
    row.metadata_raw = {}
    assert not concierge._passes_constraints(row, c)
    row.release_date = date(2020, 1, 1)
    c = concierge.ConciergeConstraints(year_max=1989)
    assert retrieval.definitely_outside_request(row, c)


def test_new_discovery_excludes_saved_and_temporarily_dismissed_but_list_search_works(db, monkeypatch):
    from test_concierge_retrieval import title, fake_review
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    rows = [title(i) for i in range(8)]
    db.add_all([user, *rows]); db.flush()
    wl = Watchlist(id=uuid4(), owner_user_id=user.id, name="My list")
    db.add(wl); db.flush()
    db.add(WatchlistItem(watchlist_id=wl.id, content_title_id=rows[0].id, added_via="test"))
    db.add(DiscoveryDecision(id=uuid4(), user_id=user.id, content_title_id=rows[1].id, direction="left", action_version=2, sequence=1))
    db.commit()
    fake_review(monkeypatch)
    monkeypatch.setattr(concierge, "_ground_suggestions", lambda *a: [t.id for t in rows])
    monkeypatch.setattr(concierge, "_intent_matched_catalog_batch", lambda *a, **kw: [])
    result = retrieval.retrieve(db, user_id=user.id, suggested_names=["Films"], constraints=concierge.ConciergeConstraints(), context=concierge.PersonalContext())
    assert len(result.title_ids) == 5 and not set(result.title_ids) & {t.id for t in rows[:2]}
    result = retrieval.retrieve(db, user_id=user.id, suggested_names=[], constraints=concierge.ConciergeConstraints(collection_scope="named_list", collection_list_id=str(wl.id)), context=concierge.PersonalContext())
    assert result.title_ids == [rows[0].id]


def test_partial_model_review_preserves_only_individually_verified_matches():
    rows = [ContentTitle(id=uuid4()) for _ in range(5)]
    raw = {"matches": [{"title_id": str(rows[0].id), "relevance": 90, "reason": "Verified evidence"}]}
    assert len(retrieval.validated_matches(raw, rows, allow_partial=True)) == 1
    raw["matches"][0]["title_id"] = str(uuid4())
    with pytest.raises(ValueError): retrieval.validated_matches(raw, rows, allow_partial=True)


def test_followup_keeps_filters_and_resolves_the_second_actual_title(db, monkeypatch):
    rows = [ContentTitle(id=uuid4(), tmdb_id=i, content_type="movie", title=f"Title {i}") for i in range(2)]
    db.add_all(rows); db.commit()
    c = concierge.ConciergeConstraints(genres=["comedy"], year_min=1980, year_max=1989, required_providers=["netflix"], original_language="en")
    monkeypatch.setattr(concierge, "_call_configured_model", lambda *a, **kw: {"updates": {"moods": ["light"], "runtime_max": 90}})
    result = refine_constraints(db, c, "Something lighter and under 90 minutes", [str(t.id) for t in rows])
    assert result.moods == ["light"] and result.runtime_max == 89
    assert result.year_min == 1980 and result.required_providers == ["netflix"] and result.original_language == "en"
    result = refine_constraints(db, c, "more like the second one", [str(t.id) for t in rows])
    assert result.anchor_title_ids == [str(rows[1].id)] and result.genres == ["comedy"]
    assert c.anchor_title_ids == []


@pytest.mark.parametrize("location,host", [("global", "aiplatform.googleapis.com"), ("us", "aiplatform.us.rep.googleapis.com"), ("eu", "aiplatform.eu.rep.googleapis.com"), ("us-central1", "us-central1-aiplatform.googleapis.com")])
def test_vertex_uses_correct_endpoint_and_ignores_thought_parts(monkeypatch, location, host):
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"thought": True, "text": "Reasoning, not JSON"}, {"text": '{"media_type":"movie","suggested_titles":[]}'}]}}]})
    client = httpx.Client
    monkeypatch.setattr(concierge, "_vertex_access_token", lambda: "test-only")
    monkeypatch.setattr(concierge.httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(handle), **kwargs))
    output = concierge._call_vertex("comedy", project="test", location=location, model="gemini-3.5-flash-lite")
    assert output["media_type"] == "movie" and requests[0].url.host == host


def test_catalog_expansion_keeps_decade_language_runtime_and_services(db, monkeypatch):
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"results": [], "total_pages": 1})
    client = httpx.Client
    monkeypatch.setattr(retrieval.tmdb, "_tmdb_headers", lambda: {})
    monkeypatch.setattr(retrieval.tmdb, "_fetch_genre_map", lambda kind: {35: "Comedy"})
    monkeypatch.setattr(retrieval, "discover_provider_ids", lambda *a: [8])
    monkeypatch.setattr(retrieval.httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(handle), **kwargs))
    c = concierge.ConciergeConstraints(media_type="movie", genres=["comedy"], year_min=1980, year_max=1989, runtime_max=90, original_language="en", required_providers=["netflix"], region_code="GB")
    rows, done = retrieval.catalog_page(db, c, 1)
    params = requests[0].url.params
    assert params["primary_release_date.gte"] == "1980-01-01" and params["with_runtime.lte"] == "90"
    assert params["watch_region"] == "GB" and params["with_watch_providers"] == "8" and params["with_original_language"] == "en"
    assert rows == [] and done


def test_watch_options_are_current_and_in_the_viewers_country(db):
    from datetime import datetime, timedelta, timezone
    from app.models.user import UserProfile
    from app.models.content import ContentAvailability
    from app.api.routes.concierge import _hydrate_decision_titles
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    row = ContentTitle(id=uuid4(), tmdb_id=41, content_type="movie", title="A film")
    db.add_all([user, row]); db.flush()
    db.add(UserProfile(user_id=user.id, username=user.id.hex, display_name="Viewer", country_code="GB"))
    for country, days, name in [("GB", 1, "Fresh"), ("US", 1, "Wrong country"), ("GB", -1, "Expired")]:
        db.add(ContentAvailability(content_title_id=row.id, provider_code=name, provider_name=name,
            region_code=country, monetization_type="flatrate", expires_at=datetime.now(timezone.utc) + timedelta(days=days)))
    db.commit()
    cards = _hydrate_decision_titles(db, [row.id], user.id)
    assert [offer.provider_name for offer in cards[0].watch_options] == ["Fresh"]


def test_explicit_rewatch_includes_unrated_watched_titles(db, monkeypatch):
    from test_concierge_retrieval import title, fake_review
    from app.models.social import TitleWatchStatus
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    row = title(11)
    db.add_all([user, row]); db.flush()
    db.add(TitleWatchStatus(user_id=user.id, content_title_id=row.id, watched_state="watched")); db.commit()
    fake_review(monkeypatch)
    result = retrieval.retrieve(db, user_id=user.id, suggested_names=[], constraints=concierge.ConciergeConstraints(collection_scope="watched", rewatch_intent=True), context=concierge.PersonalContext())
    assert result.title_ids == [row.id]


@pytest.mark.parametrize("prompt", ["Help me choose from one of my saved lists.", "Choose from my weekend list", "Only from my lists"])
def test_suggested_saved_list_prompt_is_a_hard_source_constraint(prompt):
    result = concierge._resolve_collection_scope(concierge.ConciergeConstraints(), prompt)
    assert result.collection_scope == "named_list" and result.collection_list_id is None
