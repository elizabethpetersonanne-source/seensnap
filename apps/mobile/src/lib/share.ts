import { Alert, Platform, Share } from "react-native";

import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";

/**
 * Web-first share: try the browser's Web Share API (available on most
 * mobile browsers + Safari on macOS), fall back to writing the URL to
 * the clipboard and showing a toast-style confirm alert. Returns
 * "shared" | "copied" | "dismissed" so callers can log the outcome.
 */
async function shareOnWeb(url: string, title: string, message: string): Promise<"shared" | "copied" | "dismissed"> {
  const navShare = (globalThis as any)?.navigator?.share;
  if (typeof navShare === "function") {
    try {
      await navShare.call((globalThis as any).navigator, { title, text: message, url });
      return "shared";
    } catch (err) {
      // AbortError = user closed the sheet; treat as dismissed.
      if (err instanceof Error && err.name === "AbortError") return "dismissed";
      // Fall through to clipboard.
    }
  }
  const clipboard = (globalThis as any)?.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(url);
      Alert.alert("Link copied", url);
      return "copied";
    } catch {
      // Fall through.
    }
  }
  Alert.alert("Share link", url);
  return "copied";
}

/**
 * SeenSnap share helpers — one place that constructs share URLs, invokes the
 * native share sheet, falls back to clipboard when the sheet fails or is
 * declined, and instruments analytics on both start + completion.
 *
 * Analytics events (consumed by /events endpoint):
 *   - title_share_started    { title_id, entry_point }
 *   - title_shared           { title_id, entry_point, activity? }
 *   - title_share_dismissed  { title_id, entry_point }
 *   - list_share_started     { list_id, entry_point }
 *   - list_shared            { list_id, entry_point, activity? }
 *   - list_share_revoked     { list_id }
 */

const DEFAULT_BASE = "https://seensnap.app";

export function buildTitleShareUrl(tmdbId: number | string, mediaType: "movie" | "series" | "tv"): string {
  const t = mediaType === "series" ? "tv" : mediaType;
  return `${DEFAULT_BASE}/titles/${t}/${tmdbId}`;
}

/** Native share for a single title. Copies to clipboard as fallback. */
export async function shareTitle(args: {
  titleId: string;
  tmdbId: number;
  mediaType: "movie" | "series" | "tv";
  displayTitle: string;
  entryPoint: string;
}) {
  const url = buildTitleShareUrl(args.tmdbId, args.mediaType);
  const message = `${args.displayTitle} — on SeenSnap`;
  trackEvent("title_share_started", { title_id: args.titleId, entry_point: args.entryPoint });
  if (Platform.OS === "web") {
    const outcome = await shareOnWeb(url, args.displayTitle, message);
    trackEvent(outcome === "dismissed" ? "title_share_dismissed" : "title_shared", {
      title_id: args.titleId,
      entry_point: args.entryPoint,
      activity: outcome === "shared" ? "web_share_api" : "clipboard",
    });
    return;
  }
  try {
    const result = await Share.share({ message: `${message}\n${url}`, url });
    if (result.action === Share.sharedAction) {
      trackEvent("title_shared", {
        title_id: args.titleId,
        entry_point: args.entryPoint,
        activity: result.activityType ?? null,
      });
    } else {
      trackEvent("title_share_dismissed", { title_id: args.titleId, entry_point: args.entryPoint });
    }
  } catch {
    // Fallback: show the URL in a dialog for manual copy.
    Alert.alert("Share link", url);
    trackEvent("title_shared", {
      title_id: args.titleId,
      entry_point: args.entryPoint,
      activity: "manual_fallback",
    });
  }
}

/** Mint (or reuse) a share token for a list, then invoke native share. */
export async function shareList(args: {
  token: string;
  listId: string;
  listName: string;
  entryPoint: string;
}) {
  if (!args.token) return;
  trackEvent("list_share_started", { list_id: args.listId, entry_point: args.entryPoint });
  // Create-or-reuse token
  let url: string;
  try {
    const resp = await apiRequest<{ token: string; url: string }>(
      `/me/watchlist/lists/${args.listId}/share`,
      { method: "POST", token: args.token, body: "{}" },
    );
    url = resp.url;
  } catch (err) {
    Alert.alert("Couldn't share", err instanceof Error ? err.message : "Please try again.");
    return;
  }
  const message = `${args.listName} — my SeenSnap list`;
  if (Platform.OS === "web") {
    const outcome = await shareOnWeb(url, args.listName, message);
    trackEvent("list_shared", {
      list_id: args.listId,
      entry_point: args.entryPoint,
      activity: outcome === "shared" ? "web_share_api" : "clipboard",
    });
    return;
  }
  try {
    const result = await Share.share({ message: `${message}\n${url}`, url });
    if (result.action === Share.sharedAction) {
      trackEvent("list_shared", {
        list_id: args.listId,
        entry_point: args.entryPoint,
        activity: result.activityType ?? null,
      });
    }
  } catch {
    Alert.alert("Share link", url);
    trackEvent("list_shared", {
      list_id: args.listId,
      entry_point: args.entryPoint,
      activity: "manual_fallback",
    });
  }
}

/** Revoke ALL active shares for a list. */
export async function revokeListShare(sessionToken: string, listId: string) {
  await apiRequest<void>(`/me/watchlist/lists/${listId}/share`, {
    method: "DELETE",
    token: sessionToken,
  });
  trackEvent("list_share_revoked", { list_id: listId });
}
