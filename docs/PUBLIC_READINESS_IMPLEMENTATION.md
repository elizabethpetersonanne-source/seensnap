# Public readiness implementation

Started November 13, 2026 (America/New_York). Scope: Elizabeth's authorization to implement the complete repository review. Branch: `codex/public-readiness-completion`; PR #10.

## Implemented

- **Watch queue:** one role-based My Next Watch destination. Migration 0043 unions identified legacy queues without deleting original memberships, notes, audiences or share links. Previous collections remain readable. Custom lists are never identified by name alone. Import receipts catch late saves from an older API revision and prevent an intentional unsave from being resurrected. Private legacy items are never copied into a queue subsequently made public. New accounts no longer receive redundant physical Favorites lists; Favorites remains the rating-derived section.
- **Undo:** owner-checked recovery for pre-ledger receipts, defensive receipt parsing, retention of independent/newer saves and ratings, idempotent retries, and a privacy-safe diagnostic reference on unexpected failures. This addresses known failure modes; the earlier intermittent live Undo symptom still requires post-deployment reproduction/acceptance.
- **SceneDNA identity:** negative-only genres do not become favorite labels, positive genre percentages remain bounded, current obsessions use current signed evidence, and cached profiles carry their source taste version. A low rating overrides an earlier save.
- **Taste matches:** both users' versions and evidence counts are stored with each pair, candidate scores are read/written in batches, stale pairs cannot qualify for feed tiers, and candidate selection uses current positive ratings. No invented percentages for insufficient evidence.
- **Public lists:** profile discovery follows current list visibility and viewer permissions; a share token is no longer a prerequisite. Owner-only pagination supports every custom-list title, including empty-list management. Original shared collections retain their audiences.
- **My Picks:** Ranked Favorites → My Next Watch → Favorites → Watched → My Lists, with vertical section browsing and horizontal title browsing. Small posters promote the featured title; the large poster opens details. Promotion does not change personal rank order. Loaded pages refresh without collapsing back to the first page. Empty lists and previous collections are reachable. New List lives within My Lists. Send produces a real title link. Unplaced ratings remain reachable.
- **Account deletion:** owned-team analytics are removed before teams; populated PostgreSQL deletion tests protect the foreign-key path.
- **For You:** media and genre constraints apply before bounded candidate materialization (maximum 800 candidates). Positive taste seeds share the budget with exploration. A bounded post-response task repairs metadata for recently rated evidence and displayed candidates and expands sparse pools. Missing metadata remains missing evidence, not a fabricated match.
- **Concierge:** operational concurrency and recent-attempt limits apply independently of Premium allowances; replay/recovery remains idempotent. Refinements share protection without taking a second allowance slot. User copy distinguishes a busy search from retrieval failure. Structured diagnostics include counts for metadata failures, constraint rejection and per-title relevance assessments without prompts, list contents or title IDs.
- **Streaming:** watch options default to the profile country, with validated explicit region overrides.
- **Preview:** native retry restores position; a different trailer resets it. Web/native diagnostics distinguish startup, unavailable playback and retries without logging viewing identifiers. Existing 16:9 and muted autoplay fallback remain in place.
- **Onboarding:** existing resumable draft, country selector, responsive calibration, scrollable rating editor and keyboard-safe form reviewed. Added accessible form labels, keyboard dismissal and a back action for setup steps before calibration.
- **Public destinations:** Help now opens an in-app guide. Unconfigured App Store/Google Play actions and dummy native signing data are hidden. Legal-link open failures have visible recovery copy. No legal text or signing identifiers were invented.

## Verification and remaining acceptance

Automated coverage includes queue reconciliation and original-link preservation; late legacy saves and unsave retention; old/malformed Undo receipts; visibility-only public-list discovery; full custom-list pagination; profile/pair cache invalidation; populated team deletion; bounded TV/genre retrieval; operational Premium protection; country selection; poster promotion; refresh failures; and native retry position.

The complete PostgreSQL/API suite, migration chain, client interaction suite, TypeScript check, Expo web export and deployment tests run in PR #10. The final PR check results are the release gate; local SQLite tests do not substitute for PostgreSQL locking/constraint tests.

