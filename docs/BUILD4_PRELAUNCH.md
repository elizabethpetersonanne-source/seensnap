# Build 4 release candidate — November 19, 2026

Based on `codex/testflight-foundation` at `fd22cbc98f8f58c4210d167678f806be35c0c851`. Implements the attached November 18 prelaunch specification plus the reported rough swipe motion. This is a TestFlight candidate, not a claim of completed device acceptance or public release.

## Changes

- Discover: retain personalized local candidates when optional remote evidence enrichment times out; keep the evidence deadline inside the client request budget. Trending, theaters and title details expose retry. Title-sheet dismissal has a bounded fallback if the animation callback is interrupted.
- Profile: send only changed fields so an unchanged legacy username cannot block a bio edit. Verify saved profile and avatar via a fresh read before reporting success; retain draft/error when verification fails. Normalize iPhone photo uploads to JPEG with a maximum 1024px dimension.
- Preview: session-only shared sound state starts muted in a new app runtime or account. Remove inactive embedded players to stop offscreen audio. Add explicit Expand/Done, a landscape-capable fullscreen modal, 16:9 fit, bounded position capture/resume, and a retry/manual play fallback. Stop playback during scrolling, when another sheet opens, on backgrounding, and when leaving the screen. Compact layouts reserve room for controls.
- Swipe: remove double top safe-area spacing; keep the main portrait-phone workflow within the available screen, with a scrolling fallback for short windows/large accessibility fonts. Keep four decision buttons and Undo visible. Require a deliberate dominant-axis gesture. Exit begins immediately from the released position, concurrently with persistence; native exit/return animations avoid the previous recenter/wait/exit sequence. Preload the next poster underneath; only a confirmed save advances the actionable queue. Failed or uncertain saves restore the original card and retain the same idempotency key for retry. Remove the next-card scale pop and saving-opacity flash.
- Navigation: hidden Preview/search/discovery/settings routes map to their owning bottom tab. SceneDNA modes expose selection and real load failures have Retry.
- Teams: replace “unknown” with a meaningful unshared-status prompt. Keep existing explicit member-sharing API and team ranking separation; no new implicit rating publication.
- Rankings: keyboard-safe position editor, refresh stale version conflicts, reload through the requested position beyond the initial 100 rows, and accessible wrapped controls.
- Branding: use the supplied gold camera emblem throughout the shared logo and launch artwork; use the supplied navy/gold wordmark image for both the Expo icon and committed native iOS AppIcon catalog. Preserve transparency for the in-app mark and use opaque 1024px app artwork.

## Validation

- TypeScript passes.
- 90 client regression tests pass, including actual Swipe-screen tests for delayed/failed persistence, no duplicate gestures, immediate exit from release coordinates, four directions, Undo, and recovery from interrupted animations. New tests also cover profile field deltas/read-back, tab ownership, sound reset, fullscreen position and inactive-player removal.
- Targeted API tests: 28 passed, 12 PostgreSQL-specific tests skipped locally; the full PostgreSQL suite subsequently passed in GitHub Actions.
- Final web export and iOS bundle export passed in GitHub Actions for candidate `949fb9d3927081adc4dcc279f49df8a720f15f5d`.
- Native release configuration gate passed with the existing EAS preview environment. No development login enabled. All three GitHub Actions jobs passed (run 44615797148).
- Local browser visual automation was unavailable in this execution environment. Unit/component tests do not establish real-device frame rate, Safari/WebView autoplay behavior, or keyboard/safe-area correctness.

## Release and remaining acceptance

1. Require passing GitHub Actions and build this exact candidate using EAS `testflight` / iOS / `preview` environment. The native iOS directory is committed; changing only Expo icon configuration is insufficient.
2. Deploy this candidate's backend with `deploy/rollout_existing.py --apply --expected-commit <candidate SHA>` using the established Cloud Shell flow. Only the optional For You enrichment fallback changes backend behavior; the client remains compatible with the currently deployed API.
3. Submit the new successful EAS build using the existing App Store Connect team key in the owner's Cloud Shell. Do not resubmit build 3 as this update.
4. **Legal documents are still blocked:** `https://seensnap.app/terms` and `/privacy` returned 404 on November 19. Netlify's equivalent paths returned the application shell, not legal documents. Obtain/publish the approved documents or provide their actual URLs, then update every entry point and verify the content. No legal text has been invented.
5. Test on a small iPhone, a current notched iPhone, and iPad: onboarding → Discover → Swipe → Preview → My Picks → Watch Teams. Drag slowly and flick in all four directions; cancel a short/diagonal drag; interrupt a swipe, disconnect/retry, undo, and switch filters while a request is pending. Verify no dropped/duplicate actions, poster jump, controls hidden by navigation, or frozen input.
6. Verify muted initial autoplay, explicit sound on/off across at least ten trailers, immediate silence on scroll/tab/background, fullscreen/rotation/return at the same position, and manual Play/Retry when autoplay is restricted.
7. Save a large iPhone photo and bio, reopen/relaunch, move a ranking beyond position 100, and verify saved/watched/ranked collections. Use two accounts to verify shared team statuses/ratings, default privacy, and ranking independence.
8. This candidate does not complete the separate subscription/App Store product configuration or server-side Apple Sign In configuration. Beta Premium behavior remains unchanged. Netlify production is not changed by an EAS build.

## Build result

Expo iOS App Store build **1.0.0 (4)** succeeded on November 19, 2026, from code commit `949fb9d3927081adc4dcc279f49df8a720f15f5d`. Build ID: `7ece279c-40ae-466e-a87a-cb74314f5ab8`.

[Verified build](https://expo.dev/accounts/lizzy456/projects/seensnap/builds/7ece279c-40ae-466e-a87a-cb74314f5ab8) · [Cloud Shell deployment/upload steps](BUILD4_CLOUD_SHELL.md)

Apple submission and backend deployment have not been performed in this session. The private Apple key remains in the owner's Cloud Shell. These documentation-only follow-up changes do not change the built application.
