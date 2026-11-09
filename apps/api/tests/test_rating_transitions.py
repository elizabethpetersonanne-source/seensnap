from uuid import uuid4
from sqlalchemy import select
from fastapi import HTTPException
import pytest
from app.models.content import ContentTitle
from app.models.user import User
from app.models.social import Watchlist, WatchlistItem, Rating, RankedFavorite
from app.api.routes.ratings import (
    upsert_rating,
    clear_rating,
    set_watch_status,
    RatingUpsertRequest,
    WatchStatusRequest,
)


@pytest.fixture
def setup(db):
    user = User(id=uuid4(), email="test@example.invalid", auth_provider="test")
    title = ContentTitle(id=uuid4(), tmdb_id=5, content_type="movie", title="Test")
    queue = Watchlist(
        id=uuid4(), owner_user_id=user.id, name="Renamed queue", system_role="next_watch"
    )
    custom = Watchlist(id=uuid4(), owner_user_id=user.id, name="Keep this list")
    db.add_all([user, title])
    db.flush()
    db.add_all([queue, custom])
    db.flush()
    db.add_all(
        [
            WatchlistItem(watchlist_id=wl.id, content_title_id=title.id, added_via="test")
            for wl in [queue, custom]
        ]
    )
    db.add(RankedFavorite(user_id=user.id, content_title_id=title.id, position=1))
    db.commit()
    return user, title, queue, custom


def test_legacy_rating_endpoint_uses_canonical_queue_cleanup(db, setup):
    user, title, queue, custom = setup
    result = upsert_rating(title.id, RatingUpsertRequest(score=9, expected_version=0), user, db)
    assert result.score == 9 and result.watched_state == "watched"
    assert result.in_next_watch is False
    assert result.is_saved_anywhere is True
    assert result.saved_list_ids == [custom.id]
    assert db.scalar(select(RankedFavorite.position)) == 1
    changed = upsert_rating(
        title.id, RatingUpsertRequest(score=7, expected_version=result.version), user, db
    )
    assert changed.score == 7 and changed.version > result.version
    with pytest.raises(HTTPException) as conflict:
        upsert_rating(
            title.id, RatingUpsertRequest(score=4, expected_version=result.version), user, db
        )
    assert conflict.value.status_code == 409
    assert conflict.value.detail["current"]["score"] == 7


def test_clear_keeps_watched_lists_and_manual_rank(db, setup):
    user, title, _, custom = setup
    upsert_rating(title.id, RatingUpsertRequest(score=8), user, db)
    result = clear_rating(title.id, user, db)
    assert result.score is None and result.watched_state == "watched"
    assert result.saved_list_ids == [custom.id]
    assert db.scalar(select(RankedFavorite.position)) == 1
    assert db.scalar(select(Rating.id)) is None


def test_mark_watched_does_not_invent_rating(db, setup):
    user, title, _, custom = setup
    result = set_watch_status(title.id, WatchStatusRequest(watched_state="watched"), user, db)
    assert result.score is None and result.watched_state == "watched"
    assert result.saved_list_ids == [custom.id]


def test_stale_clear_does_not_remove_a_newer_rating(db, setup):
    user, title, _, _ = setup
    original = upsert_rating(title.id, RatingUpsertRequest(score=7), user, db)
    upsert_rating(title.id, RatingUpsertRequest(score=9, expected_version=original.version), user, db)
    with pytest.raises(HTTPException) as error:
        clear_rating(title.id, user, db, expected_version=original.version)
    assert error.value.status_code == 409
    assert error.value.detail['current']['score'] == 9


def test_concurrent_rating_edits_accept_only_one_expected_version(db, setup):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL row locks")
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from sqlalchemy.orm import Session
    from app.services.title_state import rate_title, TitleStateError

    user, title, _, _ = setup
    initial = rate_title(db, user.id, title.id, 8)
    user_id, title_id = user.id, title.id
    db.rollback()
    barrier = Barrier(2)

    def edit(score):
        with Session(db.bind) as session:
            barrier.wait(timeout=5)
            try:
                return rate_title(
                    session, user_id, title_id, score, expected_version=initial.version
                ).rating
            except TitleStateError as error:
                session.rollback()
                return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(edit, [4, 9]))
    assert results.count("version_conflict") == 1
    assert sum(isinstance(value, int) for value in results) == 1
