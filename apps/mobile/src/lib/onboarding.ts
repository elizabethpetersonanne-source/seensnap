import * as SessionStorage from "@/lib/session-storage";

export const ONBOARDING_COMPLETED_KEY = "onboarding_completed_v1"; // legacy: deleted on logout only
export const onboardingCompletedKey = (userId: string) =>
  `onboarding_completed_v2:${userId}`;
export const onboardingDraftKey = (userId: string) =>
  `onboarding_draft_v2:${userId}`;

const completionListeners = new Set<(userId: string) => void>();
export function subscribeOnboardingCompletion(
  listener: (userId: string) => void,
): () => void {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

/** Called only after the server accepts completion. Update the gate before routing. */
export async function markOnboardingCompleted(userId: string): Promise<void> {
  // Server completion is authoritative even if a device cannot persist its cache.
  completionListeners.forEach((listener) => {
    try {
      listener(userId);
    } catch {}
  });
  await SessionStorage.setItem(onboardingCompletedKey(userId), "true").catch(
    () => {},
  );
}
