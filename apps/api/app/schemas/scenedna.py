from datetime import datetime
from pydantic import BaseModel, Field


class SceneDnaDimension(BaseModel):
    dimension: str
    weight: float
    score: float
    confidence: float
    evidence_count: int


class TitleCompatibility(BaseModel):
    # Internal ordering may use score before the display gate is met.
    score: float | None = None
    percentage: int | None = None
    score_version: str
    computed_at: datetime
    evidence_count: int
    numeric_rating_count: int
    confidence: float
    available_dimensions: list[str] = Field(default_factory=list)
    breakdown: list[SceneDnaDimension] = Field(default_factory=list)
    learning: bool = True
    learning_reason: str | None = None
    explanation: str = "Learning your taste"
