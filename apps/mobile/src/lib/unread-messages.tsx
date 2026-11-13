import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { AppState } from "react-native";

import { useAuth } from "@/lib/auth";
import { fetchUnreadCount } from "@/lib/messaging";
import { subscribeMessageChanges } from "@/lib/message-events";

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
  const currentToken=useRef(sessionToken);currentToken.current=sessionToken;
  const request = useRef(0);
  useEffect(()=>setCount(0),[sessionToken]);

  const refresh = useCallback(async () => {
    if (!sessionToken) {
      setCount(0);
      return;
    }
    const version = ++request.current;
    try {
      const c = await fetchUnreadCount(sessionToken);
      if(currentToken.current===sessionToken && request.current === version)setCount(c);
    } catch { /* Keep the last confirmed badge during transient failures. */ }
  }, [sessionToken]);

  useEffect(() => {
    void refresh();
    if (!sessionToken) return;
    const stop = subscribeMessageChanges(() => { void refresh(); });
    const timer = setInterval(() => {
      if (AppState.currentState === "active" && (typeof document === "undefined" || !document.hidden)) void refresh();
    }, 30000);
    return () => { stop(); clearInterval(timer); request.current++; };
  }, [refresh, sessionToken]);

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
