/**
 * Oct-27 spec ID-01: one typed TitleRef with strict external parsing.
 *
 * Internal identity is the SeenSnap UUID. External identity is the
 * composite of a strictly numeric TMDB id + media type. The same
 * numeric TMDB ID can appear on both a movie and a TV series, so
 * tmdb_id alone is insufficient.
 *
 * The old Social → external-route bug was that
 * /titles/[kind]/[tmdbId] used Number.parseInt(uuid), which happily
 * accepts a UUID beginning with digits (e.g. "550abc…" → 550) and
 * then rendered the wrong movie. Use these helpers so no caller has
 * to re-derive the parse rule.
 */

import { router } from "expo-router";


export type MediaType = "movie" | "series";

export type TitleRef = {
  titleId: string;         // internal SeenSnap UUID
  tmdbId: number | null;   // numeric external ID (nullable only during cold-start)
  mediaType: MediaType;
};


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/** True iff the string is a valid SeenSnap UUID. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}


/** True iff the string parses as a non-negative base-10 integer with no leading sign and no trailing junk. */
export function isStrictNumericId(s: string): boolean {
  if (!s || !/^\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER;
}


/** Normalize a server media_type to our canonical "movie" | "series". */
export function normalizeMediaType(input: string | null | undefined): MediaType | null {
  if (!input) return null;
  const v = input.toString().trim().toLowerCase();
  if (v === "movie" || v === "film") return "movie";
  if (v === "series" || v === "tv" || v === "show") return "series";
  return null;
}


/** Convert `movie` ↔ `movie` and `series` ↔ `tv` for the external URL namespace. */
export function urlKindForMediaType(mt: MediaType): "movie" | "tv" {
  return mt === "movie" ? "movie" : "tv";
}


/** Build an in-app detail path. Prefers internal UUID; external route only used
 *  for universal links where only a numeric TMDB ID is available. */
export function detailPathForRef(ref: TitleRef): string {
  if (ref.tmdbId != null) {
    return `/titles/${urlKindForMediaType(ref.mediaType)}/${ref.tmdbId}`;
  }
  return `/titles/${urlKindForMediaType(ref.mediaType)}/${ref.titleId}`;
}


/** One opener every surface should route through so no caller has to
 *  decide between the UUID path and the TMDB path. */
export function openTitleDetails(ref: TitleRef): void {
  router.push(detailPathForRef(ref) as Parameters<typeof router.push>[0]);
}
