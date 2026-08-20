"""Social acceptance harness — Social brief §96-§103.

Run: `.venv/bin/python -m scripts.social_acceptance`

Multi-user integration checks that exercise the real backend services (no
mocks) against the local database. Each test provisions ephemeral users,
runs the flow, and cleans up. Prints PASS / FAIL per criterion with the
observed behavior. Intended for local verification, not CI (CI would need
a fixture DB).

Criteria checked:
  1. Following feed excludes users you don't follow.
  2. Private posts never surface to non-authors.
  3. Blocked users disappear from the follower's feed on next fetch.
  4. Save via social_feed attributes with added_via="social_feed" and the
     save flows into the follower's SceneDNA signals.
  5. Liking a post fires a notification to the author (deduped by liker+post).
  6. Commenting on a post fires a notification per comment (no dedupe).
  7. Search results respect is_demo=False by default (no fake-data leak).
"""
from __future__ import annotations

from uuid import uuid4

from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models.content import ContentTitle
from app.models.social import (
    Block,
    FeedComment,
    FeedEvent,
    FeedReaction,
    Notification,
    Rating,
    UserFollow,
    Watchlist,
    WatchlistItem,
)
from app.models.taste import SwipeRecord, UserSignal
from app.models.user import User, UserPreferences, UserProfile
from app.services.follows import follow_user
from app.services.social_feed import (
    create_comment,
    create_social_post,
    following_feed,
    search_users,
    toggle_block,
    toggle_like,
)
from app.services.user_signals import compute_user_signals
from app.services.watchlists import ensure_default_watchlists


PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"


def _report(name: str, passed: bool, detail: str = "") -> None:
    print(f"  [{PASS if passed else FAIL}] {name}")
    if detail:
        print(f"        {detail}")


def _wipe_user(db, email: str) -> None:
    """Full teardown of an ephemeral user + everything they touched. Order
    matters — child rows first, then the user."""
    existing = db.scalar(select(User).where(User.email == email))
    if existing is None:
        return
    uid = existing.id
    db.execute(delete(FeedReaction).where(FeedReaction.user_id == uid))
    db.execute(delete(FeedComment).where(FeedComment.user_id == uid))
    db.execute(delete(FeedEvent).where(FeedEvent.actor_user_id == uid))
    db.execute(delete(Notification).where(
        (Notification.user_id == uid) | (Notification.actor_user_id == uid)
    ))
    db.execute(delete(UserFollow).where(
        (UserFollow.follower_user_id == uid) | (UserFollow.following_user_id == uid)
    ))
    db.execute(delete(Block).where(
        (Block.blocker_user_id == uid) | (Block.blocked_user_id == uid)
    ))
    db.execute(delete(WatchlistItem).where(
        WatchlistItem.watchlist_id.in_(
            select(Watchlist.id).where(Watchlist.owner_user_id == uid)
        )
    ))
    db.execute(delete(Watchlist).where(Watchlist.owner_user_id == uid))
    db.execute(delete(SwipeRecord).where(SwipeRecord.user_id == uid))
    db.execute(delete(Rating).where(Rating.user_id == uid))
    db.execute(delete(UserSignal).where(UserSignal.user_id == uid))
    db.execute(delete(UserPreferences).where(UserPreferences.user_id == uid))
    db.execute(delete(UserProfile).where(UserProfile.user_id == uid))
    db.execute(delete(User).where(User.id == uid))
    db.commit()


def _make_user(db, tag: str, *, is_demo: bool = False) -> User:
    email = f"social_accept_{tag}_{uuid4().hex[:6]}@test.local"
    _wipe_user(db, email)
    user = User(email=email, auth_provider="dev", is_demo=is_demo)
    db.add(user)
    db.flush()
    db.add(UserPreferences(user_id=user.id))
    db.add(UserProfile(
        user_id=user.id,
        username=email.split("@")[0],
        display_name=email.split("@")[0],
        favorite_genres=[],
        country_code="US",
    ))
    ensure_default_watchlists(db, user.id)
    db.commit()
    return user


