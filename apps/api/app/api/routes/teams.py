from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, HTTPException, Response, status
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.db.session import SessionLocal
from app.models.content import ContentTitle
from app.models.social import TeamActivity
from app.models.social import Team as TeamModel
from app.models.social import TeamMember
from app.models.social import TeamRanking, TeamTitle
from app.models.user import User, UserProfile
from app.services.notifications import (
    notify_team_comment,
    notify_team_member_added,
    notify_team_member_joined,
)
from app.services.push_delivery import send_pending_push_notifications
from app.schemas.team import (
    TeamActivityResponse,
    TeamActivityCommentCreateRequest,
    TeamFeedPostCreateRequest,
    TeamActivityReactionCreateRequest,
    TeamMemberAddRequest,
    TeamCreateRequest,
    TeamJoinRequest,
    TeamMemberSummaryResponse,
    TeamRankingResponse,
    TeamResponse,
    TeamSummaryResponse,
    TeamTitleAddRequest,
    TeamTitleResponse,
    TeamUpdateRequest,
    TeamUserSearchResponse,
)
from app.schemas.taste import TeamAnalyticsResponse
from app.services.activity import get_team_activity_by_id, list_activity_actor_profiles, list_team_activity
from app.services.compatibility import get_team_analytics, to_team_analytics_response
from app.services.teams import (
    add_title_to_team,
    add_team_member,
    compute_team_derived_state,
    create_team_feed_post,
    create_team as create_team_record,
    get_team,
    join_team_by_invite_code,
    leave_team,
    list_team_rankings,
    list_team_member_profiles,
    list_team_members,
    list_team_titles,
    list_user_teams,
    mark_team_viewed,
    remove_team_member,
    require_team_admin_or_owner,
    require_team_member,
    search_users_for_team,
    search_teams_by_name,
    update_team,
)

router = APIRouter()


@router.get("", response_model=list[TeamSummaryResponse])
def list_teams(current_user: CurrentUser, db: DbSession) -> list[TeamSummaryResponse]:
    return [
        _to_team_summary(db, team, member_count, viewer_user_id=current_user.id)
        for team, member_count in list_user_teams(db, current_user.id)
    ]


@router.get("/search", response_model=list[TeamSummaryResponse])
def search_teams(q: str, current_user: CurrentUser, db: DbSession) -> list[TeamSummaryResponse]:
    if not q.strip():
        return []
    return [
        _to_team_summary(db, team, member_count, viewer_user_id=current_user.id)
        for team, member_count in search_teams_by_name(db, q, current_user.id)
    ]


@router.post("", response_model=TeamResponse, status_code=status.HTTP_201_CREATED)
def create_team(payload: TeamCreateRequest, current_user: CurrentUser, db: DbSession) -> TeamResponse:
    team = create_team_record(db, current_user, payload)
    return _load_team_response(db, team)


@router.post("/join", response_model=TeamResponse, status_code=status.HTTP_200_OK)
def join_team(
    payload: TeamJoinRequest,
    current_user: CurrentUser,
    db: DbSession,
    background_tasks: BackgroundTasks,
) -> TeamResponse:
    existing_member_ids = [
        m.user_id
        for m in db.scalars(
            select(TeamMember).where(TeamMember.team_id.in_(
                select(TeamModel.id).where(TeamModel.invite_code == payload.invite_code.strip().lower())
            ), TeamMember.status == "active")
        ).all()
    ]

    team = join_team_by_invite_code(db, current_user, payload.invite_code)

    notify_team_member_joined(
        db,
        joiner=current_user,
        team_id=team.id,
        team_name=team.name,
        existing_member_ids=existing_member_ids,
        is_demo=current_user.is_demo,
    )
    db.commit()
    background_tasks.add_task(_deliver_push)

    return _load_team_response(db, team)


