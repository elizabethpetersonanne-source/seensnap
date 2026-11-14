# SeenSnap repository review — November 14, 2026

Reviewed main: `c9932e62235adf2a0d65027fa8393d19e690bc8d`. Last verified backend release: `656069ca636a53ba8394ecd33d4e1091d72aa67b`. The accompanying polish changes are frontend-only.

This is a source review of product flows, client/API contracts, taste and recommendation logic, privacy, lists, deployment, and tests. Findings below distinguish demonstrated defects from recommendations and outstanding live checks. Passing automated tests does not establish iPhone/iPad acceptance or guarantee recommendation quality.

## Fixed in the accompanying polish change

- Swipe save progress, saved confirmation, pagination progress, and Undo no longer insert rows above the poster. They sit in an absolute overlay above bottom navigation. Left/right exit animations no longer add a downward offset. Confirmation still waits for the server, and retry/Undo behavior is preserved.
- Removed visible `system` and `default` suffixes from list selection. Internal flags remain intact.
- Removed internal taste-match diagnostic counters from the empty state.
- Replaced the misleading Ranked Favorites “Top 20” empty-state copy with instructions to rate and reorder titles.
- Corrected shared-favorite names in the compatibility sheet: the API returns `title_name`, while the client read `title`. Replaced “Canonical compatibility” with ordinary product language.

Validation: the initial 45 client tests pass, including a new regression asserting that pending/saved feedback stays outside the scrolling deck, Undo is reachable, and a right swipe does not open the list picker. The follow-up adds successful and failed Undo/retry coverage. TypeScript passes.

Production observation after the initial release: the poster remained at exactly `top=332px`, `height=520px` before and after a confirmed right swipe, and My Next Watch contained the saved title. Visual inspection caught an extra bottom-navigation offset in the overlay; the follow-up removes that duplicate offset because the tab navigator already reserves the navigation area.

**Additional live defect:** Undo returned the retry message on two attempts. The current card/receipt remained available, but the server-side reversal was not confirmed. Local mocked-client and API tests do not reproduce this production failure. Investigate the deployed Undo response and Cloud Run logs before calling Undo accepted. The follow-up logs only the HTTP status (no account, token, title or raw response) and adds clear conflict/missing-receipt messages. This diagnostic change is not a claimed backend fix.

## Recommended order for remaining work

### 1. Fix signed taste evidence becoming positive favorite labels

**Confirmed, reproduced locally.** `apps/api/app/services/taste.py` now gathers signed interaction utility, but `_serialize_genres` and `_derive_labels` still normalize it as though every value were positive.

Calling the actual helpers with `{"Horror": -1}` produces a displayed Horror score of 100 and confident horror labels. With `{"Horror": -1, "Crime": -5}`, displayed genre scores become 100 and 500. Mixed positive/negative inputs can also produce negative display percentages and positive labels for disliked genres.

This concerns the legacy taste profile and person-compatibility inputs; it is separate from the newer title SceneDNA scoring implementation. It does not establish that every title percentage is wrong.

**Implementation:** keep signed evidence in the scoring model, but build favorite genres/identity labels from positive evidence only. Bound public percentages, handle zero-positive-evidence profiles honestly, and invalidate/rebuild affected profiles and pair scores. Add negative-only, mixed-sign, zero-total, and ordinary-positive regressions.

**Acceptance:** disliking horror cannot label someone a horror fan; all displayed percentages are bounded; title matching still uses negative preference evidence.

### 2. Consolidate the watch-queue model without losing titles

**Confirmed structural conflict.** `services/watchlists.py` still creates legacy **My Picks**, **Want to Watch**, and **Favorites** lists. `ensure_next_watch_list` separately creates **Next Watch**, with both `is_default=True` and `system_role='next_watch'`. An account can therefore have two default lists. The My Next Watch collection reads the role-based queue, while saving to the older Want to Watch list does not put a title into that queue.

There is also an editing mismatch: `update_watchlist` rejects any default-list name other than “My Picks.” The list editor (`apps/mobile/app/favorites/list/[listId].tsx`) always sends the name, so editing Next Watch's description or visibility can fail with a misleading rename error.

