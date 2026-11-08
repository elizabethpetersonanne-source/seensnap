from datetime import date, datetime, timedelta, timezone
from uuid import uuid4, UUID
import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select, func
from app.models.content import ContentTitle
from app.models.user import User, UserProfile
from app.models.social import Watchlist, WatchlistItem, Rating, RankedFavorite, TitleWatchStatus
from app.models.discovery import DiscoveryDecision, DiscoverySession
from app.services import discovery_feed as feed, taste
from app.services.discovery_decisions import excluded_title_ids, undo_decision


@pytest.fixture
def user(db, monkeypatch):
    if db.bind.dialect.name != "postgresql": pytest.skip("Requires complete PostgreSQL model set")
    person = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    db.add(person); db.flush()
    db.add(UserProfile(user_id=person.id, username=person.id.hex, display_name="Viewer", country_code="US")); db.commit()
    monkeypatch.setattr(taste, "refresh_taste_profile", lambda *a, **k: None)
    monkeypatch.setattr("app.services.user_signals.compute_user_signals", lambda *a, **k: None)
    monkeypatch.setattr(feed, "_build_signal_index", lambda *a: {})
    return person


def title(db, n=1):
    row=ContentTitle(tmdb_id=n, content_type="movie", title=f"Title {n}")
    db.add(row); db.flush(); return row


def decide(db, user, row, direction="left", key=None, source="swipe"):
    return taste.record_swipe(db, user.id, title_id=row.id, direction=direction, source_surface=source, idempotency_key=key)


def test_cooldown_exactly_100_actions_retries_onboarding_and_undo(db, user):
    passed, interest = title(db), title(db,2)
    first=decide(db,user,passed,key="first")
    decide(db,user,passed,key="first")
    decide(db,user,interest,"right",source="onboarding")
    for i in range(99):
        db.add(DiscoveryDecision(id=uuid4(), user_id=user.id, content_title_id=interest.id, sequence=i+2, direction="right"))
    db.commit()
    assert passed.id in excluded_title_ids(db,user.id)
    last=decide(db,user,interest,"right",key="hundredth")
    assert passed.id not in excluded_title_ids(db,user.id)
    undo_decision(db,user.id,last.id)
    assert passed.id in excluded_title_ids(db,user.id)
    assert db.scalar(select(func.count(DiscoveryDecision.id)).where(DiscoveryDecision.id==first.id)) == 1


def test_watched_swipe_atomic_and_undo_preserves_custom_list(db,user):
    row=title(db)
    queue=Watchlist(owner_user_id=user.id,name="Queue",system_role="next_watch")
    custom=Watchlist(owner_user_id=user.id,name="Custom")
    db.add_all([queue,custom]); db.flush()
    db.add_all([WatchlistItem(watchlist_id=w.id,content_title_id=row.id,added_via="test") for w in [queue,custom]]); db.commit()
    action=decide(db,user,row,"up",key="up")
    assert db.scalar(select(Rating.id)) is None
    assert set(db.scalars(select(WatchlistItem.watchlist_id))) == {custom.id}
    result=undo_decision(db,user.id,action.id)
    assert result["watched"] is False
    assert set(db.scalars(select(WatchlistItem.watchlist_id))) == {queue.id,custom.id}
    right=decide(db,user,row,"right",key="right")
    undo_decision(db,user.id,right.id)
    assert set(db.scalars(select(WatchlistItem.watchlist_id))) == {queue.id,custom.id}


def test_undo_keeps_newer_rating_and_down_conflict(db,user):
    row=title(db); action=decide(db,user,row,"up",key="up")
    from app.services.title_state import rate_title
    rate_title(db,user.id,row.id,9)
    result=undo_decision(db,user.id,action.id)
    assert result["watched"] and result["partial_reason"]
    assert db.scalar(select(Rating.score)) == 9
    with pytest.raises(taste.RatingConflictError): decide(db,user,row,"down",key="down")
    assert db.scalar(select(func.count(DiscoveryDecision.id))) == 1


def test_failed_watched_write_rolls_back_entire_decision(db,user,monkeypatch):
    row=title(db); db.commit()
    def failure(*a,**k): raise RuntimeError("write failed")
    monkeypatch.setattr("app.services.title_state.mark_watched",failure)
    with pytest.raises(RuntimeError): decide(db,user,row,"down",key="failed")
    db.rollback()
    from app.models.taste import SwipeRecord
    assert db.scalar(select(func.count(SwipeRecord.id))) == 0
    assert db.scalar(select(func.count(DiscoveryDecision.id))) == 0


