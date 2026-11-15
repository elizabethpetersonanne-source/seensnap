"""Viewer-owned, factual recommendation copy. No model calls or extra queries.

Use the same current evidence as SceneDNA, but explain an actual title-to-title
connection. A save is interest, not proof of enjoyment; broad format/language
overlap alone is not a personal recommendation. Never infer mood from a genre.
"""
from collections import defaultdict
from app.services.taste_semantics import semantic_similarity


def action_phrase(signal, title):
    if signal.kind == "rating" and signal.rating is not None:
        return f"You rated {title.title} {signal.rating:g}/10"
    if signal.kind == "rank" and signal.rank is not None:
        return f"{title.title} is your #{signal.rank} pick"
    if signal.kind == "save":
        return f"You saved {title.title}"
    if signal.kind == "interest":
        return f"You swiped right on {title.title}"
    return None


def metadata_labels(title):
    meta = title.metadata_raw if isinstance(title.metadata_raw, dict) else {}
    credits = meta.get("credits") or {}
    credits = credits if isinstance(credits, dict) else {}
    keywords = meta.get("keywords") or {}
    if isinstance(keywords, dict):
        keywords = keywords.get("keywords", keywords.get("results", []))
    def names(rows, prefix=""):
        return {prefix + str(r["id"]): r["name"].strip() for r in rows if
                isinstance(r, dict) and type(r.get("id")) is int and
                isinstance(r.get("name"), str) and r["name"].strip()}
    cast = credits.get("cast") or []
    crew = credits.get("crew") or []
    return {
        "actors": names(cast if isinstance(cast, list) else []),
        "directors": names([r for r in crew if isinstance(r, dict) and r.get("job") == "Director"]
                           if isinstance(crew, list) else []),
        "exemplars": names(keywords if isinstance(keywords, list) else [], "keyword:"),
        "genres": {g.strip().casefold(): g.strip() for g in title.genres or [] if isinstance(g, str) and g.strip()},
    }


class PersonalReasons:
    def __init__(self, scorer, titles):
        self.scorer, self.titles = scorer, titles
        self.index = defaultdict(set)
        self.semantic_affinity = defaultdict(float)
        self.labels = {}
        self.connections = {}
        for key, signal in scorer.evidence.items():
            for dim in ("directors", "actors", "exemplars", "genres"):
                for attr, weight in scorer.features.get(key, {}).get(dim, {}).items():
                    if dim == "exemplars":
                        self.semantic_affinity[attr] += weight * signal.utility * signal.boost
                    if signal.utility > 0 and key in titles and action_phrase(signal, titles[key]):
                        self.index[dim, attr].add(key)

    def connection(self, title, features):
        if title.id in self.connections:
            return self.connections[title.id]
        labels = metadata_labels(title)
        options = []
        for dim, specificity in (("directors", 4), ("exemplars", 3), ("actors", 2)):
            for attr in features.get(dim, {}):
                name = labels[dim].get(attr)
                affinity = (self.semantic_affinity[attr] if dim == "exemplars" else
                            self.scorer.attribute_sum[dim, attr])
                if not name or affinity <= 0:
                    continue
                for key in self.index[dim, attr]:
                    if key == title.id:
                        continue
                    signal = self.scorer.evidence[key]
                    anchor = self.titles[key]
                    # Require the same named TMDB identity in both titles, not
                    # a free-text coincidence or an inferred semantic label.
                    if key not in self.labels:
                        self.labels[key] = metadata_labels(anchor)
                    if attr not in self.labels[key][dim]:
                        continue
                    other = self.scorer.features.get(key, {})
                    theme_overlap = semantic_similarity(features.get("exemplars", {}), other.get("exemplars", {}))
                    if dim == "exemplars" and not theme_overlap:
                        continue
                    strength = .6 * theme_overlap
                    for dimension, weight in (("directors", .25), ("actors", .15)):
                        a, b = set(features.get(dimension, {})), set(other.get(dimension, {}))
                        if a and b:
                            strength += weight * len(a & b) / len(a | b)
                    options.append((strength * signal.utility * signal.boost, specificity, str(key), dim, name, key))
        if not options:
            self.connections[title.id] = None
            return None
        strength, _, _, dim, name, key = max(options)
        action = action_phrase(self.scorer.evidence[key], self.titles[key])
        connection = {
            "directors": f"This is also directed by {name}.",
            "actors": f"This also stars {name}.",
            "exemplars": f"What they share: {name}.",
        }[dim]
        result = {"anchor": str(key), "strength": strength, "dimension": dim,
                  "text": f"{action}. {connection}"}
        self.connections[title.id] = result
        return result

    def for_title(self, title, features):
        connection = self.connection(title, features)
        return connection["text"] if connection else None

    def from_seed(self, seed_id):
        signal = self.scorer.evidence.get(seed_id)
        title = self.titles.get(seed_id)
        if signal is None or signal.utility <= 0 or title is None:
            return None
        action = action_phrase(signal, title)
        # Retrieval provenance supports 'recommended from', but not a claim
        # that two films share a specific mood or story without metadata.
        return f"{action}. A recommendation from that title." if action else None

    def fallback(self):
        if self.scorer.evidence:
            return "A change of pace to help us learn what else you enjoy."
        return "An early pick while we get to know your taste."
