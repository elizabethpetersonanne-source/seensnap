"""Exercise selected titles across surfaces, not just explanation wording."""
from datetime import date, datetime, timedelta, timezone
import json
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.content import ContentTitle
from app.models.discovery import DiscoverySession
from app.models.social import Rating, Watchlist, WatchlistItem
from app.models.user import User, UserProfile
from app.services import concierge, concierge_retrieval as retrieval, for_you, viewing_style as style
from app.services import taste_candidates as taste
from app.services.related_titles import rank_related_titles
from test_viewing_style import STYLIZED, EPISODIC, title, model


def viewer(db):
    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(user); db.flush()
    db.add(UserProfile(user_id=user.id, username=user.id.hex, display_name="Viewer", country_code="US"))
    db.flush()
    return user


def setup(db, monkeypatch):
    users = [viewer(db), viewer(db)]
    favorites = [title(n) for n in range(1, 13)]
    choices = [title(n) for n in range(100, 120)]
    for row in favorites + choices:
        row.poster_url = "https://example.invalid/poster.jpg"
    db.add_all(favorites + choices); db.flush()
    for index, user in enumerate(users):
        db.add_all(Rating(user_id=user.id, content_title_id=t.id, score=9, watched_state="watched")
                   for t in favorites[index*6:(index+1)*6])
    db.commit()
    styles = {f"series:{t.tmdb_id}": STYLIZED if t.tmdb_id <= 6 or 100 <= t.tmdb_id < 110 else EPISODIC
              for t in favorites + choices}
    calls = model(monkeypatch, styles)
    monkeypatch.setattr(settings, "tmdb_api_key", "")
    return users, favorites, choices, calls


def own_list(db, user, rows):
    wl = Watchlist(owner_user_id=user.id, name="Tonight")
    db.add(wl); db.flush()
    db.add_all(WatchlistItem(watchlist_id=wl.id, content_title_id=t.id, added_via="test") for t in rows)
    db.commit()
    return concierge.ConciergeConstraints(collection_scope="named_list", collection_list_id=str(wl.id), media_type="series")


def review(monkeypatch, relevance=None):
    calls = []
    def call(intent, **kwargs):
        payload = json.loads(kwargs["prompt_override"].split("Candidates: ")[1])
        calls.append(payload)
        return {"matches": [{"title_id": item["title_id"], "relevance": (relevance or {}).get(item["title_id"], 90),
                            "reason": "Verified request match."} for item in payload]}
    monkeypatch.setattr(concierge, "_call_configured_model", call)
    return calls


def test_for_you_selects_different_vibes_on_first_visit_without_swipe(db, monkeypatch):
    users, favorites, choices, calls = setup(db, monkeypatch)
    sets = []
    for user, expected in zip(users, (range(100, 110), range(110, 120))):
        result = for_you.for_you_recommendations(db, user.id, preferred_type="show", limit=5)
        assert len(result) == 5 and all(t.title.tmdb_id in expected for t in result)
        assert all("family conflict" not in t.reason for t in result)
        sets.append({t.title.id for t in result})
    assert sets[0].isdisjoint(sets[1])
    assert calls  # Styles were fetched here, with no earlier Swipe request.
    count = len(calls)
    result = for_you.for_you_recommendations(db, users[0].id, preferred_type="show", limit=5)
    assert {t.title.id for t in result} == sets[0] and len(calls) == count
    db.add(Rating(user_id=users[0].id, content_title_id=result[0].title.id, score=2, watched_state="watched"))
    db.commit()
    again = for_you.for_you_recommendations(db, users[0].id, preferred_type="show", limit=5)
    assert result[0].title.id not in {t.title.id for t in again}
    # Cache identity includes owner, format, filter and taste revision.
    users[0].taste_version += 1; db.commit()
    for_you.for_you_recommendations(db, users[0].id, preferred_type="show", limit=5)
    assert len(db.scalars(select(DiscoverySession)).all()) == 2