def test_all_saved_ranked_rated_and_watched_are_excluded(db,user):
    titles=[title(db,n) for n in range(1,6)]
    wl=Watchlist(owner_user_id=user.id,name="Private collection",visibility="private");db.add(wl);db.flush()
    db.add(WatchlistItem(watchlist_id=wl.id,content_title_id=titles[0].id,added_via="test"))
    db.add(RankedFavorite(user_id=user.id,content_title_id=titles[1].id,position=1))
    db.add(Rating(user_id=user.id,content_title_id=titles[2].id,score=2,watched_state="watched"))
    db.add(TitleWatchStatus(user_id=user.id,content_title_id=titles[3].id,watched_state="watched"))
    db.commit()
    assert excluded_title_ids(db,user.id) == {t.id for t in titles[:4]}


def catalog(kind, band, page, genre, region, mode, as_of):
    rows=[]
    for i in range(20):
        number=band*10000+page*100+i+1
        rows.append({"id":number,"media_type":kind,"title":f"{kind} {number}","name":f"{kind} {number}",
            "overview":"A complete synopsis", "poster_path":"/poster.jpg",
            "release_date":feed.anniversary(as_of,-(2,14,25,50)[band]).isoformat(),
            "genres":[{"id":35,"name":"Comedy"}]})
    return {"rows":rows,"done":page>=3,"cap":False}


def test_cursor_continues_beyond_25_with_age_mix_and_no_duplicates(db,user,monkeypatch):
    monkeypatch.setattr(feed,"catalog_page",catalog)
    page=feed.get_feed(db,user.id,genre="comedy",preferred_type="show",limit=20)
    ids=[]
    for n in range(5):
        assert all(x["title"]["content_type"]=="series" for x in page["items"])
        ids.extend(x["title"]["id"] for x in page["items"])
        if n<4: page=feed.get_feed(db,user.id,genre="comedy",preferred_type="show",limit=20,cursor=page["next_cursor"])
    assert len(ids)==len(set(ids))==100
    assert page["release_age_counts"] == [50,30,15,5]


def test_cursor_replay_owner_filter_and_new_watched_gate(db,user,monkeypatch):
    monkeypatch.setattr(feed,"catalog_page",catalog)
    first=feed.get_feed(db,user.id,genre="comedy",limit=10)
    second=feed.get_feed(db,user.id,genre="comedy",limit=10,cursor=first["next_cursor"])
    again=feed.get_feed(db,user.id,genre="comedy",limit=10,cursor=first["next_cursor"])
    assert second==again
    tid=UUID(second["items"][0]["title"]["id"])
    db.add(TitleWatchStatus(user_id=user.id,content_title_id=tid,watched_state="watched"));db.commit()
    replay=feed.get_feed(db,user.id,genre="comedy",cursor=first["next_cursor"])
    assert str(tid) not in [i["title"]["id"] for i in replay["items"]]
    for viewer,genre in [(uuid4(),"comedy"),(user.id,"crime")]:
        with pytest.raises(HTTPException) as error: feed.get_feed(db,viewer,genre=genre,cursor=second["next_cursor"])
        assert error.value.status_code==409
        db.rollback()
    db.get(UserProfile,user.id).country_code="GB";db.commit()
    with pytest.raises(HTTPException) as error: feed.get_feed(db,user.id,genre="comedy",cursor=second["next_cursor"])
    assert error.value.status_code==409


def test_preview_filters_official_videos_without_losing_continuation(db,user,monkeypatch):
    monkeypatch.setattr(feed,"catalog_page",catalog)
    monkeypatch.setattr(feed,"_video",lambda row: None if row.tmdb_id%2 else {"provider":"YouTube","external_key":str(row.tmdb_id),"type":"Trailer","name":"Trailer","official":True})
    first=feed.get_feed(db,user.id,preferred_type="show",surface="preview",limit=15)
    second=feed.get_feed(db,user.id,preferred_type="show",surface="preview",limit=15,cursor=first["next_cursor"])
    ids=[i["title_id"] for i in first["items"]+second["items"]]
    assert len(ids)==len(set(ids))==30
    assert all(i["tmdb_id"]%2==0 for i in first["items"]+second["items"])


def test_upstream_failure_is_retryable_not_catalog_exhaustion(db,user,monkeypatch):
    def failure(*a): raise httpx.ConnectError("offline")
    monkeypatch.setattr(feed,"catalog_page",failure)
    with pytest.raises(HTTPException) as error: feed.get_feed(db,user.id)
    assert error.value.status_code==503
    assert db.scalar(select(func.count(DiscoverySession.id)))==0


