# Swipe and Concierge reliability release

Baseline: main `b85a4a9a67f25fd720b2b94da1c8d4d8710c02e1`.
Input: the November 9 SeenSnap Concierge / Vortex proposal and the report that swipes still freeze. This is an implementation record, not a claim of signed-in production or physical-device acceptance.

## Findings and changes

- Swipe acknowledgements previously waited for a full taste-profile and UserSignal rebuild after the action had already committed. The HTTP path now commits the decision and returns its receipt first. Derived refresh uses a separate database session after the response, with a nonblocking advisory lock. SceneDNA title scoring already reads authoritative state directly; summary readers check for newer discovery activity. Undo uses the same fast acknowledgement path. The optional legacy SceneDNA feedback payload is omitted on this path rather than delaying a saved action.
- Swipe's prefetch effect re-requested unfinished details whenever another card finished loading. Each upcoming title now has one request per queue generation. These requests use the new cached-only `enrich=false` read; they do not fetch Wikipedia, galleries or related-title catalogs. Opening full details still requests full enrichment. The existing receipt retry, cancellation and interrupted-animation protections remain in place.
- Concierge's old default Gemini 2.5 Flash was retired by Google on October 20, 2026. The new fallback is Gemini 3.5 Flash-Lite, with a US multi-region endpoint. Explicit deployment settings take precedence. The adapter now supports the distinct US/EU/global hostnames and excludes reasoning text from JSON parsing. Deployment preflight refuses the known retired text models and incompatible endpoints. The running service's actual model still requires checking; repository defaults alone do not establish its current configuration.
- General Concierge discovery uses the same current exclusions as Swipe: saved, ranked, watched, permanently disliked and temporarily suppressed titles. Explicit personal-list searches preserve their source and can return saved titles. Explicit rewatch includes unrated watched titles; the previous hidden 7-star cutoff is removed.
- Original-language requests are validated and enforced against catalog metadata. TV genres use the TV taxonomy. Profile country is respected consistently. Catalog expansion now carries decade, runtime, language, region and provider/offer filters instead of spending the search budget on generic genre pages. Provider IDs come from TMDB, not invented constants.
- All displayed recommendations still require their own relevance assessment. If the provider omits some assessments, verified matches survive and unreviewed candidates remain pending; no arbitrary alternatives fill the remaining slots. Matching objective requests use consistent relevance so SceneDNA can order otherwise equivalent candidates.
- The existing single input now submits follow-ups against the current decision. Structured updates preserve unchanged constraints; ordinal references resolve against actual prior result IDs. The existing New search control resets the conversation. Shorter is available for movies even when the original request had no time limit, and uses the selected title's duration when known.
- Concierge cards show available, unexpired watch offers for the viewer's country, including Included / Free / With ads / Rent / Buy labels. Service launches record the existing watch handoff so the return-to-app confirmation can operate. Missing availability is not presented as verified access.

## Proposal coverage and remaining work

Already present and retained: the ten SceneDNA dimensions and configurable code weights; personally ranked/contextual prompt suggestions; owner-only complete list searches; hero plus alternatives; Save, Send, Watch Team and Rate; versioned decisions, retries, continuation and Undo; relevance before compatibility; provisional SceneDNA scores for sparse history.

Still requires product/implementation work:

- Team-aware Concierge recommendations that combine participating members' taste, watch history and services. Adding a result to a Watch Team is not the same capability. Do not claim group optimization or expose members' private preferences.
- Dedicated seen-it / too-dark / not-interested feedback on Concierge results, with an explicit distinction between refining this conversation and changing lasting taste. A general dislike must not silently mark a title watched; Swipe Down retains its distinct watched-and-disliked meaning.
- A visible choice for defaulting new searches to selected subscriptions versus the whole catalog. Current implementation makes services a hard constraint only when explicitly requested; it does not silently change the user's search policy.
- More robust operational monitoring of real model outcomes, search latency and swipe acknowledgement latency. Existing request-stage logs and analytics remain; a production dashboard/alert threshold has not been installed.
- Signed-in iPhone/iPad acceptance: continuous genre swiping, ten rating choices, trailer audio/landscape controls, interrupted network recovery, onboarding and list/story permissions. Automated component/database checks do not replace Safari or physical-device testing.

## Deployment

No new schema migration is introduced. Use the existing backup/migration/candidate rollout; do not use the bootstrap deployment script. Pin the reviewed commit and include these flags when the existing provider is Vertex:

```sh
python3 -u deploy/rollout_existing.py --apply --expected-commit REVIEWED_SHA \
  --concierge-model gemini-3.5-flash-lite --concierge-location us
```

The flags update only model/location on the new candidate revision. Database references, secrets and other service settings are retained. The old serving revision keeps its configuration and traffic until candidate checks pass. Live model credentials, access and quota remain a separate signed-in test; structural API checks do not prove the model works. A Netlify-only release cannot deploy these backend changes.

Acceptance: make at least 30 consecutive swipes with a selected TV genre; retry one interrupted action and verify only one history event; Undo without deleting a later rating. Search an 80s comedy on selected services, a specific creator, a language-specific TV request and a named list. Verify all alternatives, refine with “lighter” and “more like the second one,” and confirm saved/watched titles only reappear when requested. Record the serving revision and browser bundle when reporting results.

Model references checked November 12, 2026:
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations
