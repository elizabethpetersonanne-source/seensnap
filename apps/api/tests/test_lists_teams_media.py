"""Regression coverage for shared-list navigation and private team evidence."""

from io import BytesIO
from uuid import UUID, uuid4
from types import SimpleNamespace
import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import select, func
from PIL import Image
from app.models.user import User, UserProfile, UserPreferences
from app.models.content import ContentTitle
from app.models.social import (
    Watchlist,
    WatchlistItem,
    ListShare,
    UserFollow,
    Team,
    TeamMember,
    TeamTitle,
    TeamRanking,
    TeamActivity,
    Rating,
    Block,
)
from app.models.messaging import Conversation, Message
from app.models.team_state import MediaAsset
from app.api.routes.list_shares import get_visible_list
from app.api.routes.team_home import (
    get_team_home,
    get_team_page,
    share_team_state,
    SharedStateRequest,
    set_team_title_like,
    TitleLike,
    move_team_rank,
    TeamRankMove,
    post_discussion,
    DiscussionComment,
)
from app.api.routes.profiles import list_profile_followers
from app.api.routes.media_assets import readable
from app.api.routes.me import upload_avatar
from app.services.media_assets import sanitized_image, store_image
from app.services.messaging import hydrate_message
from app.services.watchlists import delete_watchlist