**Implementation:** define one canonical queue role, migrate legacy memberships with deduplication and privacy preservation, make default/system protections role-based, and stop recreating obsolete lists. Do not delete user-created lists merely because their names resemble defaults. Present one consistent “My Next Watch” name.

**Acceptance:** right swipe, Save, Concierge list context, My Picks, and list editing resolve the same queue; old titles survive migration; no duplicate defaults are created on sign-in.

### 3. Make Public visibility and profile discovery agree

**Confirmed.** `api/routes/profiles.py:get_public_profile_lists` joins through an active `ListShare`. Creating or editing a list to `visibility='public'` does not itself create that token. A list explicitly marked Public can therefore remain absent from the owner's Public Lists until separately shared.

**Implementation:** derive profile visibility from list visibility and viewer access. Use the existing viewer-aware list reader by list ID; reserve share tokens for share links. Alternatively make the publishing step explicit in the UI, but do not silently turn private lists public or revive revoked links.

**Acceptance:** an intentionally public list appears on the profile and opens correctly; Followers and Private remain protected; changing visibility revokes access appropriately.

### 4. Finish My Lists browsing and empty-list management

**Confirmed.** `api/routes/picks.py` returns at most 20 preview titles per custom list. `apps/mobile/app/(tabs)/my-picks.tsx` disables its load-more handler for `my_lists` and filters out lists with no titles. The carousel therefore stops at the preview limit, and a newly created empty list can disappear from this view. The separate list-detail page remains available for full contents; the titles are not deleted.

**Implementation:** paginate list contents, retain empty-list cards with Add titles / Edit / Delete actions, and clearly expose the full list reader.

**Acceptance:** create an empty list and find it again; browse a 25+ title list to its final title; remove titles and delete custom lists without stale UI.

### 5. Repair account deletion for owners of teams with analytics

**Confirmed code/schema defect; not exercised against a live account.** `api/routes/auth.py:delete_account` deletes owned teams without first deleting their `TeamAnalyticsSnapshot` rows. The `team_analytics.team_id` foreign key in `20260501_0005_taste_graph.py` has no delete cascade. `services/compatibility.py` creates these snapshots. An owner whose team has analytics can hit a foreign-key failure instead of completing deletion.

**Implementation:** explicitly clean up the snapshots before teams, or add a reviewed cascade migration. Add a PostgreSQL integration test with a populated owner/team/analytics graph and verify transaction rollback on failure.

### 6. Keep person compatibility fresh and make discovery cheaper

**Confirmed code paths; load impact requires measurement.** `services/taste_invalidation.py` invalidates user taste/profile snapshots but not `CompatibilityScore`. `services/social_feed.py` uses stored pair scores to select 80%/90% match tiers without checking freshness. Updated ratings can therefore leave old feed eligibility until the pair is recomputed.

Meanwhile `api/routes/social.py` can call `get_compatibility` serially for up to 60 candidates, and `services/compatibility.py` recomputes/commits each pair. This adds avoidable request work. The taste-match carousel is wired to the API; the remaining problem is score quality, freshness, and cost, not an entirely missing integration.

**Implementation:** version pair scores against both users' taste versions, enforce consistent minimum evidence, batch candidate scoring, and avoid one commit per candidate. Recheck privacy/block eligibility when serving cached results.

### 7. Improve For You retrieval and title metadata coverage

**Confirmed implementation characteristics; production scale impact requires measurement.** `services/for_you.py` loads the eligible local catalog before scoring, sorting, and applying the result limit. The work grows with the catalog rather than the page size. A sparse nonempty pool also avoids the empty-pool discovery path.

The newer SceneDNA scorer intentionally does not invent rich metadata from legacy derived tags. TMDB discovery records often lack credits/keywords until detail hydration, which limits usable matching evidence.

**Implementation:** use a bounded retrieval stage, hydrate high-value candidates ahead of requests, measure metadata coverage, and support pool expansion/diversity for both TV and movies. Preserve honest “limited match data” states rather than filling them with a fixed percentage.

**Acceptance:** establish response-time and coverage baselines on a representative catalog; mature accounts receive personalized TV and film pools; low-metadata titles do not receive fabricated certainty.

