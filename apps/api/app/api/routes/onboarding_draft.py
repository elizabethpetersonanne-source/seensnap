"""Owner-only, versioned progress. Drafts never publish profile or taste activity."""

from datetime import datetime, timezone
from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from app.api.dependencies import CurrentUser, DbSession
from app.models.user import User, UserPreferences
from app.models.user_state import OnboardingDraft

router = APIRouter()


class DraftData(BaseModel):
    step: Literal[
        "welcome", "basics", "services", "calibrate-intro", "calibrate", "dna", "complete"
    ] = "welcome"
    display_name: str = Field(default="", max_length=80)
    username: str = Field(default="", max_length=40)
    country_code: str = Field(default="US", pattern="^[A-Za-z]{2}$")
    streaming_services: list[str] = Field(default_factory=list, max_length=12)


class DraftWrite(BaseModel):
    data: DraftData
    expected_version: int = Field(ge=0)


def snapshot(db, user_id):
    row = db.get(OnboardingDraft, user_id, populate_existing=True)
    prefs = db.get(UserPreferences, user_id)
    completed = bool(prefs and prefs.onboarding_completed)
    return {
        "data": row.data if row and row.data and not completed else None,
        "version": row.version if row else 0,
        "completed": completed,
    }


@router.get("")
def get_draft(current_user: CurrentUser, db: DbSession):
    return snapshot(db, current_user.id)


@router.put("")
def put_draft(payload: DraftWrite, current_user: CurrentUser, db: DbSession):
    db.scalar(select(User.id).where(User.id == current_user.id).with_for_update())
    current = snapshot(db, current_user.id)
    if current["completed"]:
        raise HTTPException(409, detail={"code": "onboarding_completed", "current": current})
    data = payload.data.model_dump()
    data["country_code"] = data["country_code"].upper()
    from app.api.routes.me import SUPPORTED_STREAMING_SERVICES

    if set(data["streaming_services"]) - SUPPORTED_STREAMING_SERVICES:
        raise HTTPException(400, detail="Choose a supported streaming service.")
    if current["version"] != payload.expected_version:
        if data == current["data"]:
            return current  # Safe replay of an acknowledged snapshot.
        raise HTTPException(409, detail={"code": "draft_conflict", "current": current})
    row = db.get(OnboardingDraft, current_user.id)
    if row is None:
        row = OnboardingDraft(user_id=current_user.id, version=0)
        db.add(row)
    if row.data != data:
        row.data = data
        row.version += 1
        row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return snapshot(db, current_user.id)


@router.delete("")
def clear_draft(current_user: CurrentUser, db: DbSession):
    db.scalar(select(User.id).where(User.id == current_user.id).with_for_update())
    row = db.get(OnboardingDraft, current_user.id)
    if row and row.data:
        row.data = {}
        row.version += 1
        row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return snapshot(db, current_user.id)
