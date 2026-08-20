from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.router import api_router
from app.api.routes.share_pages import router as share_pages_router
from app.core.config import settings
from app.core.limiter import limiter


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings.validate_production_safety()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.include_router(api_router, prefix=settings.api_v1_prefix)
# Public share-page routes are mounted at the ROOT (no /api/v1 prefix) so
# shareable URLs read like https://seensnap.app/lists/{token} — clean URLs
# also matter for iOS Universal Links matching the paths listed in AASA.
app.include_router(share_pages_router)
uploads_dir = settings.uploads_path()
uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(uploads_dir)), name="uploads")
app.mount("/media", StaticFiles(directory=str(uploads_dir)), name="media")


@app.get("/health", tags=["health"])
def healthcheck() -> dict[str, str]:
    return {"status": "ok", "environment": settings.environment}
