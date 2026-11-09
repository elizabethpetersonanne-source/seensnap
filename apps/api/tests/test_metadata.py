from datetime import date
from unittest.mock import Mock
from uuid import uuid4
import pytest
from app.models.content import ContentTitle
from app.services import tmdb


def existing():
    return ContentTitle(
        id=uuid4(),
        tmdb_id=42,
        content_type="movie",
        title="Example",
        genres=["Comedy"],
        runtime_minutes=91,
        season_count=None,
        release_date=date(2020, 1, 2),
        poster_url="poster",
        overview="Rich synopsis",
        metadata_raw={
            "credits": {"cast": [{"id": 17}]},
            "runtime": 91,
            "_seensnap_details_at": "previous",
        },
    )


def test_sparse_search_preserves_hydration(monkeypatch):
    title = existing()
    db = Mock()
    db.scalar.return_value = title
    monkeypatch.setattr(tmdb, "_fetch_genre_map", lambda kind: {35: "Comedy"})
    tmdb._upsert_title_from_tmdb_result(
        db, {"id": 42, "media_type": "movie", "title": "Example", "genre_ids": [35]}
    )
    assert title.runtime_minutes == 91
    assert title.overview == "Rich synopsis"
    assert title.poster_url == "poster"
    assert title.genres == ["Comedy"]
    assert title.metadata_raw["credits"]["cast"][0]["id"] == 17
    assert title.metadata_raw["_seensnap_details_at"] == "previous"


def test_authoritative_refresh_can_clear_metadata():
    title = existing()
    db = Mock()
    db.scalar.return_value = title
    tmdb._upsert_title_from_tmdb_result(
        db,
        {
            "id": 42,
            "media_type": "movie",
            "title": "Example",
            "runtime": None,
            "genres": [],
            "credits": {"cast": []},
        },
        complete=True,
    )
    assert title.runtime_minutes is None
    assert title.genres == []
    assert title.metadata_raw["credits"]["cast"] == []


@pytest.mark.parametrize("alias", ["tv", "show", "series"])
def test_tv_genre_ids_and_episode_runtime_are_distinct(monkeypatch, alias):
    db = Mock()
    db.scalar.return_value = None
    monkeypatch.setattr(
        tmdb, "_fetch_genre_map", lambda kind: {99: "Documentary"} if kind == "tv" else {}
    )
    title = tmdb._upsert_title_from_tmdb_result(
        db,
        {
            "id": 42,
            "media_type": alias,
            "name": "Nature",
            "genre_ids": [99],
            "first_air_date": "2010-02-03",
            "episode_run_time": [25],
        },
    )
    assert title.content_type == "series"
    assert title.genres == ["Documentary"]
    assert title.runtime_minutes is None
    assert title.metadata_raw["episode_run_time"] == [25]
    assert title.release_date == date(2010, 2, 3)


def test_movie_and_tv_identity_does_not_collide(db):
    movie = tmdb._upsert_title_from_tmdb_result(
        db, {"id": 42, "media_type": "movie", "title": "Movie"}
    )
    show = tmdb._upsert_title_from_tmdb_result(db, {"id": 42, "media_type": "tv", "name": "Series"})
    assert movie.id != show.id
