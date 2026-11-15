"""Regression for broad-genre decks hiding behind a repeated favorite's name.

List responses deliberately omit credits and keywords, as TMDB does. Users
have the same genre/year/language preferences but opposite thematic tastes.
Evaluate selected title identities, not simply explanation copy.
"""
from datetime import date
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models.content import ContentTitle
from app.models.social import Rating
from app.models.user import User, UserProfile
from app.services import discovery_feed as feed, discovery_personalization as personal
from app.services.title_compatibility import scorer_for_user, TitleScorer, Evidence, title_features


def data(n, anchor, kind="movie"):
    family = anchor < 104
    themes = [(101, "family road trip"), (102, "eccentric family")] if family else [(201, "serial killer"), (202, "violent crime")]
    return {"id": n, "media_type": kind, "title": f"Film {n}", "name": f"Series {n}",
            "overview": "A full synopsis", "poster_path": "/poster.jpg", "release_date": "2020-01-01",
            "first_air_date": "2020-01-01", "genres": [{"id": 18, "name": "Drama"}], "original_language": "en",
            "keywords": {"keywords": [{"id": key, "name": name} for key, name in themes]},
            "credits": {"cast": [{"id": anchor, "name": f"Actor {anchor}", "order": 0}],
                        "crew": [{"id": anchor+1000, "name": f"Director {anchor}", "job": "Director"}]},
            "watch/providers": {"results": {"US": {"flatrate": [{"provider_id": 8}]}}}}


def basic(raw):
    return {k: v for k, v in raw.items() if k not in {"credits", "keywords", "watch/providers"}}


def user(db):
    row = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(row); db.flush()
    db.add(UserProfile(user_id=row.id, username=row.id.hex, display_name="Viewer", country_code="US"))
    db.commit()
    return row


@pytest.mark.parametrize("kind,surface", [("movie", "swipe"), ("tv", "swipe"), ("tv", "preview")])
def test_same_genre_opposite_tastes_choose_different_actual_titles_with_sparse_list_data(db, monkeypatch, kind, surface):
    viewers = [user(db), user(db)]
    corpus = {n: data(n, n, kind) for n in range(100, 108)}
    for n in range(100, 108):
        row = personal._upsert_title_from_tmdb_result(db, basic(corpus[n]))
        for i, viewer in enumerate(viewers):
            liked = (n < 104) == (i == 0)
            db.add(Rating(user_id=viewer.id, content_title_id=row.id, score=9 if liked else 1, watched_state="watched"))
    db.commit()
    calls, jobs = [], []
    monkeypatch.setattr(settings, "tmdb_api_key", "isolated-test")
    monkeypatch.setattr(feed, "private_sources", lambda *a: ([], []))
    monkeypatch.setattr(feed, "_video", lambda row: {"provider": "YouTube", "external_key": str(row.tmdb_id),
                                                   "type": "Trailer", "name": "Trailer", "official": True})
    def detail(kind, number):
        calls.append(number)
        return corpus[number]
    monkeypatch.setattr(personal, "fetch_evidence", detail)
    def source(job, *args):
        jobs.append(job)
        if job.get("seed"):
            anchor = int(job["path"].split("/")[2])
            start = anchor * 1000 + job["page"] * 20
        else:
            keyword = int(job["params"].get("with_keywords", 0))
            person = int(job["params"].get("with_crew", job["params"].get("with_cast", 0)))
            if person >= 1000:
                person -= 1000
            anchor = person or (100 if keyword < 200 else 104)
            start = 500000 + anchor*1000 + keyword*20 + job["page"]*20
        rows = []
        for n in range(20):
            # Upstream related lists are noisy: one in four results has the
            # opposite theme despite the same genre and retrieval provenance.
            candidate_anchor = (104 if anchor < 104 else 100) if n % 4 == 0 else anchor
            row = data(start+n, candidate_anchor, kind)
            corpus[row["id"]] = row
            rows.append(basic(row))
        return {"rows": rows, "done": job["page"] >= 3}
    monkeypatch.setattr(personal, "fetch_source", source)
    def catalog(kind, band, page, *args):
        rows = []
        for n in range(20):
            row = data(900000+band*1000+page*20+n, 100 if n%2 else 104, kind)
            corpus[row["id"]] = row
            rows.append(basic(row))
        return {"rows": rows, "done": page >= 3, "cap": False}
    monkeypatch.setattr(feed, "catalog_page", catalog)
    responses = []
    for i, viewer in enumerate(viewers):
        before = len(calls)
        response = feed.get_feed(db, viewer.id, preferred_type="show" if kind == "tv" else "movie", surface=surface)
        ids = [row["tmdb_id"] if surface == "preview" else row["title"]["tmdb_id"] for row in response["items"]]
        assert 16 <= len(ids) <= 20  # A short relevant page beats disliked filler.
        correct = sum((corpus[n]["keywords"]["keywords"][0]["id"] == 101) == (i == 0) for n in ids)
        print(f"quality_fixture {kind}/{surface} viewer={i+1}: {correct}/{len(ids)} thematic fits; metadata_calls={len(calls)-before}")
        assert correct >= 16, f"Only {correct}/20 titles fit the held-out thematic preference"
        assert len(calls) - before <= 32  # Eight history titles + twenty-four candidates.
        reasons = [row["reason"]["label"] if surface == "preview" else row["reason"] for row in response["items"]]
        assert all("another drama pick" not in reason for reason in reasons)
        responses.append((response, set(ids)))
    assert len(responses[0][1] & responses[1][1]) <= 4
    first = responses[0][0]
    next_page = feed.get_feed(db, viewers[0].id, preferred_type="show" if kind == "tv" else "movie",
                              surface=surface, cursor=first["next_cursor"])
    next_ids = {row["tmdb_id"] if surface == "preview" else row["title"]["tmdb_id"] for row in next_page["items"]}
    assert next_ids and not next_ids.intersection(responses[0][1])


