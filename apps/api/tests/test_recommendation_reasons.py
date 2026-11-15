"""Reasons must reflect the viewer's current actions and verifiable metadata."""
from uuid import UUID, uuid4
import pytest

from sqlalchemy import select

from app.core.config import settings
from app.models.discovery import DiscoverySession
from app.models.social import Rating, RankedFavorite, Watchlist, WatchlistItem
from app.models.user import User, UserProfile
from app.services import discovery_feed as feed, discovery_personalization as personal
from app.services.title_compatibility import scorer_for_user
from app.api.routes.discovery_resume import ResumeRequest, resume_discovery


def viewer(db):
    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(user); db.flush()
    db.add(UserProfile(user_id=user.id, username=user.id.hex, display_name="Viewer", country_code="US"))
    db.commit()
    return user


def raw(n, name=None, *, genre="Comedy", director=None, actor=None, keyword=None):
    return {"id": n, "media_type": "movie", "title": name or f"Film {n}",
            "overview": "A complete synopsis", "poster_path": "/poster.jpg", "release_date": "2020-01-01",
            "genres": [{"id": 35 if genre == "Comedy" else 99, "name": genre}],
            "original_language": "en", "keywords": {"keywords": [keyword, {"id": 99, "name": "highly stylized"}] if keyword else []},
            "credits": {"cast": [{**actor, "order": 0}] if actor else [],
                        "crew": [{**director, "job": "Director"}] if director else []},
            "watch/providers": {"results": {"US": {"flatrate": [{"provider_id": 8}]}}}}


def title(db, n, name=None, **kw):
    row = personal._upsert_title_from_tmdb_result(db, raw(n, name, **kw))
    db.commit()
    return row


def rate(db, user, row, score):
    rating = db.scalar(select(Rating).where(Rating.user_id == user.id, Rating.content_title_id == row.id))
    if rating:
        rating.score = score
    else:
        db.add(Rating(user_id=user.id, content_title_id=row.id, score=score, watched_state="watched"))
    db.commit()


def save(db, user, row):
    queue = Watchlist(owner_user_id=user.id, name="My Next Watch", visibility="private")
    db.add(queue); db.flush()
    db.add(WatchlistItem(watchlist_id=queue.id, content_title_id=row.id, added_via="manual"))
    db.commit()


def test_names_actual_rating_and_verified_director_without_changing_score(db):
    user = viewer(db)
    director = {"id": 7, "name": "Example Director"}
    anchor = title(db, 1, "Your Favorite", director=director)
    candidate = title(db, 2, director=director)
    rate(db, user, anchor, 9)
    scorer = scorer_for_user(db, user.id, [candidate])
    match = scorer.score(candidate)
    assert match.explanation == "You rated Your Favorite 9/10. This is also directed by Example Director."
    assert match.score == scorer.score_features(scorer.candidate_features[candidate.id]).score
    assert match.percentage is None  # Specific evidence does not fabricate confidence.


def test_save_is_interest_not_enjoyment_and_current_rating_wins(db):
    user = viewer(db)
    actor = {"id": 9, "name": "Example Actor"}
    anchor = title(db, 1, "Saved Film", actor=actor)
    candidate = title(db, 2, actor=actor)
    save(db, user, anchor)
    assert scorer_for_user(db, user.id, [candidate]).score(candidate).explanation == (
        "You saved Saved Film. This also stars Example Actor.")
    rate(db, user, anchor, 7.5)
    assert "7.5/10" in scorer_for_user(db, user.id, [candidate]).score(candidate).explanation
    for value in (5, 1):
        rate(db, user, anchor, value)
        assert "Saved Film" not in scorer_for_user(db, user.id, [candidate]).score(candidate).explanation


def test_rank_without_rating_and_private_evidence_are_viewer_scoped(db):
    owner, stranger = viewer(db), viewer(db)
    anchor = title(db, 1, "Private Favorite", keyword={"id": 11, "name": "deadpan humor"})
    candidate = title(db, 2, keyword={"id": 11, "name": "deadpan humor"})
    db.add(RankedFavorite(user_id=owner.id, content_title_id=anchor.id, position=3)); db.commit()
    assert "Private Favorite is your #3 pick" in scorer_for_user(db, owner.id, [candidate]).score(candidate).explanation
    assert "Private Favorite" not in scorer_for_user(db, stranger.id, [candidate]).score(candidate).explanation


