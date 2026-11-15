# Workflow and privacy closeout — November 15, 2026

This batch changes the web/native client and regression coverage only. It uses the deployed backend's existing list, public ranking and team pagination contracts. No backend rollout or migration is required.

## Closed in this batch

- Public Ranked Favorites previously fetched only 100 titles. The reader now continues in owner order until all pages are reachable, with an explicit Load More/retry control as well as scroll pagination. Viewing somebody else's ranking never changes their order or exposes private scores.
- Shared lists and public ranking readers recheck their audience when returning to the screen. Previously loaded pages are restored only after successful reads. Revoked access clears the content; failed revalidation does not certify an old snapshot as readable. Transient pagination failures preserve the current page and allow retry.
- Account/source changes cancel outstanding reads and prevent late responses from restoring another viewer's data. Pagination is deduplicated and follows the server's continuation. Scroll offsets are retained for the current account/source.
- Public profiles clear previous rankings, lists and activity before refreshing. Partial failures cannot display sections from another profile or an earlier permission state. Title navigation cancels superseded/closed requests. Confirmed follow/unfollow actions recheck the profile audience.
- Teams with more than two members have separate Any member / All members controls for Watched and At least two / All members controls for Want to Watch. The existing server applies the filter to the complete set, including later pages. Counts, empty-state copy and results follow the chosen filter. Top Picks retains team ranking. Only explicitly team-shared statuses count; personal saves and ratings are not inferred or published.
- Team reads are cancelled on navigation and rechecked on return. Membership failures remove stale team content.

## Verification

Client regression cases exercise more than 100 rankings, loaded-page restoration, page failures and retry, revoked audiences, changed accounts/sources, stale title responses and partial profile failures. PostgreSQL coverage exercises three-member filtering, explicit shared state, membership changes and pagination. The full existing suites also cover rating-group insertion/manual ordering, right-swipe save/Undo, story ownership/history and list audiences.

These checks use isolated fixtures. They are not a claim that two production accounts or physical devices were used. Live read-only browser checks are recorded separately when performed; production preferences, ratings, lists, stories and follow relationships are not changed just to generate test evidence.

## Still open

- Physical iPhone/iPad Safari/native acceptance: keyboard, large text, rotation, split view, repeated autoplay and fullscreen playback position.
- Fresh-account onboarding and the full signed-in Concierge relevance matrix on the deployed product; inspect every recommendation and several different taste profiles.
- Approved Terms/Privacy content and destination verification; native push/store configuration only if distributing native builds.
- Global persistent official-video availability cache and consolidation of older recommendation callers. Preview currently has a bounded per-session resolution cache; this batch does not claim to add a global cache or guarantee audible autoplay against device policy.
- Broader privacy acceptance beyond these routes remains ongoing; no complete app-wide privacy certification is implied.
