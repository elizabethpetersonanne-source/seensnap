import Constants from "expo-constants";
import { Platform } from "react-native";

import { apiRequest } from "@/lib/api";

// Module-level token holder. AuthProvider calls `setAnalyticsToken(token)` when
// the session changes. Kept out of React context to let `trackEvent` be callable
// from anywhere (including services and non-component code) without prop drilling.
let currentToken: string | null = null;
let sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const appBuild =
  (Constants.expoConfig?.version ?? Constants.expoConfig?.runtimeVersion?.toString() ?? "dev") as string;

export function setAnalyticsToken(token: string | null) {
  currentToken = token;
  if (!token) {
    // Rotate the session id on sign-out so post-signout events aren't lumped in with prior activity.
    sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function trackEvent(event: string, payload: Record<string, unknown> = {}) {
  // Best-effort: never block UI, never throw.
  if (__DEV__) {
    console.log(`[analytics] ${event}`, payload);
  }
  const body = {
    event,
    properties: payload,
    platform: Platform.OS,
    app_build: appBuild,
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
  };
  apiRequest<void>("/events", {
    method: "POST",
    token: currentToken,
    body: JSON.stringify(body),
  }).catch(() => {
    // Swallow — analytics must never impact the user's session.
  });
}
