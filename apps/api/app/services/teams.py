from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.models.content import ContentTitle
from app.models.social import Team, TeamActivity, TeamMember, TeamRanking, TeamTitle
from app.models.user import User, UserProfile
from app.schemas.team import TeamCreateRequest, TeamUpdateRequest
from app.services.activity import log_team_activity


def _invite_code() -> str:
    return uuid4().hex[:8]


def _slugify(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    slug = "-".join(part for part in slug.split("-") if part)
    return slug[:120] or "watch-team"


def _unique_slug(db: Session, name: str) -> str:
    base = _slugify(name)
    slug = base
    i = 2
    while db.scalar(select(Team.id).where(Team.slug == slug, Team.archived_at.is_(None))) is not None:
        slug = f"{base}-{i}"
        i += 1
    return slug


def get_team(db: Session, team_id: UUID) -> Team | None:
    return db.scalar(select(Team).where(Team.id == team_id, Team.archived_at.is_(None)))


def require_team_member(db: Session, team_id: UUID, user_id: UUID) -> Team:
    team = get_team(db, team_id)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found")

    membership = db.scalar(
        select(TeamMember).where(
            TeamMember.team_id == team_id,
            TeamMember.user_id == user_id,
            TeamMember.status == "active",
        )
    )
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Team membership required")
    return team


def list_user_teams(db: Session, user_id: UUID) -> list[tuple[Team, int]]:
    membership_filter = aliased(TeamMember)
    active_members = aliased(TeamMember)
    # Per Watch Teams brief §6: teams with recent activity float upward — the
    # Home screen is an inbox of group momentum, not an alphabetical directory.
    # Teams that never had activity fall to the bottom via created_at tiebreak.
    rows = db.execute(
        select(Team, func.count(active_members.id).label("member_count"))
        .join(membership_filter, membership_filter.team_id == Team.id)
        .join(active_members, active_members.team_id == Team.id)
        .where(
            membership_filter.user_id == user_id,
            membership_filter.status == "active",
            active_members.status == "active",
            Team.archived_at.is_(None),
        )
        .group_by(Team.id)
        .order_by(Team.last_activity_at.desc().nulls_last(), Team.created_at.desc())
    ).all()
    return [(team, member_count) for team, member_count in rows]


def list_team_members(db: Session, team_id: UUID) -> list[TeamMember]:
    return db.scalars(
        select(TeamMember)
        .where(TeamMember.team_id == team_id)
        .order_by(TeamMember.joined_at.asc())
    ).all()


def list_team_member_profiles(db: Session, team_id: UUID) -> dict[UUID, UserProfile]:
    rows = db.scalars(
        select(UserProfile)
        .join(TeamMember, TeamMember.user_id == UserProfile.user_id)
        .where(TeamMember.team_id == team_id)
    ).all()
    return {profile.user_id: profile for profile in rows}


def create_team(db: Session, current_user: User, payload: TeamCreateRequest) -> Team:
    clean_name = payload.name.strip()
    if len(clean_name) < 3:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Team name must be at least 3 characters")

    team = Team(
        name=clean_name,
        slug=_unique_slug(db, clean_name),
        description=payload.description.strip() if payload.description else None,
        visibility=payload.visibility,
        icon=payload.icon,
        cover_image=payload.cover_image,
        owner_user_id=current_user.id,
        invite_code=_invite_code(),
        max_members=payload.max_members,
        last_activity_at=datetime.now(UTC),
    )
    db.add(team)
    db.flush()

    db.add(
        TeamMember(
            team_id=team.id,
            user_id=current_user.id,
            role="owner",
            status="active",
        )
    )
    log_team_activity(
        db,
        team_id=team.id,
        actor_user_id=current_user.id,
        activity_type="team_created",
        entity_id=team.id,
        payload={"team_name": team.name},
    )
    db.commit()
    db.refresh(team)
    return team


def join_team_by_invite_code(db: Session, current_user: User, invite_code: str) -> Team:
    normalized_code = invite_code.strip().lower()
    team = db.scalar(select(Team).where(func.lower(Team.invite_code) == normalized_code, Team.archived_at.is_(None)))
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite code not found")

    membership = db.scalar(
        select(TeamMember).where(TeamMember.team_id == team.id, TeamMember.user_id == current_user.id)
    )
    if membership is not None:
        if membership.status != "active":
            membership.status = "active"
            db.commit()
        return team

    member_count = db.scalar(
        select(func.count(TeamMember.id)).where(TeamMember.team_id == team.id, TeamMember.status == "active")
    )
    if member_count is not None and member_count >= team.max_members:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Team is full")

    db.add(
        TeamMember(
            team_id=team.id,
            user_id=current_user.id,
            role="member",
            status="active",
        )
    )
    log_team_activity(
        db,
        team_id=team.id,
        actor_user_id=current_user.id,
        activity_type="member_joined",
        payload={"joined_user_id": str(current_user.id)},
    )
    team.last_activity_at = datetime.now(UTC)
    db.commit()
    db.refresh(team)
    return team


def get_team_member(db: Session, team_id: UUID, user_id: UUID) -> TeamMember | None:
    return db.scalar(select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user_id))


