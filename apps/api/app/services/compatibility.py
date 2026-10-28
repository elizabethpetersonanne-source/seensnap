from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from itertools import combinations
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import Rating, TeamActivity, TeamMember, TeamRanking, TeamTitle, Watchlist, WatchlistItem
from app.models.taste import CompatibilityScore, TeamAnalyticsSnapshot
from app.models.user import UserProfile
from app.schemas.taste import CompatibilityResponse, TeamAnalyticsResponse, TeamAnalyticsGenreBreakdownResponse, TeamAnalyticsPairResponse, TeamAnalyticsPersonResponse, TasteTitleReferenceResponse
from app.services.taste import get_taste_profile


def refresh_compatibility(db: Session, user_a: UUID, user_b: UUID) -> CompatibilityScore:
    first, second = sorted([user_a, user_b], key=str)
    record = db.scalar(
        select(CompatibilityScore).where(CompatibilityScore.user_a_id == first, CompatibilityScore.user_b_id == second)
    )
    if record is None:
        record = CompatibilityScore(user_a_id=first, user_b_id=second, compatibility=0)
        db.add(record)
        db.flush()

    profile_a = get_taste_profile(db, first)
    profile_b = get_taste_profile(db, second)

    genres_a = {item["genre"]: int(item["score"]) for item in profile_a.top_genres or []}
    genres_b = {item["genre"]: int(item["score"]) for item in profile_b.top_genres or []}
    shared_genres = sorted(set(genres_a).intersection(genres_b), key=lambda g: min(genres_a[g], genres_b[g]), reverse=True)

    labels_a = {item["label"] for item in profile_a.taste_labels or []}
    labels_b = {item["label"] for item in profile_b.taste_labels or []}
    shared_labels = sorted(labels_a.intersection(labels_b))

    platforms_a = set(profile_a.top_platforms or [])
    platforms_b = set(profile_b.top_platforms or [])
    shared_platforms = sorted(platforms_a.intersection(platforms_b))

    shared_titles = _shared_titles(db, first, second)

    genre_score = sum(min(genres_a[g], genres_b[g]) for g in shared_genres[:3]) / 3 if shared_genres else 0
    title_score = min(len(shared_titles) * 18, 36)
    label_score = min(len(shared_labels) * 12, 24)
    platform_score = min(len(shared_platforms) * 6, 12)
    # Oct-27 spec DNA-01: no arbitrary positive floor when evidence is
    # absent. Clamp only on the upper end; let a thin-evidence pair
    # read 0, and let the response serializer decide to show the
    # number vs the "Still learning your taste" state.
    compatibility = min(99, int(round(genre_score * 0.35 + title_score + label_score + platform_score)))

    record.compatibility = compatibility
    record.shared_genres = shared_genres[:3]
    record.shared_titles = shared_titles[:4]
    record.shared_labels = shared_labels[:4]
    record.shared_platforms = shared_platforms[:3]
    record.summary = _compatibility_summary(shared_genres, shared_labels, shared_platforms)
    record.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(record)
    return record


def get_compatibility(db: Session, user_a: UUID, user_b: UUID, *, force_refresh: bool = False) -> CompatibilityScore:
    first, second = sorted([user_a, user_b], key=str)
    record = db.scalar(
        select(CompatibilityScore).where(CompatibilityScore.user_a_id == first, CompatibilityScore.user_b_id == second)
    )
    if record is None or force_refresh or _is_stale(record.updated_at, hours=24):
        return refresh_compatibility(db, user_a, user_b)
    return record


