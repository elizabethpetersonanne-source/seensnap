/** Only opaque queue IDs are saved; the backend rechecks owner, filters and eligibility. */
export type DiscoverySnapshot = {
  version: 1;
  filter: string;
  cursor: string;
  title_ids: string[];
  saved_at: number;
  filters_hidden: boolean;
};
export function discoveryFilterKey(
  media: string | null,
  genre: string | null,
  mode = "streaming",
) {
  return JSON.stringify([media, genre?.trim().toLowerCase() || null, mode]);
}
export function discoveryStorageKey(
  owner: string,
  surface: "swipe" | "preview",
) {
  return `discovery_resume_v1_${owner}_${surface}`;
}
export function parseDiscoverySnapshot(
  raw: string | null,
  filter: string,
  now = Date.now(),
): DiscoverySnapshot | null {
  try {
    const value = JSON.parse(raw || "null");
    if (
      !value ||
      value.version !== 1 ||
      value.filter !== filter ||
      typeof value.cursor !== "string" ||
      !/^[0-9a-f-]{36}:\d+$/i.test(value.cursor) ||
      !Array.isArray(value.title_ids) ||
      value.title_ids.length > 100 ||
      value.title_ids.some(
        (id: unknown) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id),
      ) ||
      typeof value.saved_at !== "number" ||
      now - value.saved_at < 0 ||
      now - value.saved_at >= 24 * 60 * 60 * 1000
    )
      return null;
    return {
      version: 1,
      filter,
      cursor: value.cursor,
      title_ids: [...new Set(value.title_ids)] as string[],
      saved_at: value.saved_at,
      filters_hidden: value.filters_hidden === true,
    };
  } catch {
    return null;
  }
}
