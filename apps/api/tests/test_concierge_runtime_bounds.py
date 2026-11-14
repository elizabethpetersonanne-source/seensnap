"""Live acceptance regressions: strict duration wording and empty results."""
from uuid import uuid4

import pytest

from app.models.content import ContentTitle
from app.services import concierge
from app.services.concierge_contract import explicit_runtime_bounds
from app.services.concierge_refinement import refine_constraints


@pytest.mark.parametrize("prompt,upper,lower", [
    ("Comedies under 90 minutes", 89, None),
    ("Comedies less than 90 mins", 89, None),
    ("A film shorter than 1.5 hours", 89, None),
    ("A film under 1 hour and 30 minutes", 89, None),
    ("A movie up to 90 minutes", 90, None),
    ("A film no more than 90 min", 90, None),
    ("A film at most 1.5 hours", 90, None),
    ("Movies over 90 minutes", None, 91),
    ("At least 90 minutes", None, 90),
    ("More than 1 hour but under 90 minutes", 89, 61),
])
def test_explicit_duration_enforced_at_the_title_boundary(prompt, upper, lower):
    c = concierge._constraints_from_raw(
        {"media_type": "movie", "suggested_titles": []}, prompt,
    )
    assert (c.runtime_max, c.runtime_min) == (upper, lower)
    for runtime in (60, 61, 89, 90, 91, None):
        row = ContentTitle(id=uuid4(), content_type="movie", runtime_minutes=runtime)
        expected = runtime is not None and (upper is None or runtime <= upper) and (lower is None or runtime >= lower)
        assert concierge._passes_constraints(row, c) == expected


def test_model_cannot_relax_under_90_to_90_and_already_strict_bound_is_not_reduced_twice():
    for model_limit in (90, 89):
        c = concierge._constraints_from_raw(
            {"media_type": "movie", "runtime_max": model_limit, "suggested_titles": []},
            "Comedy movies under 90 minutes on Netflix",
        )
        assert c.runtime_max == 89


def test_negated_or_non_duration_words_do_not_create_a_runtime_filter():
    assert explicit_runtime_bounds("Movies not under 90 minutes") == {}
    assert explicit_runtime_bounds("Movies under 90 dollars from the 90s") == {}


def test_followup_duration_is_exact_even_when_model_omits_it(monkeypatch):
    monkeypatch.setattr(concierge, "_call_configured_model", lambda *a, **kw: {"updates": {}})
    current = concierge.ConciergeConstraints(runtime_max=120, genres=["comedy"], required_providers=["netflix"])
    strict = refine_constraints(None, current, "Actually under 90 minutes", [])
    assert strict.runtime_max == 89
    assert strict.genres == ["comedy"] and strict.required_providers == ["netflix"]
    inclusive = refine_constraints(None, strict, "Up to 90 minutes is fine", [])
    assert inclusive.runtime_max == 90 and current.runtime_max == 120


def test_empty_result_does_not_repeat_unverified_model_selection_claim(monkeypatch):
    monkeypatch.setattr(concierge.settings, "concierge_ai_provider", "vertex")
    monkeypatch.setattr(concierge, "build_personal_context", lambda *a: concierge.PersonalContext())
    monkeypatch.setattr(concierge, "_call_configured_model", lambda *a, **kw: {
        "media_type": "any", "suggested_titles": [],
        "rationale": "Selected these titles from your highly-rated favorites.",
    })
    monkeypatch.setattr(concierge, "_retrieve_candidates", lambda *a, **kw: concierge.RetrievalResult([], True))
    result = concierge.resolve_concierge_decision(None, uuid4(), "Help me choose from one of my saved lists.")
    assert result.status == "empty" and result.status_detail == "needs_list_selection"
    assert result.title_ids == [] and result.rationale == ""