def to_compatibility_response(record: CompatibilityScore, viewer_user_id: UUID, other_user_id: UUID) -> CompatibilityResponse:
    # Oct-27 spec DNA-01: return null when evidence is absent so the
    # client can show "Still learning your taste" instead of a
    # fabricated number. Evidence = at least one shared genre, title,
    # label or platform.
    has_evidence = bool(
        (record.shared_genres or [])
        or (record.shared_titles or [])
        or (record.shared_labels or [])
        or (record.shared_platforms or [])
    )
    compat: int | None = record.compatibility if has_evidence else None
    return CompatibilityResponse(
        user_a=viewer_user_id,
        user_b=other_user_id,
        compatibility=compat,
        top_shared_genres=record.shared_genres or [],
        top_shared_titles=[TasteTitleReferenceResponse(**item) for item in (record.shared_titles or [])],
        shared_labels=record.shared_labels or [],
        shared_platforms=record.shared_platforms or [],
        summary=record.summary,
        updated_at=record.updated_at,
    )


def refresh_team_analytics(db: Session, team_id: UUID) -> TeamAnalyticsSnapshot:
    snapshot = db.scalar(select(TeamAnalyticsSnapshot).where(TeamAnalyticsSnapshot.team_id == team_id))
    if snapshot is None:
        snapshot = TeamAnalyticsSnapshot(team_id=team_id)
        db.add(snapshot)
        db.flush()

    members = db.execute(
        select(TeamMember, UserProfile)
        .join(UserProfile, UserProfile.user_id == TeamMember.user_id)
        .where(TeamMember.team_id == team_id, TeamMember.status == "active")
        .order_by(TeamMember.joined_at.asc())
    ).all()
    member_ids = [member.user_id for member, _ in members]
    profiles = {member.user_id: profile for member, profile in members}

    pair_records = []
    member_scores: defaultdict[UUID, list[int]] = defaultdict(list)
    for first, second in combinations(member_ids, 2):
        record = get_compatibility(db, first, second)
        pair_records.append(record)
        member_scores[first].append(record.compatibility)
        member_scores[second].append(record.compatibility)

    avg_compat = int(round(sum(item.compatibility for item in pair_records) / len(pair_records))) if pair_records else 0
    strongest = max(pair_records, key=lambda item: item.compatibility, default=None)
    weakest_member_id = min(
        member_scores,
        key=lambda user_id: sum(member_scores[user_id]) / len(member_scores[user_id]),
        default=None,
    )

    team_titles = db.execute(
        select(TeamTitle, ContentTitle)
        .join(ContentTitle, ContentTitle.id == TeamTitle.content_title_id)
        .where(TeamTitle.team_id == team_id)
    ).all()
    title_refs = {
        title.id: {"title_id": str(title.id), "title_name": title.title, "poster_url": title.poster_url}
        for _, title in team_titles
    }

    ranking_rows = db.execute(
        select(TeamRanking, ContentTitle)
        .join(ContentTitle, ContentTitle.id == TeamRanking.content_title_id)
        .where(TeamRanking.team_id == team_id)
        .order_by(TeamRanking.score.desc(), TeamRanking.rank.asc())
    ).all()
    most_loved = ranking_rows[0][1] if ranking_rows else None
    most_divisive = _most_divisive_title(db, team_id, member_ids)
    genre_breakdown = _genre_breakdown(team_titles)
    activity_snapshot = _activity_snapshot(db, team_id, member_ids)
    taste_mvp = _taste_mvp(db, team_id, member_ids, profiles)

    snapshot.member_ids = [str(item) for item in member_ids]
    snapshot.average_compatibility = avg_compat
    snapshot.most_aligned_pair = _pair_payload(strongest, profiles) if strongest is not None else {}
    snapshot.most_divisive_member = _person_payload(weakest_member_id, profiles, member_scores) if weakest_member_id is not None else {}
    snapshot.taste_mvp = taste_mvp
    snapshot.most_loved_title = title_refs.get(most_loved.id, {}) if most_loved is not None else {}
    snapshot.most_divisive_title = most_divisive
    snapshot.genre_breakdown = genre_breakdown
    snapshot.activity_snapshot = activity_snapshot
    snapshot.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(snapshot)
    return snapshot


