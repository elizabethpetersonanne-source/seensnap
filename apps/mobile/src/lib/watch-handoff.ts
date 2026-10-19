import { apiRequest } from "./api";

export type WatchHandoff = {
  id: string;
  title_id: string;
  title: string;
  poster_url: string | null;
  provider_code: string;
  launched_at: string;
  resolved_action: string | null;
};

export type LaunchHandoffInput = {
  titleId: string;
  providerCode: string;
  outboundUrl: string | null;
  originSurface: string;
};

export async function recordWatchHandoff(
  token: string,
  input: LaunchHandoffInput,
): Promise<WatchHandoff | null> {
  try {
    return await apiRequest<WatchHandoff>("/me/handoffs", {
      method: "POST",
      token,
      body: JSON.stringify({
        title_id: input.titleId,
        provider_code: input.providerCode,
        outbound_url: input.outboundUrl,
        origin_surface: input.originSurface,
      }),
    });
  } catch {
    // Non-fatal — the user still gets to launch the provider.
    return null;
  }
}

export async function fetchOpenHandoffs(token: string): Promise<WatchHandoff[]> {
  try {
    return await apiRequest<WatchHandoff[]>("/me/handoffs/open", { token });
  } catch {
    return [];
  }
}

export async function confirmHandoffWatched(
  token: string,
  handoffId: string,
  rating: number | null,
): Promise<void> {
  await apiRequest(`/me/handoffs/${handoffId}/watched`, {
    method: "POST",
    token,
    body: JSON.stringify({ rating }),
  });
}

export async function dismissHandoffNotYet(token: string, handoffId: string): Promise<void> {
  await apiRequest(`/me/handoffs/${handoffId}/not-yet`, {
    method: "POST",
    token,
  });
}
