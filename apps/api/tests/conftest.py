"""Isolated domain tests: no live accounts, model calls or TMDB credentials."""

import importlib
import os
from uuid import uuid4
from pathlib import Path
import pytest
from sqlalchemy import create_engine, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session
from app.db.base import Base


@compiles(JSONB, "sqlite")
def sqlite_json(element, compiler, **kw):
    return "JSON"


@compiles(UniqueConstraint, "sqlite")
def sqlite_unique(element, compiler, **kw):
    # SQLite domain tests cannot exercise PostgreSQL deferred constraints.
    # Keep uniqueness, but reserve concurrent ranking/migration tests for PG.
    sql = compiler.visit_unique_constraint(element, **kw)
    return sql.replace(" DEFERRABLE", "").replace(" INITIALLY DEFERRED", "")


@pytest.fixture
def db():
    for path in (Path(__file__).parents[1] / "app/models").glob("*.py"):
        importlib.import_module(f"app.models.{path.stem}")
    url = os.environ.get("TEST_DATABASE_URL", "sqlite://")
    schema = "test_" + uuid4().hex
    engine = create_engine(url)
    if engine.dialect.name == "postgresql":
        with engine.begin() as conn:
            conn.execute(text(f"CREATE SCHEMA {schema}"))
        engine.dispose()
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    names = {
        "users",
        "content_titles",
        "content_availability",
        "watchlists",
        "watchlist_items",
        "ratings",
        "ranked_favorites",
        "title_watch_status",
        "user_signals",
        "concierge_decisions",
    }
    Base.metadata.create_all(
        engine,
        tables=None
        if engine.dialect.name == "postgresql"
        else [t for t in Base.metadata.tables.values() if t.name in names],
    )
    with Session(engine) as session:
        yield session
    if engine.dialect.name == "postgresql":
        with engine.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
    engine.dispose()