def get_team_analytics(db: Session, team_id: UUID, *, force_refresh: bool = False) -> TeamAnalyticsSnapshot:
    snapshot = db.scalar(select(TeamAnalyticsSnapshot).where(TeamAnalyticsSnapshot.team_id == team_id))
    if snapshot is None or force_refresh or _is_stale(snapshot.updated_at, hours=24):
        return refresh_team_analytics(db, team_id)
    return snapshot


def to_team_analytics_response(snapshot: TeamAnalyticsSnapshot) -> TeamAnalyticsResponse:
    aligned_members = [TeamAnalyticsPersonResponse(**item) for item in snapshot.most_aligned_pair.get("members", [])]
    most_divisive_member = TeamAnalyticsPersonResponse(**snapshot.most_divisive_member) if snapshot.most_divisive_member else None
    taste_mvp = TeamAnalyticsPersonResponse(**snapshot.taste_mvp) if snapshot.taste_mvp else None
    loved_title = TasteTitleReferenceResponse(**snapshot.most_loved_title) if snapshot.most_loved_title else None
    divisive_title = TasteTitleReferenceResponse(**snapshot.most_divisive_title) if snapshot.most_divisive_title else None
    return TeamAnalyticsResponse(
        team_id=snapshot.team_id,
        average_compatibility=snapshot.average_compatibility,
        most_aligned_members=TeamAnalyticsPairResponse(
            members=aligned_members,
            compatibility=snapshot.most_aligned_pair.get("compatibility", 0),
            summary=snapshot.most_aligned_pair.get("summary"),
        ),
        most_divisive_member=most_divisive_member,
        taste_mvp=taste_mvp,
        most_loved_title=loved_title,
        most_divisive_title=divisive_title,
        genre_breakdown=[TeamAnalyticsGenreBreakdownResponse(**item) for item in (snapshot.genre_breakdown or [])],
        activity_snapshot=snapshot.activity_snapshot or {},
        updated_at=snapshot.updated_at,
    )


def _shared_titles(db: Session, user_a: UUID, user_b: UUID) -> list[dict]:
    """PRIV01: shared evidence must respect audience. Rating-based
    overlap is safe to surface — ratings are personal state and the
    SHARED fact alone doesn't leak either user's individual score.
    List-based overlap is NOT safe when either side's list is
    private: naming a title would disclose both users saved it to
    somewhere, which can leak the viewer's private list membership
    to the other user and vice versa.

    Resolve by: only rating-based shared titles for compat
    explanation. Dropping the saved-list fallback is deliberate per
    the Oct-27 personalization brief.
    """
    rated_a = db.execute(
        select(ContentTitle)
        .join(Rating, Rating.content_title_id == ContentTitle.id)
        .where(Rating.user_id == user_a, Rating.score >= 7.5)
    ).scalars().all()
    rated_b = db.execute(
        select(ContentTitle)
        .join(Rating, Rating.content_title_id == ContentTitle.id)
        .where(Rating.user_id == user_b, Rating.score >= 7.5)
    ).scalars().all()
    shared_by_id = {title.id: title for title in rated_a if title.id in {other.id for other in rated_b}}
    return [
        {"title_id": str(title.id), "title_name": title.title, "poster_url": title.poster_url}
        for title in list(shared_by_id.values())[:4]
    ]


def _compatibility_summary(shared_genres: list[str], shared_labels: list[str], shared_platforms: list[str]) -> str | None:
    if shared_genres and shared_labels:
        return f"You both lean toward {shared_genres[0].lower()} and share a {shared_labels[0].lower()} streak."
    if shared_genres:
        return f"You both show strong overlap in {shared_genres[0].lower()} taste."
    if shared_platforms:
        return f"You overlap most clearly around what you watch on {shared_platforms[0]}."
    return "Your taste graphs still connect through a few early overlaps."


def _pair_payload(record: CompatibilityScore, profiles: dict[UUID, UserProfile]) -> dict:
    return {
        "members": [
            _person_payload(record.user_a_id, profiles, None),
            _person_payload(record.user_b_id, profiles, None),
        ],
        "compatibility": record.compatibility,
        "summary": record.summary,
    }


