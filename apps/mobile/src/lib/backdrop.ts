/**
 * Backdrop-selection policy for the SeenSnap MainNav cinematic headers.
 *
 * Per the forensic audit remediation:
 *   1. Prefer TMDB landscape backdrops/stills over posters.
 *   2. Never stretch a portrait poster into a landscape header.
 *   3. Reject imagery containing embedded title typography / campaign lines / logos.
 *   4. Reject low-resolution / badly cropped / compressed backdrops.
 *   5. Fallback to null (no image) — do NOT reach for a random asset.
 *
 * We can't inspect pixels client-side, but we can use URL heuristics + optional
 * caller-supplied hints (e.g. "this candidate is known to contain title typography")
 * to make deterministic decisions. When our data pipeline exposes language-neutral
 * backdrops (TMDB `iso_639_1 == null`), those should be marked `safe: true`.
 */

export type BackdropCandidate = {
  url: string | null | undefined;
  /** True when the caller knows the source is language-neutral / has no embedded typography. */
  safe?: boolean;
  /** Optional min width — reject anything below to avoid low-res backdrops. */
  minWidth?: number;
};

// Only reject URLs sized at unambiguously poster-only widths. /w780/ and larger
// are shared between posters and backdrops, so we allow them (better to show a
// stretched-but-real image than to fall back to the brand orb every time).
const TMDB_POSTER_ONLY_SIZES = ["/w92/", "/w154/", "/w185/", "/w342/", "/w500/"];

function looksLikePortraitPoster(url: string): boolean {
  if (!url.includes("image.tmdb.org")) return false;
  return TMDB_POSTER_ONLY_SIZES.some((h) => url.includes(h));
}

// Local brand assets (logo, placeholder, avatar-shaped uploads) are not backdrops.
function looksLikeBrandOrIconAsset(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("/media/brand/") ||
    lower.includes("seensnap_logo") ||
    lower.includes("title_placeholder") ||
    lower.includes("/media/avatars/") ||
    lower.includes("/media/users/") ||
    lower.includes("dicebear.com")
  );
}

/**
 * Pick the first candidate that passes the backdrop-safety rules, or null.
 * `null` means "show the solid-ink fallback" — never substitute a bad asset.
 */
export function selectSafeBackdrop(
  candidates: (BackdropCandidate | string | null | undefined)[],
): string | null {
  const safe = safeCandidates(candidates);
  return safe[0] ?? null;
}

/**
 * Rotation-aware variant of selectSafeBackdrop. Returns the candidate at the
 * given `offset` (with wrap-around) after filtering out unsafe URLs. Used so
 * different tabs pulling from the same trending pool don't all render the same
 * backdrop — Discover uses offset 0, Search offset 3, Scene DNA offset 6, etc.
 */
export function selectSafeBackdropAt(
  candidates: (BackdropCandidate | string | null | undefined)[],
  offset: number,
): string | null {
  const safe = safeCandidates(candidates);
  if (safe.length === 0) return null;
  return safe[Math.abs(offset) % safe.length];
}

function safeCandidates(
  candidates: (BackdropCandidate | string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    const candidate: BackdropCandidate =
      typeof raw === "string" ? { url: raw } : raw;
    const url = candidate.url;
    if (!url) continue;
    if (seen.has(url)) continue;
    if (looksLikePortraitPoster(url)) continue;
    if (looksLikeBrandOrIconAsset(url)) continue;
    if (candidate.safe === false) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
