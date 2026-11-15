from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from itertools import combinations
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.social import RankedFavorite, Rating, TeamActivity, TeamMember, TeamRanking, TeamTitle, Watchlist, WatchlistItem
from app.models.team_state import TeamTitleState
from app.services.visibility import can_view_profile
from app.models.taste import CompatibilityScore, TeamAnalyticsSnapshot
from app.models.user import UserProfile
from app.schemas.taste import CompatibilityResponse, TeamAnalyticsResponse, TeamAnalyticsGenreBreakdownResponse, TeamAnalyticsPairResponse, TeamAnalyticsPersonResponse, TasteTitleReferenceResponse
from app.services.taste import get_taste_profile


def get_compatibilities(db: Session, viewer: UUID, candidates, *, force_refresh=False):
    """Batch pair reads/writes, versioned against BOTH users' current taste."""
    from app.models.user import User, UserPreferences
    from app.models.social import UserFollow
    from app.models.taste import UserTasteProfile
    from app.services.visibility import visible_profile_clause
    from sqlalchemy import or_, and_
    ids = set(candidates)
    if not ids:
        return {}
    users = dict(db.execute(select(User.id, User.taste_version).where(User.id.in_(ids | {viewer}))).all())
    pairs = or_(and_(CompatibilityScore.user_a_id == viewer, CompatibilityScore.user_b_id.in_(ids)),
                and_(CompatibilityScore.user_b_id == viewer, CompatibilityScore.user_a_id.in_(ids)))
    records = {r.user_b_id if r.user_a_id == viewer else r.user_a_id: r
        for r in db.scalars(select(CompatibilityScore).where(pairs)).all()}
    pending = []
    for other in ids:
        if other not in users or viewer not in users:
            continue
        first, second = sorted((viewer, other), key=str)
        cached = records.get(other)
        if force_refresh or cached is None or cached.user_a_version != users[first] or cached.user_b_version != users[second] or _is_stale(cached.updated_at, hours=12):
            pending.append(other)
    if not pending:
        return records
    needed = set(pending) | {viewer}
    # One profile build per person, one final commit for the whole batch.
    profiles = {uid: get_taste_profile(db, uid, commit=False) for uid in sorted(needed, key=str)}
    counts = dict(db.execute(select(Rating.user_id, func.count()).where(
        Rating.user_id.in_(needed), Rating.watched_state == "watched", Rating.score.is_not(None)
    ).group_by(Rating.user_id)).all())
    favorites = defaultdict(list)
    for owner, title in db.execute(select(RankedFavorite.user_id, ContentTitle)
        .join(ContentTitle, ContentTitle.id == RankedFavorite.content_title_id)
        .where(RankedFavorite.user_id.in_(needed)).order_by(RankedFavorite.position)):
        favorites[owner].append(title)
    visible = set(db.scalars(select(UserProfile.user_id).where(UserProfile.user_id.in_(needed),
        visible_profile_clause(UserProfile.user_id, viewer))).all())
    viewer_prefs = db.get(UserPreferences, viewer)
    audience = viewer_prefs.profile_visibility if viewer_prefs else "public"
    followers = set(db.scalars(select(UserFollow.follower_user_id).where(
        UserFollow.following_user_id == viewer, UserFollow.follower_user_id.in_(needed))).all())
    values = []
    started = datetime.now(timezone.utc)
    for other in pending:
        first, second = sorted((viewer, other), key=str)
        a, b = profiles[first], profiles[second]
        ga = {g["genre"]: max(0, min(100, int(g["score"]))) for g in a.top_genres or []}
        gb = {g["genre"]: max(0, min(100, int(g["score"]))) for g in b.top_genres or []}
        shared_genres = sorted(set(ga) & set(gb), key=lambda g: (-min(ga[g], gb[g]), g))[:3]
        shared_labels = sorted({g["label"] for g in a.taste_labels or []} & {g["label"] for g in b.taste_labels or []})[:4]
        shared_platforms = sorted(set(a.top_platforms or []) & set(b.top_platforms or []))[:3]
        shared_titles = []
        if other in visible and (other == viewer or audience == "public" or (audience == "followers" and other in followers)):
            mine = {t.id for t in favorites[viewer]}
            shared_titles = [{"title_id": str(t.id), "title_name": t.title, "poster_url": t.poster_url}
                for t in favorites[other] if t.id in mine][:4]
        genre_score = sum(min(ga[g], gb[g]) for g in shared_genres) / 3
        score = min(99, max(0, round(genre_score * .35 + min(len(shared_titles)*18, 36) + min(len(shared_labels)*12, 24))))
        values.append(dict(user_a_id=first, user_b_id=second, compatibility=score,
            user_a_version=users[first], user_b_version=users[second],
            rated_count_a=counts.get(first, 0), rated_count_b=counts.get(second, 0),
            shared_genres=shared_genres, shared_titles=shared_titles, shared_labels=shared_labels,
            shared_platforms=shared_platforms, summary=_compatibility_summary(shared_genres, shared_labels, shared_platforms), updated_at=started))
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    statement = insert(CompatibilityScore).values(values)
    db.execute(statement.on_conflict_do_update(index_elements=["user_a_id", "user_b_id"],
        set_={key: getattr(statement.excluded, key) for key in values[0] if key not in {"user_a_id", "user_b_id"}}))
    db.commit()
    return {r.user_b_id if r.user_a_id == viewer else r.user_a_id: r
        for r in db.scalars(select(CompatibilityScore).where(pairs).execution_options(populate_existing=True)).all()}


