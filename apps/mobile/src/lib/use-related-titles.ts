import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import type { UniversalTitle } from "@/lib/universal-title";

type Related = UniversalTitle["relatedTitles"];
type Row = { id: string; title: string; content_type: string; poster_url: string | null; release_date: string | null };

/** Optional recommendations load independently of the title's details/actions. */
export function useRelatedTitles(token: string | null, titleId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    token: string | null; titleId: string; items: Related; loading: boolean; error: boolean;
  } | null>(null);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!titleId) return;
    let active = true;
    const controller = new AbortController();
    setSnapshot({ token, titleId, items: [], loading: true, error: false });
    void apiRequest<Row[]>(`/titles/${titleId}/related`, {
      token, signal: controller.signal, timeoutMs: 30000,
    }).then(rows => {
      if (active) setSnapshot({ token, titleId, loading: false, error: false,
        items: rows.map(row => ({ id: row.id, title: row.title,
          mediaType: row.content_type === "movie" ? "movie" : "tv",
          posterUrl: row.poster_url, year: row.release_date ? Number(row.release_date.slice(0, 4)) : null })) });
    }).catch(() => {
      if (active) setSnapshot({ token, titleId, items: [], loading: false, error: true });
    });
    return () => { active = false; controller.abort(); };
  }, [token, titleId, attempt]);
  const current = snapshot?.token === token && snapshot.titleId === titleId ? snapshot : null;
  return { items: current?.items ?? [], loading: current?.loading ?? Boolean(titleId), error: current?.error ?? false, retry };
}
