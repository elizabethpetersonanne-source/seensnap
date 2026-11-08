"""Private team collections with complete pagination and explicit member evidence."""

from datetime import datetime, timezone
from uuid import UUID
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import Team, TeamMember, TeamRanking, TeamTitle, TeamActivity, Rating
from app.models.team_state import TeamTitleState
from app.models.user import User, UserProfile
from app.services.title_state import mark_watched
from app.services.teams import require_team_member, require_team_admin_or_owner

router = APIRouter()
Section = Literal["top_picks", "recently_added", "both_want_to_watch", "watched"]


class MemberEvidence(BaseModel):
    user_id: str
    name: str
    state: str
    rating: int | None = None


class TeamHomeTitle(BaseModel):
    id: str
    title: str
    poster_url: str | None
    backdrop_url: str | None
    year: int | None
    media_type: str
    rank_label: str | None = None
    context_label: str | None = None
    added_at: datetime | None = None
    members: list[MemberEvidence] = []
    my_state: str = "unknown"
    my_state_version: int = 0
    my_shared_rating: int | None = None
    member_average: float | None = None
    rating_count: int = 0
    activity_id: str | None = None
    liked_by_me: bool = False
    like_count: int = 0


class TeamPage(BaseModel):
    items: list[TeamHomeTitle]
    total: int
    next_offset: int | None


class TeamHomeSections(BaseModel):
    team_id: str
    team_name: str
    member_count: int
    can_manage: bool
    top_picks: list[TeamHomeTitle]
    recently_added: list[TeamHomeTitle]
    both_want_to_watch: list[TeamHomeTitle]
    watched: list[TeamHomeTitle]
    totals: dict[str, int]
    next_offsets: dict[str, int | None]