### 8. Finish the shared browsing interaction contract

**Confirmed remaining spec mismatch.** My Picks still uses a floating horizontal category selector. Its continuation-poster callback opens details directly; `FullBleedPosterSection` simply forwards that tap. This differs from the requested small-poster-promotes / featured-poster-opens pattern and vertical section navigation.

**Implementation:** standardize promotion and section navigation while preserving personal rank order, team Top Picks order, scroll position, and loaded pagination. Do not reorder Ranked Favorites by SceneDNA.

### 9. Verify Preview playback on real Apple devices

**Outstanding acceptance, with a prior live symptom.** The prior browser acceptance pass observed a trailer staying at zero despite the new stalled-playback message and retry. That observation alone does not identify its root cause. Current code has autoplay attempts, muted fallback, one stalled retry, and a manual fallback; it does not establish reliable real-device playback.

**Implementation/checks:** instrument player errors and progress, distinguish unavailable videos from autoplay restrictions, test known playable alternatives, and preserve position through retries where possible. The native Retry path currently remounts the player without restoring the playback timestamp.

**Acceptance:** initial and subsequent trailers advance automatically where allowed; blocked playback has a usable fallback; 16:9 remains uncropped; iPhone landscape and iPad rotation retain position; sound preference persists. Use actual Safari/iPhone/iPad, including a slow connection and background/foreground transitions.

### 10. Honor the viewer's country in Where to Watch

**Confirmed.** `apps/mobile/src/components/universal-title-modal.tsx` requests `/watch-options?region=US`, even though onboarding/profile support a country and other recommendation code uses it.

**Implementation:** use the shared country preference for provider discovery and watch handoff. Test US and at least one supported non-US market. Never present a provider as available solely because it is available in another country.

### 11. Complete public destinations and native-link configuration

**Confirmed placeholders/configuration differences; external availability not verified.** Help & Support still uses `seensnap.com/help`, while legal defaults use `.app`. Public fetch attempts could not establish whether the legal/help pages currently resolve. Do not treat those fetch failures as proof the sites are down.

`api/routes/share_pages.py` contains an Apple team-ID placeholder, example Android signing fingerprint, and an App Store URL ending in `id0`. These must be replaced before native distribution, or unfinished store actions hidden. Native association files must be served by the actual associated domain. Web link routing and native app handoff are different acceptance checks.

**Acceptance:** verify actual Terms, Privacy, Help and support destinations; shared title/list/event links work signed in and signed out; no placeholder store link is presented to a user. Do not invent replacement legal copy or unverified support addresses.

## Additional recommendations

- **Concierge:** keep a release acceptance matrix covering actor requests, genre + media type, exclusions, runtime constraints, personal lists, refinements, fresh-query reset, and empty lists. Check all five results individually for relevance. Prior fixes exist; this review did not prove that every real request now succeeds. Track provider errors, latency, candidate counts, filtered-out reasons, and result relevance without logging private prompts/lists indiscriminately.
- **Public service resilience:** beta Premium access should remain available to everyone as requested, while per-user request/concurrency limits protect expensive Concierge operations. Preserve entitlement logic separately from operational rate limits.
- **Onboarding:** run a complete new-account flow at small iPhone sizes and iPad split view. Verify keyboard visibility, photo upload, country/streaming selection, accessible rating choices, exit/resume, and that early taste copy does not misrepresent mature accounts.
- **Tests:** current CI runs PostgreSQL API tests/migrations, client interaction tests, type checking, deployment tests, and a web build. Add a small browser acceptance suite for public profile → list → title navigation, swipe → queue → Undo, rating → ranking, and post/story ownership actions. These complement rather than replace actual-device checks.
- **Documentation:** update deployment/product docs after the next release with the actual backend SHA, frontend SHA, known limitations, and live acceptance results. Code being merged is not by itself evidence that both deployed tiers are current.

## Release boundary for this change

The accompanying code changes address the reported poster movement and internal-facing copy, plus the shared-favorite contract mismatch. The backend findings above are intentionally documented for a separate tested backend release. No database migration or Cloud Shell deployment is required for this frontend polish.
