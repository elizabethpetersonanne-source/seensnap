from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.social import FeedComment, FeedEvent
from app.models.user import UserProfile
from app.schemas.content import TitleResponse
from app.schemas.feed import (
    FeedActorResponse,
    FeedCommentCreateRequest,
    FeedCommentResponse,
    FeedEventResponse,
    FeedReactionRequest,
    FeedWallPostCreateRequest,
)
from app.services.feed import (
    add_comment,
    build_feed_response_data,
    clear_reaction,
    create_wall_post,
    delete_feed_comment,
    delete_feed_event,
    get_feed_event,
    list_comments,
    list_feed_discover,
    list_feed_for_you,
    list_feed_watch_teams,
    require_event_access,
    set_reaction,
)

router = APIRouter()


@router.get("/for-you", response_model=list[FeedEventResponse])
def get_for_you_feed(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=50, ge=1, le=100),
) -> list[FeedEventResponse]:
    events = list_feed_for_you(db, current_user.id, limit)
    return _feed_response(events, db, current_user.id)


@router.get("/watch-teams", response_model=list[FeedEventResponse])
def get_watch_teams_feed(
    current_user: CurrentUser,
    db: DbSession,
    team_id: UUID | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> list[FeedEventResponse]:
    events = list_feed_watch_teams(db, current_user.id, team_id, limit)
    return _feed_response(events, db, current_user.id)


@router.get("/discover", response_model=list[FeedEventResponse])
def get_discover_feed(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=50, ge=1, le=100),
) -> list[FeedEventResponse]:
    events = list_feed_discover(db, current_user.id, limit)
    return _feed_response(events, db, current_user.id)


