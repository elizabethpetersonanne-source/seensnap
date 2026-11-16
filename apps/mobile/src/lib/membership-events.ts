const listeners = new Set<() => void>();
export function membershipChanged() { listeners.forEach(listener => listener()); }
export function onMembershipChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
