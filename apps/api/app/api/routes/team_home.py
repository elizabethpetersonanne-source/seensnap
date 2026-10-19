"""Oct-18 UI/UX rebuild: Team Home immersive sections.

Returns the four sections the Team Home screen renders:
  - top_picks           → team's top 10 rankings
  - recently_added      → team titles sorted by added_at desc
  - both_want_to_watch  → titles every member has in their Next Watch
  - watched             → titles with watched status from any member

One call hydrates every section with poster/backdrop/year metadata
so the mobile client can lay out immediately.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.models.social import (
    Rating,
    TeamMember,
    TeamRanking,
    TeamTitle,
    TitleWatchStatus,
    Watchlist,
    WatchlistItem,
)
from app.models.user import UserProfile
from app.services.teams import require_team_member


router = APIRouter()


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


class TeamHomeSections(BaseModel):
    team_id: str
    team_name: str
    member_count: int
    top_picks: list[TeamHomeTitle]
    recently_added: list[TeamHomeTitle]
    both_want_to_watch: list[TeamHomeTitle]
    watched: list[TeamHomeTitle]


def _to_home_title(
    t: ContentTitle,
    *,
    rank: int | None = None,
    context: str | None = None,
    added_at: datetime | None = None,
) -> TeamHomeTitle:
    return TeamHomeTitle(
        id=str(t.id),
        title=t.title,
        poster_url=t.poster_url,
        backdrop_url=t.backdrop_url,
        year=t.release_date.year if t.release_date else None,
        media_type=t.content_type,
        rank_label=f"#{rank}" if rank is not None else None,
        context_label=context,
        added_at=added_at,
    )


@router.get("/{team_id}/home", response_model=TeamHomeSections)
def get_team_home(
    team_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> TeamHomeSections:
    team = require_team_member(db, team_id, current_user.id)

    members = db.scalars(select(TeamMember).where(TeamMember.team_id == team_id)).all()
    member_ids = [m.user_id for m in members]

    # ── Top picks — team's ranked 10 ────────────────────────────────
    rankings = db.scalars(
        select(TeamRanking)
        .where(TeamRanking.team_id == team_id)
        .order_by(TeamRanking.rank.asc())
        .limit(10)
    ).all()
    ranked_title_ids = [r.content_title_id for r in rankings]
    titles_map = {
        t.id: t for t in (
            db.scalars(select(ContentTitle).where(ContentTitle.id.in_(ranked_title_ids))).all()
            if ranked_title_ids else []
        )
    }
    top_picks = [
        _to_home_title(titles_map[r.content_title_id], rank=r.rank)
        for r in rankings
        if r.content_title_id in titles_map
    ]

    # ── Recently added — team titles by added_at desc ────────────────
    recent_rows = db.execute(
        select(TeamTitle, ContentTitle, UserProfile)
        .join(ContentTitle, ContentTitle.id == TeamTitle.content_title_id)
        .outerjoin(UserProfile, UserProfile.user_id == TeamTitle.added_by_user_id)
        .where(TeamTitle.team_id == team_id)
        .order_by(TeamTitle.created_at.desc())
        .limit(40)
    ).all()
    recently_added = [
        _to_home_title(
            t,
            context=f"{profile.display_name} added this" if profile and profile.display_name else "Added",
            added_at=tt.created_at,
        )
        for tt, t, profile in recent_rows
    ]

    # ── Both want to watch — titles present in EVERY member's Next
    # Watch list. Fallback to any want-to-watch TitleWatchStatus if
    # the member doesn't have a Next Watch list yet. ────────────────
    both_want_titles: list[TeamHomeTitle] = []
    if len(member_ids) > 0:
        want_sets: list[set[UUID]] = []
        for mid in member_ids:
            member_want: set[UUID] = set()
            # Pull want_to_watch TitleWatchStatus rows.
            ws_rows = db.scalars(
                select(TitleWatchStatus).where(
                    TitleWatchStatus.user_id == mid,
                    TitleWatchStatus.watched_state == "want_to_watch",
                )
            ).all()
            member_want.update(w.content_title_id for w in ws_rows)
            # Also include titles in any of their watchlists (saved = want).
            lists = db.scalars(select(Watchlist).where(Watchlist.owner_user_id == mid)).all()
            if lists:
                items = db.scalars(
                    select(WatchlistItem.content_title_id).where(
                        WatchlistItem.watchlist_id.in_([wl.id for wl in lists])
                    )
                ).all()
                member_want.update(items)
            want_sets.append(member_want)
        if want_sets:
            intersection = want_sets[0].intersection(*want_sets[1:])
            if intersection:
                shared_titles = db.scalars(
                    select(ContentTitle).where(ContentTitle.id.in_(intersection))
                ).all()
                both_want_titles = [
                    _to_home_title(t, context="Both want to watch")
                    for t in shared_titles
                ][:40]

    # ── Watched — titles with watched state from any member ─────────
    watched_titles: list[TeamHomeTitle] = []
    if member_ids:
        watched_ids = set(
            db.scalars(
                select(Rating.content_title_id).where(
                    Rating.user_id.in_(member_ids),
                    Rating.watched_state == "watched",
                )
            ).all()
        )
        watched_ids.update(
            db.scalars(
                select(TitleWatchStatus.content_title_id).where(
                    TitleWatchStatus.user_id.in_(member_ids),
                    TitleWatchStatus.watched_state == "watched",
                )
            ).all()
        )
        if watched_ids:
            watched_rows = db.scalars(
                select(ContentTitle).where(ContentTitle.id.in_(watched_ids))
            ).all()
            watched_titles = [
                _to_home_title(t, context="Watched together") for t in watched_rows
            ][:40]

    return TeamHomeSections(
        team_id=str(team_id),
        team_name=team.name,
        member_count=len(member_ids),
        top_picks=top_picks,
        recently_added=recently_added,
        both_want_to_watch=both_want_titles,
        watched=watched_titles,
    )
