from datetime import datetime, timedelta, timezone
from uuid import uuid4
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.api.dependencies import get_current_user, get_db
from app.api.routes import stories
from app.models.content import ContentTitle
from app.models.social import Block, Rating, UserFollow, Watchlist, WatchlistItem
from app.models.story import SocialStory
from app.models.user import User, UserPreferences, UserProfile


@pytest.fixture
def people(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Story audience queries require full schema")
    owner, viewer = [
        User(email=f"{uuid4()}@example.invalid", auth_provider="test") for _ in range(2)
    ]
    title = ContentTitle(tmdb_id=1, content_type="movie", title="Story title")
    db.add_all([owner, viewer, title])
    db.flush()
    for user in [owner, viewer]:
        db.add(UserProfile(user_id=user.id, username=user.id.hex, display_name="Viewer"))
    db.add(UserFollow(follower_user_id=viewer.id, following_user_id=owner.id))
    db.commit()
    return owner, viewer, title


def add_story(db, user, title, expired=False, created=None):
    now = datetime.now(timezone.utc)
    row = SocialStory(
        id=uuid4(),
        user_id=user.id,
        content_title_id=title.id,
        caption="My caption",
        created_at=created or now,
        expires_at=now + timedelta(hours=-1 if expired else 71),
    )
    db.add(row)
    db.flush()
    return row


def test_owner_history_includes_expired_and_paginates_without_delete_offset_skips(db, people):
    owner, other, title = people
    when = datetime.now(timezone.utc) - timedelta(days=4)
    rows = [add_story(db, owner, title, expired=i < 100, created=when) for i in range(105)]
    add_story(db, other, title, expired=True, created=when)
    db.commit()
    page = stories.list_my_stories(owner, db, state="all", limit=24, cursor=None)
    assert page.total == 105
    seen = [row.story_id for row in page.items]
    stories.delete_story(seen[0], owner, db)
    while page.next_cursor:
        page = stories.list_my_stories(owner, db, state="all", limit=24, cursor=page.next_cursor)
        seen.extend(row.story_id for row in page.items)
    assert len(seen) == len(set(seen)) == 105
    archived = stories.list_my_stories(owner, db, state="archived", limit=100, cursor=None)
    assert all(row.expires_at < datetime.now(timezone.utc) for row in archived.items)
    active = stories.list_my_stories(owner, db, state="active", limit=100, cursor=None)
    assert active.total in (4, 5) and all(
        row.expires_at > datetime.now(timezone.utc) for row in active.items
    )
    assert all(
        row.user_id == owner.id
        for row in db.scalars(
            select(SocialStory).where(SocialStory.id.in_([x.story_id for x in archived.items]))
        )
    )


def test_archive_is_owner_only_and_deletion_removes_story_without_mutating_title_state(db, people):
    owner, viewer, title = people
    archived = add_story(db, owner, title, expired=True)
    active = add_story(db, owner, title)
    rating = Rating(user_id=owner.id, content_title_id=title.id, score=9)
    listing = Watchlist(owner_user_id=owner.id, name="Private list")
    db.add_all([rating, listing])
    db.flush()
    db.add(WatchlistItem(watchlist_id=listing.id, content_title_id=title.id, added_via="test"))
    db.commit()
    app = FastAPI()
    app.include_router(stories.router, prefix="/me/stories")
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    assert client.get("/me/stories").status_code == 401
    app.dependency_overrides[get_current_user] = lambda: viewer
    assert client.get("/me/stories").json()["items"] == []
    assert client.get(f"/me/stories/{archived.id}").status_code == 404
    client.delete(f"/me/stories/{archived.id}")
    assert db.get(SocialStory, archived.id) is not None
    app.dependency_overrides[get_current_user] = lambda: owner
    assert client.get(f"/me/stories/{archived.id}").status_code == 200
    assert client.delete(f"/me/stories/{archived.id}").status_code == 204
    assert client.get(f"/me/stories/{archived.id}").status_code == 404
    assert client.delete(f"/me/stories/{archived.id}").status_code == 204
    assert len(stories.list_active_stories(viewer, db).others[0].stories) == 1
    assert client.delete(f"/me/stories/{active.id}").status_code == 204
    assert not stories.list_active_stories(viewer, db).others
    assert db.scalar(select(Rating.score)) == 9 and db.scalar(select(WatchlistItem.id)) is not None


def test_edit_caption_can_clear_without_republishing_expired_story(db, people):
    owner, viewer, title = people
    active = add_story(db, owner, title)
    expired = add_story(db, owner, title, expired=True)
    db.commit()
    original_expiry = active.expires_at
    result = stories.edit_story(active.id, stories.EditStoryRequest(caption=None), owner, db)
    assert result.caption is None and result.expires_at == original_expiry
    with pytest.raises(HTTPException) as refused:
        stories.edit_story(expired.id, stories.EditStoryRequest(caption="new"), owner, db)
    assert refused.value.status_code == 410
    with pytest.raises(HTTPException):
        stories.edit_story(active.id, stories.EditStoryRequest(caption="other"), viewer, db)


def test_active_story_reader_checks_blocks_profile_audience_and_expiry(db, people):
    owner, viewer, title = people
    add_story(db, owner, title)
    add_story(db, owner, title, expired=True)
    db.commit()
    assert len(stories.list_active_stories(viewer, db).others[0].stories) == 1
    block = Block(blocker_user_id=owner.id, blocked_user_id=viewer.id)
    db.add(block)
    db.commit()
    assert stories.list_active_stories(viewer, db).others == []
    db.delete(block)
    prefs = UserPreferences(user_id=owner.id, profile_visibility="private")
    db.add(prefs)
    db.commit()
    assert stories.list_active_stories(viewer, db).others == []
    assert stories.list_active_stories(owner, db).me is not None
