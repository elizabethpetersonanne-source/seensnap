/** Draft reconciliation is separate from rendering so recovery can be exercised offline. */
export const ONBOARDING_STEPS = [
  "welcome",
  "basics",
  "services",
  "calibrate-intro",
  "calibrate",
  "dna",
  "complete",
] as const;
export type Draft = {
  step: string;
  display_name: string;
  username: string;
  country_code: string;
  streaming_services: string[];
};
export type RemoteDraft = {
  data: Draft | null;
  version: number;
  completed: boolean;
};
export type LocalDraft = {
  data: Draft;
  base_version: number | null;
  pending: boolean;
};

export function normalizeDraft(value: unknown): Draft | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Draft;
  if (
    !ONBOARDING_STEPS.includes(d.step as (typeof ONBOARDING_STEPS)[number]) ||
    typeof d.display_name !== "string" ||
    d.display_name.length > 80 ||
    typeof d.username !== "string" ||
    d.username.length > 40 ||
    typeof d.country_code !== "string" ||
    !/^[a-z]{2}$/i.test(d.country_code) ||
    !Array.isArray(d.streaming_services) ||
    d.streaming_services.length > 12 ||
    !d.streaming_services.every((s) => typeof s === "string")
  )
    return null;
  return {
    step: d.step,
    display_name: d.display_name,
    username: d.username,
    country_code: d.country_code.toUpperCase(),
    streaming_services: [...new Set(d.streaming_services)].sort(),
  };
}

export function draftKey(data: Draft | null): string {
  return JSON.stringify(data ? normalizeDraft(data) : null);
}

export function readLocalDraft(
  raw: string | null,
  defaults: Draft,
): LocalDraft | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return null;
    // The previous app stored only these three fields. Preserve account preferences.
    const data = normalizeDraft(
      saved.data ?? {
        ...defaults,
        step: saved.step,
        display_name: saved.displayName ?? defaults.display_name,
        username: saved.handle ?? defaults.username,
      },
    );
    if (!data) return null;
    const base =
      Number.isInteger(saved.base_version) && saved.base_version >= 0
        ? saved.base_version
        : null;
    return {
      data,
      base_version: base,
      pending: saved.data ? saved.pending === true : true,
    };
  } catch {
    return null;
  }
}

export function reconcileDraft(
  local: LocalDraft | null,
  remote: RemoteDraft,
  defaults: Draft,
): { data: Draft; conflict: boolean } {
  if (remote.completed) return { data: defaults, conflict: false };
  if (!local?.pending)
    return { data: remote.data ?? defaults, conflict: false };
  if (draftKey(local.data) === draftKey(remote.data))
    return { data: remote.data!, conflict: false };
  const sameBase =
    local.base_version === remote.version ||
    (local.base_version === null && remote.version === 0);
  // A cleared server draft is a versioned change too, not permission to overwrite it.
  return { data: local.data, conflict: !sameBase };
}