def page(db, team_id, viewer_id, section, limit=40, offset=0, all_members=False):
    members = list(
        db.scalars(
            select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.status == "active")
        ).all()
    )
    member_ids = [m.user_id for m in members]
    shared = list(
        db.scalars(
            select(TeamTitleState).where(
                TeamTitleState.team_id == team_id, TeamTitleState.user_id.in_(member_ids)
            )
        ).all()
    )
    by_title = {}
    for state in shared:
        by_title.setdefault(state.content_title_id, []).append(state)
    stmt = (
        select(TeamTitle, ContentTitle)
        .join(ContentTitle, ContentTitle.id == TeamTitle.content_title_id)
        .where(TeamTitle.team_id == team_id)
    )
    ranks = {}
    if section == "top_picks":
        ranks = {
            r.content_title_id: r.rank
            for r in db.scalars(
                select(TeamRanking)
                .where(TeamRanking.team_id == team_id)
                .order_by(TeamRanking.rank, TeamRanking.id)
                .limit(10)
            ).all()
        }
        stmt = (
            stmt.join(
                TeamRanking,
                (TeamRanking.team_id == team_id)
                & (TeamRanking.content_title_id == ContentTitle.id),
            )
            .where(ContentTitle.id.in_(ranks))
            .order_by(TeamRanking.rank, ContentTitle.id)
        )
    elif section in {"both_want_to_watch", "watched"}:
        needed = "want_to_watch" if section == "both_want_to_watch" else "watched"
        minimum = len(members) if all_members else 2 if section == "both_want_to_watch" else 1
        eligible = [
            tid
            for tid, states in by_title.items()
            if sum(s.state == needed for s in states) >= max(1, minimum)
        ]
        stmt = stmt.where(ContentTitle.id.in_(eligible)).order_by(
            TeamTitle.added_at.desc(), ContentTitle.id
        )
    else:
        stmt = stmt.order_by(TeamTitle.added_at.desc(), ContentTitle.id)
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    rows = db.execute(stmt.offset(offset).limit(limit)).all()
    profile_ids = set(member_ids) | {tt.added_by_user_id for tt, _ in rows}
    profiles = {
        p.user_id: p
        for p in db.scalars(select(UserProfile).where(UserProfile.user_id.in_(profile_ids))).all()
    }

    def name(uid):
        return (
            profiles[uid].display_name
            if uid in profiles
            else "Former member"
            if uid not in member_ids
            else "Member"
        )

    activities = db.scalars(
        select(TeamActivity)
        .where(
            TeamActivity.team_id == team_id,
            TeamActivity.content_title_id.in_([t.id for _, t in rows]),
            TeamActivity.activity_type == "title_added",
        )
        .order_by(TeamActivity.created_at, TeamActivity.id)
    ).all()
    activity_ids = {}
    for activity in activities:
        activity_ids.setdefault(activity.content_title_id, str(activity.id))
    reactions = db.scalars(
        select(TeamActivity).where(
            TeamActivity.team_id == team_id,
            TeamActivity.activity_type == "title_liked",
            TeamActivity.actor_user_id.in_(member_ids),
        )
    ).all()
    items = []
    for tt, title in rows:
        states = by_title.get(title.id, [])
        mine = next((s for s in states if s.user_id == viewer_id), None)
        evidence = [
            MemberEvidence(
                user_id=str(s.user_id), name=name(s.user_id), state=s.state, rating=s.shared_rating
            )
            for s in states
            if s.state != "unknown"
        ]
        ratings = [
            s.shared_rating for s in states if s.state == "watched" and s.shared_rating is not None
        ]
        if section == "top_picks":
            context = "Your team's ranked picks"
        elif section == "recently_added":
            context = f"{name(tt.added_by_user_id)} added this"
        else:
            wanted = section == "both_want_to_watch"
            count = sum(s.state == ("want_to_watch" if wanted else "watched") for s in states)
            context = (
                ("Both want to watch" if wanted else "Watched by both")
                if len(members) == 2 and count == 2
                else f"{'Wanted' if wanted else 'Watched'} by {count} of {len(members)}"
            )
        items.append(
            TeamHomeTitle(
                id=str(title.id),
                title=title.title,
                poster_url=title.poster_url,
                backdrop_url=title.backdrop_url,
                year=title.release_date.year if title.release_date else None,
                media_type=title.content_type,
                rank_label=f"#{ranks[title.id]}" if title.id in ranks else None,
                context_label=context,
                added_at=tt.added_at,
                members=evidence,
                my_state=mine.state if mine else "unknown",
                my_state_version=mine.version if mine else 0,
                my_shared_rating=mine.shared_rating if mine else None,
                member_average=round(sum(ratings) / len(ratings), 1) if ratings else None,
                rating_count=len(ratings),
                activity_id=activity_ids.get(title.id),
                liked_by_me=any(
                    r.actor_user_id == viewer_id and r.content_title_id == title.id
                    for r in reactions
                ),
                like_count=len(
                    {r.actor_user_id for r in reactions if r.content_title_id == title.id}
                ),
            )
        )
    return TeamPage(
        items=items,
        total=total,
        next_offset=offset + len(items) if offset + len(items) < total else None,
    )


@router.get("/{team_id}/home", response_model=TeamHomeSections)
def get_team_home(team_id: UUID, current_user: CurrentUser, db: DbSession):
    team = require_team_member(db, team_id, current_user.id)
    members = db.scalars(
        select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.status == "active")
    ).all()
    pages = {
        key: page(db, team_id, current_user.id, key)
        for key in ("top_picks", "recently_added", "both_want_to_watch", "watched")
    }
    return TeamHomeSections(
        team_id=str(team_id),
        team_name=team.name,
        member_count=len(members),
        can_manage=any(
            m.user_id == current_user.id and m.role in ("owner", "admin") for m in members
        ),
        **{k: p.items for k, p in pages.items()},
        totals={k: p.total for k, p in pages.items()},
        next_offsets={k: p.next_offset for k, p in pages.items()},
    )


