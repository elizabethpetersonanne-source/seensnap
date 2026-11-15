# Swipe personalization upgrade

Implemented November 14, 2026. Extends the pending public-readiness release; it is not a record of a production deployment.

## Behavior

Swipe and Preview now retrieve candidates from the viewer's positive title evidence, as well as the regional catalog. Explicit ratings override weaker signals; duplicate memberships do not multiply influence; left/pass remains neutral; watched-and-disliked remains negative. The shared SceneDNA scoring formula and percentage are unchanged.

Two strong anchors and a rotating portion of the full positive library supply evidence. Related-title retrieval alternates a strong anchor with a rotating library title, so older saves are not permanently displaced by recent ratings. Additional TMDB Discover requests use net-positive verified keywords, directors, actors or genres. TV uses its own taxonomy and supported API parameters; movie cast/crew filters are never sent to TV Discover. When TV history is sparse, thematic evidence may transfer from movie history, while all returned titles must still be TV.

Candidate retrieval is independent of scoring. TMDB recommendations do not establish a high SceneDNA match by themselves. Every candidate passes current exclusions, selected genre/media, release-date, artwork, synopsis and regional availability requirements. Watch Team and followed-user sources retain the existing visibility checks.

For viewers with positive evidence, the deck targets 70% specific taste matches, 20% adjacent discovery and up to 10% social/team candidates when available. Social candidates are capped at two in a rolling twenty-card window. Missing buckets fall back to available candidates; percentages are targets, not fabricated supply. Specific taste matches require a score of at least 55 and positive support above 55 in a genre, theme, actor, director or writer dimension. Format/language/decade alone cannot qualify a title for that bucket. Small genre/franchise repetition penalties diversify ordering without modifying displayed SceneDNA. Warm decks are not forced into release-age quotas; cold-start decks retain the catalog age mix.

## Metadata and request bounds

Only public TMDB title and attribute IDs are sent upstream. User IDs, ratings, private list names and list contents are not included in requests or diagnostics.

- Up to four seed-evidence requests and four personalized-source requests per page.
- Up to eight candidate-evidence requests in a worker wave; six personalized prospects and two catalog prospects.
- Evidence requests use three-second timeouts; personalized source requests use four-second timeouts. Existing catalog and Preview video bounds remain.
- Successful credits/keywords/provider evidence is cached for 24 hours. Failed attempts cool down for one hour per region. An unavailable result in one region cannot suppress checks in another.
- Up to 160 unscanned personalized candidates are retained across pages; overflow retains the highest preliminary scores. Source pagination, canonical title IDs and served-title tracking prevent regeneration loops.
- Confirmed unavailable or failed-provider candidates do not indefinitely block continuation. Source outages leave their source cursor unchanged and usable catalog supply can still be returned.
- Provider availability is verified for related-title candidates. Missing appended provider data is not treated as proof of availability. Updates preserve independently cached images and details.

This release improves real keyword/credit coverage. It does not implement or claim LLM-derived tone/pacing enrichment, and SceneDNA remains a compatibility score rather than a calibrated probability.

## In-session adaptation

After three save-state changes, or an explicit rating/dislike, Swipe requests a nonblocking re-ranking of its existing queue. The server accepts only titles already served to the authenticated owner in the same valid session/filter context. The current card and immediate next card stay in place. The client independently pins its current position when the response arrives, ignores obsolete filter/account generations, never resurrects removed titles, and preserves pages appended during the request. Failure of optional re-ranking leaves swiping available; later page retrieval still uses fresh taste.

The discovery algorithm version changes to discovery_v4, so old saved session cursors are reset through the existing recovery path. Normal resume/replay stays idempotent; explicit re-ranking does not consume a page or record an interaction. Seed-based explanations are revalidated against current positive evidence.

## Verification

Synthetic movie and TV fixtures exercise genuinely different user histories with held-out candidate titles. Acceptance requires at least 14 of the first 20 titles to match the intended genre for each opposing profile, at most six shared results, and meaningful inclusion of older favorites despite the old age quota. Separate tests cover real-keyword theme separation, full-library retrieval rotation, metadata request bounds, region/genre/media restrictions, source failure continuation, social caps and in-session adaptation.

Client interaction tests render the real Swipe screen. They verify that re-ranking does not block swipes or move the visible card, stale responses cannot overwrite changed filters, and merging retains prefetched pages while excluding removed titles. Existing save, Undo, duplicate-request, layout-stability and autoplay tests remain release gates. PostgreSQL tests, migrations, TypeScript, web export and deployment-safety checks run in CI.

These fixtures demonstrate algorithm behavior, not a measured production recommendation hit rate. Before claiming better live satisfaction, exercise contrasting signed-in movie/TV accounts and confirm relevant results, low repetition, correct reasons, stable gestures and acceptable first-page/pagination latency. Real-device iPhone/iPad acceptance and authenticated provider access remain required.

## Release

Included with PR #10 and the earlier public-readiness fixes. Deploy the exact green backend commit before merging the frontend to Netlify. No additional migration or model/provider credentials are introduced by this upgrade; the combined release still includes public-readiness migration 0043. The live backend and Netlify deployment must be verified separately from branch CI.

Provider contracts checked against TMDB's official documentation:
- https://developer.themoviedb.org/reference/discover-movie
- https://developer.themoviedb.org/reference/discover-tv
- https://developer.themoviedb.org/docs/append-to-response
- https://developer.themoviedb.org/reference/movie-watch-providers
- https://developer.themoviedb.org/reference/tv-series-watch-providers
