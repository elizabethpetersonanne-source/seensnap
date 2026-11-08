import pytest
from pydantic import ValidationError
from app.services.concierge import (
    ConciergeConstraints,
    _constraints_from_raw,
    _extract_json,
    _resolve_collection_scope,
    _passes_constraints,
)
from app.services.concierge_retrieval import validated_matches
from app.models.content import ContentTitle
from uuid import uuid4


@pytest.mark.parametrize("text", ["", "not JSON", "{}", "[1,2]", '{"media_type":'])
def test_bad_model_output_fails_closed(text):
    with pytest.raises(ValueError):
        _extract_json(text)


def test_json_braces_inside_strings_are_safe():
    assert (
        _extract_json('```json\n{"rationale":"a } character"}\n```')["rationale"] == "a } character"
    )


@pytest.mark.parametrize(
    "change",
    [
        {"media_type": "potato"},
        {"rewatch_intent": "false"},
        {"runtime_max": True},
        {"runtime_min": 100, "runtime_max": 90},
        {"genres": "comedy"},
    ],
)
def test_constraints_do_not_silently_drop_invalid_conditions(change):
    with pytest.raises(ValidationError):
        _constraints_from_raw({"media_type": "any", "suggested_titles": [], **change}, "test")


@pytest.mark.parametrize(
    "intent,scope",
    [
        ("Choose something from My Next Watch", "my_next_watch"),
        ("Pick from my picks", "my_next_watch"),
        ("Pick from my weekend list", "named_list"),
        ("Something from my favorite director", "any"),
        ("A comfort rewatch", "watched"),
    ],
)
def test_collection_intent_precedence(intent, scope):
    assert _resolve_collection_scope(ConciergeConstraints(), intent).collection_scope == scope


@pytest.mark.parametrize(
    "intent,count",
    [
        ("Surprise me", 5),
        ("Surprise me with one", 1),
        ("Pick one movie", 1),
        ("Suggest 12 movies", 12),
    ],
)
def test_explicit_count(intent, count):
    c = _constraints_from_raw(
        {"media_type": "movie", "suggested_titles": [], "requested_count": 1}, intent
    )
    assert c.requested_count == count


def test_every_result_must_clear_relevance_floor():
    rows = [ContentTitle(id=uuid4()) for _ in range(5)]
    result = validated_matches(
        {
            "matches": [
                {
                    "title_id": str(t.id),
                    "relevance": 90 if i == 0 else 20,
                    "reason": "Synopsis evidence",
                }
                for i, t in enumerate(rows)
            ]
        },
        rows,
    )
    assert [m.title_id for m in result] == [str(rows[0].id)]
    with pytest.raises(ValueError):
        validated_matches(
            {"matches": [{"title_id": str(uuid4()), "relevance": 99, "reason": "Invented"}]}, rows
        )


def test_actor_must_be_in_verified_credits():
    row = ContentTitle(
        id=uuid4(),
        title="Movie",
        content_type="movie",
        metadata_raw={"credits": {"cast": [{"id": 7}]}},
    )
    c = ConciergeConstraints(
        person_constraints=[{"name": "Actor", "role": "cast", "tmdb_person_id": 8}]
    )
    assert not _passes_constraints(row, c)
    c.person_constraints[0]["tmdb_person_id"] = 7
    assert _passes_constraints(row, c)


def test_series_is_not_a_short_movie():
    row = ContentTitle(
        id=uuid4(), title="Show", content_type="series", metadata_raw={"episode_run_time": [25]}
    )
    c = ConciergeConstraints(runtime_max=30)
    assert not _passes_constraints(row, c)
    c.runtime_scope = "episode"
    assert _passes_constraints(row, c)
