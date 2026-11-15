import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";

type Progress = { rated_count: number; signal_count: number; target: number; completed: boolean };

/** Resume and refresh confirmed progress independently of suggestion retrieval. */
export function useOnboardingProgress(token: string | null, enabled: boolean) {
  const request = useRef<AbortController | null>(null);
  const owner = useRef(token);
  owner.current = token;
  const [snapshot, setSnapshot] = useState<{ token: string; progress: Progress } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    request.current?.abort();
    if (!token || !enabled) return null;
    const controller = new AbortController();
    request.current = controller;
    const active = () => !controller.signal.aborted && owner.current === token;
    setLoading(true);
    setError(false);
    try {
      const progress = await apiRequest<Progress>("/me/onboarding-progress", { token, signal: controller.signal });
      if (!active()) return null;
      setSnapshot({ token, progress });
      return progress;
    } catch {
      if (active()) setError(true);
      return null;
    } finally {
      if (active()) setLoading(false);
    }
  }, [token, enabled]);
  useEffect(() => {
    setError(false);
    setLoading(false);
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  return { progress: snapshot?.token === token ? snapshot.progress : null, loading, error, refresh };
}
