from datetime import date
from uuid import uuid4
import pytest
from fastapi import HTTPException
from app.models.content import ContentTitle
from app.models.user import User, UserProfile
from app.services import discover_collections as collections


@pytest.fixture
def owner(db):
    u = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(u)
    db.flush()
    db.add(UserProfile(user_id=u.id, username=u.id.hex, display_name="Viewer", country_code="CA"))
    db.commit()
    return u


def test_source_membership_media_and_region_before_pagination(db, owner, monkeypatch):
    calls = []

    def page(db, key, media, region, number):
        calls.append((key, media, region, number))
        rows = []
        for n in range((number - 1) * 20, number * 20):
            t = ContentTitle(
                tmdb_id=n + 1,
                content_type="series" if media == "tv" else "movie",
                title=f"Actual source {n}",
                poster_url="https://image.invalid/test",
            )
            db.add(t)
            rows.append(t)
        db.flush()
        return rows, number < 3

    monkeypatch.setattr(collections, "source_page", page)
    first = collections.collection_page(db, owner.id, "trending", "tv")
    second = collections.collection_page(db, owner.id, "trending", "tv", first["next_cursor"])
    replay = collections.collection_page(db, owner.id, "trending", "tv", first["next_cursor"])
    third = collections.collection_page(db, owner.id, "trending", "tv", second["next_cursor"])
    ids = [i["id"] for p in (first, second, third) for i in p["items"]]
    assert len(ids) == len(set(ids)) == 60 and not third["has_more"]
    assert second == replay and all(i["content_type"] == "series" for i in first["items"])
    assert calls == [("trending", "tv", "CA", i) for i in (1, 2, 3)]
    other = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(other)
    db.commit()
    with pytest.raises(HTTPException):
        collections.collection_page(db, other.id, "trending", "tv", first["next_cursor"])
    with pytest.raises(HTTPException):
        collections.collection_page(db, owner.id, "trending", "movie", second["next_cursor"])
    # Now-playing always requests the user's region and movie context, even if a stale link says TV.
    result = collections.collection_page(db, owner.id, "now-in-theaters", "tv")
    assert result["media"] == "movie" and calls[-1] == ("now-in-theaters", "movie", "CA", 1)


def test_for_you_snapshot_reaches_every_title_without_reranking_page_offsets(
    db, owner, monkeypatch
):
    from app.models.social import Rating

    rows = [
        ContentTitle(
            tmdb_id=i + 100,
            content_type="series",
            title=f"Series {i}",
            poster_url="https://image.invalid/test",
            overview="Synopsis",
            release_date=date(2020, 1, 1),
            genres=["Comedy"],
        )
        for i in range(65)
    ]
    db.add_all(rows)
    db.commit()

    def forbidden(*a, **k):
        raise AssertionError("Source membership must come from For You, not Trending")

    monkeypatch.setattr(collections, "source_page", forbidden)
    page = collections.collection_page(db, owner.id, "for-you", "tv")
    ids = []
    while True:
        ids.extend(i["id"] for i in page["items"])
        if not page["next_cursor"]:
            break
        # Rating a title already shown must not shift offsets and skip another title.
        if len(ids) == 20:
            db.add(Rating(user_id=owner.id, content_title_id=rows[0].id, score=10))
            db.commit()
        page = collections.collection_page(db, owner.id, "for-you", "tv", page["next_cursor"])
    expected = {str(t.id) for t in rows} - (
        {str(rows[0].id)} if str(rows[0].id) not in ids else set()
    )
    assert set(ids) == expected and len(ids) == len(set(ids))


@pytest.mark.parametrize(
    "key,media,path,region_param",
    [
        ("trending", "tv", "/trending/tv/week", None),
        ("trending", "movie", "/trending/movie/week", None),
        ("now-in-theaters", "movie", "/movie/now_playing", "CA"),
    ],
)
def test_tmdb_source_uses_typed_endpoint_and_page(db, monkeypatch, key, media, path, region_param):
    from types import SimpleNamespace

    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def get(self, url, params):
            calls.append((url, params))
            return SimpleNamespace(
                raise_for_status=lambda: None,
                json=lambda: {"results": [{"id": 123, "poster_path": "/poster"}], "total_pages": 4},
            )

    payloads = []
    monkeypatch.setattr(collections.httpx, "Client", Client)
    monkeypatch.setattr(collections, "_tmdb_headers", lambda: {})
    monkeypatch.setattr(
        collections,
        "_upsert_title_from_tmdb_result",
        lambda db, item: payloads.append(item) or SimpleNamespace(poster_url="poster"),
    )
    rows, more = collections.source_page(db, key, media, "CA", 2)
    assert len(rows) == 1 and more and calls[0][0] == path
    assert calls[0][1]["page"] == 2 and calls[0][1].get("region") == region_param
    assert payloads[0]["media_type"] == media


def test_upstream_failure_does_not_advance_collection_cursor(db, owner, monkeypatch):
    import httpx
    from app.models.discovery import DiscoverySession

    def page(db, *args):
        rows = [
            ContentTitle(tmdb_id=i, content_type="movie", title=str(i), poster_url="poster")
            for i in range(20)
        ]
        db.add_all(rows)
        db.flush()
        return rows, True

    monkeypatch.setattr(collections, "source_page", page)
    first = collections.collection_page(db, owner.id, "trending")
    from uuid import UUID

    sid = UUID(first["next_cursor"].split(":")[0])

    def offline(*a, **k):
        raise httpx.ConnectError("unavailable")

    monkeypatch.setattr(collections, "source_page", offline)
    with pytest.raises(httpx.HTTPError):
        collections.collection_page(db, owner.id, "trending", cursor=first["next_cursor"])
    db.rollback()
    assert db.get(DiscoverySession, sid).version == 1