@router.get("/{team_id}/home/{section}", response_model=TeamPage)
def get_team_page(
    team_id: UUID,
    section: Section,
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(40, ge=1, le=100),
    offset: int = Query(0, ge=0),
    all_members: bool = False,
):
    require_team_member(db, team_id, current_user.id)
    return page(db, team_id, current_user.id, section, limit, offset, all_members)


class SharedStateRequest(BaseModel):
    state: Literal["want_to_watch", "watched", "unknown"]
    share_rating: bool = False
    expected_version: int = Field(ge=0)


@router.put("/{team_id}/titles/{title_id}/my-state")
def share_team_state(
    team_id: UUID,
    title_id: UUID,
    payload: SharedStateRequest,
    current_user: CurrentUser,
    db: DbSession,
):
    require_team_member(db, team_id, current_user.id)
    db.scalar(select(User.id).where(User.id == current_user.id).with_for_update())
    db.scalar(select(Team.id).where(Team.id == team_id).with_for_update())
    if not db.scalar(
        select(TeamTitle.id).where(
            TeamTitle.team_id == team_id, TeamTitle.content_title_id == title_id
        )
    ):
        raise HTTPException(404, detail="Title is not in this team.")
    row = db.scalar(
        select(TeamTitleState)
        .where(
            TeamTitleState.team_id == team_id,
            TeamTitleState.user_id == current_user.id,
            TeamTitleState.content_title_id == title_id,
        )
        .execution_options(populate_existing=True)
    )
    if (row.version if row else 0) != payload.expected_version:
        raise HTTPException(409, detail="Team status changed. Refresh and try again.")
    score = None
    if payload.share_rating:
        score = db.scalar(
            select(Rating.score).where(
                Rating.user_id == current_user.id, Rating.content_title_id == title_id
            )
        )
        if score is None or payload.state != "watched":
            raise HTTPException(
                400, detail="Rate this title first, then choose to share that rating with the team."
            )
        score = int(round(float(score)))
    if payload.state == "watched":
        mark_watched(db, current_user.id, title_id, commit=False)
    if row is not None and row.state == payload.state and row.shared_rating == score:
        db.commit()
        return {"version": row.version, "state": row.state}
    if row is None:
        row = TeamTitleState(
            team_id=team_id,
            user_id=current_user.id,
            content_title_id=title_id,
            state=payload.state,
            version=1,
        )
        db.add(row)
    else:
        row.version += 1
        row.state = payload.state
    row.shared_rating = score
    row.updated_at = datetime.now(timezone.utc)
    db.add(
        TeamActivity(
            team_id=team_id,
            actor_user_id=current_user.id,
            content_title_id=title_id,
            activity_type="shared_status",
            payload={"state": payload.state, "rating": score, "version": row.version},
        )
    )
    db.commit()
    return {"version": row.version, "state": row.state}


class TeamRankMove(BaseModel):
    position: int = Field(ge=1)


@router.patch("/{team_id}/rankings/{title_id}")
def move_team_rank(
    team_id: UUID, title_id: UUID, payload: TeamRankMove, current_user: CurrentUser, db: DbSession
):
    require_team_admin_or_owner(db, team_id, current_user.id)
    db.scalar(select(Team.id).where(Team.id == team_id).with_for_update())
    rows = list(
        db.scalars(
            select(TeamRanking)
            .where(TeamRanking.team_id == team_id)
            .order_by(TeamRanking.rank, TeamRanking.id)
        ).all()
    )
    target = next((r for r in rows if r.content_title_id == title_id), None)
    if not target:
        raise HTTPException(404, detail="Ranked title not found.")
    if payload.position > len(rows):
        raise HTTPException(400, detail="Position is beyond the ranking.")
    rows.remove(target)
    rows.insert(payload.position - 1, target)
    for i, row in enumerate(rows):
        row.rank = i + 1
    db.commit()
    return {"position": target.rank, "total": len(rows)}


