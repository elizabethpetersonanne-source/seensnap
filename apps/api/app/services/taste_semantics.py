"""Multi-axis viewing-style similarity; subject overlap is not taste evidence."""


def semantic_similarity(a, b):
    """Require the viewing experience to align on multiple independent axes.

    A subject (even two related plot keywords) is never a style match. Tone or
    humor must align together with at least one other axis. Missing style is
    unknown, not agreement. The threshold is a conservative heuristic.
    """
    shared = set(a) & set(b)
    axes = {key.split(":")[1] for key in shared if key.startswith("style:")}
    a_axes = {key.split(":")[1] for key in a if key.startswith("style:")}
    b_axes = {key.split(":")[1] for key in b if key.startswith("style:")}
    required = 3 if min(len(a_axes), len(b_axes)) >= 4 else 2
    if len(axes) < required or not axes.intersection({"tone", "humor"}) \
            or not axes.intersection({"humor", "story", "visual"}):
        return 0.0
    union = set(a) | set(b)
    total = sum(max(a.get(k, 0), b.get(k, 0)) for k in union)
    overlap = sum(min(a[k], b[k]) for k in shared) / total if total else 0.0
    return overlap if overlap + 1e-9 >= 0.15 else 0.0
