from collections.abc import Generator
from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.session import SessionLocal
from app.models.user import User
from app.services.demo import DEMO_TOKEN, ensure_demo_user


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


DbSession = Annotated[Session, Depends(get_db)]


def get_current_user(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    if token == DEMO_TOKEN and settings.dev_auth_enabled:
        return ensure_demo_user(db)

    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    user = db.scalar(select(User).where(User.id == payload.sub))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_optional_current_user(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    """Like get_current_user but returns None instead of 401 when no/invalid token.
    Used for endpoints that accept unauthenticated calls (e.g. pre-signup analytics)."""
    if authorization is None or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    if token == DEMO_TOKEN and settings.dev_auth_enabled:
        return ensure_demo_user(db)
    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return None
    return db.scalar(select(User).where(User.id == payload.sub))


OptionalCurrentUser = Annotated[User | None, Depends(get_optional_current_user)]