def test_for_you_rechecks_genre_on_cached_pool_and_keeps_older_matches(db, monkeypatch):
    users, favorites, choices, _ = setup(db, monkeypatch)
    # A large recent catalog must not crowd every older candidate out.
    db.add_all(ContentTitle(tmdb_id=2000+i, content_type="series", title=f"Recent {i}", genres=["Crime"],
        overview="Crime", poster_url="poster", release_date=date.today()) for i in range(850))
    db.commit()
    first = for_you.for_you_recommendations(db, users[0].id, preferred_type="show", genre="Comedy", limit=5)
    assert len(first) == 5 and all(t.title.tmdb_id in range(100, 110) for t in first)
    changed = db.get(ContentTitle, first[0].title.id); changed.genres = ["Crime"]; db.commit()
    second = for_you.for_you_recommendations(db, users[0].id, preferred_type="show", genre="Comedy", limit=5)
    assert changed.id not in {t.title.id for t in second}


def test_concierge_ranks_all_five_by_taste_when_request_relevance_ties(db, monkeypatch):
    users, favorites, choices, _ = setup(db, monkeypatch)
    reviewed = review(monkeypatch)
    for user, expected in zip(users, (range(100, 110), range(110, 120))):
        constraints = own_list(db, user, choices)
        result = retrieval.retrieve(db, user_id=user.id, constraints=constraints,
            suggested_names=[], context=concierge.PersonalContext())
        assert len(result.title_ids) == 5
        assert all(db.get(ContentTitle, tid).tmdb_id in expected for tid in result.title_ids)
    assert all(item["viewing_style"] for batch in reviewed for item in batch)


def test_concierge_explicit_request_relevance_beats_personal_style(db, monkeypatch):
    users, _, choices, _ = setup(db, monkeypatch)
    constraints = own_list(db, users[0], choices)
    constraints.year_min = 1990; constraints.year_max = 2005
    constraints.original_language = "en"
    choices[0].release_date = date(2020, 1, 1)
    choices[1].metadata_raw = {**choices[1].metadata_raw, "original_language": "fr"}
    db.commit()
    reviewed = review(monkeypatch, {str(choices[-1].id): 99})
    result = retrieval.retrieve(db, user_id=users[0].id, constraints=constraints,
        suggested_names=[], context=concierge.PersonalContext())
    assert result.title_ids[0] == choices[-1].id
    assert not {choices[0].id, choices[1].id} & set(result.title_ids)
    assert not {str(choices[0].id), str(choices[1].id)} & {t["title_id"] for batch in reviewed for t in batch}


def test_similarity_request_filters_subject_only_candidates_and_rechecks_anchor_on_resume(db, monkeypatch):
    users, favorites, choices, _ = setup(db, monkeypatch)
    constraints = own_list(db, users[0], choices)
    constraints.like_anchors = [favorites[0].title]
    constraints.anchor_title_ids = [str(favorites[0].id)]
    reviewed = review(monkeypatch)
    result = retrieval.retrieve(db, user_id=users[0].id, constraints=constraints,
        suggested_names=[], context=concierge.PersonalContext())
    assert len(result.title_ids) == 5
    assert all(db.get(ContentTitle, tid).tmdb_id < 110 for tid in result.title_ids)
    assert len(reviewed[0]) == 10  # Other ten share only plot/genre.
    # Corrections to anchor evidence invalidate approved continuation matches.
    anchor = favorites[0]
    cached = dict(anchor.metadata_raw[style.KEY]); cached["features"] = EPISODIC
    anchor.metadata_raw = {**anchor.metadata_raw, style.KEY: cached}; db.commit()
    resumed = retrieval.retrieve(db, user_id=users[0].id, constraints=constraints,
        suggested_names=[], context=concierge.PersonalContext(), continuation=result.retrieval_state)
    assert len(resumed.title_ids) == 5
    assert all(db.get(ContentTitle, tid).tmdb_id >= 110 for tid in resumed.title_ids)


def test_unknown_similarity_evidence_is_retryable_not_false_exhaustion(db, monkeypatch):
    users, favorites, choices, _ = setup(db, monkeypatch)
    constraints = own_list(db, users[0], choices[:5])
    constraints.anchor_title_ids = [str(favorites[0].id)]
    monkeypatch.setattr(style, "_classify", lambda payloads: {"titles": []})
    reviewed = review(monkeypatch)
    result = retrieval.retrieve(db, user_id=users[0].id, constraints=constraints,
        suggested_names=[], context=concierge.PersonalContext())
    assert not result.title_ids and not result.exhausted
    assert result.partial_reason == "metadata_unavailable" and not reviewed
    assert len(result.retrieval_state["pending_ids"]) == 5


