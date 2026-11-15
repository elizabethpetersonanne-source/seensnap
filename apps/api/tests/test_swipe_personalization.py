"""Behavioral recommendation checks with held-out synthetic catalog data.

These measure causal separation/coverage, not production user satisfaction.
No external service, private account or provider credential is used.
"""
from datetime import date, datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.content import ContentTitle
from app.models.discovery import DiscoverySession
from app.models.social import Rating, Watchlist, WatchlistItem
from app.models.user import User, UserProfile
from app.services import discovery_feed as feed, discovery_personalization as personal
from app.services.title_compatibility import scorer_for_user, TitleScorer, Evidence, title_features


def raw(n, genre="Comedy", *, kind="movie", year=2020, keyword=101):
    return {"id": n, "media_type": kind, "title": f"{genre} {n}", "name": f"{genre} {n}",
            "overview": "A complete synopsis", "poster_path": "/poster.jpg", "release_date": f"{year}-01-01",
            "first_air_date": f"{year}-01-01", "genres": [{"id": 35 if genre == "Comedy" else 99, "name": genre}],
            "original_language": "en", "keywords": {"keywords": [{"id": keyword,
                "name": {101: "psychological thriller", 202: "wildlife conservation", 999: "car chase"}.get(keyword, "found family")}]},
            "credits": {"cast": [], "crew": []},
            "watch/providers": {"results": {"US": {"flatrate": [{"provider_id": 8}]}}}}


def owner(db):
    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(user); db.flush()
    db.add(UserProfile(user_id=user.id, username=user.id.hex, display_name="Viewer", country_code="US"))
    db.commit(); return user


def seed(db, user, n, genre="Comedy", *, score=9, kind="movie", keyword=101):
    title = personal._upsert_title_from_tmdb_result(db, raw(n, genre, kind=kind, keyword=keyword))
    db.add(Rating(user_id=user.id, content_title_id=title.id, score=score, watched_state="watched"))
    db.commit(); return title


def test_seed_selection_rotates_entire_saved_library_and_ignores_dislikes(db):
    user = owner(db)
    favorite = seed(db, user, 1)
    bad = seed(db, user, 2, score=1)
    saved = [personal._upsert_title_from_tmdb_result(db, raw(n)) for n in range(3, 33)]
    wl = Watchlist(owner_user_id=user.id, name="Older favorites", visibility="private")
    db.add(wl); db.flush()
    db.add_all([WatchlistItem(watchlist_id=wl.id, content_title_id=t.id, added_via="test") for t in saved]); db.commit()
    state, observed = {}, set()
    model = scorer_for_user(db, user.id)
    retrieved = set()
    for _ in range(34):
        picks = personal.positive_seeds(db, model, state)
        assert favorite in picks and bad not in picks and len(picks) <= 6
        observed.update(t.id for t in picks)
        retrieved.update(UUID(job["seed"]) for job in personal.plan_sources(model, picks, state) if job.get("seed"))
    assert observed == {favorite.id, *(t.id for t in saved)}
    assert retrieved == observed


