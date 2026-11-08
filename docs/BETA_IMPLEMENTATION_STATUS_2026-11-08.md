# Beta implementation — November 8, 2026

Branch: `codex/beta-completion-nov08`  
Reviewed baseline: `c43c03460bc7d00e93018fc857cbaa773a041378`

This is the first implementation batch against the November 8 brief. It is a draft for review, not a declaration that the full brief or live product is complete. Production deployment has not been performed.

## Implemented in this branch

- **TMDB integrity:** sparse search/discovery/credit results preserve richer title metadata. Genre IDs resolve against the appropriate movie/TV map; full detail refreshes have explicit replacement semantics and provenance timestamps. Movie and TV IDs remain separate throughout mixed-media deduplication.
- **Concierge:** strict typed intent validation, one schema-repair attempt, exact person resolution with verified credits, request-specific metadata/provider hydration, and a separate evidence-based relevance review for every returned title. The next four posters use the same relevance threshold as the hero. No unrelated filler is introduced to make five results.
- **Personal collection search:** specific Next Watch intent takes precedence over generic custom-list parsing. Authorized collection membership is queried in full, known hard mismatches are removed before the candidate budget, watched titles are excluded where appropriate, and previously shown alternatives are excluded before refill. The model receives a bounded taste summary; it does not receive another user's private collections.
- **Concierge recovery:** shorter/longer/provider refinements preserve the other active constraints. Undo restores a saved snapshot without another generation. Refinements have optimistic versions, replay keys, stale-write checks, and an owner-only current-decision endpoint. Provider failures and unavailable metadata have distinct failure states. Configuration details are no longer leaked in end-user error strings. Client timeouts accommodate model/TMDB work and the original query remains editable.
- **Ratings:** legacy rating and Watched routes now use the canonical transition service. Rating submission marks Watched and removes Next Watch membership, while custom lists and manual ranks are preserved. Clearing a score preserves Watched. Per-user database locks serialize competing canonical mutations; stale rating versions are rejected.
- **Rating UI:** one shared editor replaces narrow inline number rails. It loads the current server version before editing, displays all ten choices in a responsive grid, uses at least 44-by-48 targets, permits vertical scrolling, respects safe-area padding, and preserves a draft when another device wins a rating conflict.
- **Rankings:** removes the database's obsolete 100-title constraint and the append/add 500-title cap. All ranked titles can be reached through paginated reads. Manual moves use absolute server positions and serialize per user. Append reports the actual number added; rebuild drafts include all rated titles. My Picks continues loading additional collection pages, reports exact Watched union counts and full-collection unplaced counts, and opens Watch Team selection directly. Dead personal Heart/Comment actions are removed.
- **Social/stories/lists:** taste matches, stories and feed controls scroll with the feed. Story editing and viewing share one modal and refresh their backing data after changes. Story deletion and list deletion have confirmations that work on web and native. List removal controls have larger touch targets. Appending ratings also uses a cross-platform confirmation.
- **Onboarding:** Up records Watched and opens the same rating sheet; Down records Watched/disliked; Right means Interested; Left means Pass; unknown-title skip is neutral. The goal is five ratings, with optional early exit. Progress advances only after accepted writes. Completion is cached per account only after server success. Profile/preference failures remain visible and retryable. Country is visible/editable, subscription labels do not imply authenticated streaming accounts, a per-account local draft retains step/name/handle, and the content scrolls within a centered layout with height-aware posters.
- **Verification workflow:** GitHub Actions runs PostgreSQL migrations and regression tests, TypeScript checking, and the Expo web export on pull requests.

## Evidence and limits

- 43 backend regression tests passed on an isolated PostgreSQL 17 database. Coverage includes 605-title collections, a move from position 605 to 3, concurrent rating edits with the same expected version, collection ownership, sparse metadata, strict model responses, relevance gating, refinement/Undo/replay, and exact Watched counts.
- The full Alembic chain from an empty PostgreSQL database through `20261108_0037` completed successfully.
- TypeScript checking and the Node 20 Expo web export succeeded. These are compile/build checks, not visual acceptance.
- Model and TMDB responses in automated tests are controlled fixtures. No live Concierge account/model/region smoke test has been claimed.
- No iPhone/iPad visual or playback acceptance has been claimed. Local headless Chromium could not start because this workspace does not support its required Unix socket; screenshots still need a supported browser/device environment.
- Database tests create isolated schemas. `TEST_DATABASE_URL` must point to a disposable test database, never production.