def test_genre_alone_is_not_a_specific_match_or_a_named_personal_connection(db):
    viewer = user(db)
    favorite = personal._upsert_title_from_tmdb_result(db, basic(data(100, 100)))
    candidate = personal._upsert_title_from_tmdb_result(db, basic(data(500, 104)))
    db.add(Rating(user_id=viewer.id, content_title_id=favorite.id, score=10, watched_state="watched")); db.commit()
    scorer = scorer_for_user(db, viewer.id, [candidate])
    match = scorer.score(candidate)
    assert match.score > 55  # A broad positive score must not satisfy the taste quota.
    assert not personal.specific_match(match)
    assert favorite.title not in match.explanation


def test_missing_candidate_details_do_not_beat_a_verified_match():
    examples = [ContentTitle(id=uuid4(), title=f"Favorite {n}", content_type="movie", genres=["Drama"],
                            release_date=date(2020, 1, 1), metadata_raw=data(n, 100)) for n in range(8)]
    scorer = TitleScorer({t.id: Evidence(t.id, .75, "rating") for t in examples}, 8,
                        {t.id: title_features(t) for t in examples})
    rich = ContentTitle(id=uuid4(), title="Real match", content_type="movie", genres=["Drama"],
                        release_date=date(2020, 1, 1), metadata_raw=data(500, 100))
    sparse = ContentTitle(id=uuid4(), title="Bare drama", content_type="movie", genres=["Drama"],
                          release_date=date(2020, 1, 1), metadata_raw=basic(data(501, 104)))
    assert scorer.score(rich).score > scorer.score(sparse).score + 10


def test_reason_chooses_the_closest_favorite_not_automatically_the_highest_rating(db):
    viewer = user(db)
    loose = data(100, 100)
    loose["keywords"]["keywords"] = [{"id": 101, "name": "family road trip"}] + [
        {"id": n, "name": f"Other theme {n}"} for n in range(300, 305)]
    top = personal._upsert_title_from_tmdb_result(db, loose)
    close = personal._upsert_title_from_tmdb_result(db, data(101, 101))
    candidate = personal._upsert_title_from_tmdb_result(db, data(500, 101))
    db.add_all([Rating(user_id=viewer.id, content_title_id=top.id, score=10, watched_state="watched"),
                Rating(user_id=viewer.id, content_title_id=close.id, score=8, watched_state="watched")]); db.commit()
    reason = scorer_for_user(db, viewer.id, [candidate]).score(candidate).explanation
    assert f"{close.title} 8/10" in reason and top.title not in reason


def test_known_disliked_theme_does_not_fill_the_remaining_slots():
    titles = {str(n): ContentTitle(title=str(n), genres=["Drama"], release_date=date(2020, 1, 1)) for n in range(20)}
    scores = {str(n): SimpleNamespace(score=75 if n < 5 else 40, confidence=.8,
              breakdown=[SimpleNamespace(dimension="exemplars", score=80 if n < 5 else 30)]) for n in range(20)}
    selected, _ = personal.compose(titles, scores, {}, 20)
    assert len(selected) == 5 and all(int(key) < 5 for key in selected)


