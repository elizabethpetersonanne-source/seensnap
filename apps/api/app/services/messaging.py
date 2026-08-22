"""MessagingService — direct 1:1 conversations, per Messaging spec §35–§45.

Boundary: this service handles conversation state, message persistence,
authorization, and unread bookkeeping. Push notifications live in
NotificationService and are called out to explicitly. Safety (blocking,
reporting) reuses the existing social Block model.

Every mutation derives the acting user from the authenticated session —
NEVER from client-supplied IDs. See spec §45.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session

from app.models.content import ContentTitle
from app.models.messaging import Conversation, ConversationParticipant, Message
from app.models.social import Block, Watchlist
from app.models.user import User, UserProfile
from app.services.follows import is_following
from app.services.teams import list_user_teams


# ─── Errors ─────────────────────────────────────────────────────────────


class MessagingError(Exception):
    """Base for messaging service errors — HTTP layer maps to 4xx codes."""

    status_code: int = 400


class NotAuthorized(MessagingError):
    status_code = 403


class NotFound(MessagingError):
    status_code = 404


class RateLimited(MessagingError):
    status_code = 429


class InvalidPayload(MessagingError):
    status_code = 400


# ─── Constants ─────────────────────────────────────────────────────────

MAX_TEXT_LENGTH = 1000  # spec §12
DEFAULT_INBOX_PAGE = 25
DEFAULT_MESSAGES_PAGE = 50


# ─── Pair key ──────────────────────────────────────────────────────────


def _pair_key(a: UUID, b: UUID) -> str:
    """Canonical `min:max` key so (A, B) and (B, A) map to the same
    conversation. Enforced unique in the schema via partial index."""
    left, right = sorted([str(a), str(b)])
    return f"{left}:{right}"


# ─── Authorization ─────────────────────────────────────────────────────


def _is_blocked_either_way(db: Session, user_a: UUID, user_b: UUID) -> bool:
    """True if either user has blocked the other. Blocking is bidirectional
    in visibility per spec §32 — blocked user disappears entirely."""
    return db.scalar(
        select(exists().where(
            or_(
                and_(Block.blocker_user_id == user_a, Block.blocked_user_id == user_b),
                and_(Block.blocker_user_id == user_b, Block.blocked_user_id == user_a),
            )
        ))
    ) or False


def _can_message(db: Session, sender_id: UUID, recipient_id: UUID) -> bool:
    """Privacy gate per spec §10. MVP default: "People I follow + Watch
    Team members" — meaning A can message B if:
      - A follows B (A opted into the relationship), OR
      - B follows A (B invited A into their circle), OR
      - A and B share at least one Watch Team.
    Blocking always wins. Same-user is always allowed (own inbox view).
    """
    if sender_id == recipient_id:
        return True
    if _is_blocked_either_way(db, sender_id, recipient_id):
        return False
    if is_following(db, sender_id, recipient_id):
        return True
    if is_following(db, recipient_id, sender_id):
        return True
    # Shared Watch Team check — cheapest to build via the teams service
    # (returns a small list) and set-intersect.
    sender_teams = {t.id for t, _ in list_user_teams(db, sender_id)}
    if not sender_teams:
        return False
    recipient_teams = {t.id for t, _ in list_user_teams(db, recipient_id)}
    return bool(sender_teams & recipient_teams)


# ─── Conversation lookup / create ──────────────────────────────────────


def get_or_create_direct_conversation(
    db: Session, user_a: UUID, user_b: UUID
) -> Conversation:
    """Idempotent — returns the existing direct conversation between the
    two users if one exists, otherwise creates it. Callers must have
    already checked `_can_message` — this function does not.
    """
    if user_a == user_b:
        raise InvalidPayload("Cannot start a conversation with yourself")

    pair = _pair_key(user_a, user_b)
    existing = db.scalar(
        select(Conversation).where(
            Conversation.pair_key == pair,
            Conversation.conversation_type == "direct",
        )
    )
    if existing is not None:
        return existing

    convo = Conversation(
        id=uuid4(),
        conversation_type="direct",
        pair_key=pair,
    )
    db.add(convo)
    db.flush()
    # Two participant rows — one per user.
    for uid in (user_a, user_b):
        db.add(ConversationParticipant(
            id=uuid4(),
            conversation_id=convo.id,
            user_id=uid,
        ))
    db.commit()
    db.refresh(convo)
    return convo


def _membership(db: Session, convo_id: UUID, user_id: UUID) -> ConversationParticipant | None:
    return db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == convo_id,
            ConversationParticipant.user_id == user_id,
        )
    )


def _require_membership(db: Session, convo_id: UUID, user_id: UUID) -> ConversationParticipant:
    m = _membership(db, convo_id, user_id)
    if m is None:
        raise NotFound("Conversation not found")
    return m


def _other_participant_id(db: Session, convo_id: UUID, viewer_user_id: UUID) -> UUID | None:
    """Return the OTHER user in a direct conversation, or None if the
    conversation has only one participant (shouldn't happen but defensive)."""
    row = db.scalar(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == convo_id,
            ConversationParticipant.user_id != viewer_user_id,
        ).limit(1)
    )
    return row


