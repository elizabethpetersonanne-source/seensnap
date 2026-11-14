"""Small post-response catalog repairs; never invent missing semantic metadata."""
from datetime import datetime, timedelta, timezone
import logging
from time import monotonic
from uuid import UUID
from sqlalchemy import select
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.content import ContentTitle
from app.models.social import Rating
from app.services.tmdb import refresh_title_details, fetch_popular_titles, _fresh_stamp

log = logging.getLogger(__name__)


def enrich_for_you(user_id: UUID, title_ids, preferred_type=None, genre=None, *, sparse=False):
    if not settings.tmdb_api_key:
        return
    started = monotonic()
    completed = failed = 0
    with SessionLocal() as db:
        # Rated evidence deserves metadata as much as candidate posters do.
        seeds = list(db.scalars(select(Rating.content_title_id).where(Rating.user_id == user_id)
            .order_by(Rating.updated_at.desc()).limit(3)))
        ids = list(dict.fromkeys([*seeds, *title_ids[:3]]))
        for title_id in ids:
            if monotonic() - started > 20:
                break
            title = db.get(ContentTitle, title_id)
            if title is None or _fresh_stamp((title.metadata_raw or {}).get("_seensnap_details_at")):
                continue
            # Failed providers are cooled down too, so swiping between tabs
            # cannot repeatedly hammer the same unavailable metadata endpoint.
            if _fresh_stamp((title.metadata_raw or {}).get("_seensnap_enrichment_attempt"), hours=1):
                continue
            title.metadata_raw = {**(title.metadata_raw or {}), "_seensnap_enrichment_attempt": datetime.now(timezone.utc).isoformat()}
            db.commit()
            try:
                refresh_title_details(db, title, timeout_seconds=3)
                completed += 1
            except Exception:
                db.rollback()
                failed += 1
        if sparse and monotonic() - started < 20:
            try:
                fetch_popular_titles(db, limit=20, max_pages=1, timeout_seconds=3,
                    media_type_filter=preferred_type, genre_filter=genre)
            except Exception:
                db.rollback()
                failed += 1
    log.info("catalog_enrichment completed=%s failed=%s", completed, failed)