@pytest.fixture
def people(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("Privacy and team models require PostgreSQL")
    users = [User(email=f"{uuid4()}@example.invalid", auth_provider="test") for _ in range(3)]
    db.add_all(users)
    db.flush()
    db.add_all(
        [
            UserProfile(user_id=u.id, username=u.id.hex, display_name=f"Person {i}")
            for i, u in enumerate(users)
        ]
    )
    db.add(UserFollow(follower_user_id=users[1].id, following_user_id=users[0].id))
    db.commit()
    return users


def unavailable(fn):
    with pytest.raises(HTTPException) as exc:
        fn()
    assert exc.value.status_code == 404


def titles(db, count):
    rows = [
        ContentTitle(tmdb_id=i + 1000, content_type="movie" if i % 2 else "tv", title=f"Title {i}")
        for i in range(count)
    ]
    db.add_all(rows)
    db.flush()
    return rows


def team_fixture(db, people, count=105):
    owner, member, stranger = people
    team = Team(
        owner_user_id=owner.id, name="Private team", slug=uuid4().hex, invite_code=uuid4().hex
    )
    db.add(team)
    db.flush()
    db.add_all(
        [
            TeamMember(
                team_id=team.id,
                user_id=u.id,
                role="owner" if u == owner else "member",
                status="active",
            )
            for u in [owner, member]
        ]
    )
    rows = titles(db, count)
    db.add_all(
        [TeamTitle(team_id=team.id, content_title_id=t.id, added_by_user_id=owner.id) for t in rows]
    )
    db.add_all(
        [
            TeamRanking(team_id=team.id, content_title_id=t.id, rank=i + 1, score=0)
            for i, t in enumerate(rows)
        ]
    )
    db.commit()
    return team, rows


def test_list_reader_all_titles_and_audience_without_token(db, people):
    owner, follower, stranger = people
    rows = titles(db, 105)
    wl = Watchlist(owner_user_id=owner.id, name="Mixed films and TV", visibility="public")
    db.add(wl)
    db.flush()
    db.add_all(
        [
            WatchlistItem(watchlist_id=wl.id, content_title_id=t.id, position=i, added_via="test")
            for i, t in enumerate(rows)
        ]
    )
    db.commit()
    collected = []
    for offset in [0, 40, 80]:
        page = get_visible_list(wl.id, db, follower, 40, offset)
        collected += page.items
        assert page.item_count == 105
    assert [t.title_id for t in collected] == [t.id for t in rows]
    assert [(t.tmdb_id, t.content_type) for t in collected] == [
        (t.tmdb_id, t.content_type) for t in rows
    ]
    assert page.next_offset is None
    assert db.scalar(select(func.count(ListShare.id))) == 0
    assert get_visible_list(wl.id, db, None).item_count == 105
    wl.visibility = "followers"
    db.commit()
    assert get_visible_list(wl.id, db, follower).item_count == 105
    for viewer in [None, stranger]:
        unavailable(lambda: get_visible_list(wl.id, db, viewer))
    wl.visibility = "private"
    db.commit()
    unavailable(lambda: get_visible_list(wl.id, db, follower))
    assert get_visible_list(wl.id, db, owner).item_count == 105
    delete_watchlist(db, wl)
    unavailable(lambda: get_visible_list(wl.id, db, owner))


def test_message_list_reads_never_publish_or_reveal_private_snapshot(db, people):
    owner, follower, _ = people
    wl = Watchlist(owner_user_id=owner.id, name="Private secrets", visibility="public")
    conv = Conversation(conversation_type="direct")
    db.add_all([wl, conv])
    db.flush()
    msg = Message(
        conversation_id=conv.id,
        sender_user_id=owner.id,
        message_type="content",
        content_type="list",
        content_id=wl.id,
        snapshot_json={"name": "Private secrets"},
    )
    db.add(msg)
    db.commit()
    assert hydrate_message(db, msg, follower.id)["list"]["id"] == str(wl.id)
    assert db.scalar(select(func.count(ListShare.id))) == 0
    wl.visibility = "private"
    db.commit()
    result = hydrate_message(db, msg, follower.id)
    assert result["list"] is None and result["snapshot"] is None
    assert hydrate_message(db, msg, owner.id)["list"]["name"] == "Private secrets"


def test_team_pagination_and_explicit_status_not_private_list_inference(db, people):
    owner, member, stranger = people
    team, rows = team_fixture(db, people)
    for user in [owner, member]:
        wl = Watchlist(owner_user_id=user.id, name="Private", visibility="private", is_default=True)
        db.add(wl)
        db.flush()
        db.add(WatchlistItem(watchlist_id=wl.id, content_title_id=rows[0].id, added_via="test"))
    db.commit()
    home = get_team_home(team.id, owner, db)
    assert not home.both_want_to_watch and not home.watched
    assert len(home.recently_added) == 40 and home.totals["recently_added"] == 105
    assert len(home.top_picks) == 10 and home.can_manage
    seen = []
    for offset in [0, 40, 80]:
        seen += get_team_page(team.id, "recently_added", owner, db, 40, offset).items
    assert len({t.id for t in seen}) == 105
    share_team_state(
        team.id,
        rows[0].id,
        SharedStateRequest(state="want_to_watch", expected_version=0),
        owner,
        db,
    )
    assert not get_team_home(team.id, member, db).both_want_to_watch
    share_team_state(
        team.id,
        rows[0].id,
        SharedStateRequest(state="want_to_watch", expected_version=0),
        member,
        db,
    )
    assert len(get_team_home(team.id, member, db).both_want_to_watch) == 1
    share_team_state(
        team.id, rows[0].id, SharedStateRequest(state="watched", expected_version=1), member, db
    )
    watched = get_team_home(team.id, owner, db).watched[0]
    assert watched.context_label == "Watched by 1 of 2" and watched.member_average is None
    assert all(m.rating is None for m in watched.members)
    with pytest.raises(HTTPException) as denied:
        get_team_home(team.id, stranger, db)
    assert denied.value.status_code in (403, 404)
    membership = db.scalar(
        select(TeamMember).where(TeamMember.team_id == team.id, TeamMember.user_id == member.id)
    )
    membership.status = "removed"
    db.commit()
    assert not get_team_home(team.id, owner, db).watched


def test_team_sharing_concurrency_ratings_and_idempotent_actions(db, people):
    owner, member, _ = people
    team, rows = team_fixture(db, people, 3)
    title = rows[0]
    db.add(Rating(user_id=member.id, content_title_id=title.id, score=9))
    db.commit()
    request = SharedStateRequest(state="watched", share_rating=True, expected_version=0)
    share_team_state(team.id, title.id, request, member, db)
    with pytest.raises(HTTPException) as exc:
        share_team_state(team.id, title.id, request, member, db)
    assert exc.value.status_code == 409
    db.rollback()
    watched = get_team_home(team.id, owner, db).watched[0]
    assert watched.member_average == 9 and watched.rating_count == 1
    for _ in range(2):
        set_team_title_like(team.id, title.id, TitleLike(liked=True), member, db)
    assert get_team_home(team.id, member, db).watched[0].like_count == 1
    set_team_title_like(team.id, title.id, TitleLike(liked=False), member, db)
    assert get_team_home(team.id, member, db).watched[0].like_count == 0
    comment = DiscussionComment(text="A private thought", request_id=uuid4())
    for _ in range(2):
        result = post_discussion(team.id, title.id, comment, member, db)
    assert sum(x["text"] == "A private thought" for x in result["items"]) == 1
    with pytest.raises(HTTPException):
        move_team_rank(team.id, title.id, TeamRankMove(position=3), member, db)
    db.rollback()
    move_team_rank(team.id, title.id, TeamRankMove(position=3), owner, db)
    assert get_team_home(team.id, member, db).top_picks[-1].id == str(title.id)


def image_bytes():
    image = Image.new("RGB", (1200, 800), "red")
    exif = Image.Exif()
    exif[270] = "Private camera information"
    out = BytesIO()
    image.save(out, format="JPEG", exif=exif)
    out.seek(0)
    return out


def test_images_decode_resize_and_strip_metadata():
    data = sanitized_image(image_bytes())
    image = Image.open(BytesIO(data))
    assert (
        image.format == "WEBP"
        and max(image.size) <= 768
        and not image.getexif()
        and len(data) < 512 * 1024
    )
    with pytest.raises(HTTPException):
        sanitized_image(BytesIO(b"\xff\xd8\xffnot an image"))
    with pytest.raises(HTTPException) as exc:
        sanitized_image(BytesIO(b"x" * (6 * 1024 * 1024 + 1)))
    assert exc.value.status_code == 413


def test_media_persistence_replacement_failure_and_access(db, people):
    owner, member, stranger = people
    team, _ = team_fixture(db, people, 1)
    avatar = upload_avatar(None, owner, db, UploadFile(filename="fake.txt", file=image_bytes()))
    aid = UUID(avatar.avatar_url.rsplit("/", 1)[-1])
    data = readable(db, aid, member.id).data
    db.expire_all()
    assert readable(db, aid, owner.id).data == data
    with pytest.raises(HTTPException):
        upload_avatar(None, owner, db, UploadFile(filename="evil.jpg", file=BytesIO(b"not image")))
    db.rollback()
    assert db.get(UserProfile, owner.id).avatar_url == avatar.avatar_url
    db.add(UserPreferences(user_id=owner.id, profile_visibility="followers"))
    db.commit()
    unavailable(lambda: readable(db, aid, stranger.id))
    assert readable(db, aid, member.id)
    path = store_image(db, owner.id, image_bytes(), "team", team.id)
    db.commit()
    tid = UUID(path.rsplit("/", 1)[-1])
    assert readable(db, tid, member.id)
    unavailable(lambda: readable(db, tid, stranger.id))
    membership = db.scalar(
        select(TeamMember).where(TeamMember.team_id == team.id, TeamMember.user_id == member.id)
    )
    membership.status = "removed"
    db.commit()
    unavailable(lambda: readable(db, tid, member.id))


def test_follower_lists_obey_subject_audience_and_blocks(db, people):
    owner, member, stranger = people
    assert list_profile_followers(owner.id, stranger, db, 40, 0).total == 1
    db.add(Block(blocker_user_id=member.id, blocked_user_id=stranger.id))
    db.commit()
    assert list_profile_followers(owner.id, stranger, db, 40, 0).total == 0
    db.add(UserPreferences(user_id=owner.id, profile_visibility="followers"))
    db.commit()
    unavailable(lambda: list_profile_followers(owner.id, stranger, db, 40, 0))
    assert list_profile_followers(owner.id, member, db, 40, 0).total == 1


def test_team_upload_authorization_and_real_response(db, people):
    from app.api.routes.teams import upload_team_image, delete_team_image

    owner, member, _ = people
    team, _ = team_fixture(db, people, 1)
    with pytest.raises(HTTPException):
        upload_team_image(team.id, member, db, UploadFile(file=image_bytes(), filename="photo.jpg"))
    result = upload_team_image(
        team.id, owner, db, UploadFile(file=image_bytes(), filename="photo.jpg")
    )
    aid = UUID(result.cover_image.rsplit("/", 1)[-1])
    assert readable(db, aid, member.id)
    assert delete_team_image(team.id, owner, db).cover_image is None
    unavailable(lambda: readable(db, aid, owner.id))


def test_private_ratings_do_not_become_named_public_or_team_evidence(db, people):
    from app.services.compatibility import _shared_titles, _most_divisive_title

    owner, member, _ = people
    team, rows = team_fixture(db, people, 1)
    db.add_all(
        [
            Rating(user_id=owner.id, content_title_id=rows[0].id, score=10),
            Rating(user_id=member.id, content_title_id=rows[0].id, score=8),
        ]
    )
    db.commit()
    assert _shared_titles(db, owner.id, member.id) == []
    assert _most_divisive_title(db, team.id, [owner.id, member.id]) == {}
    for user in [owner, member]:
        share_team_state(
            team.id,
            rows[0].id,
            SharedStateRequest(state="watched", share_rating=True, expected_version=0),
            user,
            db,
        )
    assert _most_divisive_title(db, team.id, [owner.id, member.id])["title_id"] == str(rows[0].id)


def test_username_write_uses_same_rules_as_availability(db, people):
    from app.api.routes.me import patch_me
    from app.schemas.user import ProfileUpdateRequest

    owner, member, _ = people
    with pytest.raises(HTTPException) as exc:
        patch_me(ProfileUpdateRequest(username="bad handle"), owner, db)
    assert exc.value.status_code == 400
    db.rollback()
    assert patch_me(ProfileUpdateRequest(username="My_Handle"), owner, db).username == "my_handle"
    with pytest.raises(HTTPException) as exc:
        patch_me(ProfileUpdateRequest(username="MY_HANDLE"), member, db)
    assert exc.value.status_code == 409


def test_http_list_route_and_owner_only_media_match_deployed_contract(db,people):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.dependencies import get_db,get_current_user,get_optional_current_user
    from app.api.routes.list_shares import router as lists_router
    from app.api.routes.media_assets import router as media_router
    owner,viewer,_=people
    wl=Watchlist(owner_user_id=owner.id,name='Visible list',visibility='public');db.add(wl);db.commit()
    path=store_image(db,owner.id,image_bytes(),'bug');db.commit()
    app=FastAPI();app.include_router(lists_router,prefix='/api/v1');app.include_router(media_router,prefix='/api/v1/media-assets')
    app.dependency_overrides[get_db]=lambda:db
    app.dependency_overrides[get_current_user]=lambda:viewer
    app.dependency_overrides[get_optional_current_user]=lambda:viewer
    client=TestClient(app)
    response=client.get(f'/api/v1/lists/{wl.id}?limit=40&offset=0')
    assert response.status_code==200 and response.json()['list_id']==str(wl.id)
    assert response.json()['items']==[] and response.json()['next_offset'] is None
    assert client.get(path+'/source').status_code==404
    app.dependency_overrides[get_current_user]=lambda:owner
    response=client.get(path+'/source')
    assert response.status_code==200 and response.json()['uri'].startswith('data:image/webp;base64,')
    assert response.headers['cache-control']=='private, no-store'
