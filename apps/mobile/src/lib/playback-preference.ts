import { useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth";
// Runtime-only preference: each new app process starts muted.
let owner: string | null = null;
let muted = true;
const listeners = new Set<() => void>();
export function usePlaybackMute(): [boolean, (update: boolean | ((old: boolean) => boolean)) => void] {
  const { user } = useAuth();
  const id = user?.user_id ?? null;
  if (owner !== id) { owner = id; muted = true; }
  const value = useSyncExternalStore(
    callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    () => owner === id ? muted : true,
    () => true,
  );
  return [value, update => {
    if (owner !== id) return;
    muted = typeof update === "function" ? update(muted) : update;
    listeners.forEach(callback => callback());
  }];
}
