from fastapi import APIRouter

from app.api.routes import analytics, auth, collections, devices, discover, feed, list_shares, me, messages, notifications, profiles, recommendations, search, shares, snips, social, teams, titles, watch_options, watchlist

api_router = APIRouter()
api_router.include_router(analytics.router, prefix="/events", tags=["analytics"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(me.router, prefix="/me", tags=["me"])
api_router.include_router(titles.router, prefix="/titles", tags=["titles"])
api_router.include_router(watchlist.router, prefix="/me/watchlist", tags=["watchlist"])
api_router.include_router(feed.router, prefix="/feed", tags=["feed"])
api_router.include_router(snips.router, prefix="/snips", tags=["snips"])
api_router.include_router(teams.router, prefix="/teams", tags=["teams"])
api_router.include_router(shares.router, prefix="/shares", tags=["shares"])
api_router.include_router(notifications.router, prefix="/notifications", tags=["notifications"])
api_router.include_router(devices.router, prefix="/devices", tags=["devices"])
api_router.include_router(profiles.router, prefix="/profiles", tags=["profiles"])
api_router.include_router(discover.router, prefix="/discover", tags=["discover"])
api_router.include_router(collections.router, prefix="/collections", tags=["collections"])
api_router.include_router(search.router, prefix="/search", tags=["search"])
api_router.include_router(watch_options.router, prefix="/titles", tags=["watch-options"])
# Unified recommendation service — SceneDNA brief §29. Every SeenSnap surface
# that needs recommendations goes through this endpoint (mode-scoped).
api_router.include_router(recommendations.router, prefix="/recommendations", tags=["recommendations"])
# Social — feed, posts, likes, comments, blocks, reports. Per Social brief
# §56, separated from the profile domain so ownership is clean.
api_router.include_router(social.router, prefix="/social", tags=["social"])
# Sharing — mounted at root because it exposes both authed (/me/watchlist/lists/{id}/share)
# and public (/public/lists/{token}) endpoints under different prefixes.
api_router.include_router(list_shares.router, tags=["list-shares"])
# Messaging — Messaging spec §35. Direct 1:1 conversations, title/list
# send, unread state, mute, hide.
api_router.include_router(messages.router, prefix="/messages", tags=["messages"])
