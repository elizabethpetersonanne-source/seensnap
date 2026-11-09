"""Authorization tests against real PostgreSQL queries, including old share URLs."""
from types import SimpleNamespace
from uuid import uuid4
import pytest
from fastapi import HTTPException
from sqlalchemy import select, func
from app.models.user import User, UserProfile, UserPreferences
from app.models.content import ContentTitle
from app.models.social import Watchlist, WatchlistItem, ListShare, UserFollow, Block, FeedEvent, Team, RankedFavorite
from app.api.routes.list_shares import create_or_reuse_list_share, get_public_shared_list
from app.api.routes.profiles import get_public_ranked_favorites
from app.services.watchlists import update_watchlist
from app.services.social_feed import require_social_post, hydrate_feed_event, create_social_post, toggle_like, create_comment
from app.services.notification_destination import resolve_destination


@pytest.fixture
def people(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Exercises all privacy tables on PostgreSQL")
    users = [User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test") for _ in range(3)]
    db.add_all(users); db.flush()
    db.add_all([UserProfile(user_id=u.id, username=str(i)+u.id.hex[:12], display_name=f"Person {i}") for i,u in enumerate(users)])
    db.add(UserFollow(follower_user_id=users[1].id, following_user_id=users[0].id))
    db.commit()
    return users


def make_list(db, owner, visibility="public"):
    title = ContentTitle(id=uuid4(), tmdb_id=1, content_type="movie", title="Private choice")
    wl = Watchlist(id=uuid4(), owner_user_id=owner.id, name="A list", visibility=visibility)
    db.add_all([title, wl]); db.flush()
    db.add(WatchlistItem(watchlist_id=wl.id, content_title_id=title.id, added_via="test"))
    db.commit()
    return wl


def denied(call):
    with pytest.raises(HTTPException) as error: call()
    assert error.value.status_code == 404


def test_current_list_audience_controls_old_token(db, people):
    owner, follower, stranger = people
    wl = make_list(db, owner)
    token = create_or_reuse_list_share(wl.id, owner, db).token
    assert get_public_shared_list(token, db, None).item_count == 1
    # Even legacy writes that failed to revoke a token cannot bypass current visibility.
    wl.visibility = "followers"; db.commit()
    for viewer in [owner, follower]: assert get_public_shared_list(token, db, viewer).item_count == 1
    for viewer in [None, stranger]: denied(lambda: get_public_shared_list(token, db, viewer))
    wl.visibility = "private"; db.commit()
    denied(lambda: get_public_shared_list(token, db, follower))
    assert get_public_shared_list(token, db, owner).item_count == 1
    db.add(Block(blocker_user_id=owner.id, blocked_user_id=follower.id)); wl.visibility="public"; db.commit()
    denied(lambda: get_public_shared_list(token, db, follower))


def test_visibility_change_revokes_old_links_permanently(db, people):
    owner, _, _ = people; wl = make_list(db, owner)
    token = create_or_reuse_list_share(wl.id, owner, db).token
    for audience in ["private", "public"]:
        update_watchlist(db, wl, name=None, description=None, visibility=audience)
    denied(lambda: get_public_shared_list(token, db, None))
    assert create_or_reuse_list_share(wl.id, owner, db).token != token


def test_social_read_cannot_publish_list_or_create_share(db, people):
    owner, follower, stranger = people; wl = make_list(db, owner)
    event = FeedEvent(actor_user_id=owner.id, event_type="list_share", source_type="social_post", list_id=wl.id, visibility="followers")
    db.add(event); db.commit()
    result = hydrate_feed_event(db, require_social_post(db, follower.id, event.id), follower.id)
    assert result["list"]["item_count"] == 1
    assert db.scalar(select(func.count(ListShare.id))) == 0
    denied(lambda: require_social_post(db, stranger.id, event.id))
    wl.visibility="private"; db.commit()
    denied(lambda: require_social_post(db, follower.id, event.id))
    denied(lambda: toggle_like(db, follower.id, event.id))
    denied(lambda: create_comment(db, follower.id, event.id, body="Not authorized"))
    with pytest.raises(ValueError): create_social_post(db, owner.id, post_type="list_share", list_id=wl.id, visibility="public")


def test_own_team_event_never_becomes_social(db, people):
    owner, _, _ = people
    team = Team(owner_user_id=owner.id, name="Private", slug="private", invite_code="private")
    db.add(team); db.flush()
    event = FeedEvent(actor_user_id=owner.id, team_id=team.id, event_type="title_added", source_type="team", visibility="public")
    db.add(event); db.commit()
    denied(lambda: require_social_post(db, owner.id, event.id))


def test_notifications_resolve_current_entities_not_stale_routes(db, people):
    owner, follower, stranger = people
    event = FeedEvent(actor_user_id=owner.id, event_type="wall_post", source_type="social_post", visibility="followers")
    db.add(event); db.commit()
    note = SimpleNamespace(entity_type="social_post", entity_id=event.id, route="https://untrusted.invalid")
    assert resolve_destination(db, note, follower.id)["route"] == f"/post/{event.id}"
    assert not resolve_destination(db, note, stranger.id)["available"]
    db.delete(event); db.commit()
    assert not resolve_destination(db, note, follower.id)["available"]
    for kind, entity in [("conversation", None), ("conversation", uuid4()), ("unknown", uuid4())]:
        assert not resolve_destination(db, SimpleNamespace(entity_type=kind, entity_id=entity), owner.id)["available"]


def test_public_ranking_pagination_and_profile_visibility(db, people):
    owner, follower, stranger = people
    titles = [ContentTitle(tmdb_id=i, content_type="movie", title=f"Rank {i}") for i in range(105)]
    db.add_all(titles); db.flush()
    db.add_all([RankedFavorite(user_id=owner.id, content_title_id=t.id, position=i+1) for i,t in enumerate(titles)])
    db.add(UserPreferences(user_id=owner.id, profile_visibility="followers")); db.commit()
    result = get_public_ranked_favorites(owner.id, follower, db, limit=100, offset=100)
    assert result.total == 105 and [r.position for r in result.items] == [101,102,103,104,105]
    denied(lambda: get_public_ranked_favorites(owner.id, stranger, db, limit=100, offset=0))


def test_private_saves_do_not_become_named_social_recommendations(db, people):
    from app.services.taste import _source_social_saves
    from app.api.routes.profiles import get_public_profile_lists
    owner, follower, _ = people
    wl = make_list(db, owner, "private")
    assert _source_social_saves(db, follower.id, set(), 20) == []
    wl.visibility = "followers"; db.commit()
    assert len(_source_social_saves(db, follower.id, set(), 20)) == 1
    create_or_reuse_list_share(wl.id, owner, db)
    assert get_public_profile_lists(owner.id, follower, db) == []
    wl.visibility = "public"; db.commit()
    assert len(get_public_profile_lists(owner.id, follower, db)) == 1
    db.add(Block(blocker_user_id=follower.id, blocked_user_id=owner.id)); db.commit()
    assert _source_social_saves(db, follower.id, set(), 20) == []


def test_team_notifications_follow_active_membership_and_activity(db, people):
    from app.models.social import TeamMember, TeamActivity
    from datetime import datetime, timezone
    owner, member, stranger = people
    team=Team(owner_user_id=owner.id,name="Private",slug="private",invite_code="private")
    db.add(team);db.flush()
    db.add(TeamMember(team_id=team.id,user_id=member.id,status="active",role="member"))
    activity=TeamActivity(team_id=team.id,actor_user_id=owner.id,activity_type="title_added")
    db.add(activity);db.commit()
    note=SimpleNamespace(entity_type="team_activity",entity_id=activity.id)
    assert resolve_destination(db,note,member.id)["route"]==f"/teams/{team.id}/home"
    assert not resolve_destination(db,note,stranger.id)["available"]
    team.archived_at=datetime.now(timezone.utc);db.commit()
    assert not resolve_destination(db,note,member.id)["available"]
