import * as SessionStorage from "@/lib/session-storage";

const KEY = "recent_searches_v1";
const MAX = 10;

export async function getRecentSearches(): Promise<string[]> {
  try {
    const raw = await SessionStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function addRecentSearch(query: string): Promise<void> {
  const q = query.trim();
  if (!q) return;
  try {
    const current = await getRecentSearches();
    const filtered = current.filter((s) => s.toLowerCase() !== q.toLowerCase());
    const updated = [q, ...filtered].slice(0, MAX);
    await SessionStorage.setItem(KEY, JSON.stringify(updated));
  } catch {}
}

export async function removeRecentSearch(query: string): Promise<string[]> {
  try {
    const current = await getRecentSearches();
    const updated = current.filter((s) => s !== query);
    await SessionStorage.setItem(KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export async function clearRecentSearches(): Promise<void> {
  try {
    await SessionStorage.deleteItem(KEY);
  } catch {}
}
