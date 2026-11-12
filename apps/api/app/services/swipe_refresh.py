"""Best-effort derived taste refresh, outside the swipe acknowledgement.

The discovery ledger and title state are committed synchronously. SceneDNA's
title scorer reads that ledger directly. Display summaries also check the
ledger on read, so a stopped Cloud Run instance cannot lose a taste update.
"""
from datetime import datetime, timezone
import logging
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session
from app.db.session import engine
from app.models.discovery import DiscoveryDecision
from app.models.taste import UserSignal, UserTasteProfile


def newer_discovery(db, user_id, updated_at):
    if updated_at is None:
        return True
    return db.scalar(select(DiscoveryDecision.id).where(
        DiscoveryDecision.user_id == user_id,
        (DiscoveryDecision.created_at > updated_at) | (DiscoveryDecision.undone_at > updated_at),
    ).limit(1)) is not None


def refresh_after_swipe(user_id):
    # Use a separate connection/session, never the request's closing Session.
    # A session-level advisory lock survives the legacy builders' commits.
    # Overlapping tasks skip instead of tying up the request pool waiting.
    lock = int.from_bytes(user_id.bytes[:8], "big", signed=True)
    with engine.connect() as connection:
        postgres = connection.dialect.name == "postgresql"
        locked = False
        try:
            if postgres:
                locked = bool(connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": lock}))
                connection.commit()
                if not locked:
                    return
            with Session(bind=connection) as db:
                profile = db.get(UserTasteProfile, user_id)
                if profile and not newer_discovery(db, user_id, profile.updated_at):
                    return
                started = datetime.now(timezone.utc)
                from app.services.taste import _prune_old_swipes, refresh_taste_profile
                from app.services.user_signals import compute_user_signals
                _prune_old_swipes(db, user_id)
                compute_user_signals(db, user_id)
                profile = refresh_taste_profile(db, user_id)
                # Date the summaries at the start of computation. An action
                # arriving during computation must still trigger a read repair.
                profile.updated_at = started
                db.execute(update(UserSignal).where(UserSignal.user_id == user_id).values(last_updated=started))
                db.commit()
        except Exception as error:
            connection.rollback()
            logging.getLogger("seensnap.swipe").warning("derived_refresh_failed type=%s", type(error).__name__)
        finally:
            if postgres and locked:
                connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": lock})
                connection.commit()
