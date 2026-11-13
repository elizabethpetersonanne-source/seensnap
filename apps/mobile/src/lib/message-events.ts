const listeners = new Set<() => void>();
export function subscribeMessageChanges(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyMessageChanges() { listeners.forEach(listener => listener()); }
