"""Oct-18 build brief §6 share-asset generator — boundary + honest unavailable state.

The brief requires a shareable asset (poster + Take + rating badge) that
users can post to Instagram / Twitter. Rendering requires a configured
image renderer (headless browser, puppeteer worker, or a managed card
service like Imgix / Vercel OG). We define the boundary now so that:

  1. The endpoint always has a stable response shape (status + payload).
  2. When no renderer is configured, we return status="unavailable" with
     an honest reason — never a fake preview, never a broken image URL.
  3. When a provider becomes available, the switch is one function:
     set `settings.share_asset_renderer_url` and implement the fetch.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from uuid import UUID

from app.core.config import settings


@dataclass
class ShareAssetRequest:
    user_id: UUID
    title_id: UUID
    take: str | None = None
    include_rating: bool = True
    include_rank: bool = False


@dataclass
class ShareAssetResult:
    status: str                    # "ready" | "unavailable"
    status_detail: str = ""
    asset_url: str | None = None
    expires_at: str | None = None
    payload: dict = field(default_factory=dict)


def generate_share_asset(req: ShareAssetRequest) -> ShareAssetResult:
    """Generate a shareable image asset. Returns an unavailable result
    when no renderer is configured — brief §6 explicitly forbids
    fabricating preview URLs or returning broken content."""
    renderer = getattr(settings, "share_asset_renderer_url", None)
    if not renderer:
        return ShareAssetResult(
            status="unavailable",
            status_detail=(
                "Share-asset renderer is not configured in this environment. "
                "Add settings.share_asset_renderer_url and an image-renderer provider to enable."
            ),
        )

    # Boundary intentionally stops here: wiring the actual renderer
    # requires provider credentials + an image CDN. Returning a stub
    # URL would violate the brief's no-fabrication rule, so we treat
    # a configured-but-unimplemented environment as unavailable.
    return ShareAssetResult(
        status="unavailable",
        status_detail=(
            "Share-asset renderer URL is set but no provider adapter is wired. "
            "Implement the provider call in app/services/share_asset.py."
        ),
    )
