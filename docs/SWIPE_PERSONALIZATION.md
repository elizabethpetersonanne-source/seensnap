# Swipe personalization upgrade

Updated November 14, 2026 after live feedback about generic, repetitive Swipe picks. This describes the quality correction; deployment status is tracked in the release pull request.

## Behavior

Swipe and Preview now retrieve candidates from the viewer's positive title evidence, as well as the regional catalog. Explicit ratings override weaker signals; duplicate memberships do not multiply influence; left/pass remains neutral; watched-and-disliked remains negative. SceneDNA v4 retains the dimension weights and confidence gates and the v3 correction for missing metadata: all learned dimensions remain in the denominator, with absent candidate evidence neutral.

Live review of v3 exposed a second weakness: production/setting tags and incidental keywords could still behave like strong personal themes. `taste_semantics.py` now excludes known weak labels (such as sequel, friendship, ambiguous and New York City), adaptation prefixes and unlabelled keyword IDs from taste features. Their original TMDB metadata remains intact. The same filtered features govern trait retrieval, score calculation, selection and explanations. Pairwise weighted theme overlap must reach 20% for a single shared theme or 10% for multiple themes before contributing; many incidental overlaps across a large library cannot accumulate into a confident theme match. These conservative thresholds and the bounded weak-label list are explicit heuristics, not a complete ontology or measured relevance model. Strong cast/director connections and genuine shared themes remain usable.

Up to six diverse positive anchors, including rotating saves, supply history evidence. Mixed feeds inspect both film and TV anchors when available. Up to four related-title sources are queried per page, with rotation and preference for unvisited sources. Exhausted sources no longer monopolize seed selection. Up to two disliked titles are hydrated as well, so opposite preferences inside the same genre remain distinguishable. Additional TMDB Discover requests use net-positive verified keywords, directors, actors or genres. TV uses its own taxonomy and supported API parameters; movie cast/crew filters are never sent to TV Discover. When TV history is sparse, thematic evidence may transfer from movie history, while all returned titles must still be TV.

Candidate retrieval is independent of scoring. TMDB recommendations do not establish a high SceneDNA match by themselves. Every candidate passes current exclusions, selected genre/media, release-date, artwork, synopsis and regional availability requirements. Watch Team and followed-user sources retain the existing visibility checks.

For viewers with positive evidence, the deck targets 70% taste-led candidates, 20% adjacent discovery and up to 10% social/team candidates when available. Social candidates are capped at two in a rolling twenty-card window. Missing buckets fall back to available candidates; percentages are targets, not fabricated supply. Specific taste matches require a score of at least 55 and positive support above 55 in a theme, actor, director or writer dimension. Genre/format/language/decade alone cannot qualify a title for that bucket. Verified specific matches lead the taste bucket; positively scored candidates retrieved from an owned positive anchor can supplement them. Anchor repetition is limited to three in a rolling ten when alternatives exist; genre/franchise repetition penalties also diversify ordering without modifying displayed SceneDNA. Known negative theme/creator fits never pad a page; short pages retain continuation. Warm decks are not forced into release-age quotas; cold-start decks retain the catalog age mix.

## Metadata and request bounds

Only public TMDB title and attribute IDs are sent upstream. User IDs, ratings, private list names and list contents are not included in requests or diagnostics.

- Up to eight history-evidence requests (six positive, two negative) and six personalized-source requests per page. When personal retrieval is active, only two generic catalog lanes are queried, rotating across media and release bands.
- Up to 24 candidate-evidence requests, using at most eight HTTP workers. Source-balanced inspection checks twenty personal prospects and reserves four catalog slots when available; unused slots can return to personal sources.
- Evidence requests use three-second timeouts; personalized source requests use four-second timeouts. Existing catalog and Preview video bounds remain.
- Successful credits/keywords/provider evidence is cached for 24 hours. Failed attempts cool down for one hour per region. An unavailable result in one region cannot suppress checks in another.
- Up to 160 unscanned personalized candidates are retained across pages; overflow retains breadth across source groups and preserves the upstream order within each group, so sparse genre scores cannot monopolize detail inspection. Source pagination, canonical title IDs and served-title tracking prevent regeneration loops.
- Confirmed unavailable or failed-provider candidates do not indefinitely block continuation. Source outages leave their source cursor unchanged and usable catalog supply can still be returned.
- Provider availability is verified for related-title candidates. Missing appended provider data is not treated as proof of availability. Updates preserve independently cached images and details.

