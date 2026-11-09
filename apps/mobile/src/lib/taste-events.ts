/** Owner-scoped invalidation after confirmed writes, never optimistic changes. */
type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();
export function subscribeTasteChanges(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishTasteChange(token: string | null) {
  listeners.forEach((listener) => {
    try {
      listener(token);
    } catch {
      /* UI listener cannot fail a saved mutation. */
    }
  });
}
export function affectsTaste(path: string, method = "GET") {
  if (["GET", "HEAD"].includes(method.toUpperCase())) return false;
  return (
    /^\/me\/(ratings|title-state|favorites|watchlist|handoffs|preferences|scene-dna)(\/|\?|$)/.test(
      path,
    ) || /^\/titles\/swipes?(\/|\?|$)/.test(path)
  );
}