## Deployment order

1. Review the branch and CI results. Confirm the actual Netlify branch/deploy configuration and Cloud Run service revision; source configuration alone does not establish what is currently live.
2. Apply Alembic `20261108_0037` to a backed-up staging database. The migration preserves existing rankings. Its downgrade deliberately refuses to restore a 100-title cap while longer rankings exist.
3. Deploy the FastAPI backend with this commit. Verify TMDB credentials, the selected Concierge adapter/model, and Vertex ADC/project/region or the configured provider key, as appropriate. Do not put private API keys in Expo public variables.
4. Build/deploy the Expo web target with the correct `EXPO_PUBLIC_API_BASE_URL`, including `/api/v1`. A Netlify-only deployment does not ship these backend changes.
5. Exercise the device and live-service checklist below before promotion. Production rollout remains a separate step.

## Live/device acceptance still required

- New and established accounts: actor requests, Comedy TV, documentaries, Next Watch, a custom list with 600+ entries, runtime/provider constraints, all five relevant results, intentional pick-one, empty source, upstream failure, Different Options, chained refinements and repeated Undo.
- iPhone portrait/landscape, iPad portrait/landscape/Split View, and large text: all ten rating choices, cancel without side effects, a stale rating edit, story edit/delete, list delete, append-all confirmation, and ranking moves across multiple loaded pages.
- Reopen onboarding after a failed write, reload and account switch; check keyboard behavior, country persistence, neutral skip, Up/Down semantics, and completion only after a successful server response.
- Verify Social scrolling and actual feed/poster tap targets against the supplied aesthetic references. Earlier missing reference uploads have not been reconstructed or treated as reviewed imagery.

## Remaining brief scope — not implemented by this batch

- **Concierge operations and retrieval:** verify/fix live provider configuration; add diagnostics, request tracing and an enforced end-to-end deadline; durable initial-request idempotency and recoverable in-flight jobs; persistent retrieval cursors and iterative refill beyond the bounded 64-candidate relevance budget. Broad catalog exhaustion is not asserted. The current scorer remains the existing SceneDNA implementation, used after relevance bands.
- **Swipe/Preview:** shared continuous recommendation sessions, strict eligibility/cooldown rules, genre/filter continuity, release-age allocation, removing replay/shuffle fallbacks, provider links, native/web audio readiness, persistent mute preference, landscape playback/position preservation and direct action wiring across both surfaces.
- **SceneDNA/shared state:** the proposed ten-dimension confidence-aware score, signal consolidation, global title-state versions and cache invalidation, evidence-based social compatibility, and rating-clear concurrency across a delete/recreate lifetime.
- **Privacy/sharing:** audit and correct legacy list share-token visibility enforcement, private save attribution, private Watch Team activity, public-profile boundaries, and durable private upload storage. These remain release blockers from the brief; this branch must not be represented as resolving them.
- **Watch Teams:** images/settings, honest team ranking provenance, member-specific watched/rating state, Both Want to Watch semantics, duplicate activity removal, and complete horizontal pagination.
- **Navigation/profile:** post-notification deep links, deleted/unauthorized destinations, follower/following screens, profile image upload, legal URLs, standardized headers/chat outside the primary tabs, and title-sheet swipe-down dismissal.
- **Onboarding completion:** production-component consolidation, search-to-rate, an optional explicit #1 selection, server-persisted step/draft recovery, robust username availability races, a friendlier country picker, and device-reviewed responsive composition. The local draft currently covers step/name/handle only.
- **Broader UI/UX:** verify every Discover/My Picks/Profile hero-and-thumbnail interaction, vertical section navigation, personalized TV For You and More Like This, poster sizing/contrast, and alignment with the actual reference images.

## Reproduce local checks

```sh
python -m venv .venv
.venv/bin/pip install -e 'apps/api[dev]'
# Set TEST_DATABASE_URL to an isolated PostgreSQL test database.
.venv/bin/pytest apps/api/tests -q
# From apps/api, with DATABASE_URL set to a disposable migration database:
../../.venv/bin/alembic upgrade head
# From apps/mobile, on Node 20:
npm ci --no-audit --no-fund
npm run typecheck
npm run web:build
```

SQLite is available for fast domain checks when `TEST_DATABASE_URL` is unset, but intentionally skips PostgreSQL-specific ordering/locking tests and does not validate production migrations.
