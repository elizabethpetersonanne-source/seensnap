"""Conservative theme evidence shared by retrieval, scoring and explanations.

TMDB keywords include production facts, locations and broad descriptors as well
as story themes. A shared label is not automatically a useful taste connection.
These rules are a versioned heuristic, not learned semantic understanding.
"""

# Keep descriptive metadata intact on ContentTitle. Only exclude it from taste
# evidence; e.g. enjoying one sequel does not imply enjoying unrelated sequels.
WEAK_KEYWORDS = frozenset({
    "sequel", "prequel", "remake", "reboot", "spin off", "spin-off", "adaptation",
    "franchise", "short film", "independent film", "independent movie", "low budget",
    "woman director", "female director", "directorial debut", "aftercreditsstinger",
    "duringcreditsstinger", "post credits scene", "3d", "imax", "black and white",
    "friendship", "love", "family", "relationship", "relationships", "life", "death",
    "intense", "ambiguous", "emotional", "dramatic", "suspenseful", "dark", "light",
    "funny", "sad", "happy", "inspiring", "inspirational", "feel good", "feel-good",
    "new york city", "new york", "los angeles, california", "los angeles",
    "san francisco, california", "chicago, illinois", "london, england", "london",
    "paris, france", "paris", "tokyo, japan", "tokyo", "united states", "usa",
})
WEAK_PREFIXES = ("based on ", "adapted from ", "remake of ", "sequel to ",
                 "prequel to ", "spin-off of ", "spin off of ")


def personal_keyword(row):
    if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] <= 0:
        return False
    name = row.get("name")
    # Unlabelled IDs cannot be checked for production/setting-only metadata.
    if not isinstance(name, str) or not name.strip():
        return False
    name = " ".join(name.casefold().split())
    return name not in WEAK_KEYWORDS and not name.startswith(WEAK_PREFIXES)


def semantic_similarity(a, b):
    """Require meaningful overlap, not one incidental tag among many.

    A single shared theme needs >=20% weighted overlap; multiple themes need
    >=10%. Strong sparse matches remain useful, but dozens of weak overlaps
    across a large library cannot accumulate into a claimed strong match.
    """
    shared = set(a) & set(b)
    if not shared:
        return 0.0
    union = set(a) | set(b)
    total = sum(max(a.get(k, 0), b.get(k, 0)) for k in union)
    overlap = sum(min(a[k], b[k]) for k in shared) / total if total else 0.0
    return overlap if overlap + 1e-9 >= (0.2 if len(shared) == 1 else 0.1) else 0.0