def test_personalized_retrieval_changes_movie_and_tv_decks_between_users(db, monkeypatch):
    monkeypatch.setattr(settings, "tmdb_api_key", "isolated-test")
    monkeypatch.setattr(feed, "private_sources", lambda *a: ([], []))
    for kind in ("movie", "tv"):
        users = [owner(db), owner(db)]
        corpus = {}
        for person, genre, offset, keyword in zip(users, ("Comedy", "Documentary"), (1000, 2000), (101, 202)):
            for n in range(offset, offset + 8):
                seed(db, person, n, genre, kind=kind, keyword=keyword)
                corpus[n] = raw(n, genre, kind=kind, keyword=keyword)
        def sources(job, *args):
            keyword = int(job["params"].get("with_keywords", 0))
            is_comedy = keyword == 101 or (job.get("seed") and 1000 <= int(job["path"].split("/")[2]) < 2000)
            if not job.get("seed") and not keyword:
                is_comedy = job["params"].get("taste_genre") == "comedy"
            genre, kw, start = ("Comedy", 101, 10000) if is_comedy else ("Documentary", 202, 20000)
            rows = [raw(start + n, genre, kind=kind, year=1980, keyword=kw) for n in range(20)]
            corpus.update({r["id"]: r for r in rows})
            return {"rows": rows, "done": True}
        def catalog(kind, band, page, *args):
            rows = [raw(30000 + band*100 + n, "Comedy" if n%2 else "Documentary", kind=kind,
                        year=(2020, 2010, 2000, 1960)[band], keyword=303) for n in range(8)]
            corpus.update({r["id"]: r for r in rows})
            return {"rows": rows, "done": True, "cap": False}
        monkeypatch.setattr(personal, "fetch_source", sources)
        monkeypatch.setattr(personal, "fetch_evidence", lambda kind, n: corpus[n])
        monkeypatch.setattr(feed, "catalog_page", catalog)
        decks = [feed.get_feed(db, person.id, preferred_type="movie" if kind == "movie" else "show") for person in users]
        for response, wanted in zip(decks, ("Comedy", "Documentary")):
            items = response["items"]
            assert len(items) == 20
            assert sum(wanted in item["title"]["genres"] for item in items) >= 14
            assert sum(item["title"]["release_date"].startswith("1980") for item in items) >= 6
            assert any(item["reason"].startswith("You rated") for item in items)
        ids = [{x["title"]["id"] for x in d["items"]} for d in decks]
        assert len(ids[0] & ids[1]) <= 6


def test_evidence_adds_real_theme_separation_and_never_fabricates_it():
    examples = [ContentTitle(id=uuid4(), title="Favorite", content_type="movie", genres=["Thriller"],
                 release_date=date(2020, 1, 1), metadata_raw=raw(i, "Thriller", keyword=101)) for i in range(12)]
    model = TitleScorer({t.id: Evidence(t.id, .75, "rating") for t in examples}, 12,
                        {t.id: title_features(t) for t in examples})
    same_theme = ContentTitle(id=uuid4(), content_type="movie", title="Psychological", genres=["Thriller"],
                             release_date=date(2020, 1, 1), metadata_raw=raw(50, "Thriller", keyword=101))
    other_theme = ContentTitle(id=uuid4(), content_type="movie", title="Car chase", genres=["Thriller"],
                              release_date=date(2020, 1, 1), metadata_raw=raw(51, "Thriller", keyword=999))
    assert model.score(same_theme).score > model.score(other_theme).score + 10
    same_theme.metadata_raw = {}; other_theme.metadata_raw = {}
    assert model.score(same_theme).score == model.score(other_theme).score


def test_composition_prefers_old_strong_matches_caps_social_and_diversifies():
    titles, scores, social = {}, {}, {}
    for n in range(40):
        key = str(n)
        titles[key] = ContentTitle(title=key, genres=["Comedy" if n%2 else "Drama"], release_date=date(1960 if n<14 else 2020, 1, 1))
        strong = n < 14
        scores[key] = SimpleNamespace(score=90 if strong else 55, confidence=.8,
            breakdown=[SimpleNamespace(dimension="exemplars" if strong else "format", score=90 if strong else 55)])
        if n >= 20: social[key] = "In your Watch Teams"
    selected, history = personal.compose(titles, scores, social, 20)
    assert sum(int(key) < 14 for key in selected) == 14
    assert sum(key in social for key in selected) == 2
    assert len(set(selected)) == 20
    assert titles[selected[0]].genres != titles[selected[1]].genres
    next_rows = {key: t for key, t in titles.items() if key not in selected}
    _, history2 = personal.compose(next_rows, scores, social, 5, history)
    assert sum(h["kind"] == "social" for h in history2) <= 2


