/**
 * Oct-27 spec STATE-02: shared viewer-scoped title-state cache.
 *
 * Rating already has its own pub-sub (see rating-editor.tsx). This
 * module adds the same pattern for saved + watched transitions so
 * every surface (Discover, Social, Swipe/Preview, My Picks, Teams,
 * Profile) stays coherent after a mutation.
 *
 * One mutation per logical action; optimistic updates must call
 * publishTitleState again on failure with the reverted snapshot.
 */

export type TitleStateSnapshot = {
  title_id: string;
  // Oct-27 STATE-01 fields. Rating is intentionally kept in the
  // existing rating-editor pub-sub so legacy consumers don't have to
  // dual-subscribe; this snapshot broadcasts only save/watched.
  saved: boolean | null;         // null = unknown
  watched: boolean | null;       // null = unknown
  // Monotonic client version. Reconciliation can prefer the latest.
  version: number;
  // Server-assigned when available; null for optimistic client updates.
  updated_at: string | null;
};


type Listener = (snapshot: TitleStateSnapshot) => void;
const listeners = new Set<Listener>();
const cache = new Map<string, TitleStateSnapshot>();


export function subscribeTitleState(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}


export function getTitleState(titleId: string): TitleStateSnapshot | null {
  return cache.get(titleId) ?? null;
}


export function publishTitleState(snapshot: TitleStateSnapshot): void {
  const prev = cache.get(snapshot.title_id);
  // Drop out-of-order updates. A client-optimistic version N+1 should
  // not be clobbered by a late server N update.
  if (prev && prev.version > snapshot.version) return;
  cache.set(snapshot.title_id, snapshot);
  listeners.forEach((l) => {
    try { l(snapshot); } catch { /* a bad listener shouldn't break others */ }
  });
}


/** Convenience: patch an existing cache entry with partial fields.
 *  Only use when the caller has already observed the current snapshot
 *  (e.g. an optimistic save after a save-sheet confirmation). */
export function patchTitleState(titleId: string, patch: Partial<Omit<TitleStateSnapshot, "title_id">>): void {
  const current = cache.get(titleId) ?? {
    title_id: titleId,
    saved: null,
    watched: null,
    version: 0,
    updated_at: null,
  };
  publishTitleState({
    ...current,
    ...patch,
    title_id: titleId,
    version: (patch.version ?? current.version) + (patch.version === undefined ? 1 : 0),
  });
}


/** Clear everything. Call on logout or account switch per STATE-02. */
export function clearTitleStateCache(): void {
  cache.clear();
}
