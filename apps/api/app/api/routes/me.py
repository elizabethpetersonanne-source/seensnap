from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy import func, select

from pydantic import BaseModel

from app.api.dependencies import CurrentUser, DbSession
from app.core.config import settings
from app.models.taste import SwipeRecord
from app.models.user import UserPreferences, UserProfile
from app.schemas.taste import HotTakeResponse, SceneDnaResponse, TasteAlignmentResponse, TasteEvolutionResponse
from app.schemas.user import (
    PreferencesResponse,
    PreferencesUpdateRequest,
    ProfileResponse,
    ProfileUpdateRequest,
)
from app.services.taste import build_scene_dna_response, get_hot_takes, get_taste_alignment, get_taste_evolution

ONBOARDING_CALIBRATION_TARGET = 20


class OnboardingProgressResponse(BaseModel):
    signal_count: int
    target: int
    completed: bool

SUPPORTED_STREAMING_SERVICES = {
    "netflix",
    "prime_video",
    "apple_tv_plus",
    "hbo_max",
    "disney_plus",
    "hulu",
    "paramount_plus",
    "peacock",
}

router = APIRouter()


@router.get("", response_model=ProfileResponse)
def get_me(current_user: CurrentUser, db: DbSession) -> ProfileResponse:
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == current_user.id))
    if profile is None:
        return ProfileResponse(
            user_id=current_user.id,
            email=current_user.email,
            username="pending",
            display_name="SeenSnap User",
            favorite_genres=[],
            country_code="US",
            avatar_url=None,
            bio=None,
        )
    return ProfileResponse(
        user_id=current_user.id,
        email=current_user.email,
        username=profile.username,
        display_name=profile.display_name,
        favorite_genres=profile.favorite_genres,
        country_code=profile.country_code,
        avatar_url=profile.avatar_url,
        bio=profile.bio,
    )


@router.patch("", response_model=ProfileResponse)
def patch_me(payload: ProfileUpdateRequest, current_user: CurrentUser, db: DbSession) -> ProfileResponse:
    profile = _ensure_profile(db, current_user.id, current_user.email)

    if payload.username is not None:
        candidate = payload.username.strip().lower()
        if len(candidate) < 3:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username must be at least 3 characters")
        duplicate = db.scalar(
            select(UserProfile).where(func.lower(UserProfile.username) == candidate, UserProfile.user_id != current_user.id)
        )
        if duplicate is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is already taken")
        profile.username = candidate

    if payload.display_name is not None:
        display_name = payload.display_name.strip()
        if not display_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name cannot be empty")
        profile.display_name = display_name

    if payload.bio is not None:
        profile.bio = payload.bio.strip() if payload.bio.strip() else None

    if payload.avatar_url is not None:
        avatar = payload.avatar_url.strip()
        profile.avatar_url = avatar if avatar else None

    if payload.country_code is not None:
        profile.country_code = payload.country_code.upper()

    db.commit()
    db.refresh(profile)
    return ProfileResponse(
        user_id=current_user.id,
        email=current_user.email,
        username=profile.username,
        display_name=profile.display_name,
        favorite_genres=profile.favorite_genres,
        country_code=profile.country_code,
        avatar_url=profile.avatar_url,
        bio=profile.bio,
    )


@router.post("/avatar", response_model=ProfileResponse)
def upload_avatar(
    request: Request,
    current_user: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
) -> ProfileResponse:
    profile = _ensure_profile(db, current_user.id, current_user.email)
    content_type = (file.content_type or "").lower()
    extension_map = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }
    ext = extension_map.get(content_type)
    if ext is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image type")

    data = file.file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Image file is empty")
    if len(data) > 6 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Image too large (max 6MB)")

    avatars_dir = settings.uploads_path() / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{current_user.id}_{uuid4().hex}{ext}"
    target = avatars_dir / filename
    target.write_bytes(data)

    if profile.avatar_url and "/uploads/avatars/" in profile.avatar_url:
        old_name = profile.avatar_url.split("/uploads/avatars/")[-1]
        old_path = avatars_dir / old_name
        if old_path.exists():
            old_path.unlink(missing_ok=True)

    profile.avatar_url = str(request.base_url).rstrip("/") + f"/uploads/avatars/{filename}"
    db.commit()
    db.refresh(profile)
    return ProfileResponse(
        user_id=current_user.id,
        email=current_user.email,
        username=profile.username,
        display_name=profile.display_name,
        favorite_genres=profile.favorite_genres,
        country_code=profile.country_code,
        avatar_url=profile.avatar_url,
        bio=profile.bio,
    )