# Watch Teams overhaul (brief §8) — derived state for the Teams inbox pattern.
# Kept as simple per-team queries; batch later if it becomes hot. `team_status`
# thresholds: active if any activity in the last 24h, quiet within a week,
# dormant beyond that.
_TEAM_ACTIVE_WINDOW = timedelta(hours=24)
_TEAM_QUIET_WINDOW = timedelta(days=7)


def _derive_team_status(last_activity_at: datetime | None) -> str:
    if last_activity_at is None:
        return "dormant"
    now = datetime.now(UTC)
    delta = now - last_activity_at
    if delta <= _TEAM_ACTIVE_WINDOW:
        return "active"
    if delta <= _TEAM_QUIET_WINDOW:
        return "quiet"
    return "dormant"


def compute_team_derived_state(
    db: Session,
    team: Team,
    viewer_user_id: UUID | None,
) -> dict:
    """Compute the derived Team fields the overhaul relies on: unread since the
    viewer's last visit, active-member count in the last 24h, coarse status,
    and Top 10 freshness. Returns a dict merged into the response schema."""
    since_24h = datetime.now(UTC) - _TEAM_ACTIVE_WINDOW

    # unread_activity_count — only meaningful when we know the viewer. Members
    # who've never opened the team see the full recent activity count.
    unread_count = 0
    if viewer_user_id is not None:
        viewer_cursor = db.scalar(
            select(TeamMember.last_viewed_at).where(
                TeamMember.team_id == team.id,
                TeamMember.user_id == viewer_user_id,
            )
        )
        unread_query = select(func.count(TeamActivity.id)).where(
            TeamActivity.team_id == team.id,
            TeamActivity.actor_user_id != viewer_user_id,
        )
        if viewer_cursor is not None:
            unread_query = unread_query.where(TeamActivity.created_at > viewer_cursor)
        unread_count = int(db.scalar(unread_query) or 0)

    # active_member_count_24h — distinct actors on TeamActivity in last 24h.
    active_members = int(
        db.scalar(
            select(func.count(func.distinct(TeamActivity.actor_user_id))).where(
                TeamActivity.team_id == team.id,
                TeamActivity.created_at >= since_24h,
            )
        )
        or 0
    )

    top10_updated_at = db.scalar(
        select(func.max(TeamRanking.updated_at)).where(TeamRanking.team_id == team.id)
    )

    return {
        "unread_activity_count": unread_count,
        "active_member_count_24h": active_members,
        "team_status": _derive_team_status(team.last_activity_at),
        "top10_updated_at": top10_updated_at,
    }


def mark_team_viewed(db: Session, team_id: UUID, user_id: UUID) -> None:
    """Stamp the viewer's last_viewed_at cursor so unread_activity_count resets
    the next time the Teams Home refreshes. No-op if user is not a member."""
    membership = db.scalar(
        select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user_id)
    )
    if membership is None:
        return
    membership.last_viewed_at = datetime.now(UTC)
    db.commit()


