from uuid import uuid4
import pytest
from fastapi import HTTPException
from app.models.user import User, UserPreferences
from app.models.content import ContentTitle
from app.api.routes.ratings import (
    upsert_rating,
    clear_rating,
    get_rating,
    set_watch_status,
    RatingUpsertRequest,
    WatchStatusRequest,
)
from app.api.routes.onboarding_draft import get_draft, put_draft, clear_draft, DraftData, DraftWrite


@pytest.fixture
def person(db):
    user = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    title = ContentTitle(tmdb_id=123, content_type="movie", title="A film")
    db.add_all([user, title])
    db.commit()
    return user, title


def test_rating_clear_and_recreate_never_reuses_version(db, person):
    user, title = person
    first = upsert_rating(title.id, RatingUpsertRequest(score=8, expected_version=0), user, db)
    cleared = clear_rating(title.id, user, db, first.version)
    assert cleared.version > first.version and cleared.score is None
    assert get_rating(title.id, user, db).version == cleared.version
    for stale in [0, first.version]:
        with pytest.raises(HTTPException) as exc:
            upsert_rating(title.id, RatingUpsertRequest(score=3, expected_version=stale), user, db)
        assert exc.value.status_code == 409
        db.rollback()
    recreated = upsert_rating(
        title.id, RatingUpsertRequest(score=9, expected_version=cleared.version), user, db
    )
    assert recreated.version > cleared.version
    with pytest.raises(HTTPException) as exc:
        clear_rating(title.id, user, db, first.version)
    assert exc.value.status_code == 409
    db.rollback()
    assert get_rating(title.id, user, db).score == 9


def test_watch_correction_advances_revision_and_confirms_rating_removal(db, person):
    user, title = person
    first = upsert_rating(title.id, RatingUpsertRequest(score=8), user, db)
    with pytest.raises(HTTPException):
        set_watch_status(title.id, WatchStatusRequest(watched_state="want_to_watch"), user, db)
    db.rollback()
    corrected = set_watch_status(
        title.id,
        WatchStatusRequest(watched_state="want_to_watch", confirm_clear_rating=True),
        user,
        db,
    )
    assert corrected.version > first.version and corrected.score is None
    with pytest.raises(HTTPException):
        upsert_rating(
            title.id, RatingUpsertRequest(score=1, expected_version=first.version), user, db
        )


def test_onboarding_owner_scope_conflicts_replay_and_completion(db, person):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Preferences model included in PostgreSQL suite")
    user, _ = person
    other = User(email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(other)
    db.commit()
    assert get_draft(user, db)["data"] is None
    payload = DraftWrite(
        data=DraftData(
            step="services",
            display_name="Alex",
            username="alex",
            country_code="ca",
            streaming_services=["netflix"],
        ),
        expected_version=0,
    )
    first = put_draft(payload, user, db)
    assert first["data"]["country_code"] == "CA" and first["version"] == 1
    assert put_draft(payload, user, db)["version"] == 1
    assert get_draft(other, db)["data"] is None
    with pytest.raises(HTTPException) as exc:
        put_draft(DraftWrite(data=DraftData(step="dna"), expected_version=0), user, db)
    assert exc.value.status_code == 409
    db.rollback()
    db.add(UserPreferences(user_id=user.id, onboarding_completed=True))
    db.commit()
    assert get_draft(user, db)["data"] is None
    with pytest.raises(HTTPException) as exc:
        put_draft(DraftWrite(data=DraftData(step="calibrate"), expected_version=1), user, db)
    assert exc.value.detail["code"] == "onboarding_completed"
    db.rollback()
    assert clear_draft(user, db)["version"] > first["version"]


def test_stale_watched_confirmation_cannot_clear_a_newer_rating(db, person):
    user, title = person
    old = upsert_rating(title.id, RatingUpsertRequest(score=5, expected_version=0), user, db)
    new = upsert_rating(
        title.id, RatingUpsertRequest(score=9, expected_version=old.version), user, db
    )
    with pytest.raises(HTTPException) as exc:
        set_watch_status(
            title.id,
            WatchStatusRequest(
                watched_state="want_to_watch",
                confirm_clear_rating=True,
                expected_version=old.version,
            ),
            user,
            db,
        )
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "version_conflict"
    db.rollback()
    assert get_rating(title.id, user, db).score == 9
    assert get_rating(title.id, user, db).version == new.version
