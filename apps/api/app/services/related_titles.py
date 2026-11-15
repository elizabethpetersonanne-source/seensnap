"""Keep More Like This anchored to its source title, then personalize the choices."""
from app.services.title_compatibility import scorer_for_user, title_features
from app.services import taste_candidates as taste
from app.services.concierge_runtime import request_runtime


def rank_related_titles(db, user_id, source, candidates, limit=10):
    rows = list({t.id: t for t in candidates if t.id != source.id and t.poster_url}.values())
    _, seeds, negatives, _ = taste.history(db, user_id, "movie" if source.content_type == "movie" else "show")
    with request_runtime("related-style", seconds=14):
        taste.prepare_evidence(db, rows[:20], seeds=seeds[:3], negatives=negatives,
            anchors=[source], region=taste.region_for(db, user_id), limit=26, metadata=False)
    scorer = scorer_for_user(db, user_id, rows)
    seed = title_features(source)
    ranked = []
    for title in rows:
        signal = scorer.evidence.get(title.id)
        if signal and signal.utility < 0:
            continue
        features = scorer.candidate_features[title.id]
        relevance = taste.similarity_strength(seed, features)
        if not relevance:
            continue
        match = scorer.score(title)
        if taste.personal.conflicts_with_taste(match):
            continue
        ranked.append((title, relevance, match.score if match.score is not None else 50))
    ranked.sort(key=lambda item: (-round(item[1], 1), -item[2], str(item[0].id)))
    db.commit()  # Persist the reusable public-title descriptions.
    return [item[0] for item in ranked[:limit]]
