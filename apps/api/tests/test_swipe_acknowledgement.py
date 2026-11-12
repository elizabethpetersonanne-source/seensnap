from uuid import uuid4
from datetime import datetime, timedelta, timezone
from fastapi import BackgroundTasks
from sqlalchemy import select, func
from app.api.routes import titles
from app.models.content import ContentTitle
from app.models.user import User
from app.models.discovery import DiscoveryDecision
from app.schemas.taste import SwipeRecordCreate
from app.services import taste
from app.services.swipe_refresh import newer_discovery


def test_acknowledgement_and_retry_do_not_wait_for_derived_work(db, monkeypatch):
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    title = ContentTitle(id=uuid4(), tmdb_id=1, content_type="movie", title="Film")
    db.add_all([user, title]); db.commit()
    def forbidden(*args, **kwargs):
        raise AssertionError("Derived work cannot block the swipe acknowledgement")
    monkeypatch.setattr(taste, "refresh_taste_profile", forbidden)
    monkeypatch.setattr(titles, "build_swipe_feedback", forbidden)
    payload = SwipeRecordCreate(title_id=title.id, direction="right", idempotency_key="one-durable-choice")
    tasks = BackgroundTasks()
    first = titles.record_title_swipe(payload, user, db, tasks)
    retry = titles.record_title_swipe(payload, user, db, BackgroundTasks())
    assert first.swipe_id == retry.swipe_id
    assert db.scalar(select(func.count()).select_from(DiscoveryDecision)) == 1
    assert len(tasks.tasks) == 1 and first.scene_dna_feedback is None
    assert newer_discovery(db, user.id, datetime.now(timezone.utc) - timedelta(days=1))
    assert not newer_discovery(db, user.id, datetime.now(timezone.utc) + timedelta(seconds=1))
    undone = titles.undo_title_swipe(first.swipe_id, user, db, BackgroundTasks())
    assert "swipe" in undone.reversed


def test_prefetch_read_does_not_enrich_or_mutate_catalog(db, monkeypatch):
    title = ContentTitle(id=uuid4(), tmdb_id=1, content_type="movie", title="Film", overview="Cached synopsis")
    db.add(title); db.commit()
    def forbidden(*args, **kwargs):
        raise AssertionError("Prefetch must not call remote enrichment")
    for method in ("refresh_title_details", "refresh_streaming_options", "resolve_wikipedia_metadata", "fetch_title_gallery", "fetch_related_titles"):
        monkeypatch.setattr(titles, method, forbidden)
    result = titles.get_title(title.id, db, enrich=False)
    assert result.overview == "Cached synopsis" and result.id == title.id


def test_background_refresh_uses_new_session_and_read_repairs_new_actions(db, monkeypatch):
    import pytest
    if db.bind.dialect.name != "postgresql": pytest.skip("complete summary tables require PostgreSQL")
    from app.services import swipe_refresh
    from app.models.taste import UserTasteProfile
    user = User(id=uuid4(), email=f"{uuid4()}@example.invalid", auth_provider="test")
    title = ContentTitle(id=uuid4(), tmdb_id=1, content_type="movie", title="Film", genres=["Comedy"])
    db.add_all([user, title]); db.commit()
    taste.record_swipe(db, user.id, title_id=title.id, direction="right", refresh_derived=False)
    monkeypatch.setattr(swipe_refresh, "engine", db.get_bind())
    swipe_refresh.refresh_after_swipe(user.id)
    db.expire_all()
    profile = db.get(UserTasteProfile, user.id)
    assert profile is not None and not newer_discovery(db, user.id, profile.updated_at)
    decision = db.scalar(select(DiscoveryDecision))
    decision.undone_at = datetime.now(timezone.utc) + timedelta(seconds=1)
    db.commit()
    assert newer_discovery(db, user.id, profile.updated_at)
