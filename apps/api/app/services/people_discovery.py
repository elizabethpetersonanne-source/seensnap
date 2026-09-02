"""People discovery — recommendation service per People Discovery spec §9.

Blends real signals already available in SeenSnap (shared Watch Teams,
mutual follows, taste overlap via UserSignal, recent activity, profile
quality) into ranked candidate lists per section. Never fabricates a
relationship: the reason attached to each card is derived from the same
evidence used to qualify it.

Every candidate passes an eligibility gate (§8) before ranking:
  - not self
  - not blocked either way
  - not discovery-disabled
  - not already followed (for sections that suggest new follows)
  - not dismissed in the last 30 days
  - candidate has a usable profile

The service is intentionally cache-light for MVP — Cloud Run cold starts
+ a small alpha user population mean queries stay cheap. Add a
`people_discovery_cache` table later if profile size or query cost grows.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session

from app.models.social import Block, PeopleDismissal, UserFollow
from app.models.taste import UserSignal
from app.models.user import User, UserProfile
from app.services.teams import list_user_teams


# ─── Section identifiers ────────────────────────────────────────────────

SECTION_SUGGESTED = "suggested_for_you"
SECTION_WATCH_TEAMS = "from_your_watch_teams"
SECTION_MUTUAL_FOLLOWS = "followed_by_people_you_follow"
SECTION_NEW_ACTIVE = "new_and_active"

ALL_SECTIONS = (SECTION_SUGGESTED, SECTION_WATCH_TEAMS, SECTION_MUTUAL_FOLLOWS, SECTION_NEW_ACTIVE)

SECTION_TITLES: dict[str, str] = {
    SECTION_SUGGESTED: "Suggested for You",
    SECTION_WATCH_TEAMS: "From Your Watch Teams",
    SECTION_MUTUAL_FOLLOWS: "Followed by People You Follow",
    SECTION_NEW_ACTIVE: "New & Active",
}

# Reason codes — the client should never invent copy; it renders the
# server-returned safe label. Codes give the client structure to style by.
REASON_SHARED_TEAM = "shared_watch_team"
REASON_MUTUAL_FOLLOWS = "mutual_follows"
REASON_SIMILAR_TASTE = "similar_taste"
REASON_ACTIVE_NEW = "active_new"

# Signal weights per spec §9.1. Kept as module constants so a future
# config table can override them without touching this file.
W_SHARED_TEAM = 30
W_TASTE = 25
W_MUTUAL = 20
W_ACTIVITY = 5
W_PROFILE_QUALITY = 5

DISMISSAL_WINDOW = timedelta(days=30)


@dataclass
class CandidateReason:
    code: str
    label: str


@dataclass
class Candidate:
    user_id: UUID
    profile: UserProfile
    score: float
    reason: CandidateReason
    mutuals: list[str]  # display names, up to 3 for UI


# ─── Eligibility ────────────────────────────────────────────────────────


def _eligible_candidate_ids(
    db: Session,
    viewer_id: UUID,
    *,
    exclude_followed: bool = True,
) -> set[UUID]:
    """Return the set of user_ids that pass every eligibility filter
    from spec §8. Callers rank within this set.
    """
    now = datetime.now(timezone.utc)
    dismissal_cutoff = now - DISMISSAL_WINDOW

    # Start from every user with a profile marked discovery_enabled.
    base = db.execute(
        select(UserProfile.user_id).where(UserProfile.discovery_enabled.is_(True))
    ).all()
    ids: set[UUID] = {row[0] for row in base if row[0] != viewer_id}

    # Exclude demo users — never surface fake accounts to real users.
    demo_ids = set(
        db.scalars(select(User.id).where(User.is_demo.is_(True))).all()
    )
    ids -= demo_ids

    # Exclude blocks (both directions).
    blocks = db.execute(
        select(Block.blocker_user_id, Block.blocked_user_id).where(
            or_(
                Block.blocker_user_id == viewer_id,
                Block.blocked_user_id == viewer_id,
            )
        )
    ).all()
    for a, b in blocks:
        ids.discard(a)
        ids.discard(b)

    # Exclude recent dismissals.
    dismissed = db.scalars(
        select(PeopleDismissal.candidate_user_id).where(
            PeopleDismissal.viewer_user_id == viewer_id,
            PeopleDismissal.created_at >= dismissal_cutoff,
        )
    ).all()
    ids -= set(dismissed)

    if exclude_followed:
        following = db.scalars(
            select(UserFollow.following_user_id).where(
                UserFollow.follower_user_id == viewer_id
            )
        ).all()
        ids -= set(following)

    return ids


# ─── Section builders ───────────────────────────────────────────────────


def _shared_team_candidates(db: Session, viewer_id: UUID, eligible: set[UUID]) -> dict[UUID, tuple[float, CandidateReason, list[str]]]:
    """Returns candidate_id → (score, reason, mutuals). Score based on
    number of shared teams (bounded so one team doesn't dominate)."""
    from app.models.social import Team, TeamMember

    viewer_team_ids = {t.id for t, _ in list_user_teams(db, viewer_id)}
    if not viewer_team_ids:
        return {}

    rows = db.execute(
        select(TeamMember.user_id, Team.name)
        .join(Team, Team.id == TeamMember.team_id)
        .where(
            TeamMember.team_id.in_(viewer_team_ids),
            TeamMember.status == "active",
            TeamMember.user_id != viewer_id,
        )
    ).all()

    # user_id → { team_name, ... }
    per_user: dict[UUID, list[str]] = {}
    for uid, team_name in rows:
        if uid not in eligible:
            continue
        per_user.setdefault(uid, []).append(team_name)

    out: dict[UUID, tuple[float, CandidateReason, list[str]]] = {}
    for uid, teams in per_user.items():
        # Bounded score — 1 team = base weight, 2+ = +10% each, capped.
        multiplier = min(1.0 + 0.1 * (len(teams) - 1), 1.3)
        score = W_SHARED_TEAM * multiplier
        team_name = teams[0]  # name the first shared team truthfully
        label = f"Also in {team_name}" if len(teams) == 1 else f"In {len(teams)} of your Watch Teams"
        out[uid] = (score, CandidateReason(REASON_SHARED_TEAM, label), [])
    return out


def _mutual_follow_candidates(db: Session, viewer_id: UUID, eligible: set[UUID]) -> dict[UUID, tuple[float, CandidateReason, list[str]]]:
    """Second-degree connections — people followed by people the viewer
    follows. Score scales with the number of mutual followers."""
    # Who does the viewer follow?
    following_ids = set(
        db.scalars(
            select(UserFollow.following_user_id).where(
                UserFollow.follower_user_id == viewer_id
            )
        ).all()
    )
    if not following_ids:
        return {}

    # Who do THOSE users follow?
    rows = db.execute(
        select(UserFollow.follower_user_id, UserFollow.following_user_id).where(
            UserFollow.follower_user_id.in_(following_ids)
        )
    ).all()

    # candidate → set of mutual-follower user_ids
    per_candidate: dict[UUID, set[UUID]] = {}
    for follower_uid, followed_uid in rows:
        if followed_uid not in eligible or followed_uid == viewer_id:
            continue
        per_candidate.setdefault(followed_uid, set()).add(follower_uid)

    if not per_candidate:
        return {}

    # Fetch display names for the mutuals (limit N per candidate for UI).
    all_mutual_ids = {uid for uids in per_candidate.values() for uid in uids}
    name_rows = db.execute(
        select(UserProfile.user_id, UserProfile.display_name).where(
            UserProfile.user_id.in_(all_mutual_ids)
        )
    ).all()
    name_by_id: dict[UUID, str] = {uid: name or "someone" for uid, name in name_rows}

    out: dict[UUID, tuple[float, CandidateReason, list[str]]] = {}
    for candidate_uid, mutuals in per_candidate.items():
        n = len(mutuals)
        # log-ish scaling: 1 mutual = W_MUTUAL, 5 = ~1.4x, 20 = ~1.7x cap
        multiplier = min(1.0 + 0.1 * (n - 1), 1.7) if n > 1 else 1.0
        score = W_MUTUAL * multiplier
        names = sorted([name_by_id.get(m, "someone") for m in mutuals])
        # Reason label — 2 names + "+N others" per spec §6.2
        first_two = names[:2]
        if n <= 2:
            label = f"Followed by {' and '.join(first_two)}" if first_two else "Followed by people you follow"
        else:
            label = f"Followed by {', '.join(first_two)} +{n - 2}"
        out[candidate_uid] = (score, CandidateReason(REASON_MUTUAL_FOLLOWS, label), names[:3])
    return out


def _taste_similarity_candidates(db: Session, viewer_id: UUID, eligible: set[UUID]) -> dict[UUID, tuple[float, CandidateReason, list[str]]]:
    """Approximate taste overlap using UserSignal rows — count of
    (signal_type, signal_name) tuples that both viewer and candidate
    have with positive score. This is a coarse Jaccard-ish overlap;
    good enough for MVP without adding a vector store."""
    viewer_signals = db.execute(
        select(UserSignal.signal_type, UserSignal.signal_name, UserSignal.score).where(
            UserSignal.user_id == viewer_id,
            UserSignal.score > 0.3,
        )
    ).all()
    if not viewer_signals:
        return {}

    viewer_set = {(t, n) for t, n, _ in viewer_signals}
    # Small viewer_set = weak signal; skip taste section rather than
    # surfacing weakly-justified matches per spec §6.2 "Similar Taste
    # must not fall back to generic popular users".
    if len(viewer_set) < 3:
        return {}

    # Fetch every OTHER user's positive signals in one shot. On a small
    # alpha this is fine; add a vector table + ANN when it isn't.
    candidate_rows = db.execute(
        select(
            UserSignal.user_id,
            UserSignal.signal_type,
            UserSignal.signal_name,
        ).where(
            UserSignal.user_id.in_(eligible),
            UserSignal.score > 0.3,
        )
    ).all()

    per_user: dict[UUID, set[tuple[str, str]]] = {}
    for uid, stype, sname in candidate_rows:
        per_user.setdefault(uid, set()).add((stype, sname))

    out: dict[UUID, tuple[float, CandidateReason, list[str]]] = {}
    for uid, sig_set in per_user.items():
        overlap = viewer_set & sig_set
        if len(overlap) < 2:
            continue  # need at least 2 shared signals to make a claim
        # Jaccard similarity → 0..1
        jaccard = len(overlap) / len(viewer_set | sig_set)
        score = W_TASTE * min(jaccard * 3, 1.0)  # amplify but cap at full weight

        # Pick a truthful descriptor from the overlap for the reason label.
        # Prefer named 'label' signals (SlowBurn, PsychologicalThriller, …)
        # over raw genres because they read more human.
        labeled = sorted(overlap, key=lambda x: (0 if x[0] == "label" else 1, x[1]))
        first = labeled[0]
        descriptor = first[1]
        if len(overlap) >= 4:
            label = f"Similar taste — {descriptor} + {len(overlap) - 1} others"
        else:
            label = f"Similar taste in {descriptor}"
        out[uid] = (score, CandidateReason(REASON_SIMILAR_TASTE, label), [])
    return out


def _new_active_candidates(db: Session, viewer_id: UUID, eligible: set[UUID], *, limit: int = 20) -> dict[UUID, tuple[float, CandidateReason, list[str]]]:
    """Cold-start / diversity surface — users with a decent-looking
    public profile who are active. Ranked by rough profile completeness
    (has avatar + bio + at least one signal). Non-personalized but
    honestly labeled (§6.2)."""
    from sqlalchemy import case

    quality_score = (
        case((UserProfile.avatar_url.is_not(None), 2), else_=0)
        + case((UserProfile.bio.is_not(None), 1), else_=0)
    )
    rows = db.execute(
        select(
            UserProfile.user_id,
            quality_score.label("quality"),
        )
        .where(UserProfile.user_id.in_(eligible))
        .order_by(quality_score.desc(), UserProfile.updated_at.desc())
        .limit(limit)
    ).all()

    out: dict[UUID, tuple[float, CandidateReason, list[str]]] = {}
    for uid, quality in rows:
        # Only include reasonably-complete profiles in this fallback.
        if quality < 1:
            continue
        score = W_ACTIVITY + W_PROFILE_QUALITY * (quality / 3.0)
        out[uid] = (score, CandidateReason(REASON_ACTIVE_NEW, "Active on SeenSnap"), [])
    return out


# ─── Blend + hydrate ────────────────────────────────────────────────────


def _blend(
    parts: list[dict[UUID, tuple[float, CandidateReason, list[str]]]]
) -> dict[UUID, tuple[float, CandidateReason, list[str]]]:
    """Sum scores across sources per candidate. Keep the strongest reason
    (highest single-source score) for the label per spec §9.2 priority."""
    merged: dict[UUID, list[tuple[float, CandidateReason, list[str]]]] = {}
    for part in parts:
        for uid, entry in part.items():
            merged.setdefault(uid, []).append(entry)

    out: dict[UUID, tuple[float, CandidateReason, list[str]]] = {}
    for uid, entries in merged.items():
        total = sum(e[0] for e in entries)
        # Prefer the strongest by spec-priority order for the label.
        priority_order = {
            REASON_SHARED_TEAM: 0,
            REASON_MUTUAL_FOLLOWS: 1,
            REASON_SIMILAR_TASTE: 2,
            REASON_ACTIVE_NEW: 3,
        }
        entries_sorted = sorted(
            entries, key=lambda e: (priority_order.get(e[1].code, 99), -e[0])
        )
        _, best_reason, best_mutuals = entries_sorted[0]
        out[uid] = (total, best_reason, best_mutuals)
    return out


def _hydrate(
    db: Session,
    scored: dict[UUID, tuple[float, CandidateReason, list[str]]],
    *,
    limit: int,
) -> list[Candidate]:
    """Fetch profiles + assemble Candidate objects in ranked order."""
    if not scored:
        return []
    top_ids = sorted(scored.keys(), key=lambda uid: -scored[uid][0])[:limit]
    profiles = db.execute(
        select(UserProfile).where(UserProfile.user_id.in_(top_ids))
    ).all()
    by_id = {p[0].user_id: p[0] for p in profiles}

    out: list[Candidate] = []
    for uid in top_ids:
        profile = by_id.get(uid)
        if profile is None:
            continue
        score, reason, mutuals = scored[uid]
        out.append(Candidate(
            user_id=uid,
            profile=profile,
            score=score,
            reason=reason,
            mutuals=mutuals,
        ))
    return out


# ─── Public API ─────────────────────────────────────────────────────────


def get_section(
    db: Session,
    viewer_id: UUID,
    *,
    section: str,
    limit: int = 12,
) -> list[Candidate]:
    """Return the candidates for a single section, ranked and hydrated.
    Section == 'suggested_for_you' blends all sources."""
    eligible = _eligible_candidate_ids(db, viewer_id)
    if not eligible:
        return []

    if section == SECTION_WATCH_TEAMS:
        return _hydrate(db, _shared_team_candidates(db, viewer_id, eligible), limit=limit)
    if section == SECTION_MUTUAL_FOLLOWS:
        return _hydrate(db, _mutual_follow_candidates(db, viewer_id, eligible), limit=limit)
    if section == SECTION_NEW_ACTIVE:
        return _hydrate(db, _new_active_candidates(db, viewer_id, eligible, limit=limit * 2), limit=limit)
    # Default: suggested — blend all four sources.
    blended = _blend([
        _shared_team_candidates(db, viewer_id, eligible),
        _mutual_follow_candidates(db, viewer_id, eligible),
        _taste_similarity_candidates(db, viewer_id, eligible),
        _new_active_candidates(db, viewer_id, eligible, limit=limit * 2),
    ])
    return _hydrate(db, blended, limit=limit)


def get_all_sections(db: Session, viewer_id: UUID, *, per_section_limit: int = 8) -> list[dict]:
    """Return every non-empty section as { id, title, items } dicts —
    ready for the client's People screen. Sections with zero candidates
    are omitted (spec §6.2 — don't render five empty headings)."""
    out: list[dict] = []
    for section_id in ALL_SECTIONS:
        items = get_section(db, viewer_id, section=section_id, limit=per_section_limit)
        if not items:
            continue
        out.append({
            "id": section_id,
            "title": SECTION_TITLES[section_id],
            "items": [_candidate_to_dict(c) for c in items],
        })
    return out


def _candidate_to_dict(c: Candidate) -> dict:
    return {
        "user_id": str(c.user_id),
        "username": c.profile.username,
        "display_name": c.profile.display_name,
        "avatar_url": c.profile.avatar_url,
        "bio": c.profile.bio,
        "reason": {"code": c.reason.code, "label": c.reason.label},
        "mutuals": c.mutuals,
    }


def dismiss_candidate(db: Session, *, viewer_id: UUID, candidate_id: UUID) -> None:
    """Record a "Not interested" so this candidate is suppressed in
    suggestion sections for 30 days. Idempotent — repeated dismissals
    silently succeed."""
    if viewer_id == candidate_id:
        return
    existing = db.scalar(
        select(PeopleDismissal).where(
            PeopleDismissal.viewer_user_id == viewer_id,
            PeopleDismissal.candidate_user_id == candidate_id,
        )
    )
    if existing is not None:
        return
    from uuid import uuid4
    db.add(PeopleDismissal(
        id=uuid4(),
        viewer_user_id=viewer_id,
        candidate_user_id=candidate_id,
    ))
    db.commit()
