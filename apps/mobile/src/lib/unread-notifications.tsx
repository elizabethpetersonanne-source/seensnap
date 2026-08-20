import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { AppState } from "react-native";

import { useAuth } from "@/lib/auth";
import { fetchNotifications } from "@/lib/notifications";

/**
 * Shared unread-notification count. One fetch per session (+ refresh on app
 * foreground) instead of every tab hitting the endpoint independently. Powers
 * the badge on the persistent notifications icon in the app header.
 */

type UnreadState = {
  count: number;
  refresh: () => Promise<void>;
};

const UnreadContext = createContext<UnreadState>({ count: 0, refresh: async () => {} });

export function UnreadNotificationsProvider({ children }: PropsWithChildren) {
  const { sessionToken } = useAuth();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!sessionToken) {
      setCount(0);
      return;
    }
    try {
      const res = await fetchNotifications(sessionToken);
      setCount(res.unread_count ?? 0);
    } catch {
      // silent — badge just doesn't update
    }
  }, [sessionToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-fetch when app returns to foreground so the badge stays honest.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  return (
    <UnreadContext.Provider value={{ count, refresh }}>{children}</UnreadContext.Provider>
  );
}

export function useUnreadNotifications(): UnreadState {
  return useContext(UnreadContext);
}