# ─── Rate limits ───────────────────────────────────────────────────────


_RATE_LIMIT_MSG_PER_HOUR = 120  # spec §46
_RATE_LIMIT_CONVERSATIONS_PER_HOUR = 20


def _check_message_rate_limit(db: Session, sender_id: UUID) -> None:
    since = datetime.now(timezone.utc).timestamp() - 3600
    count = db.scalar(
        select(func.count(Message.id)).where(
            Message.sender_user_id == sender_id,
            Message.created_at >= datetime.fromtimestamp(since, tz=timezone.utc),
        )
    ) or 0
    if count >= _RATE_LIMIT_MSG_PER_HOUR:
        raise RateLimited("Slow down — you've sent too many messages in the last hour.")


# ─── Message send ──────────────────────────────────────────────────────


def send_message(
    db: Session,
    *,
    sender_id: UUID,
    conversation_id: UUID,
    text_body: str | None = None,
    content_type: str | None = None,
    content_id: UUID | None = None,
    client_message_id: str | None = None,
) -> Message:
    """Persist a message. Enforces membership, privacy re-check, and
    idempotency. Returns the canonical message; on repeat calls with the
    same client_message_id, returns the previously-created row.
    """
    _require_membership(db, conversation_id, sender_id)

    # Re-check privacy at send time — a follow could have been revoked
    # between conversation creation and this message. Fails soft (403)
    # so the sender knows their access changed.
    other_id = _other_participant_id(db, conversation_id, sender_id)
    if other_id is not None and not _can_message(db, sender_id, other_id):
        raise NotAuthorized("You can no longer message this user")

    # Idempotency — return the existing message if the client retried.
    if client_message_id:
        existing = db.scalar(
            select(Message).where(
                Message.sender_user_id == sender_id,
                Message.conversation_id == conversation_id,
                Message.client_message_id == client_message_id,
            )
        )
        if existing is not None:
            return existing

    # Validate payload
    text = (text_body or "").strip() or None
    if text is not None and len(text) > MAX_TEXT_LENGTH:
        raise InvalidPayload(f"Message text exceeds {MAX_TEXT_LENGTH} characters")

    if content_type is not None:
        if content_type not in ("title", "list"):
            raise InvalidPayload(f"Unsupported content_type: {content_type}")
        if content_id is None:
            raise InvalidPayload("content_id is required when content_type is set")

    if text is None and content_type is None:
        raise InvalidPayload("Message must have text and/or content")

    _check_message_rate_limit(db, sender_id)

    # Build a small snapshot so cards still render honestly if the
    # underlying object is later deleted / made private (spec §18, §62).
    snapshot: dict | None = None
    if content_type == "title":
        title = db.scalar(select(ContentTitle).where(ContentTitle.id == content_id))
        if title is None:
            raise NotFound("Title not found")
        snapshot = {
            "title": title.title,
            "poster_url": title.poster_url,
            "content_type_kind": title.content_type,
            "tmdb_id": title.tmdb_id,
            "year": title.release_date.year if title.release_date else None,
        }
    elif content_type == "list":
        watchlist = db.scalar(select(Watchlist).where(Watchlist.id == content_id))
        if watchlist is None:
            raise NotFound("List not found")
        # Only the owner can send their own list per spec §19 conservative
        # MVP rule (private lists cannot be sent — we'll extend to
        # public-only later; for MVP, owner-only send).
        if watchlist.owner_user_id != sender_id:
            raise NotAuthorized("You can only send your own lists")
        snapshot = {
            "name": watchlist.name,
            "description": watchlist.description,
        }

    if text and content_type:
        message_type = "text_with_content"
    elif content_type:
        message_type = "content"
    else:
        message_type = "text"

    msg = Message(
        id=uuid4(),
        conversation_id=conversation_id,
        sender_user_id=sender_id,
        message_type=message_type,
        text_body=text,
        content_type=content_type,
        content_id=content_id,
        snapshot_json=snapshot,
        client_message_id=client_message_id,
    )
    db.add(msg)
    db.flush()

    # Update conversation cursors.
    convo = db.scalar(select(Conversation).where(Conversation.id == conversation_id))
    if convo is not None:
        convo.last_message_id = msg.id
        convo.last_message_at = msg.created_at
        # A message revives a hidden conversation for the recipient
        # (spec §34 — hide reappears on new activity).
        recipient_membership = _membership(db, conversation_id, other_id) if other_id else None
        if recipient_membership is not None and recipient_membership.hidden_at is not None:
            recipient_membership.hidden_at = None
    # Sender's own message is implicitly "read".
    sender_membership = _membership(db, conversation_id, sender_id)
    if sender_membership is not None:
        sender_membership.last_read_at = msg.created_at
        sender_membership.last_read_message_id = msg.id
    db.commit()
    db.refresh(msg)

    # Fire push notification to the OTHER participant.
    if other_id is not None:
        try:
            from app.services.notifications import notify_message_received
            sender = db.scalar(select(User).where(User.id == sender_id))
            if sender is not None:
                notify_message_received(
                    db,
                    sender=sender,
                    recipient_id=other_id,
                    conversation_id=conversation_id,
                    message=msg,
                    is_demo=sender.is_demo,
                )
        except Exception:
            # Never let a push-notification failure fail a message send.
            pass

    return msg