@router.patch("/{team_id}", response_model=TeamResponse)
def patch_team(
    team_id: UUID,
    payload: TeamUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TeamResponse:
    team, _ = require_team_admin_or_owner(db, team_id, current_user.id)
    updated = update_team(db, team=team, payload=payload)
    return _load_team_response(db, updated)


@router.get("/{team_id}", response_model=TeamResponse)
def get_team_detail(team_id: UUID, current_user: CurrentUser, db: DbSession) -> TeamResponse:
    require_team_member(db, team_id, current_user.id)
    team = get_team(db, team_id)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found")
    return _load_team_response(db, team, viewer_user_id=current_user.id)


@router.post("/{team_id}/view", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def mark_team_viewed_route(
    team_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> Response:
    """Stamp the member's last_viewed_at cursor. Called by the mobile client
    when the user opens a team so unread_activity_count resets on next fetch."""
    require_team_member(db, team_id, current_user.id)
    mark_team_viewed(db, team_id, current_user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{team_id}/analytics", response_model=TeamAnalyticsResponse)
def get_team_analytics_route(team_id: UUID, current_user: CurrentUser, db: DbSession) -> TeamAnalyticsResponse:
    require_team_member(db, team_id, current_user.id)
    return to_team_analytics_response(get_team_analytics(db, team_id, force_refresh=True))


@router.get("/{team_id}/titles", response_model=list[TeamTitleResponse])
def get_team_titles(team_id: UUID, current_user: CurrentUser, db: DbSession) -> list[TeamTitleResponse]:
    require_team_member(db, team_id, current_user.id)
    rows = list_team_titles(db, team_id)
    if not rows:
        return []
    title_ids = {row.content_title_id for row in rows}
    user_ids = {row.added_by_user_id for row in rows}
    titles = {t.id: t for t in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(title_ids))).all()}
    profiles = {p.user_id: p for p in db.scalars(select(UserProfile).where(UserProfile.user_id.in_(user_ids))).all()}
    return [_to_team_title_response(row, titles.get(row.content_title_id), profiles.get(row.added_by_user_id)) for row in rows]


@router.post("/{team_id}/titles", response_model=TeamTitleResponse, status_code=status.HTTP_201_CREATED)
def add_team_title(
    team_id: UUID,
    payload: TeamTitleAddRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TeamTitleResponse:
    team = require_team_member(db, team_id, current_user.id)
    added = add_title_to_team(
        db,
        team=team,
        actor_user_id=current_user.id,
        content_title_id=payload.content_title_id,
        note=payload.note,
        suggested_rank=payload.suggested_rank,
        also_post_to_feed=payload.also_post_to_feed,
    )
    title = db.scalar(select(ContentTitle).where(ContentTitle.id == added.content_title_id))
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == added.added_by_user_id))
    return _to_team_title_response(added, title, profile)


@router.get("/{team_id}/top-10", response_model=list[TeamRankingResponse])
def get_team_top_10(team_id: UUID, current_user: CurrentUser, db: DbSession) -> list[TeamRankingResponse]:
    require_team_member(db, team_id, current_user.id)
    rankings = list_team_rankings(db, team_id)[:10]
    if not rankings:
        return []
    title_ids = {row.content_title_id for row in rankings}
    titles = {t.id: t for t in db.scalars(select(ContentTitle).where(ContentTitle.id.in_(title_ids))).all()}
    return [_to_team_ranking_response(row, titles.get(row.content_title_id)) for row in rankings]


@router.post("/{team_id}/feed-posts", response_model=TeamActivityResponse, status_code=status.HTTP_201_CREATED)
def create_feed_post(
    team_id: UUID,
    payload: TeamFeedPostCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TeamActivityResponse:
    team = require_team_member(db, team_id, current_user.id)
    post = create_team_feed_post(
        db,
        team=team,
        actor_user_id=current_user.id,
        text=payload.text,
        content_title_id=payload.content_title_id,
        rating=payload.rating,
    )
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == post.actor_user_id))
    return _to_activity_response(post, profile)


@router.get("/{team_id}/activity", response_model=list[TeamActivityResponse])
def get_team_activity(team_id: UUID, current_user: CurrentUser, db: DbSession) -> list[TeamActivityResponse]:
    require_team_member(db, team_id, current_user.id)
    activities = list_team_activity(db, team_id)
    actor_profiles = list_activity_actor_profiles(db, activities)
    return [_to_activity_response(activity, actor_profiles.get(activity.actor_user_id)) for activity in activities]


