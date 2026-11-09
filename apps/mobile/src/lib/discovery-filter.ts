/** Account-scoped, persisted filters shared by Swipe and Preview. */
import { useEffect, useState } from "react";
import type { CategoryFilter } from "@/components/category-chips";
import { useAuth } from "@/lib/auth";
import * as Storage from "@/lib/session-storage";

type Listener = () => void;
let account: string | null = null;
let ready = false;
let generation = 0;
let current: CategoryFilter = { media_type: null, genre: null };
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((listener) => listener());
const key = (userId: string) => `discovery_filter_v2_${userId}`;

async function activate(userId: string | null) {
  if (account === userId && (ready || account !== null)) return;
  account = userId;
  ready = false;
  current = { media_type: null, genre: null };
  const version = ++generation;
  notify();
  if (!userId) return;
  try {
    const raw = await Storage.getItem(key(userId));
    if (raw && generation === version) {
      const saved = JSON.parse(raw) as CategoryFilter;
      if (
        [null, "movie", "show"].includes(saved.media_type) &&
        (saved.genre === null || typeof saved.genre === "string")
      )
        current = {
          media_type: saved.media_type,
          genre: saved.genre,
          availability_mode:
            saved.availability_mode === "all" ? "all" : "streaming",
        };
    }
  } catch {
    /* Storage failure does not prevent browsing. */
  }
  if (generation === version) {
    ready = true;
    notify();
  }
}

export function getDiscoveryFilter() {
  return current;
}
export function setDiscoveryFilter(next: CategoryFilter) {
  current = {
    media_type: next.media_type,
    genre: next.genre,
    availability_mode:
      next.availability_mode ?? current.availability_mode ?? "streaming",
  };
  if (account)
    void Storage.setItem(key(account), JSON.stringify(current)).catch(() => {});
  notify();
}
export function clearDiscoveryFilter() {
  generation++;
  account = null;
  ready = false;
  current = { media_type: null, genre: null };
  notify();
}
export function useDiscoveryFilter(): [
  CategoryFilter,
  (next: CategoryFilter) => void,
  boolean,
] {
  const { user } = useAuth();
  const userId = user?.user_id ?? null;
  const [, render] = useState(0);
  useEffect(() => {
    const update = () => render((n) => n + 1);
    listeners.add(update);
    void activate(userId);
    return () => {
      listeners.delete(update);
    };
  }, [userId]);
  return [
    account === userId ? current : { media_type: null, genre: null },
    (next) => {
      if (account === userId && ready) setDiscoveryFilter(next);
    },
    account === userId && ready,
  ];
}