def refresh_compatibility(db: Session, user_a: UUID, user_b: UUID) -> CompatibilityScore:
    return get_compatibilities(db, user_a, [user_b], force_refresh=True)[user_b]


def get_compatibility(db: Session, user_a: UUID, user_b: UUID, *, force_refresh: bool = False) -> CompatibilityScore:
    return get_compatibilities(db, user_a, [user_b], force_refresh=force_refresh)[user_b]


# M01 evidence gate: minimum distinct rated titles PER PERSON before
# we display a numerical compatibility. Below this, both sides see
# "Still learning your taste" instead of an invented percentage.
# Product threshold, not statistical — kept intentionally conservative.
_MIN_RATED_FOR_EVIDENCE = 5


def _user_rated_count(db: Session, user_id: UUID) -> int:
    from app.models.social import Rating as _R
    from sqlalchemy import func as _f
    return int(db.scalar(
        select(_f.count()).select_from(_R).where(
            _R.user_id == user_id,
            _R.watched_state == "watched",
        )
    ) or 0)


def to_compatibility_response(
    record: CompatibilityScore,
    viewer_user_id: UUID,
    other_user_id: UUID,
    *,
    db: Session | None = None,
    include_titles: bool = True,
) -> CompatibilityResponse:
    # M01: compatibility is a NUMBER only when BOTH users have >= 5
    # rated titles AND there's supported shared evidence. Otherwise
    # the client shows the "Still learning your taste" Learning card.
    shared_present = bool(
        (record.shared_genres or [])
        or (record.shared_titles or [])
        or (record.shared_labels or [])
    )
    has_evidence = shared_present
    if has_evidence:
        has_evidence = min(record.rated_count_a or 0, record.rated_count_b or 0) >= _MIN_RATED_FOR_EVIDENCE
    compat: int | None = record.compatibility if has_evidence else None
    return CompatibilityResponse(
        user_a=viewer_user_id,
        user_b=other_user_id,
        compatibility=compat,
        top_shared_genres=record.shared_genres or [],
        top_shared_titles=[TasteTitleReferenceResponse(**item) for item in (_shared_titles(db,viewer_user_id,other_user_id) if db is not None and include_titles else (record.shared_titles or []) if not include_titles else [])],
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
        .order_by(TeamRanking.rank.asc())
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
    return refresh_team_analytics(db,team_id)


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


def _shared_titles(db: Session,user_a: UUID,user_b: UUID) -> list[dict]:
    """Only named favorites that each person may currently see on the other's profile.

    A private rating is not publication, even if the other person rated the same title.
    """
    if not can_view_profile(db,user_a,user_b) or not can_view_profile(db,user_b,user_a): return []
    a=set(db.scalars(select(RankedFavorite.content_title_id).where(RankedFavorite.user_id==user_a)).all())
    rows=db.scalars(select(ContentTitle).join(RankedFavorite,RankedFavorite.content_title_id==ContentTitle.id)
        .where(RankedFavorite.user_id==user_b,RankedFavorite.content_title_id.in_(a)).order_by(RankedFavorite.position).limit(4)).all()
    return [{'title_id':str(t.id),'title_name':t.title,'poster_url':t.poster_url} for t in rows]


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


def _most_divisive_title(db: Session,team_id: UUID,member_ids: list[UUID]) -> dict:
    if not member_ids:return {}
    spread=func.max(TeamTitleState.shared_rating)-func.min(TeamTitleState.shared_rating)
    row=db.execute(select(TeamTitleState.content_title_id,spread,ContentTitle.title,ContentTitle.poster_url)
        .join(ContentTitle,ContentTitle.id==TeamTitleState.content_title_id)
        .join(TeamTitle,(TeamTitle.content_title_id==ContentTitle.id)&(TeamTitle.team_id==team_id))
        .where(TeamTitleState.team_id==team_id,TeamTitleState.user_id.in_(member_ids),TeamTitleState.state=='watched',TeamTitleState.shared_rating.is_not(None))
        .group_by(TeamTitleState.content_title_id,ContentTitle.title,ContentTitle.poster_url)
        .having(func.count(TeamTitleState.id)>=2).order_by(spread.desc(),TeamTitleState.content_title_id).limit(1)).first()
    if row is None:return {}
    return {'title_id':str(row[0]),'title_name':row[2],'poster_url':row[3]}


def _is_stale(updated_at: datetime | None, *, hours: int) -> bool:
    if updated_at is None:
        return True
    return (datetime.now(timezone.utc) - updated_at.replace(tzinfo=timezone.utc)).total_seconds() > hours * 3600