def test_style_requires_multiple_axes_and_no_invented_mood(db):
    user = viewer(db)
    anchor = title(db, 1, "Family Film", keyword={"id": 11, "name": "deadpan humor"})
    candidate = title(db, 2, keyword={"id": 11, "name": "deadpan humor"})
    rate(db, user, anchor, 8)
    reason = scorer_for_user(db, user.id, [candidate]).score(candidate).explanation
    assert reason == "You rated Family Film 8/10. Both lean toward deadpan humor and stylized visuals."
    unrelated = title(db, 3, genre="Documentary", keyword={"id": 12, "name": "family conflict"})
    reason = scorer_for_user(db, user.id, [unrelated]).score(unrelated).explanation
    assert "Family Film" not in reason and "family conflict" not in reason
    assert "change of pace" in reason  # Same year/format/language alone is insufficient.


def test_net_negative_genre_cannot_be_presented_as_a_favorite(db):
    user = viewer(db)
    anchor = title(db, 1, "One Comedy")
    rate(db, user, anchor, 7)
    for n in range(2, 5):
        rate(db, user, title(db, n), 1)
    candidate = title(db, 9)
    assert "One Comedy" not in scorer_for_user(db, user.id, [candidate]).score(candidate).explanation


def test_feature_cache_never_reuses_another_titles_personal_reason(db):
    user = viewer(db)
    anchor = title(db, 1, "Only Favorite", keyword={"id": 11, "name": "deadpan humor"})
    candidate = title(db, 2, keyword={"id": 11, "name": "deadpan humor"})
    rate(db, user, anchor, 10)
    scorer = scorer_for_user(db, user.id, [candidate])
    assert "Only Favorite" in scorer.score(candidate).explanation
    assert "Only Favorite" not in scorer.score(anchor).explanation


@pytest.mark.parametrize("surface", ["swipe", "preview"])
def test_fresh_replay_resume_and_rerank_keep_reasons_and_drop_outdated_evidence(db, monkeypatch, surface):
    user = viewer(db)
    anchor = title(db, 1, "Recent Favorite", keyword={"id": 11, "name": "deadpan humor"})
    rate(db, user, anchor, 9)
    monkeypatch.setattr(settings, "tmdb_api_key", "")
    monkeypatch.setattr(personal, "enrich_evidence", lambda *a, **k: 0)
    monkeypatch.setattr(feed, "private_sources", lambda *a: ([], []))
    monkeypatch.setattr(feed, "_video", lambda row: {"provider": "YouTube", "external_key": str(row.tmdb_id),
                                                   "type": "Trailer", "name": "Trailer", "official": True})
    monkeypatch.setattr(feed, "catalog_page", lambda kind, band, page, *a: {
        "rows": [raw(100+band*100+n, keyword={"id": 11, "name": "deadpan humor"}) for n in range(8)], "done": True, "cap": False})
    reason = lambda i: i["reason"]["label"] if surface == "preview" else i["reason"]
    first = feed.get_feed(db, user.id, preferred_type="movie", limit=6, surface=surface)
    assert first["items"] and all("Recent Favorite 9/10" in reason(i) for i in first["items"])
    replay = feed.get_feed(db, user.id, preferred_type="movie", cursor=f'{first["session_id"]}:0', surface=surface)
    assert [i["reason"] for i in replay["items"]] == [i["reason"] for i in first["items"]]
    ids = [UUID(i["title_id"] if surface == "preview" else i["title"]["id"]) for i in first["items"]]
    request = ResumeRequest(cursor=first["next_cursor"], title_ids=ids, surface=surface, preferred_type="movie", rerank=True)
    restored = resume_discovery(request, user, db)
    assert restored["items"] and all("Recent Favorite 9/10" in reason(i) for i in restored["items"])
    # A persisted source cannot retain an old positive claim after re-rating.
    session = db.get(DiscoverySession, UUID(first["session_id"]))
    session.state = {**session.state, "served_origins": {str(i): {"seed": str(anchor.id)} for i in ids}}
    db.commit()
    rate(db, user, anchor, 1)
    restored = resume_discovery(request, user, db)
    replay = feed.get_feed(db, user.id, preferred_type="movie", cursor=f'{first["session_id"]}:0', surface=surface)
    assert all("Recent Favorite" not in reason(i) for i in restored["items"] + replay["items"])
