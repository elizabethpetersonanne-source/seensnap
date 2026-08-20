"""Unified recommendation endpoints — SceneDNA brief §29.

Every SeenSnap surface (Swipe, SceneDNA Scene Picks, Discover, Teams) calls
these endpoints. Prevents multiple screens from inventing their own
recommendation logic.

Endpoints:
    GET  /recommendations                       — mode-scoped rec query
    POST /recommendations/{impression_id}/feedback  — user action on a rec
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.taste import RecommendationImpression, RecommendationFeedback
from app.services.recommendation_service import MODES, recommend_for_user

router = APIRouter()


class RecommendationReasonResponse(BaseModel):
    type: str
    signal_type: str | None = None
    signal_name: str | None = None
    hits: int | None = None
    score: float | None = None


class RecommendationTitleResponse(BaseModel):
    id: UUID
    title: str
    content_type: str
    poster_url: str | None = None
    backdrop_url: str | None = None
    overview: str | None = None
    release_date: str | None = None
    genres: list[str] = Field(default_factory=list)


class RecommendationItemResponse(BaseModel):
    impression_id: UUID
    title: RecommendationTitleResponse
    score: float
    confidence: str
    reasons: list[RecommendationReasonResponse] = Field(default_factory=list)
    mode: str
    mode_label: str
    reason_template: str


class RecommendationsResponse(BaseModel):
    mode: str
    mode_label: str
    items: list[RecommendationItemResponse]


class RecommendationFeedbackRequest(BaseModel):
    action: str  # open | save | dismiss | swipe_right | swipe_left | watch_now | share | signal_less_like | signal_not_me
    payload: dict = Field(default_factory=dict)


@router.get("", response_model=RecommendationsResponse)
def get_recommendations(
    current_user: CurrentUser,
    db: DbSession,
    mode: str = Query("perfect", description="perfect | dark-cinematic | comfort | hidden-gems | stretch | movie-night | late-night | afternoon"),
    limit: int = Query(20, ge=1, le=60),
    session_id: str | None = Query(None, max_length=96),
    surface: str = Query("recommendations", max_length=48),
) -> RecommendationsResponse:
    """Mode-scoped, personally re-ranked recommendations. Impressions are
    logged automatically so downstream can measure which sources cause
    saves (brief §35)."""
    if mode not in MODES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown mode: {mode}")
    items = recommend_for_user(
        db,
        current_user.id,
        mode=mode,
        limit=limit,
        session_id=session_id,
        surface=surface,
    )
    config = MODES[mode]
    return RecommendationsResponse(
        mode=mode,
        mode_label=config.display_label,
        items=[
            RecommendationItemResponse(
                impression_id=UUID(item["impression_id"]),
                title=RecommendationTitleResponse(
                    id=item["title"].id,
                    title=item["title"].title,
                    content_type=item["title"].content_type,
                    poster_url=item["title"].poster_url,
                    backdrop_url=item["title"].backdrop_url,
                    overview=item["title"].overview,
                    release_date=item["title"].release_date.isoformat() if item["title"].release_date else None,
                    genres=item["title"].genres or [],
                ),
                score=item["score"],
                confidence=item["confidence"],
                reasons=[RecommendationReasonResponse(**r) for r in item["reasons"]],
                mode=item["mode"],
                mode_label=item["mode_label"],
                reason_template=item["reason_template"],
            )
            for item in items
        ],
    )


@router.get("/{impression_id}/explain")
def explain_recommendation(
    impression_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    """Debug mode per Discover brief §32. Long-press on any recommendation
    surfaces this: WHY did the user receive this title, broken down by
    contributing signal + candidate source + score. Dev-only in production
    builds — enable a developer setting to reveal in the client.

    Returns:
        {
          "surface": "swipe" | "discover_hero_movie_night" | ...,
          "mode": "movie-night" | ...,
          "candidate_source": "unified_service" | ...,
          "algorithm_version": "reco_service_v1",
          "score": 1.87,
          "reason_type": "signal_match",
          "signal_contributions": [
             { "signal_type": "label", "signal_name": "Prestige Drama", "score": 0.95 },
             ...
          ],
          "title": {...},
          "excluded_reasons": [...],
        }
    """
    from app.core.config import settings
    from app.models.content import ContentTitle

    if not settings.dev_auth_enabled and not current_user.is_demo:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Debug mode not available in this environment")

    impression = db.scalar(
        select(RecommendationImpression).where(
            RecommendationImpression.id == impression_id,
            RecommendationImpression.user_id == current_user.id,
        )
    )
    if impression is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Impression not found")

    title = db.scalar(select(ContentTitle).where(ContentTitle.id == impression.content_title_id))
    reasons = (impression.payload or {}).get("reasons", []) if isinstance(impression.payload, dict) else []

    return {
        "impression_id": str(impression.id),
        "surface": impression.surface,
        "mode": impression.mode,
        "position": impression.position,
        "score": float(impression.score) if impression.score is not None else None,
        "candidate_source": impression.candidate_source,
        "reason_type": impression.reason_type,
        "algorithm_version": impression.algorithm_version,
        "session_id": impression.session_id,
        "signal_contributions": reasons,
        "title": {
            "id": str(title.id) if title else None,
            "title": title.title if title else None,
            "genres": title.genres if title else [],
        },
        "created_at": impression.created_at.isoformat(),
    }


@router.post("/{impression_id}/feedback", status_code=status.HTTP_201_CREATED)
def submit_recommendation_feedback(
    impression_id: UUID,
    payload: RecommendationFeedbackRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    """Record a user's action on a specific recommendation impression.
    Downstream services read RecommendationFeedback to update UserSignal
    scores (positive_evidence / negative_evidence) and measure the
    personalized engine's outperformance vs generic popularity."""
    impression = db.scalar(
        select(RecommendationImpression).where(
            RecommendationImpression.id == impression_id,
            RecommendationImpression.user_id == current_user.id,
        )
    )
    if impression is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Impression not found")
    feedback = RecommendationFeedback(
        user_id=current_user.id,
        impression_id=impression.id,
        content_title_id=impression.content_title_id,
        action=payload.action,
        payload=payload.payload or {},
    )
    db.add(feedback)
    db.commit()
    return {"ok": True, "feedback_id": str(feedback.id)}