def test_more_like_this_requires_source_style_even_when_user_likes_other_vibe(db, monkeypatch):
    users, favorites, choices, _ = setup(db, monkeypatch)
    assert len(rank_related_titles(db, users[0].id, favorites[0], choices)) == 10
    result = rank_related_titles(db, users[1].id, favorites[0], choices)
    # A personalized sort must never turn 'like this film' into an unrelated favorite genre.
    assert all(t.tmdb_id < 110 for t in result)
    assert not any(t.tmdb_id >= 110 for t in result)
    # A source with only generic subjects/genre cannot assert similarity.
    monkeypatch.setattr(settings, "discovery_style_enrichment", False)
    unknown = title(900)
    assert rank_related_titles(db, users[0].id, unknown, choices) == []


def test_detail_can_load_without_calling_related_retrieval(db, monkeypatch):
    from app.api.routes import titles as route
    user = viewer(db); row = title(100); db.add(row); db.commit()
    monkeypatch.setattr(route, "refresh_title_details", lambda db, t: t)
    monkeypatch.setattr(route, "resolve_wikipedia_metadata", lambda **k: None)
    monkeypatch.setattr(route, "refresh_streaming_options", lambda *a: None)
    monkeypatch.setattr(route, "fetch_title_gallery", lambda *a, **k: [])
    def forbidden(*a, **k): raise AssertionError("Optional similarity must not block details")
    monkeypatch.setattr(route, "fetch_related_titles", forbidden)
    assert route.get_title(row.id, db, current_user=user, include_related=False).id == row.id
    assert route.get_title_by_tmdb_id("tv", row.tmdb_id, db, user, include_related=False).id == row.id


def test_optional_style_workers_inherit_parent_deadline(monkeypatch):
    from app.services.concierge_runtime import request_runtime, timeout_for
    monkeypatch.setattr(settings, "concierge_ai_provider", "vertex")
    monkeypatch.setattr(settings, "discovery_style_enrichment", True)
    seen = []
    def provider(intent, **kwargs):
        seen.append(timeout_for(25)); return {"titles": []}
    monkeypatch.setattr(concierge, "_call_configured_model", provider)
    with request_runtime("parent", seconds=.5):
        style.enrich_styles([title(100)])
    assert len(seen) == 1 and 0 < seen[0] <= .5


def test_style_unknown_and_provider_outage_have_different_retry_windows(monkeypatch):
    monkeypatch.setattr(settings, "concierge_ai_provider", "vertex")
    monkeypatch.setattr(settings, "discovery_style_enrichment", True)
    unknown, unavailable = title(100), title(101)
    monkeypatch.setattr(style, "_classify", lambda payloads: {"titles": []})
    style.enrich_styles([unknown]); assert unknown.metadata_raw[style.KEY]["status"] == "unknown"
    def outage(*a): raise httpx.ReadTimeout("test")
    monkeypatch.setattr(style, "_classify", outage)
    style.enrich_styles([unavailable]); assert unavailable.metadata_raw[style.KEY]["status"] == "unavailable"
    for row in (unknown, unavailable):
        row.metadata_raw[style.KEY]["checked_at"] = (datetime.now(timezone.utc)-timedelta(minutes=6)).isoformat()
    calls = model(monkeypatch, {"series:101": STYLIZED})
    style.enrich_styles([unknown, unavailable])
    assert len(calls) == 1 and calls[0][0]["key"] == "series:101"


@pytest.mark.parametrize("signals", ["six", "right", "save", "six-and-right"])
def test_rating_six_and_right_swipes_are_used_without_rankings(db, monkeypatch, signals):
    from app.models.taste import SwipeRecord
    users, favorites, choices, _ = setup(db, monkeypatch)
    # A genuinely new account: no ratings or manual rankings from setup.
    user = viewer(db)
    expected = set()
    if "six" in signals:
        db.add(Rating(user_id=user.id, content_title_id=favorites[0].id, score=6))
        expected.add(favorites[0].id)
    if "right" in signals:
        db.add(SwipeRecord(user_id=user.id, content_title_id=favorites[1].id, direction="right", action_version=3))
        expected.add(favorites[1].id)
    if signals == "save":
        own_list(db, user, favorites[:1]); expected.add(favorites[0].id)
    db.commit()
    scorer, seeds, _, _ = taste.history(db, user.id)
    assert set(scorer.evidence) == expected
    assert all(s.utility > 0 for s in scorer.evidence.values())
    if "right" in signals:
        assert scorer.evidence[favorites[1].id].kind == "interest"
    result = for_you.for_you_recommendations(db, user.id, preferred_type="show", limit=5)
    assert len(result) == 5 and all(t.title.tmdb_id < 110 for t in result)
    assert all(t.title.scenedna.learning and t.title.scenedna.percentage is None for t in result)