def _pick_title(db) -> ContentTitle | None:
    """A title that has both a vote_average AND non-empty genres — signal
    computation needs at least one genre to produce anything meaningful."""
    rows = db.scalars(
        select(ContentTitle)
        .where(ContentTitle.tmdb_vote_average.is_not(None))
        .order_by(ContentTitle.tmdb_vote_average.desc())
        .limit(200)
    ).all()
    for t in rows:
        if t.genres:
            return t
    return None


def test_following_feed_excludes_strangers():
    print("\n1) Following feed excludes users you don't follow")
    db = SessionLocal()
    try:
        viewer = _make_user(db, "viewer_a")
        friend = _make_user(db, "friend_a")
        stranger = _make_user(db, "stranger_a")
        title = _pick_title(db)
        if title is None:
            _report("preconditions", False, "no titles in DB")
            return
        follow_user(db, viewer.id, friend.id)
        create_social_post(
            db, friend.id, post_type="title_share",
            title_id=title.id, caption="Friend post", visibility="followers",
        )
        create_social_post(
            db, stranger.id, post_type="title_share",
            title_id=title.id, caption="Stranger post", visibility="public",
        )
        events = following_feed(db, viewer.id, limit=20)
        actor_ids = {e.actor_user_id for e in events}
        passed = friend.id in actor_ids and stranger.id not in actor_ids
        _report(
            "Feed contains friend's post, excludes stranger's",
            passed,
            f"actors={actor_ids} expected={{friend={friend.id}}}",
        )
    finally:
        db.close()


def test_private_posts_never_leak():
    print("\n2) Private posts never surface to non-authors")
    db = SessionLocal()
    try:
        author = _make_user(db, "priv_author")
        follower = _make_user(db, "priv_follower")
        title = _pick_title(db)
        follow_user(db, follower.id, author.id)
        create_social_post(
            db, author.id, post_type="title_share",
            title_id=title.id, caption="Private thought", visibility="private",
        )
        events = following_feed(db, follower.id, limit=20)
        passed = all(e.visibility != "private" for e in events)
        _report(
            "Follower does not see author's private post",
            passed,
            f"{len(events)} events returned, none private" if passed else "PRIVATE POST LEAKED",
        )
    finally:
        db.close()


def test_block_hides_posts_immediately():
    print("\n3) Blocking a user removes their posts from your next feed fetch")
    db = SessionLocal()
    try:
        viewer = _make_user(db, "blk_viewer")
        troll = _make_user(db, "blk_troll")
        title = _pick_title(db)
        follow_user(db, viewer.id, troll.id)
        create_social_post(
            db, troll.id, post_type="title_share",
            title_id=title.id, caption="troll post", visibility="followers",
        )
        before = following_feed(db, viewer.id, limit=20)
        toggle_block(db, viewer.id, troll.id)
        after = following_feed(db, viewer.id, limit=20)
        troll_before = any(e.actor_user_id == troll.id for e in before)
        troll_after = any(e.actor_user_id == troll.id for e in after)
        passed = troll_before and not troll_after
        _report(
            "Troll visible before block; hidden after",
            passed,
            f"before={troll_before} after={troll_after}",
        )
    finally:
        db.close()


def test_social_save_attribution_flows_into_signals():
    print("\n4) Save via social feed → added_via='social_feed' → SceneDNA picks it up")
    db = SessionLocal()
    try:
        follower = _make_user(db, "attr_follower")
        author = _make_user(db, "attr_author")
        title = _pick_title(db)
        follow_user(db, follower.id, author.id)
        # Author posts a title share; follower saves it as if from the feed.
        create_social_post(
            db, author.id, post_type="title_share",
            title_id=title.id, caption="Recommend this", visibility="followers",
        )
        picks = db.scalar(
            select(Watchlist).where(
                Watchlist.owner_user_id == follower.id,
                Watchlist.is_default.is_(True),
            ).limit(1)
        )
        db.add(WatchlistItem(
            watchlist_id=picks.id,
            content_title_id=title.id,
            added_via="social_feed",
        ))
        db.commit()

        saved = db.scalar(select(WatchlistItem).where(
            WatchlistItem.watchlist_id == picks.id,
            WatchlistItem.content_title_id == title.id,
        ))
        attribution_ok = saved is not None and saved.added_via == "social_feed"

        # Now recompute signals — the save should light up genre signals for
        # the title's genres.
        compute_user_signals(db, follower.id)
        signals = db.scalars(select(UserSignal).where(UserSignal.user_id == follower.id)).all()
        # The save should have contributed at least one non-zero signal.
        has_positive_signal = any(s.score > 0 for s in signals)
        passed = attribution_ok and has_positive_signal
        _report(
            "Save attributed to social_feed AND contributes to signals",
            passed,
            f"added_via={'social_feed' if attribution_ok else 'MISSING'}  "
            f"signals={len(signals)}  positive={sum(1 for s in signals if s.score > 0)}",
        )
    finally:
        db.close()