# ─── Read state ────────────────────────────────────────────────────────


def mark_read(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> None:
    """Set the viewer's last_read cursor to the latest message. Idempotent."""
    membership = _require_membership(db, conversation_id, viewer_id)
    latest = db.scalar(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    now = datetime.now(timezone.utc)
    membership.last_read_at = now
    membership.last_read_message_id = latest.id if latest else None
    db.commit()


def toggle_mute(db: Session, *, viewer_id: UUID, conversation_id: UUID, muted: bool) -> None:
    membership = _require_membership(db, conversation_id, viewer_id)
    membership.muted_at = datetime.now(timezone.utc) if muted else None
    db.commit()


def hide_conversation(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> None:
    membership = _require_membership(db, conversation_id, viewer_id)
    membership.hidden_at = datetime.now(timezone.utc)
    db.commit()


# ─── Reads: inbox, message list ────────────────────────────────────────


def list_conversations(
    db: Session, *, viewer_id: UUID, limit: int = DEFAULT_INBOX_PAGE
) -> list[dict]:
    """Return the viewer's inbox — one row per conversation they participate
    in that isn't hidden. Sorted by last_message_at desc. Each row is
    already hydrated (other user info + last message preview + unread count).
    """
    rows = db.execute(
        select(ConversationParticipant, Conversation)
        .join(Conversation, Conversation.id == ConversationParticipant.conversation_id)
        .where(
            ConversationParticipant.user_id == viewer_id,
            ConversationParticipant.hidden_at.is_(None),
        )
        .order_by(Conversation.last_message_at.desc().nullslast())
        .limit(limit)
    ).all()

    out: list[dict] = []
    for participant, convo in rows:
        other_id = _other_participant_id(db, convo.id, viewer_id)
        other_profile = (
            db.scalar(select(UserProfile).where(UserProfile.user_id == other_id))
            if other_id
            else None
        )
        last_msg = None
        if convo.last_message_id:
            last_msg = db.scalar(select(Message).where(Message.id == convo.last_message_id))

        unread_count = db.scalar(
            select(func.count(Message.id)).where(
                Message.conversation_id == convo.id,
                Message.sender_user_id != viewer_id,
                (
                    Message.created_at > participant.last_read_at
                    if participant.last_read_at is not None
                    else True
                ),
            )
        ) or 0

        out.append({
            "conversation_id": str(convo.id),
            "other_user": {
                "user_id": str(other_id) if other_id else None,
                "display_name": other_profile.display_name if other_profile else None,
                "username": other_profile.username if other_profile else None,
                "avatar_url": other_profile.avatar_url if other_profile else None,
            },
            "last_message": _message_to_dict(last_msg) if last_msg else None,
            "unread_count": int(unread_count),
            "muted": participant.muted_at is not None,
            "updated_at": (convo.last_message_at or convo.updated_at).isoformat(),
        })
    return out


def unread_conversations_count(db: Session, viewer_id: UUID) -> int:
    """Number of conversations with at least one unread message from the
    other party. Powers the header badge — count of conversations, NOT
    count of individual messages (spec §41)."""
    rows = db.execute(
        select(ConversationParticipant, Conversation)
        .join(Conversation, Conversation.id == ConversationParticipant.conversation_id)
        .where(
            ConversationParticipant.user_id == viewer_id,
            ConversationParticipant.hidden_at.is_(None),
        )
    ).all()
    unread = 0
    for participant, convo in rows:
        last_from_other = db.scalar(
            select(Message.created_at).where(
                Message.conversation_id == convo.id,
                Message.sender_user_id != viewer_id,
            ).order_by(Message.created_at.desc()).limit(1)
        )
        if last_from_other is None:
            continue
        if participant.last_read_at is None or last_from_other > participant.last_read_at:
            unread += 1
    return unread


def list_messages(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    limit: int = DEFAULT_MESSAGES_PAGE,
    before_created_at: datetime | None = None,
) -> list[Message]:
    """Return page of messages ordered newest-first (client renders oldest
    to newest, scroll up loads older). Membership-gated."""
    _require_membership(db, conversation_id, viewer_id)
    conds = [Message.conversation_id == conversation_id]
    if before_created_at is not None:
        conds.append(Message.created_at < before_created_at)
    return list(
        db.scalars(
            select(Message)
            .where(and_(*conds))
            .order_by(Message.created_at.desc())
            .limit(limit)
        ).all()
    )


# ─── Hydration ─────────────────────────────────────────────────────────


def _message_to_dict(msg: Message | None) -> dict | None:
    if msg is None:
        return None
    out: dict = {
        "id": str(msg.id),
        "conversation_id": str(msg.conversation_id),
        "sender_user_id": str(msg.sender_user_id),
        "message_type": msg.message_type,
        "text_body": msg.text_body,
        "content_type": msg.content_type,
        "content_id": str(msg.content_id) if msg.content_id else None,
        "created_at": msg.created_at.isoformat(),
    }
    # Snapshot + a hydrated "current" view of the referenced object so
    # the client can render a card with real up-to-date metadata while
    # still gracefully degrading to the snapshot if the object went away.
    if msg.content_type == "title" and msg.content_id:
        # Fetched lazily by the API route via hydrate_message when needed.
        out["snapshot"] = msg.snapshot_json
    elif msg.content_type == "list":
        out["snapshot"] = msg.snapshot_json
    return out


def hydrate_message(db: Session, msg: Message) -> dict:
    """Build a fully-rendered message dict including current title/list
    metadata (with graceful fallback to the snapshot when the referenced
    object is deleted / made private)."""
    data = _message_to_dict(msg) or {}
    if msg.content_type == "title" and msg.content_id:
        title = db.scalar(select(ContentTitle).where(ContentTitle.id == msg.content_id))
        if title is not None:
            data["title"] = {
                "id": str(title.id),
                "tmdb_id": title.tmdb_id,
                "title": title.title,
                "content_type": title.content_type,
                "poster_url": title.poster_url,
                "backdrop_url": title.backdrop_url,
                "year": title.release_date.year if title.release_date else None,
            }
        else:
            # Title deleted — degrade to snapshot only. `title: null`
            # tells the client to render "This title is no longer available."
            data["title"] = None
    elif msg.content_type == "list" and msg.content_id:
        watchlist = db.scalar(select(Watchlist).where(Watchlist.id == msg.content_id))
        if watchlist is not None:
            data["list"] = {
                "id": str(watchlist.id),
                "name": watchlist.name,
                "description": watchlist.description,
                "owner_user_id": str(watchlist.owner_user_id),
            }
        else:
            data["list"] = None
    return data
