"""Validated provider output. Invalid output must never become an open search."""

from typing import Literal
from math import ceil, floor
import re

from pydantic import BaseModel, ConfigDict, Field, model_validator


def explicit_runtime_bounds(prompt: str) -> dict[str, int]:
    """Translate explicit durations into the catalog's inclusive integer bounds.

    The model sometimes treats "under 90" as <= 90. Resolve numeric duration
    wording before validation so retrieval, relevance and follow-ups all see
    the same limit. Unrecognized wording remains the model's responsibility.
    """
    operators = {
        "under": ("runtime_max", False), "below": ("runtime_max", False),
        "less than": ("runtime_max", False), "shorter than": ("runtime_max", False),
        "at most": ("runtime_max", True), "up to": ("runtime_max", True),
        "no more than": ("runtime_max", True), "not more than": ("runtime_max", True),
        "no longer than": ("runtime_max", True),
        "over": ("runtime_min", False), "above": ("runtime_min", False),
        "more than": ("runtime_min", False), "longer than": ("runtime_min", False),
        "at least": ("runtime_min", True), "no less than": ("runtime_min", True),
        "not less than": ("runtime_min", True),
    }
    pattern = (r"\b(" + "|".join(sorted(operators, key=len, reverse=True))
               + r")\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b")
    bounds = {}
    for match in re.finditer(pattern, prompt.lower()):
        # Do not turn "not under 90 minutes" into an upper bound.
        if re.search(r"\b(?:not|never|avoid)\s+$", prompt[:match.start()].lower()):
            continue
        field, inclusive = operators[match[1]]
        minutes = float(match[2]) * (60 if match[3].startswith("h") else 1)
        if match[3].startswith("h"):
            extra = re.match(r"\s*(?:and\s+)?(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b", prompt[match.end():].lower())
            if extra:
                minutes += float(extra[1])
        if field == "runtime_max":
            value = floor(minutes) if inclusive else ceil(minutes) - 1
            bounds[field] = min(bounds.get(field, value), value)
        else:
            value = ceil(minutes) if inclusive else floor(minutes) + 1
            bounds[field] = max(bounds.get(field, value), value)
    return bounds


class PersonConstraint(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    role: Literal["cast", "director", "writer"] = "cast"


class ConciergeIntent(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore")
    media_type: Literal["movie", "series", "any"]
    genres: list[str] = Field(default_factory=list, max_length=8)
    original_language: str | None = Field(default=None, pattern=r"^[a-z]{2}$")
    moods: list[str] = Field(default_factory=list, max_length=8)
    year_min: int | None = Field(default=None, ge=1870, le=2200)
    year_max: int | None = Field(default=None, ge=1870, le=2200)
    runtime_min: int | None = Field(default=None, ge=1, le=1440)
    runtime_max: int | None = Field(default=None, ge=1, le=1440)
    runtime_scope: Literal["movie", "episode"] = "movie"
    required_providers: list[str] = Field(default_factory=list, max_length=8)
    exclusions: list[str] = Field(default_factory=list, max_length=12)
    like_anchors: list[str] = Field(default_factory=list, max_length=4)
    person_constraints: list[PersonConstraint] = Field(default_factory=list, max_length=3)
    rewatch_intent: bool = False
    requested_count: int = Field(default=5, ge=1, le=20)
    suggested_titles: list[str] = Field(max_length=30)
    rationale: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def ordered_ranges(self):
        for lower, upper in ((self.year_min, self.year_max), (self.runtime_min, self.runtime_max)):
            if lower is not None and upper is not None and lower > upper:
                raise ValueError("Minimum cannot exceed maximum")
        for values in (
            self.genres,
            self.moods,
            self.required_providers,
            self.exclusions,
            self.like_anchors,
            self.suggested_titles,
        ):
            if any(not value.strip() or len(value) > 255 for value in values):
                raise ValueError("Empty or oversized constraint")
        return self


class RelevanceMatch(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    title_id: str
    relevance: int = Field(ge=0, le=100)
    reason: str = Field(min_length=1, max_length=240)


class RelevanceResponse(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    matches: list[RelevanceMatch] = Field(max_length=80)
