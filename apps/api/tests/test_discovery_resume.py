from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4
import pytest
from fastapi import HTTPException
from app.models.discovery import DiscoveryDecision, DiscoverySession
from app.models.social import TitleWatchStatus
from app.models.user import User, UserProfile
from app.services import discovery_feed as feed
from app.api.routes.discovery_resume import ResumeRequest, resume_discovery


@pytest.fixture
def owner(db, monkeypatch):
    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(user)
    db.flush()
    db.add(
        UserProfile(user_id=user.id, username=user.id.hex, display_name="Viewer", country_code="US")
    )
    db.commit()

    def catalog(kind, band, page, genre, region, mode, as_of):
        rows = []
        for i in range(20):
            number = band * 10000 + page * 100 + i + 1
            rows.append(
                {
                    "id": number,
                    "media_type": kind,
                    "title": str(number),
                    "name": str(number),
                    "overview": "Full synopsis",
                    "poster_path": "/poster.jpg",
                    "release_date": feed.anniversary(as_of, -(2, 14, 25, 50)[band]).isoformat(),
                    "genres": [{"id": 35, "name": "Comedy"}],
                }
            )
        return {"rows": rows, "done": page >= 3, "cap": False}

    monkeypatch.setattr(feed, "catalog_page", catalog)
    return user


def test_resume_recovers_lost_prefetch_without_skipping_or_repeating_accepted_actions(db, owner):
    page = feed.get_feed(db, owner.id, preferred_type="movie", genre="comedy", limit=10)
    original = [UUID(item["title"]["id"]) for item in page["items"]]
    second = feed.get_feed(
        db, owner.id, preferred_type="movie", genre="comedy", limit=10, cursor=page["next_cursor"]
    )
    # Device saved page 1, then lost both an accepted Right response and page 2 response.
    db.add(
        DiscoveryDecision(
            id=uuid4(),
            user_id=owner.id,
            content_title_id=original[0],
            direction="right",
            action_version=2,
            created_at=datetime.now(timezone.utc),
        )
    )
    db.add(
        TitleWatchStatus(user_id=owner.id, content_title_id=original[1], watched_state="watched")
    )
    db.commit()
    payload = ResumeRequest(
        cursor=page["resume_cursor"],
        title_ids=original,
        surface="swipe",
        preferred_type="movie",
        genre="comedy",
    )
    resumed = resume_discovery(payload, owner, db)
    expected = [str(i) for i in original[2:]] + [item["title"]["id"] for item in second["items"]]
    assert [item["title"]["id"] for item in resumed["items"]] == expected
    assert resumed["next_cursor"] == second["next_cursor"]
    assert db.get(DiscoverySession, UUID(page["session_id"])).version == 2


def test_resume_rejects_other_owner_unserved_ids_expired_sessions_and_changed_filters(db, owner):
    page = feed.get_feed(db, owner.id, preferred_type="movie", genre="comedy", limit=10)
    values = dict(
        cursor=page["resume_cursor"],
        title_ids=[page["items"][0]["title"]["id"]],
        surface="swipe",
        preferred_type="movie",
        genre="comedy",
    )
    other = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(other)
    db.commit()
    for payload, viewer in [
        (values, other),
        (values | {"title_ids": [uuid4()]}, owner),
        (values | {"genre": "documentary"}, owner),
        (values | {"mode": "all"}, owner),
        (values | {"surface": "preview"}, owner),
    ]:
        with pytest.raises(HTTPException) as exc:
            resume_discovery(ResumeRequest(**payload), viewer, db)
        assert exc.value.status_code == 409
    profile = db.get(UserProfile, owner.id)
    profile.country_code = "CA"
    db.commit()
    with pytest.raises(HTTPException):
        resume_discovery(ResumeRequest(**values), owner, db)
    profile.country_code = "US"
    session = db.get(DiscoverySession, UUID(page["session_id"]))
    session.created_at = datetime.now(timezone.utc) - timedelta(days=2)
    db.commit()
    with pytest.raises(HTTPException):
        resume_discovery(ResumeRequest(**values), owner, db)


def test_preview_resume_reuses_verified_session_video_and_keeps_exact_title_order(
    db, owner, monkeypatch
):
    calls = []

    def video(title):
        calls.append(title.id)
        return {
            "provider": "YouTube",
            "external_key": str(title.tmdb_id),
            "type": "Trailer",
            "name": "Official trailer",
            "official": True,
        }

    monkeypatch.setattr(feed, "_video", video)
    page = feed.get_feed(
        db, owner.id, preferred_type="movie", genre="comedy", surface="preview", limit=10
    )
    before = len(calls)
    requested = [item["title_id"] for item in page["items"][4:]]
    result = resume_discovery(
        ResumeRequest(
            cursor=page["resume_cursor"],
            title_ids=requested,
            surface="preview",
            preferred_type="movie",
            genre="comedy",
        ),
        owner,
        db,
    )
    assert [item["title_id"] for item in result["items"]] == requested
    assert len(calls) == before and all(item["video"]["official"] for item in result["items"])