@router.post("/{team_id}/activity/{activity_id}/comments", response_model=TeamActivityResponse)
def add_team_activity_comment(
    team_id: UUID,
    activity_id: UUID,
    payload: TeamActivityCommentCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
    background_tasks: BackgroundTasks,
) -> TeamActivityResponse:
    team = require_team_member(db, team_id, current_user.id)
    target_activity = get_team_activity_by_id(db, team_id, activity_id)
    if target_activity is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
    comment = payload.comment.strip()
    if not comment:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Comment cannot be empty")

    created = TeamActivity(
        team_id=team_id,
        actor_user_id=current_user.id,
        activity_type="activity_commented",
        content_title_id=target_activity.content_title_id,
        entity_id=activity_id,
        payload={"comment": comment},
    )
    db.add(created)
    db.flush()

    notify_team_comment(
        db,
        commenter=current_user,
        team_id=team_id,
        team_name=team.name,
        activity_id=activity_id,
        activity_actor_id=target_activity.actor_user_id,
        comment_excerpt=comment,
        is_demo=current_user.is_demo,
    )
    db.commit()
    db.refresh(created)
    background_tasks.add_task(_deliver_push)

    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == created.actor_user_id))
    return _to_activity_response(created, profile)


@router.post("/{team_id}/activity/{activity_id}/reactions", response_model=TeamActivityResponse)
def add_team_activity_reaction(
    team_id: UUID,
    activity_id: UUID,
    payload: TeamActivityReactionCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TeamActivityResponse:
    require_team_member(db, team_id, current_user.id)
    target_activity = get_team_activity_by_id(db, team_id, activity_id)
    if target_activity is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
    reaction = payload.reaction.strip().lower()
    if not reaction:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reaction cannot be empty")

    created = TeamActivity(
        team_id=team_id,
        actor_user_id=current_user.id,
        activity_type="activity_reacted",
        content_title_id=target_activity.content_title_id,
        entity_id=activity_id,
        payload={"reaction": reaction},
    )
    db.add(created)
    db.commit()
    db.refresh(created)
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == created.actor_user_id))
    return _to_activity_response(created, profile)


