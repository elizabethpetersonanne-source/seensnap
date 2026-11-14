from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import func, select

from app.models.content import ContentTitle
from app.models.discovery import DiscoveryDecision
from app.models.social import FeedComment, FeedEvent, FeedReaction, Rating, UserFollow, Watchlist, WatchlistItem
from app.models.taste import CompatibilityScore, SwipeRecord, UserTasteProfile
from app.models.user import User, UserProfile
from app.services import discovery_decisions, taste
from app.services.title_state import rate_title, save_title, unsave_title


def seed(db):
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    title = ContentTitle(id=uuid4(), tmdb_id=1, content_type="movie", title="A film")
    db.add_all([user, title]); db.commit()
    return user, title


def swipe(db, user, title, key="choice"):
    return taste.record_swipe(db, user.id, title_id=title.id, direction="right",
                             idempotency_key=key, refresh_derived=False)


def test_right_swipe_saves_once_and_undo_removes_only_its_queue_item(db):
    user, title = seed(db)
    custom = Watchlist(owner_user_id=user.id, name="Private favorites")
    db.add(custom); db.flush()
    db.add(WatchlistItem(watchlist_id=custom.id, content_title_id=title.id, added_via="manual")); db.commit()
    first = swipe(db, user, title)
    assert swipe(db, user, title).id == first.id
    assert db.scalar(select(func.count()).select_from(WatchlistItem)) == 2
    assert db.scalar(select(Rating.id)) is None
    result = discovery_decisions.undo_decision(db, user.id, first.id, refresh_derived=False)
    assert result["saved"] is False and "saved" in result["reversed"]
    assert db.scalar(select(WatchlistItem.watchlist_id)) == custom.id
    assert discovery_decisions.undo_decision(db, user.id, first.id, refresh_derived=False)["saved"] is False


@pytest.mark.parametrize("save_before,save_after", [(True, False), (False, True)])
def test_right_undo_preserves_independent_saves_and_ratings(db, save_before, save_after):
    user, title = seed(db)
    rate_title(db, user.id, title.id, 8)
    if save_before: save_title(db, user.id, title.id)
    first = swipe(db, user, title)
    if save_after: save_title(db, user.id, title.id)
    result = discovery_decisions.undo_decision(db, user.id, first.id, refresh_derived=False)
    assert result["saved"] and result["watched"]
    assert db.scalar(select(Rating.score)) == 8


def test_right_undo_preserves_removed_and_resaved_item(db):
    user, title = seed(db)
    first = swipe(db, user, title)
    unsave_title(db, user.id, title.id); save_title(db, user.id, title.id)
    result = discovery_decisions.undo_decision(db, user.id, first.id, refresh_derived=False)
    assert result["saved"]


def test_right_queue_creation_rolls_back_with_failed_decision(db, monkeypatch):
    user, title = seed(db)
    def fail(*args): raise RuntimeError("decision write failed")
    monkeypatch.setattr(discovery_decisions, "create_decision", fail)
    with pytest.raises(RuntimeError): swipe(db, user, title)
    db.rollback()
    for model in [Watchlist, WatchlistItem, SwipeRecord, DiscoveryDecision]:
        assert db.scalar(select(func.count()).select_from(model)) == 0


def test_rating_invalidates_existing_taste_summary(db):
    user, title = seed(db)
    profile = UserTasteProfile(user_id=user.id, updated_at=datetime.now(timezone.utc))
    db.add(profile); db.commit()
    rate_title(db, user.id, title.id, 7)
    db.refresh(profile)
    assert profile.updated_at.year == 1970


