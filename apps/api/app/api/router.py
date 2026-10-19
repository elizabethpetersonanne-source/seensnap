from fastapi import APIRouter

from app.api.routes import activity, analytics, auth, collections, concierge, devices, discover, entitlement, favorites, feed, list_shares, me, messages, notifications, picks, previews, profiles, ratings, recommendations, scene_dna, search, share_asset, shares, snips, social, stories, team_home, teams, title_state, titles, watch_handoff, watch_options, watchlist

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
# Previews — Previews spec §12 (MVP). Personalized swipeable autoplay
# feed of official teasers/trailers. Ingestion + admin console + analytics
# events schema deferred to later phases.
api_router.include_router(previews.router, prefix="/previews", tags=["previews"])
# Personal 1-10 ratings + watch status (want_to_watch | watched) per
# Sep-22 execution brief §7. Canonical personal score service — every
# title-bearing surface reads through this so a rating updates everywhere.
api_router.include_router(ratings.router, prefix="/me/ratings", tags=["ratings"])
# SceneDNA correction UI per Sep-22 execution brief §8 — recent
# signals list + disable/enable-influence controls.
api_router.include_router(scene_dna.router, prefix="/me/scene-dna", tags=["scene-dna"])
# Ranked favorites (Top 20 / Top 100) — Sep-22 execution brief §14.
api_router.include_router(favorites.router, prefix="/me/favorites", tags=["favorites"])
# Server-authoritative entitlement — Oct-18 build brief §9. During
# beta, every current + new user receives a Premium grant via a
# server-side source='beta' EntitlementGrant row. Client NEVER sets
# isPremium directly; every protected boundary resolves this.
api_router.include_router(entitlement.router, prefix="/me/entitlement", tags=["entitlement"])
# Canonical title state — Oct-18 build brief §5. One transactional
# service for save / watched / rate / unrate; every surface writes
# through this and reads back the full snapshot to reconcile.
api_router.include_router(title_state.router, prefix="/me/title-state", tags=["title-state"])
# Explicit publication — Oct-18 build brief §6. Private save/rate/rank
# never auto-publishes; the user explicitly posts via this endpoint
# with an optional ≤300-char Take. Historical rating/rank is snapshot
# at publish time so later private edits don't silently rewrite posts.
api_router.include_router(activity.router, prefix="/me/activity", tags=["activity"])
# Concierge decision — Oct-18 build brief §4. Server-side AI adapter
# resolves natural-language intent to typed constraints + grounded
# titles. Honest unavailable state when no provider is configured.
api_router.include_router(concierge.router, prefix="/me/concierge", tags=["concierge"])
# Watch handoff — Oct-18 build brief §8. Persist handoff on provider
# launch, prompt Did you watch? on meaningful return. 10-minute
# starting threshold; routes through title_state for canonical
# save/watched/rate transitions.
api_router.include_router(watch_handoff.router, prefix="/me/handoffs", tags=["handoffs"])
# Share asset — Oct-18 build brief §6. Image renderer boundary with
# honest unavailable state when no provider is configured.
api_router.include_router(share_asset.router, prefix="/me/share-assets", tags=["share-assets"])
# Social Stories — Oct-19 mock. 72-hour title stories per user.
# Writer endpoints on /me/stories; reader endpoint on /social/stories.
api_router.include_router(stories.router, prefix="/me/stories", tags=["stories"])
api_router.include_router(stories.reader_router, prefix="/social/stories", tags=["stories"])
# My Picks — Oct-18 UI/UX rebuild. Returns the five collections rendered
# by the My Picks screen in one call.
api_router.include_router(picks.router, prefix="/me/picks", tags=["picks"])
# Team Home — Oct-18 UI/UX rebuild. Immersive full-screen team home;
# returns top_picks / recently_added / both_want_to_watch / watched
# in one call.
api_router.include_router(team_home.router, prefix="/teams", tags=["teams"])
