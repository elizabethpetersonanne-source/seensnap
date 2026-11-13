import { apiRequest } from "@/lib/api";
import { subscribeTasteChanges } from "@/lib/taste-events";

export type TitleCompatibility = {
  score: number | null;
  percentage: number | null;
  score_version: string;
  computed_at: string;
  evidence_count: number;
  numeric_rating_count: number;
  confidence: number;
  available_dimensions: string[];
  learning: boolean;
  learning_reason?: "more_ratings" | "limited_title_evidence" | null;
  explanation: string;
};
type Pending = {
  id: string;
  resolve: (match: TitleCompatibility | null) => void;
};
const cache = new Map<
  string,
  {
    epoch: number;
    entries: Map<string, { at: number; value: TitleCompatibility }>;
  }
>();
const queues = new Map<string, Pending[]>();
subscribeTasteChanges((token) => {
  if (!token) {
    cache.clear();
    return;
  }
  const owner = cache.get(token);
  if (owner) {
    owner.epoch++;
    owner.entries.clear();
  }
});

/** Coalesce badges into batches; account changes and mutations reject late reads. */
export function getTitleCompatibility(
  token: string,
  id: string,
): Promise<TitleCompatibility | null> {
  let owner = cache.get(token);
  if (!owner) {
    owner = { epoch: 0, entries: new Map() };
    cache.set(token, owner);
  }
  const hit = owner.entries.get(id);
  if (hit && Date.now() - hit.at < 15000) return Promise.resolve(hit.value);
  return new Promise((resolve) => {
    const pending = queues.get(token);
    if (pending) {
      pending.push({ id, resolve });
      return;
    }
    const batch: Pending[] = [{ id, resolve }];
    queues.set(token, batch);
    setTimeout(async () => {
      queues.delete(token);
      const current = cache.get(token),
        epoch = current?.epoch;
      if (!current) {
        batch.forEach((p) => p.resolve(null));
        return;
      }
      const ids = [...new Set(batch.map((x) => x.id))];
      const matches: Record<string, TitleCompatibility> = {};
      try {
        for (let i = 0; i < ids.length; i += 100) {
          Object.assign(
            matches,
            await apiRequest<Record<string, TitleCompatibility>>(
              "/me/title-compatibility",
              {
                token,
                method: "POST",
                body: JSON.stringify({ title_ids: ids.slice(i, i + 100) }),
              },
            ),
          );
        }
        if (cache.get(token) !== current || current?.epoch !== epoch) {
          batch.forEach((p) => p.resolve(null));
          return;
        }
        Object.entries(matches).forEach(([key, value]) =>
          current?.entries.set(key, { value, at: Date.now() }),
        );
        batch.forEach((p) => p.resolve(matches[p.id] ?? null));
      } catch {
        batch.forEach((p) => p.resolve(null));
      }
    }, 20);
  });
}
