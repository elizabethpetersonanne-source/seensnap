/**
 * Header artwork resolvers — Unified Header System brief §16 + §17 + §18.
 *
 * Every destination's header artwork is semantically tied to real data:
 *   - Discover        → cycling trending backdrops
 *   - Swipe           → the current recommendation's backdrop (owned locally)
 *   - SceneDNA        → titles that actually contributed to the DNA
 *   - My Picks        → posters from the user's saved lists
 *   - Watch Teams     → recently active teams' cover art
 *   - Team Detail     → titles associated with that team
 *   - Profile         → taste collage (favorites + strongest signals)
 *
 * These helpers formalize what was previously ad-hoc per-screen fetching so
 * the system can never accidentally drift toward generic "popular catalog"
 * imagery on personalized surfaces (brief §16 last paragraph, §34).
 *
 * Fallback hierarchy per §18:
 *   personalized → contextual → popular relevant → deliberate SeenSnap texture
 * The final tier is handled inside SeenSnapHeader itself (brand fallback).
 */

import { useEffect, useState } from "react";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * My Picks personal poster collage. Fetches the top posters from ALL of the
 * user's saved lists, deduped, most-recent-first. Returns an array of URLs
 * the caller can pass to a poster mosaic component; empty until the fetch
 * resolves. Never returns generic/popular imagery — if the user has no
 * saves, returns empty and the header falls back to the brand texture.
 */
export function useMyPicksArtwork(limit: number = 4): string[] {
  const { sessionToken } = useAuth();
  const [posters, setPosters] = useState<string[]>([]);

  useEffect(() => {
    if (!sessionToken) {
      setPosters([]);
      return;
    }
    let cancelled = false;
    apiRequest<Array<{ preview_posters?: string[] }>>("/me/watchlist/lists", {
      token: sessionToken,
    })
      .then((rows) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const out: string[] = [];
        for (const list of rows ?? []) {
          for (const poster of list.preview_posters ?? []) {
            if (!poster || seen.has(poster)) continue;
            seen.add(poster);
            out.push(poster);
            if (out.length >= limit) break;
          }
          if (out.length >= limit) break;
        }
        setPosters(out);
      })
      .catch(() => {
        // Silent — header degrades to brand fallback per §18.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken, limit]);

  return posters;
}

/**
 * Profile taste collage. For now, reuses the My Picks artwork (favorites +
 * saves are the strongest tangible taste signal). Once #56 (first-class
 * UserSignal) lands, this can pull from strongest-signal contributing titles
 * instead so Profile and My Picks look distinct.
 */
export function useProfileArtwork(limit: number = 4): string[] {
  return useMyPicksArtwork(limit);
}
