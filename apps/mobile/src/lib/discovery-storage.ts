import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  discoveryStorageKey,
  parseDiscoverySnapshot,
  type DiscoverySnapshot,
} from "@/lib/discovery-recovery";
const pending = new Map<string, Promise<void>>();
export async function readDiscoverySnapshot(
  owner: string,
  surface: "swipe" | "preview",
  filter: string,
) {
  const key = discoveryStorageKey(owner, surface);
  try {
    await pending.get(key);
    return parseDiscoverySnapshot(await AsyncStorage.getItem(key), filter);
  } catch {
    return null;
  }
}
export function saveDiscoverySnapshot(
  owner: string,
  surface: "swipe" | "preview",
  snapshot: DiscoverySnapshot,
) {
  const key = discoveryStorageKey(owner, surface);
  const next = (pending.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => AsyncStorage.setItem(key, JSON.stringify(snapshot)))
    .catch(() => {});
  pending.set(key, next);
  void next.then(() => {
    if (pending.get(key) === next) pending.delete(key);
  });
}

export async function restoreDiscovery<T>(
  owner: string,
  token: string,
  surface: "swipe" | "preview",
  filter: string,
  parameters: {
    preferred_type: string | null;
    genre: string | null;
    mode: string;
  },
) {
  const snapshot = await readDiscoverySnapshot(owner, surface, filter);
  if (!snapshot) return null;
  const { apiRequest, ApiError } = await import("@/lib/api");
  try {
    const response = await apiRequest<T>("/me/discovery-resume", {
      token,
      method: "POST",
      timeoutMs: 90000,
      body: JSON.stringify({
        cursor: snapshot.cursor,
        title_ids: snapshot.title_ids,
        surface,
        ...parameters,
      }),
    });
    return { response, filtersHidden: snapshot.filters_hidden };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return null;
    throw error;
  }
}