def test_title_selection_limits_repeated_anchors_when_alternatives_exist():
    titles, scores, anchors = {}, {}, {}
    for n in range(60):
        key = str(n)
        titles[key] = ContentTitle(title=key, genres=["Drama"], release_date=date(2020, 1, 1))
        scores[key] = SimpleNamespace(score=80-(n%4), confidence=.8,
                                     breakdown=[SimpleNamespace(dimension="exemplars", score=85)])
        anchors[key] = f"favorite-{n%4}"
    selected, history = personal.compose(titles, scores, {}, 20, anchors=anchors)
    assert len({anchors[k] for k in selected}) == 4
    assert all(anchors[a] != anchors[b] for a,b in zip(selected, selected[1:]))
    for end in range(10, len(selected)+1):
        window = selected[end-10:end]
        assert max(sum(anchors[k] == anchor for k in window) for anchor in anchors.values()) <= 3


def test_anchor_diversity_does_not_promote_weak_picks_over_verified_matches():
    titles = {str(n): ContentTitle(title=str(n), genres=["Drama"], release_date=date(2020, 1, 1)) for n in range(20)}
    scores = {str(n): SimpleNamespace(score=85 if n < 10 else 51, confidence=.8,
              breakdown=[SimpleNamespace(dimension="exemplars" if n < 10 else "genres", score=90)]) for n in range(20)}
    anchors = {str(n): "strong-favorite" if n < 10 else f"weak-{n}" for n in range(20)}
    selected, _ = personal.compose(titles, scores, {}, 8, anchors=anchors, related=set(titles))
    assert all(int(key) < 10 for key in selected)


def test_metadata_inspection_cannot_be_consumed_by_one_source(db):
    viewer = user(db)
    waiting, origins = {}, {}
    for source in range(4):
        for n in range(20):
            row = personal._upsert_title_from_tmdb_result(db, basic(data(10000+source*100+n, 100+source)))
            waiting[str(row.id)] = row
            origins[str(row.id)] = {"source": f"seed:{source}", "position": n}
    scorer = scorer_for_user(db, viewer.id, waiting.values())
    selected = personal.evidence_prospects(waiting, {}, origins, scorer, "US")
    assert len(selected) == 24
    assert all(sum(origins[str(t.id)]["source"] == f"seed:{source}" for t in selected) == 6 for source in range(4))


def test_exhausted_related_sources_still_advance_remaining_trait_queries(db, monkeypatch):
    viewer = user(db)
    favorite = personal._upsert_title_from_tmdb_result(db, data(100, 100))
    db.add(Rating(user_id=viewer.id, content_title_id=favorite.id, score=9, watched_state="watched")); db.commit()
    scorer = scorer_for_user(db, viewer.id)
    monkeypatch.setattr(settings, "tmdb_api_key", "isolated-test")
    state = {"taste_sources": {f"seed:{favorite.id}": {"page": 2, "done": True}}}
    assert personal.has_more_sources(scorer, state, "movie")
    for _ in range(10):
        seeds = personal.positive_seeds(db, scorer, state, "movie")
        jobs = personal.plan_sources(scorer, seeds, state, "movie")
        assert all(not job.get("seed") for job in jobs)
        for job in jobs:
            state["taste_sources"][job["key"]] = {"page": 2, "done": True}
        if not personal.has_more_sources(scorer, state, "movie"):
            break
    else:
        pytest.fail("Trait queries did not reach exhaustion")


def test_old_generic_session_is_invalidated_without_recording_a_swipe(db, monkeypatch):
    viewer = user(db)
    monkeypatch.setattr(feed, "private_sources", lambda *a: ([], []))
    monkeypatch.setattr(feed, "catalog_page", lambda *a: {"rows": [data(500, 100)], "done": True, "cap": False})
    new_algorithm = feed.ALGORITHM
    monkeypatch.setattr(feed, "ALGORITHM", "discovery_v4:scenedna_title_v2")
    old = feed.get_feed(db, viewer.id, preferred_type="movie")
    monkeypatch.setattr(feed, "ALGORITHM", new_algorithm)
    with pytest.raises(HTTPException) as error:
        feed.get_feed(db, viewer.id, preferred_type="movie", cursor=old["resume_cursor"])
    assert error.value.status_code == 409