class DiscussionComment(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    request_id: UUID


@router.get("/{team_id}/discussions/{title_id}")
def get_discussion(team_id: UUID, title_id: UUID, current_user: CurrentUser, db: DbSession):
    require_team_member(db, team_id, current_user.id)
    if not db.scalar(
        select(TeamTitle.id).where(
            TeamTitle.team_id == team_id, TeamTitle.content_title_id == title_id
        )
    ):
        raise HTTPException(404, detail="Title unavailable.")
    rows = db.scalars(
        select(TeamActivity)
        .where(
            TeamActivity.team_id == team_id,
            TeamActivity.content_title_id == title_id,
            TeamActivity.activity_type.in_(
                ["title_added", "team_post", "activity_commented", "shared_status"]
            ),
        )
        .order_by(TeamActivity.created_at, TeamActivity.id)
    ).all()
    profiles = {
        p.user_id: p
        for p in db.scalars(
            select(UserProfile).where(UserProfile.user_id.in_([r.actor_user_id for r in rows]))
        ).all()
    }
    return {
        "items": [
            {
                "id": str(r.id),
                "actor": profiles[r.actor_user_id].display_name
                if r.actor_user_id in profiles
                else "Former member",
                "text": r.payload.get("comment")
                or r.payload.get("text")
                or (
                    "Shared " + r.payload.get("state", "").replace("_", " ")
                    if r.activity_type == "shared_status"
                    else "Added this title"
                ),
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ]
    }


@router.post("/{team_id}/discussions/{title_id}")
def post_discussion(
    team_id: UUID,
    title_id: UUID,
    payload: DiscussionComment,
    current_user: CurrentUser,
    db: DbSession,
):
    require_team_member(db, team_id, current_user.id)
    db.scalar(select(Team.id).where(Team.id == team_id).with_for_update())
    if not db.scalar(
        select(TeamTitle.id).where(
            TeamTitle.team_id == team_id, TeamTitle.content_title_id == title_id
        )
    ):
        raise HTTPException(404, detail="Title unavailable.")
    existing = db.get(TeamActivity, payload.request_id)
    if existing:
        if (
            existing.team_id != team_id
            or existing.actor_user_id != current_user.id
            or existing.content_title_id != title_id
            or existing.payload.get("comment") != payload.text.strip()
        ):
            raise HTTPException(409, detail="Comment request changed.")
    else:
        if not payload.text.strip():
            raise HTTPException(400, detail="Enter a comment.")
        db.add(
            TeamActivity(
                id=payload.request_id,
                team_id=team_id,
                actor_user_id=current_user.id,
                content_title_id=title_id,
                activity_type="activity_commented",
                payload={"comment": payload.text.strip()},
            )
        )
    db.commit()
    return get_discussion(team_id, title_id, current_user, db)


class TitleLike(BaseModel):
    liked: bool


@router.put("/{team_id}/titles/{title_id}/like")
def set_team_title_like(
    team_id: UUID, title_id: UUID, payload: TitleLike, current_user: CurrentUser, db: DbSession
):
    require_team_member(db, team_id, current_user.id)
    db.scalar(select(Team.id).where(Team.id == team_id).with_for_update())
    if not db.scalar(
        select(TeamTitle.id).where(
            TeamTitle.team_id == team_id, TeamTitle.content_title_id == title_id
        )
    ):
        raise HTTPException(404, detail="Title unavailable.")
    rows = db.scalars(
        select(TeamActivity).where(
            TeamActivity.team_id == team_id,
            TeamActivity.content_title_id == title_id,
            TeamActivity.actor_user_id == current_user.id,
            TeamActivity.activity_type == "title_liked",
        )
    ).all()
    if payload.liked and not rows:
        db.add(
            TeamActivity(
                team_id=team_id,
                actor_user_id=current_user.id,
                content_title_id=title_id,
                activity_type="title_liked",
                payload={},
            )
        )
    elif not payload.liked:
        for row in rows:
            db.delete(row)
    db.commit()
    return {"liked": payload.liked}