def test_provider_evidence_rejects_wrong_region_and_retains_partial_metadata(db, monkeypatch):
    title = personal._upsert_title_from_tmdb_result(db, raw(1))
    title.metadata_raw = {**title.metadata_raw, "images": {"backdrops": [{"file_path": "/keep"}]}}
    monkeypatch.setattr(personal, "fetch_evidence", lambda *a: raw(1))
    assert personal.enrich_evidence(db, [title], "GB", limit=1) == 0
    assert "GB:streaming" not in title.metadata_raw.get("_discovery_availability", {})
    assert title.metadata_raw["images"]["backdrops"]
    assert title.metadata_raw["_discovery_provider_checks"]["GB"]
    assert not personal.needs_evidence(title, "GB")
    assert personal.needs_evidence(title, "US")  # A GB cooldown cannot suppress US evidence.


def test_retrieval_failure_falls_back_without_losing_cursor(db, monkeypatch):
    user = owner(db); seed(db, user, 1)
    monkeypatch.setattr(settings, "tmdb_api_key", "isolated-test")
    monkeypatch.setattr(personal, "enrich_evidence", lambda *a, **k: 0)
    monkeypatch.setattr(feed, "private_sources", lambda *a: ([], []))
    def unavailable(*a): raise httpx.ConnectError("unavailable")
    monkeypatch.setattr(personal, "fetch_source", unavailable)
    monkeypatch.setattr(feed, "catalog_page", lambda kind, band, page, *a: {
        "rows": [raw(1000+band*100+page*20+n) for n in range(20)], "done": False, "cap": False})
    first = feed.get_feed(db, user.id, preferred_type="movie")
    second = feed.get_feed(db, user.id, preferred_type="movie", cursor=first["next_cursor"])
    assert len(first["items"]) == len(second["items"]) == 20
    assert not ({i["title"]["id"] for i in first["items"]} & {i["title"]["id"] for i in second["items"]})
    session = db.get(DiscoverySession, UUID(first["session_id"]))
    assert all(s["page"] == 1 for s in session.state["taste_sources"].values())


@pytest.mark.parametrize("kind", ["movie", "tv"])
def test_trait_query_preserves_genre_region_and_media(monkeypatch, kind):
    seen = {}
    monkeypatch.setattr(personal, "_fetch_genre_map", lambda k: {35: "Comedy", 99: "Documentary"})
    monkeypatch.setattr(personal, "_tmdb_headers", lambda: {})
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, path, params):
            seen.update(path=path, params=params)
            return httpx.Response(200, json={"results": [], "total_pages": 1}, request=httpx.Request("GET", "https://test.invalid"))
    monkeypatch.setattr(personal.httpx, "Client", Client)
    personal.fetch_source({"kind": kind, "regional": True, "path": f"/discover/{kind}", "page": 2,
                           "params": {"with_keywords": "123"}}, "documentary", "GB", "streaming", date(2026, 11, 14))
    assert seen["path"] == f"/discover/{kind}"
    assert seen["params"]["with_keywords"] == "123"
    assert seen["params"]["with_genres"] == "99"
    assert seen["params"]["watch_region"] == "GB"


def test_cached_seed_reason_is_removed_when_user_dislikes_seed(db):
    user = owner(db); title = seed(db, user, 1)
    origin = {"seed": str(title.id)}
    assert personal.personal_reason(db, scorer_for_user(db, user.id), origin).startswith("You rated")
    rating = db.scalar(select(Rating).where(Rating.user_id == user.id)); rating.score = 1; db.commit()
    assert personal.personal_reason(db, scorer_for_user(db, user.id), origin) is None


