"""Apply a conversational turn to the existing validated search."""
from copy import deepcopy
from dataclasses import asdict
import json
import re
from app.services.concierge_contract import ConciergeIntent


def refine_constraints(db, current, prompt, titles):
    from app.services.concierge import _call_configured_model, _resolve_collection_scope, ConciergeConstraints
    from app.models.content import ContentTitle
    from uuid import UUID
    effective = deepcopy(current)
    source = _resolve_collection_scope(ConciergeConstraints(), prompt)
    if source.collection_scope != "any":
        effective.collection_scope = source.collection_scope
        effective.rewatch_intent = source.rewatch_intent
        if source.collection_scope != current.collection_scope:
            effective.collection_list_id = None
    # Ordinals refer to the server's last returned result order, never the
    # model's remembered titles. The explicit "More like this" chip supplies
    # the promoted hero UUID through the existing typed endpoint.
    ordinal = re.search(r"\b(?:more\s+)?like\s+(?:the\s+)?(first|second|third|fourth|fifth|[1-5])(?:\s+one)?\b", prompt.lower())
    if ordinal:
        number = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}.get(ordinal[1])
        number = number or int(ordinal[1])
        if number > len(titles):
            raise ValueError("Choose one of the titles in the current results.")
        anchor = db.get(ContentTitle, UUID(str(titles[number - 1])))
        if anchor is None:
            raise ValueError("That title is no longer available.")
        effective.like_anchors, effective.anchor_title_ids = [anchor.title], [str(anchor.id)]
        effective.anchor_evidence = []
        if prompt.strip().rstrip(".!?").lower() == ordinal[0]:
            return effective
        # Additional words can still refine the request; give the model the
        # resolved anchor rather than asking it to guess what "second" means.
        prompt = prompt[:ordinal.start()] + f"more like {anchor.title}" + prompt[ordinal.end():]
    values = asdict(effective)
    allowed = set(ConciergeIntent.model_fields) - {"suggested_titles", "rationale"}
    raw = _call_configured_model("", prompt_override=(
        'Update the current search using ONLY the follow-up. Return JSON {"updates":{}}. '
        'Include only fields the user actually changes. Omitted fields stay unchanged; null clears a scalar. '
        'Never reset genre, decade, services, language, duration, format or similarity unless requested. '
        'Replace mood/exclusion arrays when changed, retaining other compatible values. '
        'A lighter request should remove contradictory dark mood tags. '
        'Do not interpret "more like the second" as a person or title name; resolved anchors below are authoritative. '
        'Use original-language codes, not dubbing claims. No title IDs, collection IDs or region updates. '
        f'Allowed fields: {json.dumps(sorted(allowed))}\n'
        f'Field schema: {json.dumps(ConciergeIntent.model_json_schema())}\n'
        f'Current constraints: {json.dumps(values)}\nFollow-up: {json.dumps(prompt)}'
    ))
    updates = raw.get("updates")
    if not isinstance(updates, dict) or set(updates) - allowed:
        raise ValueError("Invalid refinement fields")
    merged = {key: value for key, value in values.items() if key in allowed}
    # Resolved people carry verified IDs internally; the provider contract
    # accepts only names/roles. Keep the internal IDs when unchanged.
    merged["person_constraints"] = [{"name": p["name"], "role": p.get("role", "cast")} for p in merged["person_constraints"]]
    merged.update(updates)
    validated = ConciergeIntent.model_validate({**merged, "suggested_titles": []}).model_dump()
    for field in updates:
        setattr(effective, field, validated[field])
    for field in ("genres", "moods", "exclusions"):
        setattr(effective, field, [value.strip().lower() for value in getattr(effective, field)])
    from app.services.tmdb import SUPPORTED_PROVIDER_ALIASES
    effective.required_providers = [SUPPORTED_PROVIDER_ALIASES.get(p.strip().lower(), (p.strip().lower().replace(" ", "_"), ""))[0] for p in effective.required_providers]
    if "like_anchors" in updates:
        effective.anchor_title_ids, effective.anchor_evidence = [], []
    return effective
