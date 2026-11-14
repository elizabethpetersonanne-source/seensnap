from datetime import date, datetime, timedelta, timezone
import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from app.models.content import ContentTitle, ContentAvailability
from app.models.discovery import DiscoveryDecision
from app.models.social import Watchlist, WatchlistItem, ListShare, Rating, Team, TeamMember
from app.models.taste import CompatibilityScore, SwipeRecord, TeamAnalyticsSnapshot
from app.models.user import User, UserProfile
from app.services import taste, discovery_decisions
from app.services.title_state import save_title


def person(db):
    u = User(id=uuid4(), email=f'{uuid4()}@example.invalid', auth_provider='test')
    db.add(u); db.flush()
    db.add(UserProfile(user_id=u.id, username=u.id.hex, display_name='Tester', country_code='GB'))
    db.commit()
    return u


def title(db, number=1, genres=None):
    row = ContentTitle(id=uuid4(), tmdb_id=number, content_type='movie', title=f'Title {number}',
        genres=genres or ['Comedy'], release_date=date(2020, 1, 1), overview='Synopsis', poster_url='https://example.invalid/poster')
    db.add(row); db.commit(); return row


def test_negative_genres_never_become_positive_identity():
    assert taste._serialize_genres({'Horror': -10, 'Comedy': 0}) == []
    assert taste._derive_labels({'Horror': -10}, []) == []
    mixed = taste._serialize_genres({'Horror': -100, 'Comedy': 2, 'Drama': 1})
    assert mixed == [{'genre': 'Comedy', 'score': 100}, {'genre': 'Drama', 'score': 50}]
    assert all(0 <= label['confidence'] <= 100 for label in taste._derive_labels({'Drama': 1, 'Comedy': -5}, []))


def test_public_profile_lists_need_visibility_not_a_share_token(db):
    from app.api.routes.profiles import get_public_profile_lists
    owner, viewer = person(db), person(db)
    lists = [Watchlist(owner_user_id=owner.id, name=audience, visibility=audience) for audience in ['private', 'followers', 'public']]
    db.add_all(lists); db.commit()
    result = get_public_profile_lists(owner.id, viewer, db)
    assert [item.name for item in result] == ['public']
    assert result[0].share_token is None and result[0].item_count == 0
    assert db.scalar(select(func.count()).select_from(ListShare)) == 0


def test_every_custom_list_title_is_pageable_and_empty_lists_remain(db):
    from app.api.routes.picks import get_my_picks_collections, get_my_list_titles
    owner, stranger = person(db), person(db)
    collection = Watchlist(owner_user_id=owner.id, name='All 27')
    empty = Watchlist(owner_user_id=owner.id, name='Empty')
    db.add_all([collection, empty]); db.flush()
    rows = [ContentTitle(tmdb_id=i, content_type='movie', title=str(i)) for i in range(27)]
    db.add_all(rows); db.flush()
    db.add_all(WatchlistItem(watchlist_id=collection.id, content_title_id=t.id, added_via='test') for t in rows)
    db.commit()
    initial = get_my_picks_collections(owner, db)
    preview = next(x for x in initial.my_lists if x.id == str(collection.id))
    assert len(preview.titles) == 20 and preview.total_count == 27
    assert any(x.id == str(empty.id) and x.total_count == 0 for x in initial.my_lists)
    tail = get_my_list_titles(collection.id, owner, db, limit=100, offset=20)
    assert len(tail.items) == 7 and not tail.has_more
    assert len({t.id for t in preview.titles + tail.items}) == 27
    with pytest.raises(HTTPException): get_my_list_titles(collection.id, stranger, db, limit=100, offset=0)


def test_legacy_and_bad_undo_receipts_preserve_independent_saves(db):
    user, movie = person(db), title(db)
    save_title(db, user.id, movie.id)
    legacy = SwipeRecord(user_id=user.id, content_title_id=movie.id, direction='right', action_version=2)
    db.add(legacy); db.commit()
    result = discovery_decisions.undo_decision(db, user.id, legacy.id, refresh_derived=False)
    assert result['saved'] is True and result['partial_reason'] == 'unknown_save_receipt'
    assert db.get(SwipeRecord, legacy.id) is None
    assert discovery_decisions.undo_decision(db, user.id, legacy.id, refresh_derived=False)['saved'] is True
    fresh = taste.record_swipe(db, user.id, title_id=movie.id, direction='right', refresh_derived=False)
    decision = db.get(DiscoveryDecision, fresh.id)
    decision.state_before = {'added_queue_item': {'id': 'not-a-uuid', 'added_via': 'swipe'}}
    db.commit()
    assert discovery_decisions.undo_decision(db, user.id, fresh.id, refresh_derived=False)['saved'] is True


def test_both_sides_taste_versions_invalidate_pair_cache(db, monkeypatch):
    from app.services import compatibility
    from app.services.taste_invalidation import invalidate_taste
    from types import SimpleNamespace
    users = [person(db) for _ in range(3)]
    calls = []
    def profile(db, uid, **kwargs):
        calls.append(uid)
        return SimpleNamespace(top_genres=[{'genre': 'Comedy', 'score': 100}], taste_labels=[], top_platforms=[])
    monkeypatch.setattr(compatibility, 'get_taste_profile', profile)
    records = compatibility.get_compatibilities(db, users[0].id, [u.id for u in users[1:]])
    assert len(records) == 2 and len(calls) == 3
    calls.clear()
    compatibility.get_compatibilities(db, users[0].id, [u.id for u in users[1:]])
    assert not calls
    invalidate_taste(db, users[1].id); db.commit()
    compatibility.get_compatibilities(db, users[0].id, [u.id for u in users[1:]])
    assert set(calls) == {users[0].id, users[1].id}
    assert compatibility.to_compatibility_response(records[users[1].id], users[0].id, users[1].id).compatibility is None