@router.delete("/avatar", response_model=ProfileResponse)
def delete_avatar(current_user: CurrentUser, db: DbSession) -> ProfileResponse:
    profile = _ensure_profile(db, current_user.id, current_user.email)
    if profile.avatar_url and "/uploads/avatars/" in profile.avatar_url:
        avatars_dir = settings.uploads_path() / "avatars"
        old_name = profile.avatar_url.split("/uploads/avatars/")[-1]
        old_path = avatars_dir / old_name
        if old_path.exists():
            old_path.unlink(missing_ok=True)
    profile.avatar_url = None
    db.commit()
    db.refresh(profile)
    return ProfileResponse(
        user_id=current_user.id,
        email=current_user.email,
        username=profile.username,
        display_name=profile.display_name,
        favorite_genres=profile.favorite_genres,
        country_code=profile.country_code,
        avatar_url=profile.avatar_url,
        bio=profile.bio,
    )


@router.get("/preferences", response_model=PreferencesResponse)
def get_preferences(current_user: CurrentUser, db: DbSession) -> PreferencesResponse:
    preferences = db.scalar(select(UserPreferences).where(UserPreferences.user_id == current_user.id))
    if preferences is None:
        return PreferencesResponse(
            notifications_enabled=True,
            preferred_regions=["US"],
            connected_streaming_services=[],
            instagram_share_default=True,
        )
    return PreferencesResponse(
        notifications_enabled=preferences.notifications_enabled,
        preferred_regions=preferences.preferred_regions,
        connected_streaming_services=preferences.connected_streaming_services,
        instagram_share_default=preferences.instagram_share_default,
        onboarding_completed=preferences.onboarding_completed,
    )


@router.patch("/preferences", response_model=PreferencesResponse)
def patch_preferences(
    payload: PreferencesUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> PreferencesResponse:
    preferences = db.scalar(select(UserPreferences).where(UserPreferences.user_id == current_user.id))
    if preferences is None:
        preferences = UserPreferences(user_id=current_user.id)
        db.add(preferences)
        db.flush()

    if payload.connected_streaming_services is not None:
        normalized: list[str] = []
        seen: set[str] = set()
        for service in payload.connected_streaming_services:
            key = service.strip().lower()
            if not key or key in seen:
                continue
            if key not in SUPPORTED_STREAMING_SERVICES:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unsupported streaming service: {service}",
                )
            normalized.append(key)
            seen.add(key)
        preferences.connected_streaming_services = normalized

    if payload.onboarding_completed is not None:
        preferences.onboarding_completed = payload.onboarding_completed

    db.commit()
    db.refresh(preferences)
    return PreferencesResponse(
        notifications_enabled=preferences.notifications_enabled,
        preferred_regions=preferences.preferred_regions,
        connected_streaming_services=preferences.connected_streaming_services,
        instagram_share_default=preferences.instagram_share_default,
        onboarding_completed=preferences.onboarding_completed,
    )


@router.get("/onboarding-progress", response_model=OnboardingProgressResponse)
def get_onboarding_progress(current_user: CurrentUser, db: DbSession) -> OnboardingProgressResponse:
    """Count how many calibration swipes the user has recorded. Used by the client to
    resume onboarding at the right position after app kill/relaunch."""
    signal_count = int(
        db.scalar(
            select(func.count(SwipeRecord.id)).where(
                SwipeRecord.user_id == current_user.id,
                SwipeRecord.source_surface == "onboarding_calibration",
            )
        )
        or 0
    )
    prefs = db.scalar(select(UserPreferences).where(UserPreferences.user_id == current_user.id))
    completed = bool(prefs.onboarding_completed) if prefs else False
    return OnboardingProgressResponse(
        signal_count=signal_count,
        target=ONBOARDING_CALIBRATION_TARGET,
        completed=completed,
    )


@router.get("/hot-takes", response_model=list[HotTakeResponse])
def get_my_hot_takes(current_user: CurrentUser, db: DbSession) -> list[HotTakeResponse]:
    return get_hot_takes(db, current_user.id)


@router.get("/taste-evolution", response_model=TasteEvolutionResponse)
def get_my_taste_evolution(current_user: CurrentUser, db: DbSession) -> TasteEvolutionResponse:
    return get_taste_evolution(db, current_user.id)


@router.get("/taste-alignment", response_model=TasteAlignmentResponse)
def get_my_taste_alignment(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=5, ge=1, le=20),
) -> TasteAlignmentResponse:
    return get_taste_alignment(db, current_user.id, limit=limit)


@router.get("/scene-dna", response_model=SceneDnaResponse)
def get_my_scene_dna(current_user: CurrentUser, db: DbSession) -> SceneDnaResponse:
    """Canonical SceneDNA snapshot per UX Overhaul brief §3. Returns the
    5-layer schema (identity → signals → movement + freshness); returns a
    cold-start meter instead of a fabricated identity when signal is thin."""
    return build_scene_dna_response(db, current_user.id)