def test_internal_push_trigger_rejects_missing_wrong_and_disabled_credentials(monkeypatch):
    from app.api.routes.notifications import trigger_send_pending
    from app.core.config import settings
    for configured, supplied in [("", None), ("test-job-secret", None), ("test-job-secret", "Bearer wrong")]:
        monkeypatch.setattr(settings, "internal_job_token", configured)
        tasks = BackgroundTasks()
        with pytest.raises(HTTPException) as denied: trigger_send_pending(tasks, supplied)
        assert denied.value.status_code == 403 and not tasks.tasks
    monkeypatch.setattr(settings, "internal_job_token", "test-job-secret")
    tasks = BackgroundTasks()
    trigger_send_pending(tasks, "Bearer test-job-secret")
    assert len(tasks.tasks) == 1  # Do not execute any push delivery.


@pytest.fixture
def social_users(db):
    if db.bind.dialect.name == "sqlite":
        from app.db.base import Base
        from sqlalchemy import text
        Base.metadata.create_all(db.get_bind(), tables=[table for table in Base.metadata.tables.values() if table.name != "preview_sessions"])
        db.execute(text("PRAGMA foreign_keys=ON"))
    users = [User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test") for _ in range(4)]
    db.add_all(users); db.flush()
    db.add_all([UserProfile(user_id=u.id, username=u.id.hex, display_name="Tester") for u in users])
    db.commit()
    return users


def test_feed_cursor_exhausts_mixed_buckets_and_equal_timestamps_without_duplicates(db, social_users):
    from app.services.social_feed import following_feed, encode_feed_cursor
    viewer, followed, high, medium = social_users
    db.add(UserFollow(follower_user_id=viewer.id, following_user_id=followed.id))
    for person, score in [(high, 95), (medium, 85)]:
        a, b = sorted([viewer.id, person.id], key=str)
        db.add(CompatibilityScore(user_a_id=a, user_b_id=b, compatibility=score, user_a_version=0, user_b_version=0, rated_count_a=5, rated_count_b=5))
    now = datetime.now(timezone.utc)
    expected = []
    for group, person in enumerate([followed, high, medium]):
        events = [FeedEvent(id=uuid4(), actor_user_id=person.id, event_type="title_share",
                            source_type="social_post", visibility="public",
                            created_at=now-timedelta(minutes=(2-group)*10+i//2)) for i in range(9)]
        expected.extend(sorted(events, key=lambda e: (-e.created_at.timestamp(), str(e.id))))
        db.add_all(events)
    db.commit()
    seen, cursor = [], None
    while True:
        page = following_feed(db, viewer.id, limit=4, cursor=cursor)
        if not page: break
        seen.extend(e.id for e in page)
        cursor = encode_feed_cursor(page[-1])
    assert seen == [e.id for e in expected] and len(seen) == len(set(seen))
    with pytest.raises(HTTPException): following_feed(db, viewer.id, cursor="bad")


@pytest.mark.parametrize("account", [False, True])
def test_deletion_removes_other_users_engagement_but_keeps_other_posts(db, social_users, account):
    from app.api.routes.auth import delete_account
    from app.api.routes.activity import delete_publication
    owner, commenter, replier, _ = social_users
    post = FeedEvent(actor_user_id=owner.id, event_type="title_share", source_type="social_post", visibility="public")
    keep = FeedEvent(actor_user_id=commenter.id, event_type="title_share", source_type="social_post", visibility="public")
    db.add_all([post, keep]); db.flush()
    comment = FeedComment(event_id=post.id, user_id=commenter.id, body="Reply")
    db.add(comment); db.flush()
    db.add(FeedComment(event_id=post.id, user_id=replier.id, parent_comment_id=comment.id, body="Nested reply"))
    db.add(FeedReaction(event_id=post.id, user_id=commenter.id, reaction="like"))
    db.commit()
    post_id, keep_id, owner_id = post.id, keep.id, owner.id
    if account: delete_account(owner, db)
    else: delete_publication(post_id, owner, db)
    assert db.get(FeedEvent, post_id) is None and db.get(FeedEvent, keep_id) is not None
    assert db.scalar(select(func.count()).select_from(FeedComment)) == 0
    assert db.scalar(select(func.count()).select_from(FeedReaction)) == 0
    assert (db.get(User, owner_id) is None) == account
