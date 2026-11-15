# Personal reasons for SeenSnap recommendations

The prior explanation often named generic dimensions ("your genres, release decades"). Restoring or re-ranking Swipe also discarded a seed-specific reason. This release explains the viewer's actual action and a verified connection, and keeps that explanation through fresh feeds, retries, resume and adaptive re-ranking.

## Product behavior

- Require a shared director, meaningful named TMDB keyword overlap, or cast member for a named metadata connection. A broad genre, known weak keyword (such as sequel or a city), or incidental theme overlap cannot borrow a favorite's name. Theme connections use the same minimum weighted overlap as the scorer. Choose the closest verified title connection, not automatically the highest numeric rating. Example with synthetic data: "You rated Your Favorite 9/10. This is also directed by Example Director."
- Use the real numeric rating, including a fractional rating if present. A save says "You saved"; a right swipe says "You swiped right". Neither says the person watched or loved it.
- Personal rankings without a numeric rating can say "[Title] is your #3 pick". Current ratings take precedence over saves and rankings, including neutral and negative ratings.
- Only cite an anchor belonging to the current viewer's evidence. Shared names alone do not establish a connection: the same metadata identity must occur in both titles and contribute a positive aggregate preference. Do not invent emotional, pacing or story similarities from broad genres.
- A genuine related-title retrieval can name its positive seed when no stronger verified connection exists. Exploration is described as "A change of pace to help us learn what else you enjoy." Cold starts are described as early picks while learning the user's taste.
- The shared title scorer supplies this copy to surfaces that consume its explanation, including For You. Concierge keeps its request-relevance ordering and result rationale; this change does not replace search intent with taste alone.
- Swipe's compact reason is tappable. A scrollable explanation sheet shows the full sentence at readable size, with a 44-point close target, safe-area padding and a maximum 600-point width on larger screens. Opening it does not swipe, save or move the poster.

## Implementation boundaries

`recommendation_reasons.py` uses current owner-scoped evidence and already-loaded title metadata. It adds no provider calls, database queries or model calls. The explanation generator does not alter numeric scores. The accompanying Swipe quality correction versions the scorer to v4: v3 removed sparse-metadata inflation, and v4 excludes weak/incidental theme evidence from retrieval and scoring as well as reasons. Percentage confidence gates are unchanged. See `SWIPE_PERSONALIZATION.md`. Numeric feature-cache results are kept separate from title-specific copy so equivalent features cannot reuse another title's explanation or cite the title itself.

`discovery_feed.py` and `discovery_resume.py` regenerate reasons from current evidence. Persisted origins are not authority to retain a positive claim after the seed is re-rated or removed. No schema migration is added. The existing frontend can display the richer backend strings immediately; the new frontend adds the readable explanation sheet.

## Verification and rollout

Behavioral tests cover exact ratings, saves versus enjoyment, rank-only evidence, viewer isolation, verified keyword identities, negative aggregate preference, title-cache isolation, and fresh/replayed/restored/re-ranked Swipe and Preview. The screen test exercises explanation open/close at iPhone and iPad widths without advancing the card or recording a swipe.

Deploy the exact backend candidate with the existing rollout script before merging this frontend. Check a live account with known ratings and saves, then merge the matching frontend and verify the full explanation sheet. Physical iPhone/iPad review remains separate from simulated-width component tests. There is no measured production recommendation-quality uplift claimed by these tests.