@router.post("/wall-posts", response_model=FeedEventResponse, status_code=status.HTTP_201_CREATED)
def create_social_wall_post(
    payload: FeedWallPostCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> FeedEventResponse:
    event = create_wall_post(
        db,
        actor_user_id=current_user.id,
        content_title_id=payload.content_title_id,
        caption=payload.caption,
        rating=payload.rating,
        share_to_team_id=payload.share_to_team_id,
    )
    return _feed_response([event], db, current_user.id)[0]


@router.post("/{event_id}/reactions", response_model=FeedEventResponse, status_code=status.HTTP_200_OK)
def react_to_feed_event(
    event_id: UUID,
    payload: FeedReactionRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> FeedEventResponse:
    event = get_feed_event(db, event_id)
    require_event_access(db, event, current_user.id)
    set_reaction(db, event, current_user.id, payload.reaction)
    refreshed = get_feed_event(db, event_id)
    return _feed_response([refreshed], db, current_user.id)[0]


@router.delete("/{event_id}/reactions/me", response_model=FeedEventResponse, status_code=status.HTTP_200_OK)
def remove_my_reaction(
    event_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> FeedEventResponse:
    event = get_feed_event(db, event_id)
    require_event_access(db, event, current_user.id)
    clear_reaction(db, event, current_user.id)
    refreshed = get_feed_event(db, event_id)
    return _feed_response([refreshed], db, current_user.id)[0]


@router.post("/{event_id}/comments", response_model=FeedCommentResponse, status_code=status.HTTP_201_CREATED)
def comment_on_feed_event(
    event_id: UUID,
    payload: FeedCommentCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> FeedCommentResponse:
    event = get_feed_event(db, event_id)
    require_event_access(db, event, current_user.id)
    comment = add_comment(db, event=event, user_id=current_user.id, body=payload.body)
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == comment.user_id))
    return FeedCommentResponse(
        id=comment.id,
        event_id=comment.event_id,
        user_id=comment.user_id,
        display_name=profile.display_name if profile else None,
        avatar_url=profile.avatar_url if profile else None,
        body=comment.body,
        parent_comment_id=comment.parent_comment_id,
        can_delete=comment.user_id == current_user.id,
        created_at=comment.created_at,
    )


@router.post(
    "/comments/{comment_id}/replies",
    response_model=FeedCommentResponse,
    status_code=status.HTTP_201_CREATED,
)
def reply_to_feed_comment(
    comment_id: UUID,
    payload: FeedCommentCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> FeedCommentResponse:
    parent_comment = db.scalar(select(FeedComment).where(FeedComment.id == comment_id))
    if parent_comment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found")

    event = get_feed_event(db, parent_comment.event_id)
    require_event_access(db, event, current_user.id)
    comment = add_comment(
        db,
        event=event,
        user_id=current_user.id,
        body=payload.body,
        parent_comment_id=parent_comment.id,
    )
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == comment.user_id))
    return FeedCommentResponse(
        id=comment.id,
        event_id=comment.event_id,
        user_id=comment.user_id,
        display_name=profile.display_name if profile else None,
        avatar_url=profile.avatar_url if profile else None,
        body=comment.body,
        parent_comment_id=comment.parent_comment_id,
        can_delete=comment.user_id == current_user.id,
        created_at=comment.created_at,
    )


@router.get("/{event_id}/comments", response_model=list[FeedCommentResponse])
def get_feed_comments(event_id: UUID, current_user: CurrentUser, db: DbSession) -> list[FeedCommentResponse]:
    event = get_feed_event(db, event_id)
    require_event_access(db, event, current_user.id)
    comments = list_comments(db, event_id)
    if not comments:
        return []

    profiles = {
        profile.user_id: profile
        for profile in db.scalars(
            select(UserProfile).where(UserProfile.user_id.in_({comment.user_id for comment in comments}))
        ).all()
    }
    return [
        FeedCommentResponse(
            id=comment.id,
            event_id=comment.event_id,
            user_id=comment.user_id,
            display_name=profiles.get(comment.user_id).display_name if profiles.get(comment.user_id) else None,
            avatar_url=profiles.get(comment.user_id).avatar_url if profiles.get(comment.user_id) else None,
            body=comment.body,
            parent_comment_id=comment.parent_comment_id,
            can_delete=comment.user_id == current_user.id,
            created_at=comment.created_at,
        )
        for comment in comments
    ]


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_my_feed_post(event_id: UUID, current_user: CurrentUser, db: DbSession) -> None:
    event = get_feed_event(db, event_id)
    require_event_access(db, event, current_user.id)
    delete_feed_event(db, event=event, requester_user_id=current_user.id)
    return None


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_my_feed_comment(comment_id: UUID, current_user: CurrentUser, db: DbSession) -> None:
    comment = db.scalar(select(FeedComment).where(FeedComment.id == comment_id))
    if comment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found")
    event = get_feed_event(db, comment.event_id)
    require_event_access(db, event, current_user.id)
    delete_feed_comment(db, comment=comment, requester_user_id=current_user.id)
    return None


def _feed_response(events: list[FeedEvent], db: DbSession, viewer_user_id: UUID) -> list[FeedEventResponse]:
    if not events:
        return []
    profiles, titles, reaction_counts, my_reactions, comment_counts, following_ids = build_feed_response_data(
        db, events, viewer_user_id
    )
    return [
        FeedEventResponse(
            id=event.id,
            team_id=event.team_id,
            event_type=event.event_type,
            source_type=event.source_type,
            source_id=event.source_id,
            actor=FeedActorResponse(
                user_id=event.actor_user_id,
                display_name=profiles.get(event.actor_user_id).display_name
                if profiles.get(event.actor_user_id)
                else None,
                avatar_url=profiles.get(event.actor_user_id).avatar_url
                if profiles.get(event.actor_user_id)
                else None,
                is_following=event.actor_user_id in following_ids,
            ),
            title=_to_title_response(titles[event.content_title_id])
            if event.content_title_id in titles
            else None,
            payload=event.payload,
            reaction_counts=dict(reaction_counts.get(event.id, {})),
            comment_count=comment_counts.get(event.id, 0),
            my_reaction=my_reactions.get(event.id),
            can_delete=event.actor_user_id == viewer_user_id,
            created_at=event.created_at,
        )
        for event in events
    ]


def _to_title_response(title) -> TitleResponse:
    metadata = title.metadata_raw or {}
    credits = metadata.get("credits", {}) if isinstance(metadata, dict) else {}
    crew = credits.get("crew", []) if isinstance(credits, dict) else []
    cast = credits.get("cast", []) if isinstance(credits, dict) else []
    director = next(
        (
            person.get("name")
            for person in crew
            if isinstance(person, dict) and person.get("job") == "Director" and person.get("name")
        ),
        None,
    )
    top_cast = [
        person.get("name")
        for person in cast
        if isinstance(person, dict) and person.get("name")
    ][:5]
    poster_url = title.poster_url or "/media/brand/seensnap_logo.png"
    if "seensnap_logo" in poster_url:
        poster_url = "/media/brand/seensnap_logo.png"
    backdrop_url = title.backdrop_url or poster_url
    if backdrop_url and "seensnap_logo" in backdrop_url:
        backdrop_url = poster_url
    return TitleResponse(
        id=title.id,
        tmdb_id=title.tmdb_id,
        content_type=title.content_type,
        title=title.title,
        original_title=title.original_title,
        overview=title.overview,
        poster_url=poster_url,
        backdrop_url=backdrop_url,
        genres=title.genres,
        release_date=title.release_date,
        runtime_minutes=title.runtime_minutes,
        season_count=title.season_count,
        tmdb_rating=float(title.tmdb_vote_average) if title.tmdb_vote_average is not None else None,
        language=metadata.get("original_language") if isinstance(metadata, dict) else None,
        director=director,
        top_cast=top_cast,
    )