This release improves real keyword/credit coverage. It does not implement or claim LLM-derived tone/pacing enrichment, and SceneDNA remains a compatibility score rather than a calibrated probability.

## In-session adaptation

After three save-state changes, or an explicit rating/dislike, Swipe requests a nonblocking re-ranking of its existing queue. The server accepts only titles already served to the authenticated owner in the same valid session/filter context. The current card and immediate next card stay in place. The client independently pins its current position when the response arrives, ignores obsolete filter/account generations, never resurrects removed titles, and preserves pages appended during the request. Failure of optional re-ranking leaves swiping available; later page retrieval still uses fresh taste.

The discovery algorithm version changes to discovery_v5:scenedna_title_v4, so old saved session cursors are reset through the existing recovery path. Normal resume/replay stays idempotent; explicit re-ranking does not consume a page or record an interaction. Seed-based explanations are revalidated against current positive evidence.

## Verification

The new regression uses two viewers with opposite preferences inside **Drama**, identical broad metadata, bare TMDB list responses, and 25% off-theme noise in related-title sources. It evaluates actual selected title IDs. Against the deployed baseline, the first viewer received 14/20 thematic fits for movie Swipe, 13/20 for TV Swipe and 12/20 for TV Preview. The revised code produced 18–20/20 across the corresponding two-viewer runs. UUID tie-breaking can vary exact totals; the gate is at least 16/20, no more than four overlapping picks across opposing profiles, bounded metadata work and duplicate-free continuation. These are controlled fixtures, not a measured production hit rate.

Additional regressions reject broad genre-only named explanations, prevent sparse-metadata score inflation, select the closest evidenced favorite rather than automatically the highest-rated one, test anchor diversity, prevent disliked filler and invalidate pre-fix queues through the existing 409 recovery path.

The v4 regressions also compare actual selected title IDs against generic-tag distractors, verify excluded tags cannot power trait retrieval, reject accumulated incidental overlaps across 24 favorites and reject unlabelled keyword evidence. No further metadata requests or migrations are required by this correction.


Synthetic movie and TV fixtures exercise genuinely different user histories with held-out candidate titles. Acceptance requires at least 14 of the first 20 titles to match the intended genre for each opposing profile, at most six shared results, and meaningful inclusion of older favorites despite the old age quota. Separate tests cover real-keyword theme separation, full-library retrieval rotation, metadata request bounds, region/genre/media restrictions, source failure continuation, social caps and in-session adaptation.

Client interaction tests render the real Swipe screen. They verify that re-ranking does not block swipes or move the visible card, stale responses cannot overwrite changed filters, and merging retains prefetched pages while excluding removed titles. Existing save, Undo, duplicate-request, layout-stability and autoplay tests remain release gates. PostgreSQL tests, migrations, TypeScript, web export and deployment-safety checks run in CI.

These fixtures demonstrate algorithm behavior, not a measured production recommendation hit rate. Before claiming better live satisfaction, exercise contrasting signed-in movie/TV accounts and confirm relevant results, low repetition, correct reasons, stable gestures and acceptable first-page/pagination latency. Real-device iPhone/iPad acceptance and authenticated provider access remain required.

## Release

The initial personalization shipped in PR #10; the selection-quality corrections are in PR #12. Deploy the exact green backend commit before finalizing the release. PR #12 changes no frontend code or schema and requires no new provider credentials. The live backend and Netlify deployment must be verified separately from branch CI; a green build does not prove subjective recommendation quality.

Provider contracts checked against TMDB's official documentation:
- https://developer.themoviedb.org/reference/discover-movie
- https://developer.themoviedb.org/reference/discover-tv
- https://developer.themoviedb.org/docs/append-to-response
- https://developer.themoviedb.org/reference/movie-watch-providers
- https://developer.themoviedb.org/reference/tv-series-watch-providers
