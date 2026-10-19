import { useEffect, useState } from "react";

import { apiRequest } from "./api";

export type EntitlementResponse = {
  tier: "premium" | "free";
  sources: string[];
  expires_at: string | null;
  verified: boolean;
  concierge_monthly_cap: number | null;
  is_beta: boolean;
};

export async function fetchEntitlement(token: string): Promise<EntitlementResponse> {
  return apiRequest<EntitlementResponse>("/me/entitlement", { token });
}

export function useEntitlement(token: string | null): EntitlementResponse | null {
  const [state, setState] = useState<EntitlementResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState(null);
      return;
    }
    void fetchEntitlement(token)
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch(() => {
        if (!cancelled) {
          // Fail safe to free tier — the server is still authoritative
          // on every protected call.
          setState({
            tier: "free",
            sources: [],
            expires_at: null,
            verified: false,
            concierge_monthly_cap: null,
            is_beta: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return state;
}
