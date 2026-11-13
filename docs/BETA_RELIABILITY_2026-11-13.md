# November 13 beta reliability release

This release implements the confirmed review defects. It builds on the merged
rating-group placement change: a new rating enters after the last equal score,
while saving the same score preserves the user's manual position.

## Changes

- Right swipe saves to the canonical My Next Watch queue in the same transaction
  as the decision. A retry returns the same receipt. It does not mark a title
  watched, rate it, or publish anything. Onboarding uses the same semantics.
- Undo removes only the queue membership created by that swipe. Existing saves,
  custom lists, newer explicit saves, ratings and watched status are retained.
  Historical right-swipe receipts are not retroactively converted to saves.
- Swipe acknowledgement and Undo include the current saved state so My Picks
  and other subscribed screens refresh immediately.
- Preview retries blocked audible autoplay muted; failed/blocked players have
  recovery controls. Offscreen and backgrounded previews pause. Browser/device
  restrictions can still require a tap. Native player recovery preserves a
  deliberate pause after playback has started.
- Privacy controls display confirmed server state and actionable load/save
  failures. The obsolete public Watch Team switch is removed. Followers-only
  wording no longer promises an approval workflow that does not exist.
- Account/publication deletion removes other users' engagement on deleted posts
  without deleting their unrelated posts or accounts.
- Social uses one consistent bucket/time/ID cursor, and the client now loads
  subsequent pages with retry support. Legacy timestamp requests still work.
- Ranked Favorites refreshes on focus and accepted rating/state changes, retains
  the loaded window, and ignores responses from obsolete requests.
- Taste summaries invalidate on rating, save, list, ranking and preference
  changes. The taste-match carousel refreshes and distinguishes network failure
  from an actual empty match result.
- The unread message badge polls while active and refreshes after message/read
  operations, retaining its confirmed value during temporary network failures.
- The internal push-delivery HTTP trigger now requires an exact Bearer token
  matching INTERNAL_JOB_TOKEN. With no token configured it is disabled; the
  existing authenticated team invitation delivery path remains unchanged.
- The native iOS project enables iPad and landscape orientations, matches the
  dark appearance setting, and includes the photo-library usage description.
- Health responses expose the serving revision and release commit. The rollout
  tool sets SEENSNAP_RELEASE_COMMIT on the candidate revision while retaining
  existing service configuration.

## Deployment and acceptance

No new database migration is introduced. Deploy the reviewed backend commit
before merging the frontend, since the new right-swipe copy promises a saved
queue item. Use the existing rollout tool and exact reviewed SHA; it backs up
Cloud SQL, runs migrations, probes a no-traffic candidate and promotes the
verified revision. Preserve the existing working Concierge model/location.

The local environment cannot open a PostgreSQL server socket. SQLite tests
cover domain behavior and the new social/deletion regressions with foreign keys;
GitHub CI must pass its PostgreSQL migration/concurrency/privacy suite before
release. TypeScript, client interaction tests and web export must also pass.

Signed-in acceptance on the release:

1. Swipe right on a movie and TV title; immediately find both in My Next Watch.
   Retry an interrupted request, Undo, and verify pre-existing/later saves survive.
2. Browse 30+ genre-filtered swipes and verify Up/Down and rating placement.
3. Preview the first and next trailers with muted and previously unmuted settings;
   background/return, open/close details, and test unavailable video recovery.
4. On iPhone/iPad, check original 16:9 presentation and fullscreen landscape.
   Native configuration changes require a new native build, not a Netlify update.
5. Change a rating and return to Ranked Favorites; check order and visible score.
6. Scroll beyond 20 Social posts across followed/90%/80% buckets; check no gaps or
   repeats, including posts sharing timestamps.
7. Simulate privacy save failure; the UI must not claim that a change succeeded.
8. Use disposable test accounts to verify deletion with replies/reactions and
   confirm other people's unrelated content remains intact.
9. Receive/read a message while browsing; verify the shared unread badge updates.
10. Exercise Concierge actor/TV/provider/list/follow-up requests and assess every
    recommendation slot. Record /health revision/commit alongside results.

## Remaining work from the review

Live Concierge relevance and iPhone/iPad acceptance are not established by unit
tests. Team-aware Concierge, an explicit subscription-search selector, broader
related-title personalization, notification aggregation, Premium management,
approved legal destinations and the broader onboarding redesign remain separate
product work. This release does not claim those are implemented or tested live.
