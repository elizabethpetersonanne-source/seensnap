# Rating placement in Ranked Favorites

New ratings automatically enter Ranked Favorites after the last existing title
with the same score. For example, rating a title 7 places it after the existing
7s. Changing a score moves only that title to the end of its new score group.
Saving an unchanged score preserves its current position, including manual moves.

If there is no equal score, the title is placed after the last higher score, or
first if none exists. Other ranked titles retain their relative order. This
deliberately does not rebuild or sort the user's entire customized collection.
Manual reordering, explicit append/rebuild controls and clearing ratings retain
their existing behavior. Historical unplaced ratings are not mass-imported.

The shared `rate_title` transaction covers both rating endpoints and streaming
handoff ratings. The rating, Watched status, removal from Next Watch and ranking
commit together under the existing per-user lock. Shifted ranking rows receive
new versions so stale manual moves are rejected. Movies and TV use title UUIDs;
placement reads the whole ranked collection, beyond UI page limits.

No database migration or web/native build is required. Deploy the reviewed API
commit with `deploy/rollout_existing.py`; merging or publishing Netlify alone does
not activate this backend behavior. The existing rating editor and My Picks
refresh subscriptions consume it without an API contract change.

Regression coverage includes equal-score insertion, missing groups, score edits,
same-score retries, manual ordering, account isolation, 605-title collections,
overlapping movie/TV TMDB IDs and simultaneous ratings under PostgreSQL row locks.
Live acceptance: rate a new title 7, confirm it follows all existing 7s, change it
to another score, manually move it, and confirm its position after reopening
My Picks. Repeat from a second rating surface.
