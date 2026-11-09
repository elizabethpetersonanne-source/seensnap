"""Resolve notification subjects against current access, never arbitrary routes."""
from fastapi import HTTPException
from sqlalchemy import select

from app.models.messaging import Conversation, ConversationParticipant
from app.models.social import FeedEvent, Team, TeamMember, TeamActivity
from app.models.user import UserProfile
from app.services.social_feed import require_social_post
from app.services.visibility import unblocked_owner_clause, can_view_profile


def resolve_destination(db, notification, viewer_id):
    fallback = {"route": "/(tabs)/social", "available": False,
                "message": "This activity is no longer available. You can return to Social."}
    subject = notification.entity_id
    kind = notification.entity_type
    if not subject:
        return fallback
    route = None
    if kind in {"post", "feed_event", "social_post"}:
        try:
            require_social_post(db, viewer_id, subject)
        except HTTPException:
            return fallback
        route = f"/post/{subject}"
    elif kind == "user":
        if can_view_profile(db, subject, viewer_id):
            route = f"/profile/{subject}"
    elif kind == "conversation":
        member = db.scalar(select(ConversationParticipant.id).join(
            Conversation, Conversation.id == ConversationParticipant.conversation_id,
        ).where(Conversation.id == subject, ConversationParticipant.user_id == viewer_id))
        if member:
            route = f"/messages/{subject}"
    elif kind in {"team", "team_activity"}:
        team_id = subject if kind == "team" else db.scalar(select(TeamActivity.team_id).where(TeamActivity.id == subject))
        member = db.scalar(select(TeamMember.id).join(Team, Team.id == TeamMember.team_id).where(
            TeamMember.team_id == team_id, TeamMember.user_id == viewer_id,
            TeamMember.status == "active", Team.archived_at.is_(None),
        )) if team_id else None
        if member:
            route = f"/teams/{team_id}/home"
    return {"route": route, "available": True, "message": None} if route else fallback
