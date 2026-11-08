from uuid import uuid4
from app.models.user import User
from app.models.content import ContentTitle
from app.models.social import Rating, RankedFavorite, TitleWatchStatus
from app.api.routes.picks import get_my_picks_collections, get_collection_page


def test_all_ranked_titles_reachable_and_unplaced_counts_full_collection(db):
    user = User(id=uuid4(), email="picks@example.invalid", auth_provider="test")
    titles = [
        ContentTitle(id=uuid4(), tmdb_id=i, content_type="movie", title=f"Title {i}")
        for i in range(605)
    ]
    db.add_all([user, *titles])
    db.flush()
    db.add_all(
        [
            Rating(user_id=user.id, content_title_id=t.id, score=9, watched_state="watched")
            for t in titles
        ]
    )
    db.add_all(
        [
            RankedFavorite(user_id=user.id, content_title_id=t.id, position=i + 1)
            for i, t in enumerate(titles[:600])
        ]
    )
    db.commit()
    initial = get_my_picks_collections(user, db)
    assert len(initial.ranked_favorites) == 100
    assert initial.ranked_favorites_count == 600 and initial.rated_unplaced_count == 5
    page = get_collection_page("ranked_favorites", user, db, limit=100, offset=500)
    assert len(page.items) == 100 and page.items[-1].rank_label == "#600" and not page.has_more


def test_watched_count_is_exact_union_and_rating_remains_optional(db):
    user = User(id=uuid4(), email="union@example.invalid", auth_provider="test")
    titles = [
        ContentTitle(id=uuid4(), tmdb_id=i, content_type="movie", title=f"Title {i}")
        for i in range(3)
    ]
    db.add_all([user, *titles])
    db.flush()
    db.add_all(
        [
            Rating(user_id=user.id, content_title_id=t.id, score=8, watched_state="watched")
            for t in titles[:2]
        ]
    )
    db.add_all(
        [
            TitleWatchStatus(user_id=user.id, content_title_id=t.id, watched_state="watched")
            for t in titles[1:]
        ]
    )
    db.commit()
    result = get_my_picks_collections(user, db)
    assert result.watched_count == 3 and len(result.watched) == 3
    assert next(t for t in result.watched if t.id == str(titles[2].id)).personal_score is None