@router.post("/{team_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
def leave_team_route(team_id: UUID, current_user: CurrentUser, db: DbSession) -> Response:
    leave_team(db, current_user, team_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{team_id}/members/{member_user_id}", response_model=TeamResponse)
def remove_member_from_team(
    team_id: UUID,
    member_user_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> TeamResponse:
    team = remove_team_member(db, current_user, team_id, member_user_id)
    return _load_team_response(db, team)


@router.post("/{team_id}/members", response_model=TeamResponse, status_code=status.HTTP_200_OK)
def add_member_to_team(
    team_id: UUID,
    payload: TeamMemberAddRequest,
    current_user: CurrentUser,
    db: DbSession,
    background_tasks: BackgroundTasks,
) -> TeamResponse:
    team, _ = require_team_admin_or_owner(db, team_id, current_user.id)
    updated = add_team_member(
        db,
        team=team,
        actor_user_id=current_user.id,
        member_user_id=payload.user_id,
        role=payload.role,
    )

    notify_team_member_added(
        db,
        actor=current_user,
        team_id=team.id,
        team_name=team.name,
        recipient_id=payload.user_id,
        is_demo=current_user.is_demo,
    )
    db.commit()
    background_tasks.add_task(_deliver_push)

    return _load_team_response(db, updated)


@router.get("/{team_id}/users/search", response_model=list[TeamUserSearchResponse])
def search_users_to_add(
    team_id: UUID,
    q: str,
    current_user: CurrentUser,
    db: DbSession,
) -> list[TeamUserSearchResponse]:
    require_team_admin_or_owner(db, team_id, current_user.id)
    profiles = search_users_for_team(db, team_id=team_id, query=q)
    return [
        TeamUserSearchResponse(
            user_id=profile.user_id,
            display_name=profile.display_name,
            username=profile.username,
            avatar_url=profile.avatar_url,
        )
        for profile in profiles
    ]


def _deliver_push() -> None:
    db = SessionLocal()
    try:
        send_pending_push_notifications(db)
    finally:
        db.close()


def _load_team_response(
    db: DbSession,
    team: TeamModel,
    *,
    viewer_user_id: UUID | None = None,
) -> TeamResponse:
    members = list_team_members(db, team.id)
    profiles = list_team_member_profiles(db, team.id)
    return _to_team_response(db, team, members, profiles, viewer_user_id=viewer_user_id)


def _to_team_summary(
    db: DbSession,
    team: TeamModel,
    member_count: int,
    *,
    viewer_user_id: UUID | None = None,
) -> TeamSummaryResponse:
    latest = db.scalar(
        select(TeamActivity).where(TeamActivity.team_id == team.id).order_by(TeamActivity.created_at.desc()).limit(1)
    )
    avatars = db.scalars(
        select(UserProfile.avatar_url)
        .join(TeamMember, TeamMember.user_id == UserProfile.user_id)
        .where(TeamMember.team_id == team.id, TeamMember.status == "active", UserProfile.avatar_url.is_not(None))
        .order_by(TeamMember.joined_at.desc())
        .limit(4)
    ).all()
    latest_text = _activity_summary(latest) if latest is not None else None
    derived = compute_team_derived_state(db, team, viewer_user_id)
    return TeamSummaryResponse(
        id=team.id,
        name=team.name,
        slug=team.slug,
        description=team.description,
        visibility=team.visibility,
        icon=team.icon,
        cover_image=team.cover_image,
        owner_user_id=team.owner_user_id,
        invite_code=team.invite_code,
        max_members=team.max_members,
        member_count=member_count,
        last_activity_at=team.last_activity_at,
        latest_activity=latest_text,
        recent_member_avatars=[avatar for avatar in avatars if avatar],
        **derived,
    )


def _to_team_response(
    db: DbSession,
    team: TeamModel,
    members: list[TeamMember],
    profiles: dict[UUID, UserProfile],
    *,
    viewer_user_id: UUID | None = None,
) -> TeamResponse:
    analytics = to_team_analytics_response(get_team_analytics(db, team.id))
    summary = _to_team_summary(
        db,
        team,
        len([member for member in members if member.status == "active"]),
        viewer_user_id=viewer_user_id,
    )
    return TeamResponse(
        **summary.model_dump(),
        members=[
            TeamMemberSummaryResponse(
                user_id=member.user_id,
                display_name=profiles.get(member.user_id).display_name if profiles.get(member.user_id) else None,
                avatar_url=profiles.get(member.user_id).avatar_url if profiles.get(member.user_id) else None,
                role=member.role,
                status=member.status,
                joined_at=member.joined_at,
            )
            for member in members
        ],
        analytics=analytics,
    )


def _to_activity_response(activity: TeamActivity, actor_profile: UserProfile | None) -> TeamActivityResponse:
    return TeamActivityResponse(
        id=activity.id,
        activity_type=activity.activity_type,
        actor_user_id=activity.actor_user_id,
        actor_display_name=actor_profile.display_name if actor_profile is not None else None,
        actor_avatar_url=actor_profile.avatar_url if actor_profile is not None else None,
        content_title_id=activity.content_title_id,
        entity_id=activity.entity_id,
        payload=activity.payload,
        created_at=activity.created_at,
    )


def _activity_summary(activity: TeamActivity) -> str:
    payload = activity.payload or {}
    if activity.activity_type == "title_added":
        return f"Added {payload.get('title_name', 'a title')}"
    if activity.activity_type == "team_post":
        text = str(payload.get("text", "")).strip()
        return text[:80] if text else "Posted to team feed"
    if activity.activity_type == "member_joined":
        return "New member joined"
    return activity.activity_type.replace("_", " ")


def _to_team_title_response(row: TeamTitle, title: ContentTitle | None, profile: UserProfile | None) -> TeamTitleResponse:
    year = title.release_date.year if title is not None and title.release_date is not None else None
    return TeamTitleResponse(
        id=row.id,
        team_id=row.team_id,
        content_title_id=row.content_title_id,
        added_by_user_id=row.added_by_user_id,
        added_by_name=profile.display_name if profile is not None else None,
        note=row.note,
        added_at=row.added_at,
        title_name=title.title if title is not None else "Untitled",
        content_type=title.content_type if title is not None else "unknown",
        poster_url=title.poster_url if title is not None else None,
        year=year,
    )


def _to_team_ranking_response(row: TeamRanking, title: ContentTitle | None) -> TeamRankingResponse:
    return TeamRankingResponse(
        id=row.id,
        team_id=row.team_id,
        content_title_id=row.content_title_id,
        rank=row.rank,
        score=float(row.score),
        movement=row.movement,
        weeks_on_list=row.weeks_on_list,
        title_name=title.title if title is not None else "Untitled",
        poster_url=title.poster_url if title is not None else None,
    )
