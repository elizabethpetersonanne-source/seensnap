/** Owner-scoped recovery receipts. Never persist session tokens or model output. */
import { apiRequest, ApiError } from "@/lib/api";
import * as storage from "@/lib/session-storage";
import type { ConciergeDecisionResponse } from "@/components/concierge-composer";

type PendingSearch = { intent: string; collection_list_id?: string; idempotency_key: string; created: number };
const memory = new Map<string, PendingSearch>();
const keyFor = (userId: string) => `concierge.pending.${userId}`;
export const newConciergeKey = () => `concierge-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export async function pendingConciergeSearch(userId: string): Promise<PendingSearch | null> {
  let pending = memory.get(userId);
  if (!pending) {
    try {
      const raw = await storage.getItem(keyFor(userId));
      pending = raw ? JSON.parse(raw) : undefined;
    } catch { /* Recovery is still available in memory if browser storage is blocked. */ }
  }
  if (!pending || typeof pending.intent !== "string" || typeof pending.idempotency_key !== "string" ||
      !Number.isFinite(pending.created) || Date.now() - pending.created > 24 * 60 * 60 * 1000) return null;
  memory.set(userId, pending);
  return pending;
}

export async function runConciergeSearch(userId: string, token: string, intent: string, listId?: string): Promise<ConciergeDecisionResponse> {
  const previous = await pendingConciergeSearch(userId);
  const same = previous?.intent === intent.trim() && previous?.collection_list_id === listId;
  const pending: PendingSearch = same ? previous! : {
    intent: intent.trim(), collection_list_id: listId, idempotency_key: newConciergeKey(), created: Date.now(),
  };
  memory.set(userId, pending);
  try { await storage.setItem(keyFor(userId), JSON.stringify(pending)); } catch { /* In-memory retry remains valid. */ }
  const recover = () => apiRequest<ConciergeDecisionResponse>(`/me/concierge/requests/${encodeURIComponent(pending.idempotency_key)}`, { token, timeoutMs: 10000 });
  let result: ConciergeDecisionResponse | undefined;
  if (same) {
    try {
      const receipt = await recover();
      if (!receipt.can_retry) result = receipt;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  if (!result) {
    try {
      result = await apiRequest<ConciergeDecisionResponse>("/me/concierge/decision", {
        token, method: "POST", timeoutMs: 95000,
        body: JSON.stringify({ intent: pending.intent, collection_list_id: listId, idempotency_key: pending.idempotency_key }),
      });
    } catch (error) {
      // A disconnected response does not imply the server lost the search.
      try { result = await recover(); } catch { throw error; }
    }
  }
  if (result.status !== "processing" && !result.can_retry) {
    if (memory.get(userId)?.idempotency_key === pending.idempotency_key) memory.delete(userId);
    try {
      const raw = await storage.getItem(keyFor(userId));
      if (raw && JSON.parse(raw).idempotency_key === pending.idempotency_key) await storage.deleteItem(keyFor(userId));
    } catch { /* Expiry prevents an old receipt becoming a permanent draft. */ }
  }
  return { ...result, _intent: pending.intent };
}
