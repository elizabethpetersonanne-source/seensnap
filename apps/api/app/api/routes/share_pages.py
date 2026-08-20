"""Public web landing pages for shared content — Sharing Phase B.

Serves:
  - GET /lists/{token}          — HTML preview of a shared list with OG tags
  - GET /titles/{kind}/{tmdb}   — HTML preview of a title with OG tags
  - GET /.well-known/apple-app-site-association — iOS Universal Links config
  - GET /.well-known/assetlinks.json             — Android App Links config

Landing pages exist for two reasons:
  1. When someone shares a URL in Messages / iMessage / Slack / Twitter, the
     link renderer scrapes OG meta tags and shows a real preview.
  2. If the app isn't installed, the visitor still lands on a marketing page
     with an "Open in SeenSnap" CTA and a link to install.

Universal Links (iOS) + App Links (Android) means iOS/Android intercepts these
URLs and opens the app directly when installed — the HTML is only rendered
when the app can't handle the link.

Kept intentionally dependency-free (no template engine) — this is a small
number of pages and inline HTML keeps the deployment simple.
"""
from __future__ import annotations

import html
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import select

from app.api.dependencies import DbSession
from app.core.config import settings
from app.models.content import ContentTitle
from app.models.social import ListShare, Watchlist, WatchlistItem
from app.models.user import UserProfile

router = APIRouter()

# iOS bundle id + Android package should stay in sync with apps/mobile/app.json.
# When these change, AASA / assetlinks must be re-served, and Apple/Google
# re-crawl their caches on the next TLS request.
IOS_APP_ID_PREFIX = "TEAMIDXXXX"  # replace with Apple Team ID before ship
IOS_BUNDLE_ID = "com.seensnap.app"
ANDROID_PACKAGE = "com.seensnap.app"
# SHA-256 signing cert fingerprint — placeholder until we have a release
# keystore. `expo credentials:manager` prints the current fingerprint.
ANDROID_SHA256_FINGERPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"

APP_STORE_URL = "https://apps.apple.com/app/seensnap/id0"       # placeholder
PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.seensnap.app"


