from datetime import datetime, timedelta, timezone, date
from uuid import uuid4
from sqlalchemy import select
from app.models.user import User, UserProfile, Device
from app.models.social import Notification, NotificationOutbox, Rating
from app.models.entitlements import EntitlementGrant
from app.models.content import ContentTitle


def people(db, count=3):
    users = [User(email=f"{uuid4()}@example.invalid", auth_provider="test") for _ in range(count)]
    db.add_all(users); db.flush()
    db.add_all([UserProfile(user_id=u.id, username=u.id.hex, display_name=f"Person {i}") for i, u in enumerate(users)])
    db.commit()
    return users


def test_likes_group_without_duplicate_push_or_cross_post_merging(db):
    from app.services.notifications import notify_social_like
    owner, a, b = people(db)
    device = Device(user_id=owner.id, platform="ios", expo_push_token="test-only", enabled=True)
    db.add(device); db.commit()
    post = uuid4()
    for actor in [a, a, b, b]:
        notify_social_like(db, liker=actor, post_author_id=owner.id, post_id=post)
    db.commit()
    notes = db.scalars(select(Notification)).all()
    assert len(notes) == 1 and "1 others" in notes[0].title
    assert len(notes[0].payload["actor_ids"]) == 2
    assert len(db.scalars(select(NotificationOutbox)).all()) == 1
    notify_social_like(db, liker=a, post_author_id=owner.id, post_id=uuid4())
    db.commit()
    assert len(db.scalars(select(Notification)).all()) == 2


def test_notification_cursor_does_not_drop_equal_timestamp_rows(db):
    from app.api.routes.notifications import list_notifications
    user = people(db, 1)[0]
    stamp = datetime.now(timezone.utc)
    db.add_all([Notification(user_id=user.id, notification_type="test", title="A notice", body="", created_at=stamp) for _ in range(7)])
    db.commit()
    found, cursor = [], None
    for _ in range(3):
        page = list_notifications(user, db, limit=3, cursor=cursor)
        found.extend(n.id for n in page.items); cursor = page.next_cursor
    assert len(found) == len(set(found)) == 7 and cursor is None


def test_premium_lasts_until_last_grant_or_indefinitely_during_beta(db):
    from app.services.entitlements import resolve_entitlement
    user = people(db, 1)[0]
    now = datetime.now(timezone.utc)
    grants = [EntitlementGrant(user_id=user.id, source="promo", tier="premium", starts_at=now-timedelta(days=1), ends_at=now+timedelta(days=n), verified=True) for n in [5, 20]]
    db.add_all(grants); db.commit()
    assert resolve_entitlement(db, user.id).expires_at.date() == (now + timedelta(days=20)).date()
    grants[0].source = "beta"; grants[0].ends_at = None; db.commit()
    assert resolve_entitlement(db, user.id).expires_at is None
    assert resolve_entitlement(db, user.id).is_beta


def test_related_titles_keep_source_relevance_and_remove_known_dislikes(db):
    from app.services.related_titles import rank_related_titles
    user = people(db, 1)[0]
    rows = [ContentTitle(tmdb_id=i, title=f"Title {i}", content_type="movie", genres=genres,
                         release_date=date(2020,1,1), poster_url="https://example.invalid/poster")
            for i, genres in enumerate([["Comedy"], ["Comedy"], ["Comedy"], ["Crime"]], 1)]
    db.add_all(rows); db.flush()
    db.add(Rating(user_id=user.id, content_title_id=rows[2].id, score=2)); db.commit()
    result = rank_related_titles(db, user.id, rows[0], rows)
    assert [t.id for t in result] == [rows[1].id]


def test_for_you_returns_available_local_picks_without_waiting_for_tmdb(db, monkeypatch):
    from app.services.for_you import for_you_recommendations
    user = people(db, 1)[0]
    row = ContentTitle(tmdb_id=123, title="Local TV", content_type="series", genres=["Comedy"],
                       overview="A comedy", poster_url="https://example.invalid/poster", release_date=date(2020,1,1))
    db.add(row); db.commit()
    def forbidden(*args, **kwargs):
        raise AssertionError("Existing local picks must not block on catalog enrichment")
    monkeypatch.setattr("app.services.tmdb.fetch_popular_titles", forbidden)
    assert [r.title.id for r in for_you_recommendations(db, user.id, preferred_type="show")] == [row.id]


def test_social_swipe_source_requires_current_visibility_even_on_cursor_replay(db, monkeypatch):
    from app.services import discovery_feed as feed
    from app.models.social import UserFollow, Watchlist, WatchlistItem
    owner, viewer = people(db, 2)
    db.add(UserFollow(follower_user_id=viewer.id, following_user_id=owner.id))
    row = ContentTitle(tmdb_id=99, title="Shared comedy", content_type="movie", genres=["Comedy"],
                       overview="A complete synopsis", poster_url="https://example.invalid/poster", release_date=date(2020,1,1),
                       metadata_raw={"_discovery_availability": {"US:streaming": datetime.now(timezone.utc).isoformat()}})
    wl = Watchlist(owner_user_id=owner.id, name="Shared list", visibility="followers")
    db.add_all([row, wl]); db.flush()
    db.add(WatchlistItem(watchlist_id=wl.id, content_title_id=row.id, added_via="test")); db.commit()
    monkeypatch.setattr(feed, "catalog_page", lambda *a: {"rows": [], "done": True, "cap": False})
    first = feed.get_feed(db, viewer.id, preferred_type="movie", genre="comedy", limit=1)
    assert first["items"][0]["reason"] == "Saved by someone you follow"
    wl.visibility = "private"; db.commit()
    replay = feed.get_feed(db, viewer.id, preferred_type="movie", genre="comedy", limit=1, cursor=f'{first["session_id"]}:0')
    assert replay["items"][0]["reason"] != "Saved by someone you follow"
    assert feed.private_sources(db, viewer.id, set()) == ([], [])


def test_title_details_and_gallery_reuse_fresh_metadata(db, monkeypatch):
    from app.services import tmdb
    row = ContentTitle(tmdb_id=42, title="Cached", content_type="movie", metadata_raw={
        "_seensnap_details_at": datetime.now(timezone.utc).isoformat(),
        "images": {"backdrops": [{"file_path": "/cached.jpg"}]},
    })
    db.add(row); db.commit()
    monkeypatch.setattr(tmdb, "_tmdb_headers", lambda: (_ for _ in ()).throw(AssertionError("No network for fresh metadata")))
    assert tmdb.refresh_title_details(db, row) is row
    assert tmdb.fetch_title_gallery(row)[0]["url"].endswith("/cached.jpg")
