from __future__ import annotations

import re
from dataclasses import dataclass

import httpx
import jwt
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.models.user import AuthIdentity, User, UserPreferences, UserProfile
from app.schemas.auth import SessionResponse, SessionUserResponse
from app.services.watchlists import ensure_default_watchlists

APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
APPLE_ISSUER = "https://appleid.apple.com"


class GoogleAuthError(Exception):
    pass


class AppleAuthError(Exception):
    pass


@dataclass
class GoogleIdentity:
    subject: str
    email: str
    display_name: str
    avatar_url: str | None


def verify_google_identity_token(token: str) -> GoogleIdentity:
    if not settings.google_oauth_client_id:
        raise GoogleAuthError("GOOGLE_OAUTH_CLIENT_ID is not configured")

    try:
        payload = google_id_token.verify_oauth2_token(
            token,
            google_requests.Request(),
            settings.google_oauth_client_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise GoogleAuthError("Google ID token verification failed") from exc

    if not payload.get("email_verified"):
        raise GoogleAuthError("Google account email is not verified")

    return GoogleIdentity(
        subject=payload["sub"],
        email=payload["email"].lower(),
        display_name=payload.get("name") or payload["email"].split("@", 1)[0],
        avatar_url=payload.get("picture"),
    )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:32] or "seensnap-user"


def _build_unique_username(db: Session, base_value: str) -> str:
    base_slug = _slugify(base_value)
    existing = {
        row
        for row in db.scalars(
            select(UserProfile.username).where(UserProfile.username.like(f"{base_slug}%"))
        )
    }
    if base_slug not in existing:
        return base_slug

    suffix = 2
    while f"{base_slug}-{suffix}" in existing:
        suffix += 1
    return f"{base_slug}-{suffix}"


@dataclass
class AppleIdentity:
    subject: str
    email: str | None
    display_name: str | None


def verify_apple_identity_token(token: str, *, audience: str | None = None) -> AppleIdentity:
    if not settings.apple_bundle_id and not audience:
        raise AppleAuthError("APPLE_BUNDLE_ID is not configured")

    try:
        header = jwt.get_unverified_header(token)
    except Exception as exc:
        raise AppleAuthError("Invalid Apple identity token") from exc

    try:
        resp = httpx.get(APPLE_JWKS_URL, timeout=10)
        resp.raise_for_status()
        jwks = resp.json()
    except Exception as exc:
        raise AppleAuthError("Failed to fetch Apple public keys") from exc

    matching_key = next((k for k in jwks.get("keys", []) if k.get("kid") == header.get("kid")), None)
    if matching_key is None:
        raise AppleAuthError("No matching Apple public key found")

    try:
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(matching_key)
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=audience or settings.apple_bundle_id,
            issuer=APPLE_ISSUER,
        )
    except Exception as exc:
        raise AppleAuthError("Apple identity token verification failed") from exc

    subject = payload.get("sub")
    if not subject:
        raise AppleAuthError("Apple identity token missing subject claim")

    return AppleIdentity(
        subject=subject,
        email=payload.get("email"),
        display_name=None,
    )


def _ensure_post_auth_state(db: Session, user: User) -> None:
    """Idempotently self-heal the required account objects after any successful auth.

    Called from every provider (Google, Apple, Dev) so that a partially-provisioned account
    can never persist. Safe to call repeatedly.
    """
    prefs = db.scalar(select(UserPreferences).where(UserPreferences.user_id == user.id))
    if prefs is None:
        db.add(UserPreferences(user_id=user.id))
    ensure_default_watchlists(db, user.id)


def authenticate_with_apple(db: Session, token: str, *, display_name: str | None = None) -> SessionResponse:
    identity = verify_apple_identity_token(token)

    auth_identity = db.scalar(
        select(AuthIdentity).where(
            AuthIdentity.provider == "apple",
            AuthIdentity.provider_subject == identity.subject,
        )
    )

    if auth_identity is not None:
        user = db.scalar(select(User).where(User.id == auth_identity.user_id))
        profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    else:
        email = identity.email or f"apple_{identity.subject[:16]}@private.apple.com"
        user = db.scalar(select(User).where(func.lower(User.email) == email.lower()))
        if user is None:
            user = User(email=email, auth_provider="apple")
            db.add(user)
            db.flush()

            resolved_name = display_name or (email.split("@", 1)[0])
            profile = UserProfile(
                user_id=user.id,
                username=_build_unique_username(db, email.split("@", 1)[0]),
                display_name=resolved_name,
                avatar_url=None,
                favorite_genres=[],
                country_code="US",
            )
            db.add(profile)
        else:
            profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))

        db.add(
            AuthIdentity(
                user_id=user.id,
                provider="apple",
                provider_subject=identity.subject,
                email=email,
            )
        )

    if profile is None:
        resolved_name = display_name or user.email.split("@", 1)[0]
        profile = UserProfile(
            user_id=user.id,
            username=_build_unique_username(db, user.email.split("@", 1)[0]),
            display_name=resolved_name,
            avatar_url=None,
            favorite_genres=[],
            country_code="US",
        )
        db.add(profile)

    _ensure_post_auth_state(db, user)
    db.commit()

    access_token = create_access_token(user.id, user.email, "apple")
    return SessionResponse(
        access_token=access_token,
        user=SessionUserResponse(
            user_id=user.id,
            email=user.email,
            display_name=profile.display_name,
            avatar_url=profile.avatar_url,
        ),
    )


def authenticate_with_google(db: Session, token: str) -> SessionResponse:
    identity = verify_google_identity_token(token)

    auth_identity = db.scalar(
        select(AuthIdentity).where(
            AuthIdentity.provider == "google",
            AuthIdentity.provider_subject == identity.subject,
        )
    )

    if auth_identity is not None:
        user = db.scalar(select(User).where(User.id == auth_identity.user_id))
        profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    else:
        user = db.scalar(select(User).where(func.lower(User.email) == identity.email))
        if user is None:
            user = User(email=identity.email, auth_provider="google")
            db.add(user)
            db.flush()

            profile = UserProfile(
                user_id=user.id,
                username=_build_unique_username(db, identity.email.split("@", 1)[0]),
                display_name=identity.display_name,
                avatar_url=identity.avatar_url,
                favorite_genres=[],
                country_code="US",
            )
            db.add(profile)
        else:
            profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))

        db.add(
            AuthIdentity(
                user_id=user.id,
                provider="google",
                provider_subject=identity.subject,
                email=identity.email,
            )
        )

    if profile is None:
        profile = UserProfile(
            user_id=user.id,
            username=_build_unique_username(db, identity.email.split("@", 1)[0]),
            display_name=identity.display_name,
            avatar_url=identity.avatar_url,
            favorite_genres=[],
            country_code="US",
        )
        db.add(profile)

    _ensure_post_auth_state(db, user)
    db.commit()

    access_token = create_access_token(user.id, user.email, "google")
    return SessionResponse(
        access_token=access_token,
        user=SessionUserResponse(
            user_id=user.id,
            email=user.email,
            display_name=profile.display_name,
            avatar_url=profile.avatar_url,
        ),
    )
