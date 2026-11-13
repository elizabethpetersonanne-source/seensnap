"""Versioned beta baseline, not a calibrated probability of enjoying a title."""

from types import MappingProxyType

SCORE_VERSION = "scenedna_title_v2"
WEIGHTS = MappingProxyType(
    {
        "exemplars": 28,
        "genres": 20,
        "actors": 12,
        "decade": 10,
        "format": 7,
        "language": 7,
        "directors": 6,
        "writers": 4,
        "services": 3,
        "studios": 3,
    }
)
RATING_UTILITY = MappingProxyType(
    {1: -1.0, 2: -0.75, 3: -0.5, 4: -0.25, 5: 0.0, 6: 0.0, 7: 0.25, 8: 0.5, 9: 0.75, 10: 1.0}
)
DISPLAY_MIN_RATINGS = 5
DISPLAY_MIN_COVERAGE = 0.35
CONFIDENCE_FULL_TITLES = 12
AFFINITY_PRIOR = 2.0
