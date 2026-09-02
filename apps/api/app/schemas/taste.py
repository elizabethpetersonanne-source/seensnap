from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class TasteGenreScoreResponse(BaseModel):
    genre: str
    score: int


class TasteLabelResponse(BaseModel):
    label: str
    confidence: int


class TasteTitleReferenceResponse(BaseModel):
    title_id: UUID | None = None
    title_name: str
    poster_url: str | None = None


class TasteProfileResponse(BaseModel):
    user_id: UUID
    top_genres: list[TasteGenreScoreResponse] = Field(default_factory=list)
    top_themes: list[str] = Field(default_factory=list)
    top_platforms: list[str] = Field(default_factory=list)
    favorite_eras: list[str] = Field(default_factory=list)
    taste_labels: list[TasteLabelResponse] = Field(default_factory=list)
    profile_summary: str | None = None
    current_obsessions: list[TasteTitleReferenceResponse] = Field(default_factory=list)
    top_posters: list[str] = Field(default_factory=list)
    most_saved_genre: str | None = None
    updated_at: datetime | None = None


class CompatibilityResponse(BaseModel):
    user_a: UUID
    user_b: UUID
    compatibility: int
    top_shared_genres: list[str] = Field(default_factory=list)
    top_shared_titles: list[TasteTitleReferenceResponse] = Field(default_factory=list)
    shared_labels: list[str] = Field(default_factory=list)
    shared_platforms: list[str] = Field(default_factory=list)
    summary: str | None = None
    updated_at: datetime | None = None


class TeamAnalyticsPersonResponse(BaseModel):
    user_id: UUID
    display_name: str | None = None
    avatar_url: str | None = None
    score: int | None = None
    detail: str | None = None


class TeamAnalyticsPairResponse(BaseModel):
    members: list[TeamAnalyticsPersonResponse] = Field(default_factory=list)
    compatibility: int = 0
    summary: str | None = None


class TeamAnalyticsGenreBreakdownResponse(BaseModel):
    genre: str
    percent: int


class TeamAnalyticsResponse(BaseModel):
    team_id: UUID
    average_compatibility: int = 0
    most_aligned_members: TeamAnalyticsPairResponse
    most_divisive_member: TeamAnalyticsPersonResponse | None = None
    taste_mvp: TeamAnalyticsPersonResponse | None = None
    most_loved_title: TasteTitleReferenceResponse | None = None
    most_divisive_title: TasteTitleReferenceResponse | None = None
    genre_breakdown: list[TeamAnalyticsGenreBreakdownResponse] = Field(default_factory=list)
    activity_snapshot: dict = Field(default_factory=dict)
    updated_at: datetime | None = None


class HotTakeResponse(BaseModel):
    statement: str
    type: str
    strength: int


class GenreShiftResponse(BaseModel):
    genre: str
    delta: float
    direction: str
    current_share: float
    previous_share: float


class TasteEvolutionResponse(BaseModel):
    period_label: str
    comparison_label: str
    shifts: list[GenreShiftResponse] = Field(default_factory=list)
    summary: str
    has_data: bool


class TasteAlignmentEntryResponse(BaseModel):
    user_id: UUID
    display_name: str
    avatar_url: str | None = None
    alignment_score: int
    top_shared_genres: list[str] = Field(default_factory=list)
    shared_label: str | None = None


class TasteAlignmentResponse(BaseModel):
    entries: list[TasteAlignmentEntryResponse] = Field(default_factory=list)
    has_data: bool


class SwipeRecordCreate(BaseModel):
    title_id: UUID
    direction: str = Field(pattern="^(left|right|up)$")
    pause_ms: int | None = Field(default=None, ge=0, le=120000)
    session_id: str | None = Field(default=None, max_length=80)
    reason: str | None = Field(default=None, max_length=280)
    source_surface: str | None = Field(default=None, max_length=80)
    # Onboarding spec §12: idempotent swipe writes. Client sends a
    # UUID-per-decision; server dedupes on (user_id, idempotency_key)
    # so a network retry can't create a double signal.
    idempotency_key: str | None = Field(default=None, max_length=80)


class SceneDnaEvidenceTitle(BaseModel):
    title_id: UUID | None = None
    title_name: str


class SceneDnaFeedbackResponse(BaseModel):
    headline: str          # e.g. "That tracks."  |  "Very you."  |  "New territory."
    body: str              # 1–2 sentences grounded in actual signals
    signal_labels: list[str]  # e.g. ["Slow Burn", "Prestige Drama"]
    evidence_titles: list[SceneDnaEvidenceTitle]


class SwipeRecordResponse(BaseModel):
    ok: bool = True
    title_id: UUID
    direction: str
    updated_at: datetime | None = None
    # SceneDNA-grounded feedback for positive swipes. Null for pass/left.
    scene_dna_feedback: SceneDnaFeedbackResponse | None = None


# ─── SceneDNA unified schema (per SceneDNA UX Overhaul brief §3) ─────────────
# One canonical shape the SceneDNA screen consumes. Identity → signals →
# movement → freshness. Assembled server-side so the UI doesn't have to
# stitch multiple endpoints together and drift from the model.
#
# Confidence tiers:
#   "strong"   — signal count above the "believable" threshold; can render
#                as a firm identity claim.
#   "emerging" — signal count is meaningful but still developing; hedge
#                the copy ("emerging pattern").
#   "early"    — barely enough to name; render as "early signal" only.


class SceneDnaIdentityResponse(BaseModel):
    """Single headline archetype for the compact hero — never three
    competing identity concepts. Copy is deterministic per profile so the
    same taste always produces the same headline (no LLM invention)."""
    archetype: str  # e.g. "Prestige Drama with a Chaos Streak"
    one_line: str   # short human explanation
    confidence_tier: str  # 'strong' | 'emerging' | 'early'
    updated_at: datetime | None = None
    based_on_summary: str  # e.g. "Based on 38 saves, 21 swipes, 9 ratings"
    hero_backdrops: list[str] = Field(default_factory=list)  # 2–4 posters/backdrops from titles that ACTUALLY drove the DNA


class SceneDnaSignalResponse(BaseModel):
    """One dominant taste trait grounded in actual behavior. Signal cards
    tap to expand into the evidence drawer (task #37)."""
    label: str  # "Character Study" | "Slow Burn" | "Darkly Funny"
    confidence_tier: str
    evidence_count: int  # "Shows up across 11 recent saves"
    contributing_titles: list[TasteTitleReferenceResponse] = Field(default_factory=list)  # cap at 3


class SceneDnaMovementResponse(BaseModel):
    """Material movement only per brief §5 — not a full leaderboard.
    Two-to-three biggest changes vs prior period."""
    direction: str  # 'rising' | 'entering_top5' | 'fading'
    label: str      # e.g. "Crime"
    sample_size: int  # count of saves in the reference window
    detail: str      # e.g. "6 crime titles this month — twice your usual rate"


class SceneDnaColdStartResponse(BaseModel):
    """Cold-start meter: forming SceneDNA needs enough signal to be
    believable (brief §8). Progress is tied to meaningful behaviors, not
    arbitrary app usage."""
    saves_current: int
    saves_target: int
    ratings_current: int
    ratings_target: int
    swipes_current: int
    swipes_target: int
    next_action_hint: str


class SceneDnaResponse(BaseModel):
    identity: SceneDnaIdentityResponse | None = None
    signals: list[SceneDnaSignalResponse] = Field(default_factory=list)
    movement: list[SceneDnaMovementResponse] = Field(default_factory=list)
    has_signal: bool = False  # false when cold-start meter is still filling
    cold_start: SceneDnaColdStartResponse | None = None
