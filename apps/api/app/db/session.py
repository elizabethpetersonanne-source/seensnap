from sqlalchemy import create_engine
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import sessionmaker

from app.core.config import settings


def _make_engine():
    """Build a SQLAlchemy engine from settings.database_url.

    Cloud Run + Cloud SQL: when Cloud Run is deployed with
    `--add-cloudsql-instances=PROJECT:REGION:INSTANCE`, Google mounts a
    unix socket at `/cloudsql/PROJECT:REGION:INSTANCE`. A DATABASE_URL of
    the form
        postgresql+psycopg://user:pass@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE
    routes through that socket automatically — no proxy sidecar, no
    connector library. Works transparently with psycopg's URL parser.

    Local dev: normal TCP DATABASE_URL still works unchanged.

    Pool sizing is deliberately small for Cloud Run — each revision only
    handles a handful of concurrent requests before scaling, and Cloud
    SQL connection quotas favor short-lived pools with pre-ping.
    """
    url = make_url(settings.database_url)

    is_cloud_sql_socket = (
        (url.host is None or url.host == "")
        and url.query.get("host", "").startswith("/cloudsql/")
    )

    engine_kwargs = {
        "future": True,
        # pool_pre_ping tests connections before use — matters for both
        # Cloud Run cold-starts and Cloud SQL idle-connection timeouts.
        "pool_pre_ping": True,
        # Recycle before Cloud SQL's default idle timeout (30 min).
        "pool_recycle": 1500,
    }
    if is_cloud_sql_socket:
        # Cloud Run instances are ephemeral; a small pool is right.
        engine_kwargs["pool_size"] = 5
        engine_kwargs["max_overflow"] = 5

    return create_engine(url, **engine_kwargs)


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
