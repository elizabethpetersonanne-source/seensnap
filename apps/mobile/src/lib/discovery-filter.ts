/**
 * Oct-27 followup W09: one filter session shared by Swipe + Preview.
 *
 * Previously each tab held its own useState for CategoryFilter, so
 * picking Comedy on Swipe did nothing when the user tabbed over to
 * Previews. This module hoists the filter to a module-scoped store
 * with a pub-sub + hook, matching the pattern we already use for
 * title-state and rating-events.
 *
 * The store is intentionally lightweight — no AsyncStorage, no
 * persistence beyond the process. Launching the app clears the
 * filter so a stale "Horror" from a prior session doesn't carry
 * over silently.
 */
import { useEffect, useState } from "react";

import type { CategoryFilter } from "@/components/category-chips";


type Listener = (filter: CategoryFilter) => void;


let current: CategoryFilter = { media_type: null, genre: null };
const listeners = new Set<Listener>();


export function getDiscoveryFilter(): CategoryFilter {
  return current;
}


export function setDiscoveryFilter(next: CategoryFilter): void {
  // Equality check so identical writes don't rebroadcast.
  if (
    current.media_type === next.media_type &&
    current.genre === next.genre
  ) {
    return;
  }
  current = { media_type: next.media_type, genre: next.genre };
  listeners.forEach((l) => {
    try { l(current); } catch { /* bad listener shouldn't break others */ }
  });
}


export function subscribeDiscoveryFilter(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}


/** React hook — reads the shared filter and re-renders on changes.
 * Returned setter writes through the shared store so Swipe and
 * Preview subscribers both update. */
export function useDiscoveryFilter(): [CategoryFilter, (next: CategoryFilter) => void] {
  const [state, setState] = useState<CategoryFilter>(current);
  useEffect(() => {
    const unsub = subscribeDiscoveryFilter((next) => setState(next));
    // Catch up with any changes that happened between first render
    // and effect run.
    if (state.media_type !== current.media_type || state.genre !== current.genre) {
      setState(current);
    }
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [state, setDiscoveryFilter];
}


/** Clear on logout or explicit "new session" so a filter from a
 *  prior account doesn't bleed over. */
export function clearDiscoveryFilter(): void {
  setDiscoveryFilter({ media_type: null, genre: null });
}
