/**
 * Shared formatters for the SeenSnap main-nav surfaces. Per the forensic-audit
 * remediation: metadata (counts, timestamps, genre strings) should look identical
 * anywhere. Never let a NaN-derived string like "NaNd ago" reach the UI.
 */

export function relativeTime(input: string | Date | number | null | undefined): string {
  if (input === null || input === undefined) return "";
  const ts = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(ts)) return "";
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now"; // clock skew — never render a future-date defect
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/** Compact count for metadata rows — e.g. "12 titles" or "12 titles · 3 lists". */
export function pluralize(n: number, singular: string, plural?: string): string {
  const word = n === 1 ? singular : (plural ?? `${singular}s`);
  return `${n} ${word}`;
}

/** Standardize genre display: 1–2 concise genres, no long comma-runs. */
export function formatGenres(genres: string[] | null | undefined, max: number = 2): string {
  if (!genres || genres.length === 0) return "";
  return genres.slice(0, max).join(" · ");
}

/** Format a year from an ISO date string; empty string if invalid. */
export function releaseYear(input: string | null | undefined): string {
  if (!input) return "";
  const year = new Date(input).getFullYear();
  return Number.isFinite(year) ? String(year) : "";
}
