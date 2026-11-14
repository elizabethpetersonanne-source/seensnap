"""Keep More Like This anchored to its source title, then personalize the choices."""
from app.services.title_compatibility import scorer_for_user, title_features


def rank_related_titles(db, user_id, source, candidates, limit=10):
    rows = list({t.id: t for t in candidates if t.id != source.id and t.poster_url}.values())
    scorer = scorer_for_user(db, user_id, rows)
    seed = title_features(source)
    ranked = []
    for title in rows:
        signal = scorer.evidence.get(title.id)
        if signal and signal.utility < 0:
            continue
        features = scorer.candidate_features[title.id]
        relevance = 0.0
        comparable = False
        for dimension, weight in (("exemplars", 4), ("genres", 2), ("directors", 2), ("actors", 1)):
            left, right = set(seed[dimension]), set(features[dimension])
            if left and right:
                comparable = True
                relevance += weight * len(left & right) / len(left | right)
        # When both titles have metadata, don't call an unrelated title similar.
        # With sparse metadata the TMDB relationship remains the retrieval evidence.
        if comparable and relevance == 0:
            continue
        match = scorer.score(title)
        ranked.append((title, relevance, match.score if match.score is not None else 50))
    ranked.sort(key=lambda item: (-round(item[1], 1), -item[2], str(item[0].id)))
    return [item[0] for item in ranked[:limit]]
