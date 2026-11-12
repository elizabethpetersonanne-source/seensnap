from datetime import datetime, timezone
from uuid import UUID
from fastapi import HTTPException
from sqlalchemy import func, select
from app.models.discovery import DiscoveryDecision
from app.models.social import Rating, RankedFavorite, TitleWatchStatus, Watchlist, WatchlistItem
from app.models.taste import SwipeRecord
from app.models.user import User


def excluded_title_ids(db, user_id):
    """Current hard exclusions. Only committed discovery decisions advance cooldown."""
    excluded = set(db.scalars(select(WatchlistItem.content_title_id).join(
        Watchlist, Watchlist.id == WatchlistItem.watchlist_id,
    ).where(Watchlist.owner_user_id == user_id)).all())
    excluded.update(db.scalars(select(RankedFavorite.content_title_id).where(RankedFavorite.user_id == user_id)).all())
    excluded.update(db.scalars(select(Rating.content_title_id).where(
        Rating.user_id == user_id, (Rating.watched_state == "watched") | Rating.score.is_not(None),
    )).all())
    excluded.update(db.scalars(select(TitleWatchStatus.content_title_id).where(
        TitleWatchStatus.user_id == user_id, TitleWatchStatus.watched_state == "watched",
    )).all())
    # Last 100 ACTIONS, not last 100 dismissals: a left decision leaves this
    # window at exactly 100 subsequent accepted, non-undone decisions.
    recent = db.scalars(select(DiscoveryDecision).where(
        DiscoveryDecision.user_id == user_id, DiscoveryDecision.undone_at.is_(None),
        DiscoveryDecision.sequence.is_not(None),
    ).order_by(DiscoveryDecision.sequence.desc()).limit(100)).all()
    excluded.update(d.content_title_id for d in recent if d.direction == "left")
    for decision in db.scalars(select(DiscoveryDecision).where(
        DiscoveryDecision.user_id == user_id, DiscoveryDecision.undone_at.is_(None),
        DiscoveryDecision.direction == "down",
    )).all():
        rating = db.scalar(select(Rating).where(Rating.user_id == user_id, Rating.content_title_id == decision.content_title_id))
        if rating is None or not rating.updated_at or rating.updated_at.replace(tzinfo=timezone.utc) <= decision.created_at.replace(tzinfo=timezone.utc):
            excluded.add(decision.content_title_id)
    return excluded


def watch_snapshot(db, user_id, title_id):
    rating = db.scalar(select(Rating).where(Rating.user_id == user_id, Rating.content_title_id == title_id))
    status = db.scalar(select(TitleWatchStatus).where(TitleWatchStatus.user_id == user_id, TitleWatchStatus.content_title_id == title_id))
    return {
        "rating": {"id": str(rating.id), "version": rating.version, "watched_state": rating.watched_state} if rating else None,
        "status": {"id": str(status.id), "watched_state": status.watched_state, "updated_at": status.updated_at.isoformat()} if status else None,
    }


def create_decision(db, record, before, source_surface):
    sequence = None
    if not (source_surface or "").startswith("onboarding"):
        sequence = int(db.scalar(select(func.max(DiscoveryDecision.sequence)).where(DiscoveryDecision.user_id == record.user_id)) or 0) + 1
    decision = DiscoveryDecision(
        id=record.id, user_id=record.user_id, content_title_id=record.content_title_id,
        sequence=sequence, direction=record.direction, action_version=record.action_version, idempotency_key=record.idempotency_key,
        state_before=before, state_after=watch_snapshot(db, record.user_id, record.content_title_id),
    )
    db.add(decision)


def undo_decision(db, user_id, swipe_id, *, refresh_derived=True):
    db.scalar(select(User.id).where(User.id == user_id).with_for_update())
    decision = db.scalar(select(DiscoveryDecision).where(DiscoveryDecision.id == swipe_id, DiscoveryDecision.user_id == user_id))
    if decision is None:
        raise HTTPException(status_code=404, detail="Swipe not found")
    if decision.undone_at:
        return {"reversed": [], "partial_reason": None, "watched": _watched(db, user_id, decision.content_title_id)}
    newer = db.scalar(select(DiscoveryDecision.id).where(
        DiscoveryDecision.user_id == user_id, DiscoveryDecision.content_title_id == decision.content_title_id,
        ((DiscoveryDecision.sequence > decision.sequence) if decision.sequence is not None else (DiscoveryDecision.created_at > decision.created_at)), DiscoveryDecision.undone_at.is_(None),
    ))
    if newer:
        raise HTTPException(status_code=409, detail="This title has a newer decision. Refresh before changing it.")
    reversed_bits, partial = ["swipe"], None
    current = watch_snapshot(db, user_id, decision.content_title_id)
    if decision.direction in {"up", "down"}:
        if not decision.state_before or current != decision.state_after:
            partial = "newer_or_unknown_watch_state"
        else:
            from app.services.title_revisions import advance_revision
            revision=advance_revision(db,user_id,decision.content_title_id)
            before = decision.state_before
            rating = db.scalar(select(Rating).where(Rating.user_id == user_id, Rating.content_title_id == decision.content_title_id))
            status = db.scalar(select(TitleWatchStatus).where(TitleWatchStatus.user_id == user_id, TitleWatchStatus.content_title_id == decision.content_title_id))
            if rating is not None and before.get("rating"):
                rating.watched_state = before["rating"]["watched_state"]
                rating.version = revision
                rating.updated_at = datetime.now(timezone.utc)
            if status is not None:
                if before.get("status"):
                    status.watched_state = before["status"]["watched_state"]
                    status.updated_at = datetime.now(timezone.utc)
                else:
                    db.delete(status)
            queue_item = before.get("removed_queue_item")
            if queue_item:
                wl = db.scalar(select(Watchlist).where(Watchlist.id == UUID(queue_item["watchlist_id"]), Watchlist.owner_user_id == user_id))
                existing = db.scalar(select(WatchlistItem.id).where(WatchlistItem.watchlist_id == wl.id, WatchlistItem.content_title_id == decision.content_title_id)) if wl else None
                if wl and not existing:
                    db.add(WatchlistItem(watchlist_id=wl.id, content_title_id=decision.content_title_id,
                        added_via=queue_item["added_via"], position=queue_item.get("position"), notes=queue_item.get("notes")))
            reversed_bits.append("watched")
    # Right means interest, not Save. Never erase any list on its Undo.
    decision.undone_at = datetime.now(timezone.utc)
    record = db.get(SwipeRecord, swipe_id)
    if record:
        db.delete(record)
    db.commit()
    if refresh_derived:
        try:
            from app.services.taste import refresh_taste_profile
            from app.services.user_signals import compute_user_signals
            refresh_taste_profile(db, user_id)
            compute_user_signals(db, user_id)
            db.commit()
        except Exception:
            db.rollback()
    return {"reversed": reversed_bits, "partial_reason": partial,
            "watched": _watched(db, user_id, decision.content_title_id)}


def _watched(db, user_id, title_id):
    snapshot = watch_snapshot(db, user_id, title_id)
    return any(value and value["watched_state"] == "watched" for value in snapshot.values())