def require_team_admin_or_owner(db: Session, team_id: UUID, user_id: UUID) -> tuple[Team, TeamMember]:
    team = require_team_member(db, team_id, user_id)
    membership = get_team_member(db, team_id, user_id)
    if membership is None or membership.status != "active" or membership.role not in {"owner", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin or owner permissions required")
    return team, membership


def leave_team(db: Session, current_user: User, team_id: UUID) -> Team:
    team = require_team_member(db, team_id, current_user.id)
    membership = get_team_member(db, team_id, current_user.id)
    if membership is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team membership not found")

    membership.status = "left"
    previous_role = membership.role
    membership.role = "member"

    active_members = db.scalars(
        select(TeamMember)
        .where(TeamMember.team_id == team_id, TeamMember.user_id != current_user.id, TeamMember.status == "active")
        .order_by(TeamMember.joined_at.asc())
    ).all()

    log_team_activity(
        db,
        team_id=team.id,
        actor_user_id=current_user.id,
        activity_type="member_left",
        payload={"left_user_id": str(current_user.id)},
    )
    team.last_activity_at = datetime.now(UTC)

    if previous_role == "owner":
        if active_members:
            new_owner = active_members[0]
            new_owner.role = "owner"
            team.owner_user_id = new_owner.user_id
            log_team_activity(
                db,
                team_id=team.id,
                actor_user_id=new_owner.user_id,
                activity_type="ownership_transferred",
                payload={"previous_owner_user_id": str(current_user.id)},
            )
        else:
            team.archived_at = datetime.now(UTC)
            log_team_activity(
                db,
                team_id=team.id,
                actor_user_id=current_user.id,
                activity_type="team_archived",
                payload={"reason": "owner_left"},
            )

    db.commit()
    db.refresh(team)
    return team


def remove_team_member(db: Session, current_user: User, team_id: UUID, member_user_id: UUID) -> Team:
    team = require_team_member(db, team_id, current_user.id)
    requester_membership = get_team_member(db, team_id, current_user.id)
    if requester_membership is None or requester_membership.role not in {"owner", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins or owner can manage members")

    if team.owner_user_id == member_user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Owner cannot be removed")

    membership = get_team_member(db, team_id, member_user_id)
    if membership is None or membership.status != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team member not found")
    if requester_membership.role == "admin" and membership.role in {"admin", "owner"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admins can only remove members")

    membership.status = "removed"
    membership.role = "member"
    log_team_activity(
        db,
        team_id=team.id,
        actor_user_id=current_user.id,
        activity_type="member_removed",
        payload={"removed_user_id": str(member_user_id)},
    )
    team.last_activity_at = datetime.now(UTC)
    db.commit()
    db.refresh(team)
    return team


def search_teams_by_name(db: Session, query: str, user_id: UUID, limit: int = 15) -> list[tuple[Team, int]]:
    membership_filter = aliased(TeamMember)
    viewer_is_demo = bool(db.scalar(select(User.is_demo).where(User.id == user_id)))
    stmt = (
        select(Team, func.count(TeamMember.id).label("member_count"))
        .join(TeamMember, TeamMember.team_id == Team.id)
        .outerjoin(
            membership_filter,
            (membership_filter.team_id == Team.id)
            & (membership_filter.user_id == user_id)
            & (membership_filter.status == "active"),
        )
        .where(
            Team.archived_at.is_(None),
            Team.name.ilike(f"%{query.strip()}%"),
            Team.visibility != "private",
            TeamMember.status == "active",
        )
        .group_by(Team.id, membership_filter.id)
        .order_by(Team.last_activity_at.desc().nullslast(), Team.created_at.desc())
        .limit(limit)
    )
    if not viewer_is_demo:
        stmt = stmt.where(Team.owner_user_id.not_in(select(User.id).where(User.is_demo.is_(True))))
    rows = db.execute(stmt).all()
    return [(team, member_count) for team, member_count in rows]


def list_team_titles(db: Session, team_id: UUID) -> list[TeamTitle]:
    return db.scalars(
        select(TeamTitle).where(TeamTitle.team_id == team_id).order_by(TeamTitle.added_at.desc())
    ).all()


def add_title_to_team(
    db: Session,
    *,
    team: Team,
    actor_user_id: UUID,
    content_title_id: UUID,
    note: str | None,
    suggested_rank: int | None,
    also_post_to_feed: bool,
) -> TeamTitle:
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == content_title_id))
    if title is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    existing = db.scalar(
        select(TeamTitle).where(TeamTitle.team_id == team.id, TeamTitle.content_title_id == content_title_id)
    )
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Title already in team")

    team_title = TeamTitle(
        team_id=team.id,
        content_title_id=content_title_id,
        added_by_user_id=actor_user_id,
        note=note.strip() if note else None,
    )
    db.add(team_title)
    db.flush()

    log_team_activity(
        db,
        team_id=team.id,
        actor_user_id=actor_user_id,
        activity_type="title_added",
        content_title_id=content_title_id,
        entity_id=team_title.id,
        payload={"title_name": title.title, "note": team_title.note},
    )

    if also_post_to_feed:
        db.add(
            TeamActivity(
                team_id=team.id,
                actor_user_id=actor_user_id,
                activity_type="team_post",
                content_title_id=content_title_id,
                payload={
                    "text": (note or "").strip() or f"Added {title.title} to the team library.",
                    "title_name": title.title,
                },
            )
        )

    ranking_exists = db.scalar(
        select(TeamRanking).where(TeamRanking.team_id == team.id, TeamRanking.content_title_id == content_title_id)
    )
    if ranking_exists is None:
        max_rank = db.scalar(select(func.max(TeamRanking.rank)).where(TeamRanking.team_id == team.id)) or 0
        rank_value = int(max_rank) + 1
        if suggested_rank is not None:
            rank_value = max(1, min(10, suggested_rank))
            db.execute(
                TeamRanking.__table__.update()
                .where(TeamRanking.team_id == team.id, TeamRanking.rank >= rank_value)
                .values(rank=TeamRanking.rank + 1)
            )
        db.add(
            TeamRanking(
                team_id=team.id,
                content_title_id=content_title_id,
                rank=rank_value,
                score=max(10.1 - float(rank_value), 6.0),
                movement="new",
                weeks_on_list=1,
            )
        )

    team.last_activity_at = datetime.now(UTC)
    db.commit()
    db.refresh(team_title)
    return team_title


def update_team(
    db: Session,
    *,
    team: Team,
    payload: TeamUpdateRequest,
) -> Team:
    if payload.name is not None:
        clean_name = payload.name.strip()
        if len(clean_name) < 3:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Team name must be at least 3 characters")
        if clean_name != team.name:
            team.name = clean_name
            team.slug = _unique_slug(db, clean_name)
    if payload.description is not None:
        team.description = payload.description.strip() if payload.description.strip() else None
    if payload.visibility is not None:
        team.visibility = payload.visibility
    if payload.icon is not None:
        team.icon = payload.icon.strip() if payload.icon.strip() else None
    if payload.cover_image is not None:
        team.cover_image = payload.cover_image.strip() if payload.cover_image.strip() else None
    team.last_activity_at = datetime.now(UTC)
    db.commit()
    db.refresh(team)
    return team


def add_team_member(
    db: Session,
    *,
    team: Team,
    actor_user_id: UUID,
    member_user_id: UUID,
    role: str = "member",
) -> Team:
    if team.owner_user_id == member_user_id:
        return team
    user = db.scalar(select(User).where(User.id == member_user_id))
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    member_count = db.scalar(
        select(func.count(TeamMember.id)).where(TeamMember.team_id == team.id, TeamMember.status == "active")
    ) or 0
    existing = get_team_member(db, team.id, member_user_id)
    if existing is None and member_count >= team.max_members:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Team is full")
    if existing is None:
        db.add(TeamMember(team_id=team.id, user_id=member_user_id, role=role, status="active"))
    else:
        existing.status = "active"
        if role in {"member", "admin"}:
            existing.role = role
    log_team_activity(
        db,
        team_id=team.id,
        actor_user_id=actor_user_id,
        activity_type="member_added",
        payload={"added_user_id": str(member_user_id), "role": role},
    )
    team.last_activity_at = datetime.now(UTC)
    db.commit()
    db.refresh(team)
    return team


def search_users_for_team(db: Session, *, team_id: UUID, query: str, limit: int = 12) -> list[UserProfile]:
    existing_ids = db.scalars(
        select(TeamMember.user_id).where(TeamMember.team_id == team_id, TeamMember.status == "active")
    ).all()
    q = query.strip()
    if not q:
        return []
    # If the team is owned by a non-demo user, hide demo users from the search results.
    team_owner_id = db.scalar(select(Team.owner_user_id).where(Team.id == team_id))
    owner_is_demo = bool(
        db.scalar(select(User.is_demo).where(User.id == team_owner_id))
    ) if team_owner_id is not None else False
    stmt = (
        select(UserProfile)
        .where(
            (UserProfile.display_name.ilike(f"%{q}%") | UserProfile.username.ilike(f"%{q}%")),
            ~UserProfile.user_id.in_(existing_ids if existing_ids else [UUID(int=0)]),
        )
        .order_by(UserProfile.display_name.asc())
        .limit(limit)
    )
    if not owner_is_demo:
        stmt = stmt.where(UserProfile.user_id.not_in(select(User.id).where(User.is_demo.is_(True))))
    return db.scalars(stmt).all()


def list_team_rankings(db: Session, team_id: UUID) -> list[TeamRanking]:
    return db.scalars(
        select(TeamRanking).where(TeamRanking.team_id == team_id).order_by(TeamRanking.rank.asc())
    ).all()


def create_team_feed_post(
    db: Session,
    *,
    team: Team,
    actor_user_id: UUID,
    text: str | None,
    content_title_id: UUID | None,
    rating: float | None,
) -> TeamActivity:
    clean_text = (text or "").strip()
    if not clean_text and content_title_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Post text or title is required")

    title = None
    if content_title_id is not None:
        title = db.scalar(select(ContentTitle).where(ContentTitle.id == content_title_id))
        if title is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")

    post = TeamActivity(
        team_id=team.id,
        actor_user_id=actor_user_id,
        activity_type="team_post",
        content_title_id=content_title_id,
        payload={
            "text": clean_text,
            "rating": rating,
            "title_name": title.title if title is not None else None,
        },
    )
    db.add(post)
    team.last_activity_at = datetime.now(UTC)
    db.commit()
    db.refresh(post)
    return post