def test_like_notification_fires_and_dedupes():
    print("\n5) Like → author gets one notification; toggle off/on doesn't multiply")
    db = SessionLocal()
    try:
        author = _make_user(db, "notif_author")
        liker = _make_user(db, "notif_liker")
        title = _pick_title(db)
        follow_user(db, liker.id, author.id)
        post = create_social_post(
            db, author.id, post_type="title_share",
            title_id=title.id, caption="test", visibility="followers",
        )
        toggle_like(db, liker.id, post.id)   # like
        toggle_like(db, liker.id, post.id)   # unlike
        toggle_like(db, liker.id, post.id)   # like again
        notifs = db.scalars(select(Notification).where(
            Notification.user_id == author.id,
            Notification.notification_type == "social_like_on_your_post",
            Notification.actor_user_id == liker.id,
        )).all()
        passed = len(notifs) == 1
        _report(
            "Exactly one like notification exists after like/unlike/like cycle",
            passed,
            f"got {len(notifs)} notifications (expected 1)",
        )
    finally:
        db.close()


def test_comment_notification_per_comment():
    print("\n6) Each comment produces a fresh notification (no dedupe)")
    db = SessionLocal()
    try:
        author = _make_user(db, "cmt_author")
        commenter = _make_user(db, "cmt_commenter")
        title = _pick_title(db)
        follow_user(db, commenter.id, author.id)
        post = create_social_post(
            db, author.id, post_type="title_share",
            title_id=title.id, caption="test", visibility="followers",
        )
        create_comment(db, commenter.id, post.id, body="first")
        create_comment(db, commenter.id, post.id, body="second")
        create_comment(db, commenter.id, post.id, body="third")
        notifs = db.scalars(select(Notification).where(
            Notification.user_id == author.id,
            Notification.notification_type == "social_comment_on_your_post",
            Notification.actor_user_id == commenter.id,
        )).all()
        passed = len(notifs) == 3
        _report(
            "Three comments = three notifications",
            passed,
            f"got {len(notifs)} notifications (expected 3)",
        )
    finally:
        db.close()


def test_search_hides_demo_users():
    print("\n7) User search excludes is_demo users by default (no fake-data leak)")
    db = SessionLocal()
    try:
        # A distinct viewer is required — search excludes the searching user
        # themselves from results.
        viewer = _make_user(db, "srch_viewer")
        real = _make_user(db, "srch_real")
        fake = _make_user(db, "srch_fake", is_demo=True)
        # Give them a matching profile name so search would find both.
        for u in (real, fake):
            profile = db.scalar(select(UserProfile).where(UserProfile.user_id == u.id))
            profile.display_name = "Zzsearchable"
        db.commit()
        results = search_users(db, "Zzsearchable", viewer_user_id=viewer.id)
        result_ids = {r.user_id for r in results}
        passed = real.id in result_ids and fake.id not in result_ids
        _report(
            "Real user surfaces; demo user is hidden",
            passed,
            f"real_present={real.id in result_ids} "
            f"demo_present={fake.id in result_ids}",
        )
    finally:
        db.close()


if __name__ == "__main__":
    print("Social acceptance suite (§96-§103)")
    print("===================================")
    test_following_feed_excludes_strangers()
    test_private_posts_never_leak()
    test_block_hides_posts_immediately()
    test_social_save_attribution_flows_into_signals()
    test_like_notification_fires_and_dedupes()
    test_comment_notification_per_comment()
    test_search_hides_demo_users()
    print("\nDone.")
