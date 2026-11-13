import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { apiRequest } from "@/lib/api";
import { subscribeTasteChanges } from "@/lib/taste-events";

type Media = "movie" | "tv";
type Snapshot<T> = {
  token: string;
  media: Media;
  items: T[];
  loading: boolean;
  error: string | null;
};

/** A failed fetch is not an empty taste profile. Keep confirmed results on refresh. */
export function useForYou<T>(token: string | null, media: Media) {
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!token || !active.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const revision = ++generation.current;
    setSnapshot(previous => ({
      token, media, loading: true, error: null,
      items: previous?.token === token && previous.media === media ? previous.items : [],
    }));
    try {
      const items = await apiRequest<T[]>(
        `/titles/recommendations/for-me?limit=12&preferred_type=${media === "tv" ? "show" : "movie"}`,
        { token, signal: controller.signal, timeoutMs: 30000 },
      );
      if (active.current && revision === generation.current)
        setSnapshot({ token, media, items, loading: false, error: null });
    } catch {
      if (!active.current || revision !== generation.current || controller.signal.aborted) return;
      setSnapshot(previous => ({
        token, media, loading: false,
        items: previous?.token === token && previous.media === media ? previous.items : [],
        error: "Couldn't load your recommendations. Please try again.",
      }));
    }
  }, [token, media]);

  useFocusEffect(useCallback(() => {
    active.current = true;
    void refresh();
    const unsubscribe = subscribeTasteChanges(owner => {
      if (owner === token) void refresh();
    });
    return () => {
      active.current = false;
      generation.current++;
      request.current?.abort();
      unsubscribe();
    };
  }, [refresh, token]));

  const current = snapshot?.token === token && snapshot.media === media ? snapshot : null;
  return {
    items: current?.items ?? [],
    loading: current?.loading ?? Boolean(token),
    error: current?.error ?? null,
    refresh,
  };
}