def test_rerank_updates_unseen_titles_but_keeps_front_and_cursor(db, monkeypatch):
    from app.api.routes.discovery_resume import ResumeRequest, resume_discovery
    user = owner(db)
    monkeypatch.setattr(feed, "private_sources", lambda *a: ([], []))
    monkeypatch.setattr(feed, "catalog_page", lambda kind, band, page, *a: {
        "rows": [raw(100 + band*100+n) for n in range(10)], "done": True, "cap": False})
    first = feed.get_feed(db, user.id, preferred_type="movie", limit=10)
    ids = [UUID(i["title"]["id"]) for i in first["items"]]
    favorite = db.get(ContentTitle, ids[-1]); favorite.genres = ["Documentary"]
    favorite.metadata_raw = {**favorite.metadata_raw, "keywords": {"keywords": [{"id": 202, "name": "wildlife conservation"}]}}
    for n in range(6): seed(db, user, 10000+n, "Documentary", keyword=202)
    result = resume_discovery(ResumeRequest(cursor=first["resume_cursor"], title_ids=ids,
        surface="swipe", preferred_type="movie", rerank=True), user, db)
    reordered = [UUID(item["title"]["id"]) for item in result["items"]]
    assert reordered[:2] == ids[:2]
    assert reordered[2] == ids[-1]
    assert set(reordered) == set(ids)
    assert result["resume_cursor"] == first["resume_cursor"]
    assert db.get(DiscoverySession, UUID(first["session_id"])).version == 1


def test_related_candidates_cannot_bypass_genre_type_release_or_region(db, monkeypatch):
    user = owner(db); anchor = seed(db, user, 1, kind="tv")
    monkeypatch.setattr(settings, "tmdb_api_key", "isolated-test")
    monkeypatch.setattr(feed, "private_sources", lambda *a: ([], []))
    monkeypatch.setattr(feed, "catalog_page", lambda *a: {"rows": [], "done": True, "cap": False})
    corpus = {n: raw(n, kind="tv") for n in range(1, 7)}
    corpus[2] = raw(2, "Documentary", kind="tv")
    corpus[3] = raw(3, kind="movie")
    corpus[4] = raw(4, kind="tv", year=2099)
    corpus[5]["watch/providers"] = {"results": {"GB": {"flatrate": [{"provider_id": 8}]}}}
    monkeypatch.setattr(personal, "fetch_source", lambda *a: {"rows": [corpus[n] for n in range(2, 7)], "done": True})
    # Only the recommendations source: it has no implicit regional evidence.
    def plan(model, seeds, state, *args):
        key = f"seed:{anchor.id}"
        state["taste_sources"] = {f"trait:tv:{dim}:{attr}": {"page": 1, "done": True}
                                  for dim, attr in personal.attribute_affinities(model)
                                  if dim not in {"actors", "directors"}}
        state["taste_sources"][key] = {"page": 1, "done": False}
        return [{"key": key, "seed": str(anchor.id), "kind": "tv", "regional": False, "page": 1}]
    monkeypatch.setattr(personal, "plan_sources", plan)
    monkeypatch.setattr(personal, "fetch_evidence", lambda kind, n: corpus[n])
    result = feed.get_feed(db, user.id, preferred_type="show", genre="Comedy")
    assert [item["title"]["tmdb_id"] for item in result["items"]] == [6]
    # Warm feeds inspect only two generic catalog lanes per request; the
    # remaining lanes are still scanned before declaring true exhaustion.
    next_page = feed.get_feed(db, user.id, preferred_type="show", genre="Comedy", cursor=result["next_cursor"])
    assert not next_page["items"] and not next_page["has_more"]


def test_metadata_work_is_bounded_and_failed_titles_cool_down(db, monkeypatch):
    titles = [personal._upsert_title_from_tmdb_result(db, raw(n)) for n in range(1, 21)]
    calls = []
    def failure(kind, number):
        calls.append(number); raise httpx.ConnectError("provider unavailable")
    monkeypatch.setattr(personal, "fetch_evidence", failure)
    assert personal.enrich_evidence(db, titles, "US", limit=8) == 8
    assert len(calls) == 8
    assert not any(personal.needs_evidence(t, "US") for t in titles[:8])
    assert personal.enrich_evidence(db, titles, "US", limit=8) == 8
    assert len(set(calls)) == 16