Still required before claiming the release is live/public-ready:

1. Run the exact tested backend SHA through `deploy/rollout_existing.py` in authenticated Cloud Shell. This environment does not hold Google Cloud deployment credentials.
2. Perform signed-in acceptance against that backend and the PR's frontend. Confirm queue contents, public/private list reads, swipe → save → Undo, rating/rank order, and Concierge matrix below.
3. Merge PR #10 and confirm Netlify production serves the merged frontend. Record both backend and frontend SHAs; code on a branch is not a production deployment.
4. Test physical iPhone/iPad Safari/native playback, keyboard, rotation, safe areas and large text. Component tests are not real-device acceptance.
5. Verify approved Terms, Privacy and support destinations. Public retrieval could not verify the current `.app` legal URLs; this is not evidence they are down. Native signing/store settings are needed only for native distribution, not the web beta.

## Concierge acceptance matrix

For every request, inspect **each returned title**, including the four smaller posters. A partial response is acceptable only when it clearly explains an actual limitation and preserves verified relevant results.

| Case | Example | Expected |
| --- | --- | --- |
| Actor | Movies starring Denzel Washington | Every result has verified actor credits; no unrelated filler |
| TV and genre | A funny TV comedy, no crime | TV-only results, comedy, exclusions applied to every title |
| Documentary | A science documentary | Documentary filter and subject relevance both hold |
| Runtime | A thriller under 100 minutes | Verified movie runtime ≤100; unknown runtimes do not pass |
| Personal queue | Something from My Next Watch | Only current canonical queue members; all eligible members can be searched |
| Named list | Choose from a populated personal list | Correct owner/list scope, including titles beyond its initial preview |
| Empty list | Choose from an empty personal list | Honest empty state; no silently broadened recommendations |
| Refinement | Shorter / Different options / More like this | Existing constraints retained appropriately; selected poster anchors similarity |
| New query | Replace actor request with a documentary request | Old actor/genre constraints do not leak into the fresh search |
| Recovery | Retry after a connection interruption | Same request receipt; no duplicated allowance charge or unrelated replacement |

Provider/model access and semantic quality require this live matrix even when mocked retrieval tests pass.

## Device and flow acceptance

- Small iPhone portrait, iPhone landscape, iPad portrait/landscape and split view; increase text size. Confirm ten rating choices, keyboard-visible inputs and all five tabs.
- New account: start onboarding, enter identity/country/services, navigate back, leave and resume, calibrate, finish. Verify mature account does not re-enter onboarding after refresh.
- Public profile → public list → correct title → return preserves position. Private/Followers links deny unauthorized readers. Empty custom lists remain manageable.
- Swipe right → My Next Watch → Undo removes only that save. Swipe up/down, cancel/submit/change rating, then verify rank placement and manual reordering.
- First and subsequent trailers autoplay when permitted, retain sound preference, expose manual fallback, preserve position across fullscreen/retry, and stay 16:9.
- Edit/delete own post and current/previous story; another account cannot mutate them. Team activity remains private unless explicitly shared.

## Deployment compatibility

Base production frontend: `825840b702c0382af76063cfebeab6244a1de694`; previously verified backend: `656069ca636a53ba8394ecd33d4e1091d72aa67b`.

The schema additions allow the previous API revision to run during traffic transition. The canonical role's existing uniqueness is retained; no new default-flag uniqueness constraint breaks older writers. Queue import receipts reconcile late legacy additions exactly once. Original collections and share tokens are retained. A traffic rollback does **not** reverse queue consolidation or remove new saves; do not run a destructive database downgrade to undo traffic.

Backend runtime model/provider settings are retained by the rollout script. Optional native settings are `IOS_TEAM_ID`, `APPLE_BUNDLE_ID`, `ANDROID_APP_PACKAGE`, `ANDROID_SHA256_FINGERPRINT`, `IOS_APP_STORE_URL`, and `ANDROID_PLAY_STORE_URL`. Leave native settings empty until verified. Operational defaults: one active Concierge operation per user and a conservative twelve recent attempts per minute; Premium billing entitlement remains unchanged.
