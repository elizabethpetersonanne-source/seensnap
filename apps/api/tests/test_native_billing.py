from datetime import datetime, timedelta, timezone
from uuid import uuid4
import pytest
from fastapi import HTTPException
from sqlalchemy import select, func
from app.core.config import settings
from app.models.user import User, AuthIdentity
from app.models.entitlements import EntitlementGrant
from app.services import billing, entitlements, auth, apple_revocation

NOW = datetime.now(timezone.utc)
PRODUCT = 'com.seensnap.premium.monthly'

@pytest.fixture
def buyer(db, monkeypatch):
    user = User(id=uuid4(), email=f'{uuid4()}@example.invalid', auth_provider='apple')
    db.add(user); db.commit()
    for key, value in {'billing_enabled': True, 'revenuecat_secret_api_key': 'server-test-key',
                       'revenuecat_webhook_token': 'test-webhook-token', 'revenuecat_app_id': 'app-test',
                       'premium_product_ids': PRODUCT, 'billing_test_user_ids': ''}.items():
        monkeypatch.setattr(settings, key, value)
    return user

def snapshot(user, **changes):
    sub = {'store': 'app_store', 'is_sandbox': False, 'purchase_date': (NOW-timedelta(days=1)).isoformat(),
           'expires_date': (NOW+timedelta(days=29)).isoformat(), 'store_transaction_id': 'apple-123'}
    sub.update(changes)
    return {'original_app_user_id': str(user.id), 'subscriptions': {PRODUCT: sub}}

def set_snapshot(monkeypatch, value):
    monkeypatch.setattr(billing, 'fetch_subscriber', lambda uid: value)

def access(db, user, now=NOW):
    return entitlements.resolve_entitlement(db, user.id, now=now)

def test_purchase_replay_cancellation_and_expiry(db, buyer, monkeypatch):
    set_snapshot(monkeypatch, snapshot(buyer, unsubscribe_detected_at=NOW.isoformat()))
    for _ in range(3): billing.sync_purchases(db, buyer.id, now=NOW)
    assert db.scalar(select(func.count()).select_from(EntitlementGrant)) == 1
    assert access(db, buyer).tier == 'premium'
    assert access(db, buyer, NOW+timedelta(days=30)).tier == 'free'

def test_grace_refund_and_late_webhook_use_current_snapshot(db, buyer, monkeypatch):
    set_snapshot(monkeypatch, snapshot(buyer, expires_date=(NOW-timedelta(hours=1)).isoformat(),
        grace_period_expires_date=(NOW+timedelta(days=2)).isoformat()))
    billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).tier == 'premium'
    set_snapshot(monkeypatch, snapshot(buyer, refunded_at=NOW.isoformat()))
    billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).tier == 'free'
    from app.api.routes.billing import webhook, ProviderEnvelope
    webhook(ProviderEnvelope(event={'id': 'old-event', 'type': 'RENEWAL', 'app_id': 'app-test',
                                    'app_user_id': str(buyer.id)}), db, 'Bearer test-webhook-token')
    assert access(db, buyer).tier == 'free'

def test_sandbox_only_unlocks_explicit_tester_and_preserves_beta(db, buyer, monkeypatch):
    beta = entitlements.grant_beta_premium(db, buyer.id); beta.starts_at = NOW-timedelta(days=1); db.commit()
    set_snapshot(monkeypatch, snapshot(buyer, is_sandbox=True))
    billing.sync_purchases(db, buyer.id, now=NOW)
    assert 'purchase' not in access(db, buyer).sources
    monkeypatch.setattr(settings, 'billing_test_user_ids', str(buyer.id))
    assert access(db, buyer).tier == 'free'
    billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).sources == ['purchase']
    monkeypatch.setattr(settings, 'billing_test_user_ids', '')
    assert access(db, buyer).sources == ['beta']
    assert beta.revoked_at is None

def test_sandbox_cannot_replace_production_access(db, buyer, monkeypatch):
    set_snapshot(monkeypatch, snapshot(buyer))
    billing.sync_purchases(db, buyer.id, now=NOW)
    expires = access(db, buyer).expires_at
    set_snapshot(monkeypatch, snapshot(buyer, is_sandbox=True, expires_date=(NOW+timedelta(days=365)).isoformat()))
    billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).expires_at == expires

def test_malformed_snapshot_or_outage_preserves_access(db, buyer, monkeypatch):
    set_snapshot(monkeypatch, snapshot(buyer)); billing.sync_purchases(db, buyer.id, now=NOW)
    set_snapshot(monkeypatch, snapshot(buyer, expires_date='bad-date'))
    with pytest.raises(HTTPException): billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).tier == 'premium'
    def offline(uid): raise HTTPException(503, 'offline')
    monkeypatch.setattr(billing, 'fetch_subscriber', offline)
    with pytest.raises(HTTPException): billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).tier == 'premium'

def test_other_account_or_unknown_product_cannot_unlock(db, buyer, monkeypatch):
    value = snapshot(buyer); value['original_app_user_id'] = str(uuid4())
    set_snapshot(monkeypatch, value); billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).tier == 'free'
    value = snapshot(buyer); value['subscriptions']['unapproved'] = value['subscriptions'].pop(PRODUCT)
    set_snapshot(monkeypatch, value); billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).tier == 'free'