class SignalCorrectionRequest(BaseModel):
    action: str  # signal_less_like | signal_not_me | signal_confirmed
    reason: str | None = None


@router.post("/scene-dna/signals/{signal_name}/correction", status_code=status.HTTP_201_CREATED)
def submit_signal_correction(
    signal_name: str,
    payload: SignalCorrectionRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    """Per SceneDNA brief §18 + §20. Records the user's teaching signal so
    "less like this" / "not quite me" ACTUALLY affects future recommendations
    (not just an analytics event). Weights come from SIGNAL_WEIGHTS in
    user_signals.py; downstream signal recomputation will pull this into
    negative_evidence for the affected signal."""
    from app.models.taste import UserSignal
    from app.services.user_signals import compute_user_signals

    signal = db.scalar(
        select(UserSignal).where(
            UserSignal.user_id == current_user.id,
            UserSignal.signal_name == signal_name,
        )
    )
    if signal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Signal not found")

    # For MVP: hard-suppress the signal by dropping its score toward zero.
    # A full loop would insert a signal_correction event that _collect_interactions
    # reads on the next recompute — captured under task #66 (unified interaction
    # events). For now, immediate suppression gives users the responsive feel
    # brief §20 demands ("every recommendation interaction should teach").
    if payload.action in ("signal_less_like", "signal_not_me"):
        from decimal import Decimal
        signal.score = Decimal("0")
        signal.confidence_tier = "fading"
        signal.trend = "fading"
        db.commit()
        # Also recompute signals so downstream reads reflect the correction.
        compute_user_signals(db, current_user.id)
    return {"ok": True, "action": payload.action, "signal_name": signal_name}


@router.get("/scene-dna/signals/{signal_name}")
def get_my_scene_dna_signal(signal_name: str, current_user: CurrentUser, db: DbSession) -> dict:
    """Per SceneDNA brief §18 + §19. Detail surface for one signal:
      - score + confidence + sample size + trend
      - positive_evidence (titles that DROVE the signal up, with metadata)
      - negative_evidence (titles user actively rejected in this vein)
      - "Explore this signal" personalized rec rail keyed to the signal
    """
    from app.models.content import ContentTitle
    from app.models.taste import UserSignal
    from app.services.recommendation_service import recommend_for_user
    from app.services.user_signals import ensure_signals
    from uuid import UUID as _UUID

    ensure_signals(db, current_user.id)
    signal = db.scalar(
        select(UserSignal).where(
            UserSignal.user_id == current_user.id,
            UserSignal.signal_name == signal_name,
        )
    )
    if signal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Signal not found")

    def _load_titles(ids: list[str]) -> list[dict]:
        uuids: list = []
        for tid in ids[:12]:
            try:
                uuids.append(_UUID(str(tid)))
            except (ValueError, TypeError):
                continue
        if not uuids:
            return []
        rows = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(uuids))).all()
        return [
            {
                "title_id": str(t.id),
                "title_name": t.title,
                "poster_url": t.poster_url,
                "content_type": t.content_type,
            }
            for t in rows
        ]

    # Personalized rec rail specifically for THIS signal — candidate pool is
    # filtered to titles carrying the signal's genre/attribute set so different
    # signals return different rails ("Prestige Drama" ≠ "Slow Burn" ≠
    # "Character Study"). Prior implementation used mode="perfect" which
    # returned the same top-scored titles for every signal.
    from app.services.recommendation_service import recommend_for_signal

    explore = recommend_for_signal(
        db,
        current_user.id,
        signal_name=signal.signal_name,
        limit=8,
    )
    return {
        "signal_type": signal.signal_type,
        "signal_name": signal.signal_name,
        "score": float(signal.score),
        "confidence_tier": signal.confidence_tier,
        "sample_size": signal.sample_size,
        "trend": signal.trend,
        "positive_evidence": _load_titles(signal.positive_evidence or []),
        "negative_evidence": _load_titles(signal.negative_evidence or []),
        "explore": [
            {
                "impression_id": r["impression_id"],
                "title_id": str(r["title"].id),
                "title_name": r["title"].title,
                "poster_url": r["title"].poster_url,
                "score": r["score"],
                "confidence": r["confidence"],
            }
            for r in explore
        ],
    }


def _ensure_profile(db: DbSession, user_id, email: str) -> UserProfile:
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user_id))
    if profile is not None:
        return profile
    profile = UserProfile(
        user_id=user_id,
        username=email.split("@", 1)[0][:32] or "seensnap_user",
        display_name=email.split("@", 1)[0],
        avatar_url=None,
        favorite_genres=[],
        bio=None,
        country_code="US",
    )
    db.add(profile)
    db.flush()
    return profile