def test_source_sampling_represents_liked_ratings_and_interest_alongside_perfect_scores(db):
    from app.models.taste import SwipeRecord
    user = viewer(db)
    rows = [title(n) for n in range(100, 123)]
    db.add_all(rows); db.flush()
    db.add_all(Rating(user_id=user.id, content_title_id=t.id, score=10) for t in rows[:15])
    db.add_all(Rating(user_id=user.id, content_title_id=t.id, score=6+i) for i,t in enumerate(rows[15:18]))
    db.add_all(SwipeRecord(user_id=user.id, content_title_id=t.id, direction="right", action_version=3) for t in rows[18:])
    db.commit()
    scorer = taste.history(db, user.id)[0]
    state, covered = {}, set()
    for _ in range(16):
        seeds = taste.personal.positive_seeds(db, scorer, state, "show")
        jobs = taste.personal.plan_sources(scorer, seeds, state, "show")
        ids = {job["seed"] for job in jobs if job.get("seed")}
        assert ids & {str(t.id) for t in rows[:15]}
        assert ids & {str(t.id) for t in rows[15:18]}
        assert ids & {str(t.id) for t in rows[18:]}
        assert len(seeds) <= 6 and len(jobs) <= 6
        covered.update(ids)
    assert covered == {str(t.id) for t in rows}


def test_five_is_neutral_and_later_ratings_override_swipe_interest():
    from app.services.title_compatibility import effective_evidence
    ids = [uuid4() for _ in range(10)]
    ratings = {key: i+1 for i,key in enumerate(ids)}
    signals, count = effective_evidence(ratings, {}, set(ids), {key:{"right"} for key in ids}, set())
    assert count == 10 and ids[4] not in signals
    assert all(signals[key].utility < 0 for key in ids[:4])
    positive = [signals[key].utility for key in ids[5:]]
    assert 0 < positive[0] and positive == sorted(set(positive))
    assert all(signals[key].kind == "rating" for key in ids if key in signals)


def test_onboarding_progress_counts_real_ratings_not_unrated_watched_titles(db):
    from app.api.routes.me import get_onboarding_progress
    user = viewer(db)
    rows = [title(n) for n in range(3)]
    db.add_all(rows); db.flush()
    from app.models.social import TitleWatchStatus
    db.add(Rating(user_id=user.id, content_title_id=rows[0].id, score=6, watched_state="watched"))
    db.add_all(TitleWatchStatus(user_id=user.id, content_title_id=t.id, watched_state="watched") for t in rows[1:])
    db.commit()
    assert get_onboarding_progress(user, db).rated_count == 1


@pytest.mark.parametrize("failure", ["deadline", "network"])
def test_for_you_enrichment_failure_keeps_confirmed_personal_candidates(db, monkeypatch, failure):
    from app.services.concierge_runtime import ConciergeDeadlineExceeded
    users, favorites, choices, _ = setup(db, monkeypatch)
    def interrupted(*args, **kwargs):
        if failure == "deadline":
            raise ConciergeDeadlineExceeded("budget")
        raise httpx.ReadTimeout("provider unavailable")
    monkeypatch.setattr(taste, "retrieve_personal", interrupted)
    result = for_you.for_you_recommendations(db, users[0].id, preferred_type="show", limit=5)
    assert len(result) == 5
    assert all(r.title.content_type == "series" for r in result)
    assert not {r.title.id for r in result} & {t.id for t in favorites[:6]}
    # The result remains usable on Retry and does not repeatedly block on TMDB.
    assert [r.title.id for r in result] == [r.title.id for r in for_you.for_you_recommendations(db, users[0].id, preferred_type="show", limit=5)]