def test_calendar_age_boundaries_and_exact_allocation():
    birthday=date(2000,2,29)
    assert feed.age_band(birthday,date(2010,2,27))==0
    assert feed.age_band(birthday,date(2010,2,28))==1
    assert feed.age_band(date(2006,11,8),date(2026,11,8))==2
    counts=[0,0,0,0]
    for _ in range(100): counts[feed.next_band(counts,[0,1,2,3])]+=1
    assert counts==[50,30,15,5]
    counts=[0,0,0,0]
    for _ in range(100): counts[feed.next_band(counts,[0,1])]+=1
    assert counts==[63,37,0,0]


@pytest.mark.parametrize("kind,genre,genre_id",[("tv","comedy",35),("tv","documentary",99),("movie","comedy",35)])
def test_tmdb_discover_uses_correct_type_genre_and_region(monkeypatch,kind,genre,genre_id):
    seen={}
    monkeypatch.setattr(feed,"_fetch_genre_map",lambda k:{35:"Comedy",99:"Documentary"})
    monkeypatch.setattr(feed,"_tmdb_headers",lambda:{})
    class Client:
        def __init__(self,**kwargs): pass
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def get(self,path,params):
            seen.update(path=path,params=params)
            return httpx.Response(200,json={"results":[],"total_pages":1},request=httpx.Request("GET","https://test.invalid"))
    monkeypatch.setattr(feed.httpx,"Client",Client)
    feed.catalog_page(kind,0,1,genre,"GB","streaming",date(2026,11,8))
    assert seen["path"]==f"/discover/{kind}"
    assert seen["params"]["with_genres"]==str(genre_id)
    assert seen["params"]["watch_region"]=="GB"
    assert seen["params"]["with_watch_monetization_types"]=="flatrate|free|ads"


def test_video_policy_and_quality_gates(monkeypatch):
    from contextlib import nullcontext
    monkeypatch.setattr(feed.httpx, "Client", lambda **kwargs: nullcontext(None))
    monkeypatch.setattr(feed, "_tmdb_headers", lambda: {})
    monkeypatch.setattr(feed, "fetch_title_videos", lambda *a, **k: [
        {"site": "Vimeo", "official": True, "key": "other", "type": "Teaser"},
        {"site": "YouTube", "official": False, "key": "fan", "type": "Teaser"},
        {"site": "YouTube", "official": True, "key": "trailer", "type": "Trailer"},
        {"site": "YouTube", "official": True, "key": "teaser", "type": "Teaser"},
    ])
    row = ContentTitle(id=uuid4(), tmdb_id=1, content_type="series", title="Comedy", genres=["Comedy"],
        release_date=date(2020,1,1), poster_url="https://test.invalid/poster", overview="Synopsis")
    assert feed._video(row)["external_key"] == "teaser"
    now=datetime.now(timezone.utc)
    row.metadata_raw={"_discovery_availability":{"US:streaming":now.isoformat()}}
    args=(set(),"show","comedy","US","streaming",now.date(),now)
    assert feed.eligible(row,*args)
    assert not feed.eligible(row,{row.id},*args[1:])
    row.genres=["Crime"]; assert not feed.eligible(row,*args)
    row.genres=["Comedy"]; row.poster_url=None; assert not feed.eligible(row,*args)
    row.poster_url="https://test.invalid/poster"; row.release_date=now.date()+timedelta(days=1)
    assert not feed.eligible(row,*args)
    row.release_date=date(2020,1,1); row.metadata_raw={}
    assert not feed.eligible(row,*args)


def test_tv_action_uses_tv_taxonomy():
    assert feed.canonical_genre("tv", "action") == "action & adventure"
    assert feed.canonical_genre("movie", "action") == "action"
    assert feed.canonical_genre("tv", "documentary") == "documentary"


def test_collection_previews_preserve_order_and_report_upstream_errors(db, user, monkeypatch):
    from app.api.routes.previews import get_previews_for_titles
    rows=[title(db,n) for n in range(1,5)]
    db.commit()
    monkeypatch.setattr(feed,"_video",lambda row: None if row.tmdb_id==2 else {
        "provider":"YouTube","external_key":str(row.tmdb_id),"type":"Trailer","name":"Trailer","official":True})
    response=get_previews_for_titles(user,db,ids=",".join(str(row.id) for row in reversed(rows)))
    assert [row.tmdb_id for row in response.items]==[4,3,1]
    assert response.skipped_title_ids==[rows[1].id]
    def unavailable(*a): raise httpx.ConnectError("offline")
    monkeypatch.setattr(feed,"_video",unavailable)
    with pytest.raises(HTTPException) as error:
        get_previews_for_titles(user,db,ids=str(rows[0].id))
    assert error.value.status_code==503
