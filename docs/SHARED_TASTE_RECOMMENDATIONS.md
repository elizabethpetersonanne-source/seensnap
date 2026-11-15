# Recommendations across SeenSnap

Swipe, For You, Concierge and More Like This use current owner-scoped evidence and the same versioned SceneDNA scorer. Subject overlap—such as police, serial killers or family conflict—is not a viewing-style match.

## Signals and first-use behavior

- Every numeric rating above 5 is positive, with increasing weight. A 6 is mildly positive; 5 is neutral; 1–4 are negative. This changes the scorer to `scenedna_title_v6` and expires old Swipe/For You snapshots.
- Saves, right swipes and unrated manual favorites supply weaker positive evidence. A numeric rating supersedes weaker actions on that title, so a subsequent dislike is not cancelled by an old save. Duplicate saves/swipes do not multiply its influence.
- Scoring reads all current evidence. Bounded retrieval samples strong ratings, other positive ratings, and saved/right-swiped/unrated favorite titles. Successive Swipe pages rotate within each group. A deck is no longer sourced disproportionately from the highest ratings.
- Manual ranking is never required. First-use search and rating are the primary onboarding path: five known films/shows, including favorites and less-loved titles. Choosing a #1 is optional, as are swiping and skipping. Confirmed ratings persist and remain editable through the existing rating flow.
- Users with little evidence still receive recommendations. The badge remains in its learning state until its evidence/coverage requirements are met. Streaming services and region are availability context, not proof of a particular taste.

## Surface behavior

**For You / See All:** media and genre filters run before retrieval limits. Local supply spans four release eras, supplemented by bounded personal TMDB sources. Public metadata and viewing-style descriptions are warmed before ranking. An owner/filter/taste-version cache holds candidate IDs for 15 minutes, shared by the home rail and See All. Scores, reasons and exclusions are re-read; manual rankings remain untouched. See All keeps stable pagination. Promoting a small poster also promotes its own reason, badge and actions; the selected hero survives a refresh when still eligible.

**Concierge:** search relevance is the first ordering key; SceneDNA breaks relevance ties. Source ownership, list membership, actor, language, year, runtime and provider constraints remain authoritative. All displayed recommendations must pass their own relevance review. Similar-title requests additionally need multi-axis style or verified creator evidence. Unknown style is retryable, not a fabricated match or a false exhausted catalog. Changed anchor evidence invalidates continuation assessments. Model context includes diverse ratings, negative evidence and known viewing preferences without replacing the actual #1.

**More Like This:** retain the source title's viewing experience before personal ordering. Shared genre, cast or subject alone cannot qualify. Explicit dislikes are removed. The client loads related titles separately, so optional enrichment cannot hold up title details/actions. Requests are cancelled when changing titles/accounts or closing; failures expose a retry.

## Bounds and verification

For You materializes at most 800 local candidates plus 160 personal-source candidates, inspects up to 24 prospects and prepares at most 32 public titles per pass. Concierge permits two bounded style passes within its existing request deadline. Public-title styles are cached independently of users. Worker deadlines inherit the parent budget; model outages have a short retry cooldown and never invent metadata.

Regression coverage checks actual selection for opposite styles with identical genres/subjects; no-ranking and 6/10/right-swipe signals; representative source rotation; hard request relevance; source membership; cache exclusions; anchor changes; provider failures; stable poster interactions; optional detail loading; and onboarding rating/search recovery. Synthetic fixtures establish these behaviors, not production recommendation satisfaction. Live model quality and iPhone/iPad interaction still require acceptance after backend deployment.

Deploy the compatible backend before publishing this frontend; no new database migration is introduced by these changes. Existing deployments remain compatible because the details endpoints retain their default inline-related behavior until clients opt out.
