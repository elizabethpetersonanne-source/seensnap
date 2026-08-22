import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { AppState } from "react-native";

import { useAuth } from "@/lib/auth";
import { fetchUnreadCount } from "@/lib/messaging";

/**
 * Shared unread-conversations count — powers the badge on the persistent
 * 💬 icon in the app header. Count is CONVERSATIONS (not individual
 * messages) per Messaging spec §41 so heavy senders don't inflate the
 * number to 47.
 */

type UnreadState = {
  count: number;
  refresh: () => Promise<void>;
};

const UnreadContext = createContext<UnreadState>({ count: 0, refresh: async () => {} });

export function UnreadMessagesProvider({ children }: PropsWithChildren) {
  const { sessionToken } = useAuth();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!sessionToken) {
      setCount(0);
      return;
    }
    const c = await fetchUnreadCount(sessionToken);
    setCount(c);
  }, [sessionToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

export function useUnreadMessages(): UnreadState {
  return useContext(UnreadContext);
}
