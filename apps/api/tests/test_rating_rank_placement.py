from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes.favorites import MoveRequest, get_ranked_favorites, move_ranked_favorite
from app.api.routes.ratings import RatingUpsertRequest, upsert_rating
from app.models.content import ContentTitle
from app.models.social import RankedFavorite, Rating
from app.models.user import User
from app.services.title_state import TitleStateError, rate_title


def seed(db, scores):
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    titles = [ContentTitle(id=uuid4(), tmdb_id=i + 1, content_type="movie", title=f"Title {i}")
              for i in range(len(scores))]
    db.add_all([user, *titles])
    db.flush()
    for position, (title, score) in enumerate(zip(titles, scores), start=1):
        db.add(RankedFavorite(user_id=user.id, content_title_id=title.id, position=position))
        if score is not None:
            db.add(Rating(user_id=user.id, content_title_id=title.id, score=score))
    db.commit()
    return user, titles


def order(db, user_id):
    rows = db.scalars(select(RankedFavorite).where(RankedFavorite.user_id == user_id)
                      .order_by(RankedFavorite.position)).all()
    assert [row.position for row in rows] == list(range(1, len(rows) + 1))
    return [row.content_title_id for row in rows]


@pytest.mark.parametrize("scores,score,index", [
    ([], 7, 0),
    ([9, 7, 7, 6], 7, 3),
    ([9, 7, 6], 8, 1),
    ([9, 7, 6], 10, 0),
    ([9, 7, 6], 1, 3),
    ([None, None], 7, 0),
    # Customized ordering is preserved, even across score groups.
    ([7, 9, 7, 5, None], 7, 3),
])
def test_rating_inserts_last_in_score_group_without_resorting_siblings(db, scores, score, index):
    user, titles = seed(db, scores)
    # TV and movie IDs may overlap: ranking must use the canonical UUID.
    title = ContentTitle(id=uuid4(), tmdb_id=1, content_type="tv", title="New TV title")
    db.add(title)
    db.commit()
    result = upsert_rating(title.id, RatingUpsertRequest(score=score, expected_version=0), user, db)
    expected = [t.id for t in titles]
    expected.insert(index, title.id)
    assert order(db, user.id) == expected
    assert result.score == score and result.watched_state == "watched"
    remaining_scores = dict(db.execute(select(Rating.content_title_id, Rating.score).where(
        Rating.user_id == user.id, Rating.content_title_id != title.id,
    )).all())
    assert remaining_scores == {t.id: s for t, s in zip(titles, scores) if s is not None}


def test_score_changes_move_only_the_edited_title_and_retry_does_not_move_again(db):
    user, titles = seed(db, [9, 7, 7, 6])
    down = rate_title(db, user.id, titles[0].id, 7, expected_version=1)
    assert down.ranked_position == 3
    assert order(db, user.id) == [titles[i].id for i in [1, 2, 0, 3]]
    with pytest.raises(TitleStateError, match="stale version"):
        rate_title(db, user.id, titles[0].id, 10, expected_version=1)
    assert order(db, user.id) == [titles[i].id for i in [1, 2, 0, 3]]
    up = rate_title(db, user.id, titles[3].id, 8)
    assert up.ranked_position == 1
    assert order(db, user.id) == [titles[i].id for i in [3, 1, 2, 0]]


def test_same_score_preserves_manual_order_and_other_accounts(db):
    user, titles = seed(db, [7, 9, 7])
    other = User(id=uuid4(), email="other@example.invalid", auth_provider="test")
    db.add(other)
    db.flush()
    other_titles = titles[::-1]
    for position, title in enumerate(other_titles, start=1):
        db.add(RankedFavorite(user_id=other.id, content_title_id=title.id, position=position))
        db.add(Rating(user_id=other.id, content_title_id=title.id, score=10))
    db.commit()
    before = db.scalar(select(RankedFavorite).where(
        RankedFavorite.user_id == user.id, RankedFavorite.content_title_id == titles[0].id,
    ))
    version = before.version
    rate_title(db, user.id, titles[0].id, 7)
    assert order(db, user.id) == [t.id for t in titles]
    assert before.version == version
    assert order(db, other.id) == [t.id for t in other_titles]
    rate_title(db, user.id, titles[1].id, 7)
    assert order(db, user.id) == [titles[i].id for i in [0, 2, 1]]
    assert order(db, other.id) == [t.id for t in other_titles]


def test_unranked_existing_rating_and_unrated_ranked_title_are_placed(db):
    user, titles = seed(db, [9, 7, 6, None])
    rate_title(db, user.id, titles[-1].id, 7)
    assert order(db, user.id) == [titles[i].id for i in [0, 1, 3, 2]]
    title = ContentTitle(id=uuid4(), tmdb_id=50, content_type="movie", title="Unplaced")
    db.add(title)
    db.flush()
    db.add(Rating(user_id=user.id, content_title_id=title.id, score=7))
    db.commit()
    rate_title(db, user.id, title.id, 7)
    assert order(db, user.id) == [titles[i].id for i in [0, 1, 3]] + [title.id, titles[2].id]


def test_placement_uses_complete_ranking_beyond_page_limits(db):
    user, titles = seed(db, [9] * 100 + [7] * 503 + [6, 5])
    result = rate_title(db, user.id, titles[-1].id, 7)
    assert result.ranked_position == 604
    expected = [t.id for t in titles]
    expected[-2:] = expected[-2:][::-1]
    assert order(db, user.id) == expected
    page = get_ranked_favorites(user, db, limit=100, offset=600)
    assert page.total == 605 and page.items[-2].title_id == titles[-1].id


def test_rating_shift_invalidates_stale_manual_move_but_manual_move_still_works(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Manual moves use PostgreSQL deferred uniqueness")
    user, titles = seed(db, [9, 7, 7, 6])
    rate_title(db, user.id, titles[0].id, 7)
    with pytest.raises(HTTPException) as conflict:
        move_ranked_favorite(titles[1].id, MoveRequest(to_position=4, expected_version=1), user, db)
    assert conflict.value.status_code == 409
    row = db.scalar(select(RankedFavorite).where(RankedFavorite.content_title_id == titles[0].id))
    move_ranked_favorite(titles[0].id, MoveRequest(to_position=1, expected_version=row.version), user, db)
    rate_title(db, user.id, titles[0].id, 7)
    assert order(db, user.id) == [t.id for t in titles]


def test_concurrent_equal_ratings_are_both_added_once_after_existing_equals(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL row locks")
    user, titles = seed(db, [9, 7, 6])
    additions = [ContentTitle(id=uuid4(), tmdb_id=20+i, content_type="tv", title=f"New {i}")
                 for i in range(2)]
    db.add_all(additions)
    db.commit()
    user_id, new_ids = user.id, [t.id for t in additions]
    original_ids = [t.id for t in titles]
    db.rollback()
    barrier = Barrier(2)

    def add(title_id):
        with Session(db.bind) as session:
            barrier.wait(timeout=5)
            return rate_title(session, user_id, title_id, 7, expected_version=0).ranked_position

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(add, new_ids)) == [3, 4]
    result = order(db, user_id)
    assert result[:2] == original_ids[:2] and result[-1] == original_ids[-1]
    assert set(result[2:4]) == set(new_ids)
