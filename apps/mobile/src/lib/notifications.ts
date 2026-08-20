import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { apiRequest } from "@/lib/api";

export type NotificationItem = {
  id: string;
  notification_type: string;
  title: string;
  body: string;
  actor_user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  route: string | null;
  read_at: string | null;
  opened_at: string | null;
  created_at: string;
};

export type NotificationListResult = {
  items: NotificationItem[];
  unread_count: number;
  next_cursor: string | null;
};

export type NotificationPrefs = {
  team_activity: boolean;
  direct_engagement: boolean;
  recommendations: boolean;
  availability: boolean;
  marketing: boolean;
  push_enabled: boolean;
};

// Native push behavior is not validated in the Netlify QA build — Expo
// Notifications only ships iOS/Android runtimes. On web we no-op every
// imperative API so nothing throws when the module loads or is invoked.
const IS_NATIVE = Platform.OS !== "web";

// Configure foreground notification behavior once at module load (native only)
if (IS_NATIVE) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Returns the current push permission status without prompting.
 */
export async function getNotificationPermissionStatus(): Promise<Notifications.PermissionStatus> {
  if (!IS_NATIVE) return Notifications.PermissionStatus.UNDETERMINED;
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

/**
 * Request push notification permission. Returns true if granted.
 * Only call this after the user has seen the SeenSnap pre-prompt.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!IS_NATIVE) return false;
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === Notifications.PermissionStatus.GRANTED) {
    return true;
  }
  const { status } = await Notifications.requestPermissionsAsync();
  return status === Notifications.PermissionStatus.GRANTED;
}

/**
 * Retrieve the Expo push token and register it with the SeenSnap backend.
 * Safe to call repeatedly — registration is idempotent.
 */
export async function registerPushToken(sessionToken: string): Promise<string | null> {
  if (!IS_NATIVE) return null;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== Notifications.PermissionStatus.GRANTED) {
      return null;
    }

    const easProjectId =
      (Constants.expoConfig?.extra as Record<string, string> | undefined)?.easProjectId ||
      (Constants.easConfig as { projectId?: string } | undefined)?.projectId ||
      "";

    if (!easProjectId) {
      console.warn("[notifications] easProjectId not configured in app.json extra.easProjectId");
      return null;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId: easProjectId });
    const token = tokenData.data;

    await apiRequest("/devices", {
      method: "POST",
      token: sessionToken,
      body: JSON.stringify({
        expo_push_token: token,
        platform: Platform.OS,
        app_env: __DEV__ ? "development" : "production",
        permission_state: "granted",
      }),
    });

    return token;
  } catch (err) {
    console.warn("[notifications] token registration failed:", err);
    return null;
  }
}

/**
 * Deactivate the push token on sign-out so the device stops receiving pushes
 * for the signed-out account.
 */
export async function deactivatePushToken(sessionToken: string): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== Notifications.PermissionStatus.GRANTED) return;

    const easProjectId =
      (Constants.expoConfig?.extra as Record<string, string> | undefined)?.easProjectId ||
      (Constants.easConfig as { projectId?: string } | undefined)?.projectId ||
      "";

    if (!easProjectId) return;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId: easProjectId });
    if (!tokenData.data) return;

    await apiRequest(`/devices/deactivate-token?expo_push_token=${encodeURIComponent(tokenData.data)}`, {
      method: "POST",
      token: sessionToken,
    });
  } catch {
    // Non-fatal — sign out proceeds regardless
  }
}

/** Fetch paginated notifications from the backend. */
export async function fetchNotifications(
  sessionToken: string,
  cursor?: string,
): Promise<NotificationListResult> {
  const params = new URLSearchParams({ limit: "25" });
  if (cursor) params.set("cursor", cursor);
  return apiRequest<NotificationListResult>(`/notifications?${params.toString()}`, {
    token: sessionToken,
  });
}

/** Mark a single notification as read. */
export async function markNotificationRead(
  sessionToken: string,
  notificationId: string,
): Promise<void> {
  await apiRequest(`/notifications/${notificationId}/read`, {
    method: "POST",
    token: sessionToken,
  });
}

/** Mark all notifications as read. */
export async function markAllNotificationsRead(sessionToken: string): Promise<void> {
  await apiRequest("/notifications/read-all", {
    method: "POST",
    token: sessionToken,
  });
}

/** Fetch notification preferences. */
export async function fetchNotificationPrefs(sessionToken: string): Promise<NotificationPrefs> {
  return apiRequest<NotificationPrefs>("/notifications/preferences", { token: sessionToken });
}

/** Update notification preferences. */
export async function updateNotificationPrefs(
  sessionToken: string,
  updates: Partial<NotificationPrefs>,
): Promise<NotificationPrefs> {
  return apiRequest<NotificationPrefs>("/notifications/preferences", {
    method: "PATCH",
    token: sessionToken,
    body: JSON.stringify(updates),
  });
}
