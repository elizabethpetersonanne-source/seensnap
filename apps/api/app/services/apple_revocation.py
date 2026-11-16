"""Reauthorize and revoke Apple access before deleting an Apple-linked account.

One-use codes and refresh tokens stay in memory for this request; neither is
persisted or logged. A code from another Apple account cannot delete this one.
"""
from datetime import datetime, timedelta, timezone
import httpx
import jwt
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user import AuthIdentity
from app.services.auth import AppleAuthError, verify_apple_identity_token


def requires_apple_reauthorization(db: Session, user_id) -> bool:
    return db.scalar(select(AuthIdentity.id).where(
        AuthIdentity.user_id == user_id, AuthIdentity.provider == "apple")) is not None


def revoke_apple_for_deletion(db: Session, user_id, authorization_code: str | None) -> None:
    subjects = set(db.scalars(select(AuthIdentity.provider_subject).where(
        AuthIdentity.user_id == user_id, AuthIdentity.provider == "apple")).all())
    if not subjects:
        return
    if not authorization_code:
        raise HTTPException(409, "Confirm your Apple sign-in to delete this account.")
    if not all([settings.apple_signin_private_key, settings.apple_signin_key_id,
                settings.ios_team_id, settings.apple_bundle_id]):
        raise HTTPException(503, "Apple account deletion is temporarily unavailable. Please contact support.")
    now = datetime.now(timezone.utc)
    try:
        secret = jwt.encode({"iss": settings.ios_team_id, "iat": now, "exp": now + timedelta(minutes=5),
                             "aud": "https://appleid.apple.com", "sub": settings.apple_bundle_id},
                            settings.apple_signin_private_key.replace("\\n", "\n"),
                            algorithm="ES256", headers={"kid": settings.apple_signin_key_id})
        data = {"client_id": settings.apple_bundle_id, "client_secret": secret}
        response = httpx.post("https://appleid.apple.com/auth/token", timeout=10,
            data={**data, "code": authorization_code, "grant_type": "authorization_code"})
        response.raise_for_status()
        tokens = response.json()
        identity = verify_apple_identity_token(tokens["id_token"])
        if identity.subject not in subjects:
            raise HTTPException(403, "Use the Apple account linked to this SeenSnap account.")
        if not tokens.get("refresh_token"):
            raise ValueError("No revocable token")
        response = httpx.post("https://appleid.apple.com/auth/revoke", timeout=10,
            data={**data, "token": tokens["refresh_token"], "token_type_hint": "refresh_token"})
        response.raise_for_status()
    except (httpx.HTTPError, ValueError, KeyError, TypeError, jwt.PyJWTError, AppleAuthError) as exc:
        raise HTTPException(503, "Could not confirm Apple account removal. Please try again.") from exc
