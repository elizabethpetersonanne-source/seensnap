from uuid import uuid4
from sqlalchemy import select
from app.models.user import User
from app.models.content import ContentTitle
from app.models.social import Rating, RankedFavorite
from app.api.routes.favorites import append_unplaced_rated, BulkAddRequest, get_ranked_favorites
import pytest


def test_append_crosses_500_without_changing_manual_order_or_ratings(db):
    user = User(id=uuid4(), email="rank@example.invalid", auth_provider="test")
    rows = [
        ContentTitle(id=uuid4(), tmdb_id=i, content_type="movie", title=f"Movie {i}")
        for i in range(605)
    ]
    db.add_all([user, *rows])
    db.flush()
    db.add_all(
        [
            Rating(user_id=user.id, content_title_id=t.id, score=9, watched_state="watched")
            for t in rows
        ]
    )
    manual = [rows[2], rows[1], rows[0]]
    db.add_all(
        [
            RankedFavorite(user_id=user.id, content_title_id=t.id, position=i + 1)
            for i, t in enumerate(manual)
        ]
    )
    db.commit()
    result = append_unplaced_rated(BulkAddRequest(), user, db)
    assert result.total == 605 and result.added_count == 602
    assert len(result.items) <= 100 and result.has_more
    assert [r.title_id for r in result.items[:3]] == [t.id for t in manual]
    assert result.remaining_unplaced == 0
    page = get_ranked_favorites(user, db, limit=100, offset=600)
    assert len(page.items) == 5 and page.total == 605
    assert set(db.scalars(select(Rating.score)).all()) == {9}
    retry = append_unplaced_rated(BulkAddRequest(), user, db)
    assert retry.total == 605 and retry.added_count == 0


def test_postgres_move_crosses_pages_without_losing_order(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL deferred uniqueness")
    from app.api.routes.favorites import move_ranked_favorite, MoveRequest
    from fastapi import HTTPException

    user = User(id=uuid4(), email="move@example.invalid", auth_provider="test")
    titles = [
        ContentTitle(id=uuid4(), tmdb_id=i, content_type="movie", title=f"Title {i}")
        for i in range(605)
    ]
    db.add_all([user, *titles])
    db.flush()
    db.add_all(
        [
            RankedFavorite(user_id=user.id, content_title_id=t.id, position=i + 1)
            for i, t in enumerate(titles)
        ]
    )
    db.commit()
    moved = move_ranked_favorite(
        titles[604].id, MoveRequest(to_position=3, expected_version=1), user, db
    )
    assert moved.total == 605 and moved.items[0].title_id == titles[604].id
    ordered = db.scalars(
        select(RankedFavorite)
        .where(RankedFavorite.user_id == user.id)
        .order_by(RankedFavorite.position)
    ).all()
    assert [r.position for r in ordered] == list(range(1, 606))
    assert [r.content_title_id for r in ordered] == [
        t.id for t in titles[:2] + [titles[-1]] + titles[2:-1]
    ]
    with pytest.raises(HTTPException) as error:
        move_ranked_favorite(
            titles[604].id, MoveRequest(to_position=1, expected_version=1), user, db
        )
    assert error.value.status_code == 409
