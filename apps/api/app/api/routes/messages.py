"""Messaging HTTP surface — direct 1:1 conversations, per Messaging spec §35.

Every endpoint derives the sender from the authenticated session; the
client CANNOT specify a sender_user_id (spec §45). Membership and
privacy are re-checked on every mutation.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.dependencies import CurrentUser, DbSession
from app.services import messaging as msg_svc

router = APIRouter()


# ─── Request schemas ───────────────────────────────────────────────────


class DirectConversationRequest(BaseModel):
    recipient_user_id: UUID


class MessageSendRequest(BaseModel):
    # message_type is inferred server-side from what's present; the client
    # doesn't need to declare it. Simplifies the surface.
    text_body: str | None = Field(default=None, max_length=1200)
    content_type: str | None = Field(default=None, pattern="^(title|list)$")
    content_id: UUID | None = None
    client_message_id: str | None = Field(default=None, max_length=64)


class MuteRequest(BaseModel):
    muted: bool


# ─── Error mapping ─────────────────────────────────────────────────────


def _raise_from_error(err: msg_svc.MessagingError) -> None:
    raise HTTPException(status_code=err.status_code, detail=str(err))


# ─── Endpoints ─────────────────────────────────────────────────────────


@router.get("/conversations")
def list_conversations_route(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=25, ge=1, le=100),
) -> dict:
    items = msg_svc.list_conversations(db, viewer_id=current_user.id, limit=limit)
    return {"items": items}


@router.get("/conversations/unread-count")
def unread_count_route(current_user: CurrentUser, db: DbSession) -> dict:
    return {"count": msg_svc.unread_conversations_count(db, current_user.id)}


@router.post("/conversations/direct", status_code=status.HTTP_200_OK)
def start_direct_conversation(
    payload: DirectConversationRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    """Idempotent start-or-get. Returns the direct conversation between
    the current user and recipient_user_id — creating it on first call,
    reusing it thereafter. Privacy-gated."""
    if payload.recipient_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot message yourself")
    if not msg_svc._can_message(db, current_user.id, payload.recipient_user_id):
        raise HTTPException(status_code=403, detail="You can't message this user")
    try:
        convo = msg_svc.get_or_create_direct_conversation(
            db, current_user.id, payload.recipient_user_id
        )
    except msg_svc.MessagingError as e:
        _raise_from_error(e)
    return {"conversation_id": str(convo.id)}


@router.get("/conversations/{conversation_id}/messages")
def list_messages_route(
    conversation_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=50, ge=1, le=100),
    before: datetime | None = Query(default=None),
) -> dict:
    try:
        msgs = msg_svc.list_messages(
            db,
            viewer_id=current_user.id,
            conversation_id=conversation_id,
            limit=limit,
            before_created_at=before,
        )
    except msg_svc.MessagingError as e:
        _raise_from_error(e)
    # Reverse to chronological order for the client's default render.
    hydrated = [msg_svc.hydrate_message(db, m) for m in reversed(msgs)]
    return {"items": hydrated}


@router.post("/conversations/{conversation_id}/messages", status_code=status.HTTP_201_CREATED)
def send_message_route(
    conversation_id: UUID,
    payload: MessageSendRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> dict:
    try:
        msg = msg_svc.send_message(
            db,
            sender_id=current_user.id,
            conversation_id=conversation_id,
            text_body=payload.text_body,
            content_type=payload.content_type,
            content_id=payload.content_id,
            client_message_id=payload.client_message_id,
        )
    except msg_svc.MessagingError as e:
        _raise_from_error(e)
    return msg_svc.hydrate_message(db, msg)


@router.post("/conversations/{conversation_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read_route(
    conversation_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    try:
        msg_svc.mark_read(db, viewer_id=current_user.id, conversation_id=conversation_id)
    except msg_svc.MessagingError as e:
        _raise_from_error(e)
    return None


@router.post("/conversations/{conversation_id}/mute", status_code=status.HTTP_204_NO_CONTENT)
def mute_route(
    conversation_id: UUID,
    payload: MuteRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    try:
        msg_svc.toggle_mute(
            db,
            viewer_id=current_user.id,
            conversation_id=conversation_id,
            muted=payload.muted,
        )
    except msg_svc.MessagingError as e:
        _raise_from_error(e)
    return None


@router.post("/conversations/{conversation_id}/hide", status_code=status.HTTP_204_NO_CONTENT)
def hide_route(
    conversation_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    try:
        msg_svc.hide_conversation(
            db, viewer_id=current_user.id, conversation_id=conversation_id
        )
    except msg_svc.MessagingError as e:
        _raise_from_error(e)
    return None
