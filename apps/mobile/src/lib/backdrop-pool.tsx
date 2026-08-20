import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { useFocusEffect } from "@react-navigation/native";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { selectSafeBackdropAt } from "@/lib/backdrop";

/**
 * Shared trending backdrop pool. Fetched once per session so every cinematic
 * header on cold-start tabs (Scene DNA / Feed / Teams / Profile) can fall back
 * to a real TMDB backdrop instead of the brand orb. Different tabs pass
 * different offsets so the same pool isn't visibly duplicated across surfaces.
 *
 * Cycling: every tab visit (focus event) advances a shared `rotationTick`
 * counter so revisiting a tab shows a fresh backdrop from the pool. This is
 * cheaper than time-based rotation (no timers, no mid-tab churn) and lines up
 * with when the user is actually looking — motion where attention lands.
 *
 * Never blocks the UI — if the fetch fails, useFallbackBackdrop returns null
 * and the header degrades gracefully to its own brand fallback.
 */

type PoolState = {
  urls: string[];
  rotationTick: number;
  advance: () => void;
};

const BackdropPoolContext = createContext<PoolState>({
  urls: [],
  rotationTick: 0,
  advance: () => {},
});

export function BackdropPoolProvider({ children }: PropsWithChildren) {
  const { sessionToken } = useAuth();
  const [urls, setUrls] = useState<string[]>([]);
  const [rotationTick, setRotationTick] = useState(0);

  const advance = useCallback(() => {
    setRotationTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!sessionToken) {
      setUrls([]);
      return;
    }
    let cancelled = false;
    apiRequest<Array<{ backdrop_url?: string | null }>>(
      "/titles/trending?limit=20",
      { token: sessionToken },
    )
      .then((rows) => {
        if (cancelled) return;
        const list = (rows ?? [])
          .map((r) => r.backdrop_url)
          .filter((u): u is string => Boolean(u));
        setUrls(list);
      })
      .catch(() => {
        // Silent — headers fall back to their own brand render.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  return (
    <BackdropPoolContext.Provider value={{ urls, rotationTick, advance }}>
      {children}
    </BackdropPoolContext.Provider>
  );
}

/**
 * Pick a fallback backdrop from the shared trending pool at the given offset.
 * Advances the shared rotation tick each time the current screen gains focus,
 * so navigating away and back to a tab shows a different backdrop.
 * Returns null before the pool loads.
 */
export function useFallbackBackdrop(offset: number): string | null {
  const { urls, rotationTick, advance } = useContext(BackdropPoolContext);
  useFocusEffect(
    useCallback(() => {
      advance();
    }, [advance]),
  );
  return selectSafeBackdropAt(urls, offset + rotationTick);
}

/**
 * Cycle through a caller-supplied candidate list (e.g. top-3 trending items,
 * teams cover images) using the shared rotation tick. Same "advance on focus"
 * behavior — call this in place of `selectSafeBackdrop(candidates)` so the
 * primary backdrop rotates as the user navigates between tabs. Returns null
 * if no candidate is safe.
 */
export function useCyclingBackdrop(
  candidates: (string | null | undefined)[],
): string | null {
  const { rotationTick } = useContext(BackdropPoolContext);
  return selectSafeBackdropAt(candidates, rotationTick);
}