def _person_payload(user_id: UUID, profiles: dict[UUID, UserProfile], member_scores: defaultdict[UUID, list[int]] | None) -> dict:
    profile = profiles.get(user_id)
    avg_score = None
    if member_scores is not None and member_scores.get(user_id):
        avg_score = int(round(sum(member_scores[user_id]) / len(member_scores[user_id])))
    return {
        "user_id": str(user_id),
        "display_name": profile.display_name if profile else None,
        "avatar_url": profile.avatar_url if profile else None,
        "score": avg_score,
        "detail": None,
    }


def _genre_breakdown(team_titles: list[tuple[TeamTitle, ContentTitle]]) -> list[dict]:
    counts = Counter()
    total = 0
    for _, title in team_titles:
        for genre in title.genres or []:
            counts[genre] += 1
            total += 1
    if total == 0:
        return []
    return [
        {"genre": genre, "percent": int(round(count / total * 100))}
        for genre, count in counts.most_common(4)
    ]


def _activity_snapshot(db: Session, team_id: UUID, member_ids: list[UUID]) -> dict:
    counts = Counter(
        db.scalars(select(TeamActivity.activity_type).where(TeamActivity.team_id == team_id)).all()
    )
    member_activity = Counter(
        db.scalars(select(TeamActivity.actor_user_id).where(TeamActivity.team_id == team_id)).all()
    )
    most_active_user = member_activity.most_common(1)[0][0] if member_activity else None
    return {
        "posts": counts.get("team_post", 0),
        "title_adds": counts.get("title_added", 0),
        "member_joins": counts.get("member_joined", 0),
        "most_active_user_id": str(most_active_user) if most_active_user else None,
    }


def _taste_mvp(db: Session, team_id: UUID, member_ids: list[UUID], profiles: dict[UUID, UserProfile]) -> dict:
    if not member_ids:
        return {}
    title_adds = Counter(
        db.execute(select(TeamTitle.added_by_user_id).where(TeamTitle.team_id == team_id)).scalars().all()
    )
    activity = Counter(
        db.execute(select(TeamActivity.actor_user_id).where(TeamActivity.team_id == team_id)).scalars().all()
    )
    best_user = max(member_ids, key=lambda user_id: title_adds.get(user_id, 0) * 2 + activity.get(user_id, 0), default=None)
    if best_user is None:
        return {}
    detail = f"{title_adds.get(best_user, 0)} title adds and {activity.get(best_user, 0)} team actions"
    payload = _person_payload(best_user, profiles, None)
    payload["detail"] = detail
    return payload


def _most_divisive_title(db: Session, team_id: UUID, member_ids: list[UUID]) -> dict:
    if not member_ids:
        return {}
    title_ids = db.scalars(select(TeamTitle.content_title_id).where(TeamTitle.team_id == team_id)).all()
    if not title_ids:
        return {}
    ratings = db.execute(
        select(Rating.content_title_id, func.max(Rating.score) - func.min(Rating.score), ContentTitle.title, ContentTitle.poster_url)
        .join(ContentTitle, ContentTitle.id == Rating.content_title_id)
        .where(Rating.user_id.in_(member_ids), Rating.content_title_id.in_(title_ids))
        .group_by(Rating.content_title_id, ContentTitle.title, ContentTitle.poster_url)
        .order_by((func.max(Rating.score) - func.min(Rating.score)).desc())
        .limit(1)
    ).first()
    if ratings is None:
        return {}
    title_id, _, title_name, poster_url = ratings
    return {"title_id": str(title_id), "title_name": title_name, "poster_url": poster_url}


def _is_stale(updated_at: datetime | None, *, hours: int) -> bool:
    if updated_at is None:
        return True
    return (datetime.now(timezone.utc) - updated_at).total_seconds() > hours * 3600
