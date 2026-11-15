# Mobile flow completion

Follow-through on the remaining mobile, title navigation and onboarding work after the shared-taste release. These changes are frontend-only and use the deployed API; no migration or Cloud Shell rollout is required.

- Title action rows wrap within their available width, preserving 44-pixel targets instead of pushing Rate off narrow cards. The rating editor sizes its grid using the actual sheet width and text scale and keeps safe-area padding above and below the sheet.
- Title and inline person sheets follow the current viewport height. The title hero uses a minimum height and natural content flow, so long names and larger text can expand without overlapping the controls. Gallery paging uses its measured width and realigns on resize. Streaming actions can wrap.
- Loading title details has a dedicated loading state. No unknown-series metadata, unavailable synopsis or stale title actions are shown while the request is pending. Failed details offer a close/retry route.
- Opening a related title resets its trailer, rating, watch options, gallery and scroll position. Pending title/trailer requests are cancelled on close, source change or account change; late responses cannot replace the current title or launch an old trailer. Closing Discover details also cancels its outstanding request. Failed related-title navigation retains the original title.
- Discover collection search results now open the existing collection route and preserve the query/results for Back, just like person results.
- Onboarding restores confirmed rating progress independently of optional swipe suggestions. Old progress requests cannot overwrite a newer refresh or a different account. Failures retain the confirmed count and expose a retry. Search-first onboarding no longer downloads suggestions until requested. The final message reflects actual rated titles.
- Onboarding search cancels replaced queries, shows release years when available, and scopes the optional #1 write to the active account/component lifecycle.

Regression checks cover loading/error/ready title states; related-title trailer replacement; close/account request races; rotation height; progress ordering and retry; and collection navigation with retained search. Existing rating, swipe, onboarding recovery and recommendation checks remain in the client suite. Physical iPhone/iPad Safari and native keyboard, rotation and playback acceptance still require real devices.

Remaining work outside this frontend batch includes the global official-video availability cache, consolidation of older recommendation entry points, larger-team filters, broader private/public profile coverage, approved legal content/destinations and native distribution configuration. These are not presented as complete by this release.
