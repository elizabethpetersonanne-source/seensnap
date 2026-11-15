import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { apiRequest, ApiError } from "./api";

type Page = {
  items: { title_id: string }[];
  total?: number;
  item_count?: number;
  next_offset?: number | null;
};
function following(page: Page, offset: number) {
  if (page.next_offset !== undefined) return page.next_offset;
  const next = offset + page.items.length;
  return page.items.length && next < (page.total ?? page.item_count ?? 0) ? next : null;
}

/** Recheck audiences on return; never show another account's cached pages. */
export function useAudiencePages<T extends Page>(endpoint: string, token: string | null, enabled = true) {
  const scope = `${token ?? "anonymous"}|${endpoint}`;
  const current = useRef(scope);
  current.current = scope;
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pageBusy = useRef(false);
  const retained = useRef({ scope, count: 0 });
  const [snapshot, setSnapshot] = useState<{ scope: string; page: T; next: number | null } | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useFocusEffect(useCallback(() => {
    const version = ++generation.current;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    pageBusy.current = false;
    setBusy(false);
    setChecking(true);
    setError(null);
    if (retained.current.scope !== scope) retained.current = { scope, count: 0 };
    const valid = () => current.current === scope && version === generation.current && !request.signal.aborted;
    if (!enabled) {
      setSnapshot(null);
      setChecking(false);
      return () => { generation.current++; request.abort(); };
    }
    void (async () => {
      try {
        let page = await apiRequest<T>(`${endpoint}?limit=40&offset=0`, { token, signal: request.signal });
        if (!valid()) return;
        let next = following(page, 0);
        while (next !== null && page.items.length < retained.current.count) {
          const offset = next;
          const extra = await apiRequest<T>(`${endpoint}?limit=40&offset=${offset}`, { token, signal: request.signal });
          if (!valid()) return;
          page = { ...extra, items: [...new Map([...page.items, ...extra.items].map(item => [item.title_id, item])).values()] } as T;
          next = following(extra, offset);
          if (next !== null && next <= offset) throw new Error("Invalid page continuation");
        }
        if (!valid()) return;
        retained.current.count = page.items.length;
        setSnapshot({ scope, page, next });
      } catch (failure) {
        if (!valid()) return;
        // A failed audience refresh cannot certify that the old content is still readable.
        setSnapshot(null);
        setError(failure instanceof ApiError && [401, 403, 404].includes(failure.status)
          ? "This content is private, deleted, or no longer shared with you."
          : "Couldn't refresh this content. Please try again.");
      } finally {
        if (valid()) setChecking(false);
      }
    })();
    return () => { generation.current++; request.abort(); };
  }, [endpoint, token, scope, enabled, retry]));

  async function more() {
    if (!snapshot || snapshot.scope !== scope || snapshot.next === null || checking || pageBusy.current) return;
    const version = generation.current, offset = snapshot.next, request = controller.current;
    if (!request || request.signal.aborted) return;
    const valid = () => current.current === scope && version === generation.current && !request.signal.aborted;
    pageBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = await apiRequest<T>(`${endpoint}?limit=40&offset=${offset}`, { token, signal: request.signal });
      if (!valid()) return;
      const next = following(page, offset);
      if (next !== null && next <= offset) throw new Error("Invalid page continuation");
      const items = [...new Map([...snapshot.page.items, ...page.items].map(item => [item.title_id, item])).values()];
      retained.current.count = items.length;
      setSnapshot({ scope, page: { ...page, items } as T, next });
    } catch (failure) {
      if (!valid()) return;
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
        setSnapshot(null);
        setError("This content is private, deleted, or no longer shared with you.");
      } else setError("Couldn't load more titles. Please try again.");
    } finally {
      if (valid()) { pageBusy.current = false; setBusy(false); }
    }
  }
  const visible = snapshot?.scope === scope && !checking ? snapshot : null;
  return { data: visible?.page ?? null, nextOffset: visible?.next ?? null, checking, busy, error,
    more, refresh: () => setRetry(value => value + 1), scope };
}