def _og_page(
    *,
    title: str,
    description: str,
    image_url: str | None,
    canonical_url: str,
    deep_link: str,
    body_html: str,
) -> str:
    """Render a lean HTML page with OG + Twitter Card meta tags.

    Kept as a single inline template because we only have two page kinds; a
    real template engine is overkill and adds a runtime dependency."""
    esc_title = html.escape(title)
    esc_desc = html.escape(description)
    esc_canonical = html.escape(canonical_url, quote=True)
    esc_deep = html.escape(deep_link, quote=True)
    esc_image = html.escape(image_url, quote=True) if image_url else ""

    og_image_tags = ""
    if esc_image:
        og_image_tags = (
            f'<meta property="og:image" content="{esc_image}" />'
            f'<meta name="twitter:image" content="{esc_image}" />'
        )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{esc_title} · SeenSnap</title>
  <meta name="description" content="{esc_desc}" />
  <link rel="canonical" href="{esc_canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="SeenSnap" />
  <meta property="og:title" content="{esc_title}" />
  <meta property="og:description" content="{esc_desc}" />
  <meta property="og:url" content="{esc_canonical}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{esc_title}" />
  <meta name="twitter:description" content="{esc_desc}" />
  {og_image_tags}
  <style>
    :root {{ color-scheme: dark; }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at 20% 10%, rgba(244,196,48,0.10), transparent 30%), #0b1424;
      color: #f6f0e6; line-height: 1.5;
    }}
    .wrap {{ max-width: 640px; margin: 0 auto; padding: 40px 24px 80px; }}
    .kicker {{
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #f4c430;
    }}
    h1 {{ font-family: Georgia, serif; font-size: 40px; line-height: 1.05; margin: 12px 0 16px; letter-spacing: -0.02em; }}
    .desc {{ color: #cfd6df; font-size: 17px; margin: 0 0 28px; }}
    .cta {{
      display: inline-block; background: #f4c430; color: #0b1424; padding: 14px 22px; border-radius: 999px;
      font-weight: 700; text-decoration: none; margin-right: 8px; margin-bottom: 8px;
    }}
    .cta.secondary {{ background: transparent; color: #f6f0e6; border: 1px solid rgba(246,240,230,0.24); }}
    .grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 32px; }}
    .poster {{ aspect-ratio: 2 / 3; background: #1a2432; border-radius: 6px; overflow: hidden; }}
    .poster img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
    footer {{ margin-top: 60px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.08); color: #99a4b3; font-size: 13px; }}
  </style>
</head>
<body>
  <main class="wrap">
    {body_html}
    <div style="margin-top: 32px;">
      <a class="cta" href="{esc_deep}">Open in SeenSnap</a>
      <a class="cta secondary" href="{APP_STORE_URL}">iOS App Store</a>
      <a class="cta secondary" href="{PLAY_STORE_URL}">Google Play</a>
    </div>
    <footer>
      <p>SeenSnap is where you save what you love, discover what's next, and share it with the people you watch with.</p>
    </footer>
  </main>
  <script>
    // Best-effort: try to open the app directly on mobile. If the app isn't
    // installed, the browser stays on this page and the CTA is still visible.
    (function tryDeepLink() {{
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (!isMobile) return;
      window.setTimeout(function () {{
        window.location.href = {repr(deep_link)};
      }}, 250);
    }})();
  </script>
</body>
</html>
"""


@router.get("/lists/{token}", response_class=HTMLResponse)
def public_list_landing(token: str, db: DbSession) -> HTMLResponse:
    share = db.scalar(
        select(ListShare).where(ListShare.token == token, ListShare.revoked_at.is_(None))
    )
    if share is None:
        return HTMLResponse(
            _og_page(
                title="Link no longer active",
                description="This shared list has been revoked or the link is invalid.",
                image_url=None,
                canonical_url=f"{settings.share_base_url.rstrip('/')}/lists/{token}",
                deep_link=f"seensnap://lists/{token}",
                body_html='<span class="kicker">SeenSnap</span><h1>Link no longer active.</h1><p class="desc">The owner revoked this share, or the link was never valid.</p>',
            ),
            status_code=status.HTTP_404_NOT_FOUND,
        )

    watchlist = db.scalar(select(Watchlist).where(Watchlist.id == share.watchlist_id))
    if watchlist is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")

    items = db.execute(
        select(WatchlistItem, ContentTitle)
        .join(ContentTitle, ContentTitle.id == WatchlistItem.content_title_id)
        .where(WatchlistItem.watchlist_id == watchlist.id)
        .order_by(WatchlistItem.created_at.desc())
        .limit(9)
    ).all()
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == watchlist.owner_user_id))
    owner_name = profile.display_name if profile and profile.display_name else "A SeenSnap user"

    posters_html = ""
    hero_image = None
    for _, t in items:
        if t.poster_url and not hero_image:
            hero_image = t.poster_url
        if t.poster_url:
            posters_html += f'<div class="poster"><img src="{html.escape(t.poster_url, quote=True)}" alt="" /></div>'
    grid_html = f'<div class="grid">{posters_html}</div>' if posters_html else ""

    total_items = db.scalar(
        select(WatchlistItem)
        .where(WatchlistItem.watchlist_id == watchlist.id)
    )
    item_count = db.scalar(
        select(WatchlistItem.id).where(WatchlistItem.watchlist_id == watchlist.id).limit(1)
    )
    # Cheap count — re-run a proper count so the copy is accurate.
    from sqlalchemy import func as sql_func

    real_count = int(
        db.scalar(
            select(sql_func.count(WatchlistItem.id)).where(WatchlistItem.watchlist_id == watchlist.id)
        )
        or 0
    )
    description_line = watchlist.description or f"{real_count} title{'s' if real_count != 1 else ''} curated by {owner_name}."

    body = (
        f'<span class="kicker">Shared List · {html.escape(owner_name)}</span>'
        f'<h1>{html.escape(watchlist.name)}</h1>'
        f'<p class="desc">{html.escape(description_line)}</p>'
        f'{grid_html}'
    )

    return HTMLResponse(
        _og_page(
            title=f"{watchlist.name} — a SeenSnap list by {owner_name}",
            description=description_line,
            image_url=hero_image,
            canonical_url=f"{settings.share_base_url.rstrip('/')}/lists/{token}",
            deep_link=f"seensnap://lists/{token}",
            body_html=body,
        )
    )


@router.get("/titles/{kind}/{tmdb_id}", response_class=HTMLResponse)
def public_title_landing(kind: str, tmdb_id: int, db: DbSession) -> HTMLResponse:
    if kind not in ("movie", "tv"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown title kind")

    # We look up the title in our own content_titles table (populated whenever
    # a user has interacted with the title). If it's not in our cache yet,
    # render a minimal landing that still opens the app deep link.
    content_type = "movie" if kind == "movie" else "series"
    title = db.scalar(
        select(ContentTitle).where(
            ContentTitle.tmdb_id == tmdb_id,
            ContentTitle.content_type == content_type,
        )
    )

    canonical = f"{settings.share_base_url.rstrip('/')}/titles/{kind}/{tmdb_id}"
    deep_link = f"seensnap://titles/{kind}/{tmdb_id}"

    if title is None:
        body = (
            '<span class="kicker">Title · SeenSnap</span>'
            '<h1>This title lives inside SeenSnap.</h1>'
            '<p class="desc">Open the app to see ratings, taste-matched recommendations, and save it to your lists.</p>'
        )
        return HTMLResponse(
            _og_page(
                title="Open in SeenSnap",
                description="See where to watch, save it to a list, and get taste-matched recommendations.",
                image_url=None,
                canonical_url=canonical,
                deep_link=deep_link,
                body_html=body,
            )
        )

    year = title.release_date.year if title.release_date else None
    year_str = f" ({year})" if year else ""
    tagline = title.overview or "See where to watch, save it, and get taste-matched recommendations."
    body = (
        f'<span class="kicker">Title · SeenSnap</span>'
        f'<h1>{html.escape(title.title)}{html.escape(year_str)}</h1>'
        f'<p class="desc">{html.escape(tagline[:280])}</p>'
    )
    if title.poster_url:
        body += f'<div class="grid" style="grid-template-columns: 200px;"><div class="poster"><img src="{html.escape(title.poster_url, quote=True)}" alt="" /></div></div>'

    return HTMLResponse(
        _og_page(
            title=f"{title.title}{year_str} — on SeenSnap",
            description=tagline[:280],
            image_url=title.backdrop_url or title.poster_url,
            canonical_url=canonical,
            deep_link=deep_link,
            body_html=body,
        )
    )


@router.get("/.well-known/apple-app-site-association")
def apple_app_site_association() -> JSONResponse:
    """Universal Links (iOS) — Apple crawls this file when the app is installed
    (or on TLS certificate refresh) to decide which paths open the app directly.
    Must be served as application/json, over HTTPS, without redirects."""
    payload = {
        "applinks": {
            "apps": [],
            "details": [
                {
                    "appID": f"{IOS_APP_ID_PREFIX}.{IOS_BUNDLE_ID}",
                    "paths": ["/lists/*", "/titles/*"],
                }
            ],
        }
    }
    # Explicitly no Cache-Control tuning — Apple ignores it and refetches on
    # its own schedule. Content-Type must be application/json.
    return JSONResponse(content=payload, media_type="application/json")


@router.get("/.well-known/assetlinks.json")
def android_asset_links() -> JSONResponse:
    """Android App Links (Digital Asset Links). Similar role to AASA:
    associates the domain with the app so intercepted URLs open the app
    when installed. Google verifies the SHA-256 signing cert fingerprint."""
    payload = [
        {
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {
                "namespace": "android_app",
                "package_name": ANDROID_PACKAGE,
                "sha256_cert_fingerprints": [ANDROID_SHA256_FINGERPRINT],
            },
        }
    ]
    return JSONResponse(content=payload, media_type="application/json")