def test_webhook_requires_config_secret_and_correct_app(db, buyer, monkeypatch):
    for header in [None, '', 'Bearer wrong']:
        with pytest.raises(HTTPException) as exc: billing.verify_webhook(header)
        assert exc.value.status_code == 401
    from app.api.routes.billing import webhook, ProviderEnvelope
    with pytest.raises(HTTPException) as exc:
        webhook(ProviderEnvelope(event={'id':'id', 'type':'TEST', 'app_id':'another-app'}), db, 'Bearer test-webhook-token')
    assert exc.value.status_code == 400
    monkeypatch.setattr(settings, 'revenuecat_secret_api_key', '')
    with pytest.raises(HTTPException) as exc: billing.verify_webhook('Bearer test-webhook-token')
    assert exc.value.status_code == 503

def test_revoked_beta_cannot_resurrect(db, buyer, monkeypatch):
    grant = entitlements.grant_beta_premium(db, buyer.id); grant.revoked_at = NOW; db.commit()
    assert entitlements.grant_beta_premium(db, buyer.id).id == grant.id
    assert access(db, buyer).tier == 'free'
    monkeypatch.setattr(settings, 'beta_premium_auto_grant', False)
    assert entitlements.grant_beta_premium(db, buyer.id) is None
    assert access(db, buyer).verified

def test_google_native_audiences_and_foreign_audience_rejection(monkeypatch):
    monkeypatch.setattr(settings, 'google_oauth_client_id', 'web-client')
    monkeypatch.setattr(settings, 'google_oauth_ios_client_id', 'ios-client')
    seen = []
    def verify(token, request, audiences):
        seen.append(audiences)
        return {'aud': 'ios-client', 'sub':'google-user', 'email':'user@example.invalid', 'email_verified': True}
    monkeypatch.setattr(auth.google_id_token, 'verify_oauth2_token', verify)
    assert auth.verify_google_identity_token('signed-token').subject == 'google-user'
    assert seen == [['web-client', 'ios-client']]
    monkeypatch.setattr(auth.google_id_token, 'verify_oauth2_token', lambda *a: {'aud':'attacker', 'email_verified': True})
    with pytest.raises(auth.GoogleAuthError): auth.verify_google_identity_token('bad')

def test_apple_deletion_matches_account_before_revoking(db, buyer, monkeypatch):
    db.add(AuthIdentity(user_id=buyer.id, provider='apple', provider_subject='linked-apple', email=buyer.email)); db.commit()
    with pytest.raises(HTTPException) as exc: apple_revocation.revoke_apple_for_deletion(db, buyer.id, None)
    assert exc.value.status_code == 409
    for key in ['apple_signin_private_key','apple_signin_key_id','ios_team_id','apple_bundle_id']:
        monkeypatch.setattr(settings, key, 'configured')
    monkeypatch.setattr(apple_revocation.jwt, 'encode', lambda *a, **kw: 'signed-client-secret')
    class Response:
        def raise_for_status(self): pass
        def json(self): return {'id_token': 'token', 'refresh_token': 'refresh'}
    calls = []
    monkeypatch.setattr(apple_revocation.httpx, 'post', lambda url, **kw: calls.append(url) or Response())
    monkeypatch.setattr(apple_revocation, 'verify_apple_identity_token', lambda token: auth.AppleIdentity('other-apple', None, None))
    with pytest.raises(HTTPException) as exc: apple_revocation.revoke_apple_for_deletion(db, buyer.id, 'one-use-code')
    assert exc.value.status_code == 403 and len(calls) == 1
    monkeypatch.setattr(apple_revocation, 'verify_apple_identity_token', lambda token: auth.AppleIdentity('linked-apple', None, None))
    apple_revocation.revoke_apple_for_deletion(db, buyer.id, 'new-one-use-code')
    assert calls[-1] == 'https://appleid.apple.com/auth/revoke'
    assert db.get(User, buyer.id) is not None


def test_disabling_new_sales_keeps_subscription_lifecycle_running(db, buyer, monkeypatch):
    monkeypatch.setattr(settings, 'billing_enabled', False)
    set_snapshot(monkeypatch, snapshot(buyer))
    billing.sync_purchases(db, buyer.id, now=NOW)
    assert access(db, buyer).tier == 'premium'
    from app.api.routes.billing import configuration
    config = configuration(buyer, db)
    assert config['available'] and not config['purchase_allowed']
    billing.verify_webhook('Bearer test-webhook-token')


def test_sync_endpoint_requires_login_and_ignores_forged_target(db, buyer, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.dependencies import get_db, get_current_user
    from app.api.routes.billing import router
    from app.core.limiter import limiter
    app = FastAPI(); app.state.limiter = limiter
    app.include_router(router, prefix='/billing')
    app.dependency_overrides[get_db] = lambda: db
    calls = []
    def provider(uid): calls.append(uid); return snapshot(buyer)
    monkeypatch.setattr(billing, 'fetch_subscriber', provider)
    with TestClient(app) as client:
        assert client.post('/billing/sync').status_code == 401
        app.dependency_overrides[get_current_user] = lambda: buyer
        response = client.post('/billing/sync', json={'user_id': str(uuid4()), 'tier': 'premium'})
        assert response.status_code == 200
        assert calls == [buyer.id]
        assert response.json()['tier'] == 'premium'