def test_premium_still_has_operational_concurrency_protection(db):
    from app.services.concierge_requests import claim
    from app.services.entitlements import grant_beta_premium
    from app.api.routes.concierge import ConciergeDecisionRequest
    user = person(db); grant_beta_premium(db, user.id); db.commit()
    request = ConciergeDecisionRequest(intent='A comedy', idempotency_key='same-search-key')
    receipt, run, allowed = claim(db, user.id, request)
    assert run and allowed.remaining is None
    assert claim(db, user.id, request)[1] is False  # replay bypasses operational cap
    with pytest.raises(HTTPException) as error:
        claim(db, user.id, request.model_copy(update={'idempotency_key':'another-search-key'}))
    assert error.value.status_code == 429 and error.value.detail['code'] == 'search_busy'
    db.rollback()
    receipt.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1); db.commit()
    assert claim(db, user.id, request)[1] is True


def test_streaming_region_uses_profile_unless_explicit(db, monkeypatch):
    from app.api.routes.watch_options import get_watch_options
    from app.api.routes import watch_options
    user, movie = person(db), title(db)
    calls = []
    monkeypatch.setattr(watch_options, 'refresh_streaming_options', lambda db, title, *, region: calls.append(region) or [])
    get_watch_options(str(movie.id), db, user, region=None)
    get_watch_options(str(movie.id), db, user, region='ca')
    assert calls == ['GB', 'CA']


def test_web_only_share_pages_have_no_dummy_store_or_signing_identifiers(monkeypatch):
    from app.api.routes import share_pages
    for name in ['ios_team_id', 'apple_bundle_id', 'android_sha256_fingerprint', 'ios_app_store_url', 'android_play_store_url']:
        monkeypatch.setattr(share_pages.settings, name, '')
    html = share_pages._og_page(title='Title', description='Description', image_url=None, canonical_url='https://example.invalid', deep_link='https://example.invalid/title', body_html='')
    assert 'id0' not in html and 'apps.apple.com' not in html and 'play.google.com' not in html
    assert b'TEAMID' not in share_pages.apple_app_site_association().body
    assert share_pages.android_asset_links().body == b'[]'


def test_queue_migration_preserves_original_audiences_links_and_custom_names(db):
    if db.bind.dialect.name != 'postgresql': pytest.skip('Migration reflects PostgreSQL UUID/JSONB columns')
    spec = importlib.util.spec_from_file_location('queue_migration', Path(__file__).parents[1] / 'alembic/versions/20261113_0043_public_readiness.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    user = person(db)
    rows = [title(db, i) for i in range(3)]
    public = Watchlist(owner_user_id=user.id, name='Next Watch', system_role='next_watch', is_system_list=True, visibility='public')
    legacy = Watchlist(owner_user_id=user.id, name='My Picks', is_default=True, visibility='private')
    custom = Watchlist(owner_user_id=user.id, name='Want to Watch', visibility='private')
    db.add_all([public, legacy, custom]); db.flush()
    for wl, movie in zip([public, legacy, custom], rows): db.add(WatchlistItem(watchlist_id=wl.id, content_title_id=movie.id, added_via='test', notes='keep'))
    share = ListShare(watchlist_id=public.id, created_by_user_id=user.id, token='keep-public-token', visibility='public')
    db.add(share); db.commit()
    module.reconcile_queues(db.connection()); db.commit(); db.expire_all()
    canonical = db.scalar(select(Watchlist).where(Watchlist.system_role == 'next_watch'))
    assert canonical.id == legacy.id and canonical.visibility == 'private'
    assert set(db.scalars(select(WatchlistItem.content_title_id).where(WatchlistItem.watchlist_id == canonical.id))) == {rows[0].id, rows[1].id}
    assert public.visibility == 'public' and public.merged_into_id == canonical.id
    assert custom.merged_into_id is None
    assert db.get(ListShare, share.id).token == 'keep-public-token'
    assert db.scalar(select(func.count()).select_from(WatchlistItem).where(WatchlistItem.watchlist_id == public.id)) == 1
    module.reconcile_queues(db.connection()); db.commit()
    assert db.scalar(select(func.count()).select_from(WatchlistItem).where(WatchlistItem.watchlist_id == canonical.id)) == 2


def test_account_deletion_with_owned_team_analytics(db):
    if db.bind.dialect.name != 'postgresql': pytest.skip('Complete foreign-key graph requires PostgreSQL')
    from app.api.routes.auth import delete_account
    user, member = person(db), person(db)
    team = Team(owner_user_id=user.id, name='Team', slug='team', invite_code='team')
    db.add(team); db.flush()
    db.add_all([TeamAnalyticsSnapshot(team_id=team.id, member_ids=[str(user.id), str(member.id)]), TeamMember(team_id=team.id, user_id=member.id)])
    db.commit(); uid, tid = user.id, team.id
    delete_account(user, db); db.expire_all()
    assert db.get(User, uid) is None and db.get(Team, tid) is None
    assert db.get(TeamAnalyticsSnapshot, tid) is None and db.get(User, member.id) is not None
