import { useEffect, useRef, useState } from "react";
import { apiRequest, ApiError } from "@/lib/api";
import * as Storage from "@/lib/session-storage";
import { onboardingDraftKey, markOnboardingCompleted } from "@/lib/onboarding";
import {
  Draft,
  RemoteDraft as Remote,
  LocalDraft as Local,
  readLocalDraft,
  reconcileDraft,
  draftKey,
} from "@/lib/onboarding-recovery";
export type { Draft } from "@/lib/onboarding-recovery";
export function useOnboardingDraft(
  userId: string | undefined,
  token: string | null,
  data: Draft,
  apply: (next: Draft) => void,
) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState<string | null>(null),
    [conflict, setConflict] = useState<Remote | null>(null),
    [retry, setRetry] = useState(0),
    [syncTick, setSyncTick] = useState(0);
  const defaultsRef = useRef(data);
  const current = useRef(data);
  current.current = data;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const revision = useRef<number | null>(null),
    paused = useRef(true),
    generation = useRef(0),
    lastSaved = useRef(""),
    chain = useRef(Promise.resolve());
  const serialized = JSON.stringify(data);
  useEffect(() => {
    const version = ++generation.current;
    paused.current = true;
    revision.current = null;
    setReady(false);
    setError(null);
    setConflict(null);
    chain.current = Promise.resolve();
    if (!userId || !token) return;
    (async () => {
      const [localResult, remoteResult, prefsResult] = await Promise.allSettled(
        [
          Storage.getItem(onboardingDraftKey(userId)),
          apiRequest<Remote>("/me/onboarding-draft", { token }),
          apiRequest<{
            preferred_regions: string[];
            connected_streaming_services: string[];
          }>("/me/preferences", { token }),
        ],
      );
      if (version !== generation.current) return;
      const prefs =
        prefsResult.status === "fulfilled" ? prefsResult.value : null;
      const defaults = {
        ...current.current,
        country_code: prefs?.preferred_regions?.[0] ?? "US",
        streaming_services: prefs?.connected_streaming_services ?? [],
      };
      defaultsRef.current = defaults;
      const local = readLocalDraft(
        localResult.status === "fulfilled" ? localResult.value : null,
        defaults,
      );
      if (remoteResult.status === "fulfilled") {
        const remote = remoteResult.value;
        revision.current = remote.version;
        if (remote.completed) {
          paused.current = true;
          setReady(true);
          void markOnboardingCompleted(userId);
          return;
        }
        const restored = reconcileDraft(local, remote, defaults);
        applyRef.current(restored.data);
        lastSaved.current = draftKey(remote.data);
        if (restored.conflict) {
          setConflict(remote);
          setError(
            "Onboarding changed on another device. Choose which draft to continue.",
          );
        } else paused.current = false;
      } else {
        applyRef.current(local?.data ?? defaults);
        setError(
          "Progress is kept on this device. Retry to reconnect and sync it.",
        );
      }
      setReady(true);
    })();
    return () => {
      generation.current++;
      paused.current = true;
    };
  }, [userId, token, retry]);
  useEffect(() => {
    if (!ready || !userId || !token) return;
    const version = generation.current;
    const timer = setTimeout(() => {
      const local: Local = {
        data: JSON.parse(serialized),
        base_version: revision.current,
        pending: draftKey(JSON.parse(serialized)) !== lastSaved.current,
      };
      void Storage.setItem(
        onboardingDraftKey(userId),
        JSON.stringify(local),
      ).catch(() => {});
      if (
        paused.current ||
        !local.pending ||
        !/^[a-z]{2}$/i.test(local.data.country_code)
      )
        return;
      chain.current = chain.current.then(async () => {
        if (
          version !== generation.current ||
          paused.current ||
          revision.current === null
        )
          return;
        try {
          const result = await apiRequest<Remote>("/me/onboarding-draft", {
            token,
            method: "PUT",
            body: JSON.stringify({
              data: local.data,
              expected_version: revision.current,
            }),
          });
          if (version !== generation.current) return;
          revision.current = result.version;
          lastSaved.current = draftKey(result.data);
          setError(null);
          await Storage.setItem(
            onboardingDraftKey(userId),
            JSON.stringify({
              data: current.current,
              base_version: result.version,
              pending: draftKey(current.current) !== lastSaved.current,
            }),
          ).catch(() => {});
        } catch (e) {
          if (version !== generation.current) return;
          paused.current = true;
          const remote =
            e instanceof ApiError
              ? (e.detail as { current?: Remote })?.current
              : null;
          if (remote?.completed) {
            void markOnboardingCompleted(userId);
            return;
          }
          if (remote) {
            setConflict(remote);
            setError(
              "Onboarding changed on another device. Your draft is kept.",
            );
          } else setError("Progress is kept on this device. Retry to sync it.");
        }
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [serialized, ready, userId, token, syncTick]);
  function resolve(useThisDevice: boolean) {
    if (!conflict) return;
    revision.current = conflict.version;
    lastSaved.current = draftKey(conflict.data);
    paused.current = false;
    setConflict(null);
    setError(null);
    if (!useThisDevice) applyRef.current(conflict.data ?? defaultsRef.current);
    // A same-value local choice still needs to trigger the save effect.
    setSyncTick((n) => n + 1);
  }
  function stop() {
    generation.current++;
    paused.current = true;
  }
  async function retrySync() {
    if (!userId) return;
    await Storage.setItem(
      onboardingDraftKey(userId),
      JSON.stringify({
        data: current.current,
        base_version: revision.current,
        pending: draftKey(current.current) !== lastSaved.current,
      }),
    ).catch(() => {});
    setRetry((n) => n + 1);
  }
  return {
    ready,
    error,
    conflict: !!conflict,
    retry: () => void retrySync(),
    useThisDevice: () => resolve(true),
    useOtherDevice: () => resolve(false),
    stop,
  };
}
