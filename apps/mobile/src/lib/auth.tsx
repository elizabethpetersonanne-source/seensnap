import * as AppleAuthentication from "expo-apple-authentication";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import { exchangeCodeAsync, ResponseType } from "expo-auth-session";
import { useAuthRequest, discovery as googleDiscovery } from "expo-auth-session/providers/google";
import { Platform } from "react-native";
import { createContext, PropsWithChildren, useContext, useEffect, useRef, useState } from "react";

import { deactivatePushToken } from "@/lib/notifications";
import { ONBOARDING_COMPLETED_KEY } from "@/lib/onboarding";
import { setAnalyticsToken } from "@/lib/analytics";
import { publishTasteChange } from "@/lib/taste-events";
import { clearTitleStateCache } from "@/lib/title-state";
import { clearRecentSearches } from "@/lib/recent-searches";
import * as SessionStorage from "@/lib/session-storage";

import { apiRequest } from "@/lib/api";

WebBrowser.maybeCompleteAuthSession();

const SESSION_TOKEN_KEY = "session_token";
const SESSION_USER_KEY = "session_user";
const EXPLICIT_SIGN_OUT_KEY = "auth_signed_out";
export const DEV_AUTH_ENABLED = __DEV__ && process.env.EXPO_PUBLIC_ENABLE_DEV_AUTH === "true";
const DEMO_EMAILS = new Set(["demo@seensnap.app", "seensnap.demo@demo.seensnap.local"]);
const DEMO_SESSION_TOKEN = "expo-go-demo-session";

type SessionUser = {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url?: string | null;
};

type SessionResponse = {
  access_token: string;
  token_type: "bearer";
  user: SessionUser;
};

const EXPO_GO_FALLBACK_USER: SessionUser = {
  user_id: "expo-demo",
  email: "seensnap.demo@demo.seensnap.local",
  display_name: "SeenSnap Demo",
  avatar_url: null,
};

type AuthContextValue = {
  isLoading: boolean;
  sessionToken: string | null;
  user: SessionUser | null;
  isExpoGo: boolean;
  googleAvailable: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithDevEmail: (email: string, displayName?: string) => Promise<void>;
  signInDemo: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshSessionUser: () => Promise<void>;
  updateSessionUser: (next: Partial<SessionUser>) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [isLoading, setIsLoading] = useState(true);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const isExpoGo = Constants.appOwnership === "expo";
  const authBusy = useRef(false);

  // Keep the analytics module in sync with the current session so trackEvent can
  // attach the bearer token without needing React context.
  useEffect(() => {
    setAnalyticsToken(sessionToken);
    clearTitleStateCache();
    publishTasteChange(null);
  }, [sessionToken]);
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const androidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
  const googleClientId = Platform.OS === "ios" ? iosClientId : Platform.OS === "android" ? androidClientId : webClientId;
  const googleAvailable = Boolean(googleClientId && !isExpoGo);
  const googleRedirectUri = Platform.OS === "ios" && iosClientId
    ? `com.googleusercontent.apps.${iosClientId.replace(/\.apps\.googleusercontent\.com$/, "")}:/oauthredirect`
    : undefined;
  const [googleRequest, , promptAsync] = useAuthRequest({
    iosClientId: iosClientId || "unconfigured",
    androidClientId: androidClientId || "unconfigured",
    webClientId: webClientId || "unconfigured",
    redirectUri: googleRedirectUri,
    responseType: Platform.OS === "web" ? ResponseType.IdToken : ResponseType.Code,
    shouldAutoExchangeCode: false,
    extraParams: { prompt: "select_account" },
  });

  async function requestDemoSession(): Promise<SessionResponse> {
    if (!DEV_AUTH_ENABLED) throw new Error("Demo sign-in is available only in local development.");
    const user = await apiRequest<SessionUser>("/auth/me", { token: DEMO_SESSION_TOKEN });
    return {
      access_token: DEMO_SESSION_TOKEN,
      token_type: "bearer",
      user,
    };
  }

  async function persistSession(session: SessionResponse) {
    await SessionStorage.setItem(SESSION_TOKEN_KEY, session.access_token);
    await SessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(session.user));
    await SessionStorage.deleteItem(EXPLICIT_SIGN_OUT_KEY);
  }

  useEffect(() => {
    async function loadSession() {
      try {
        const signedOut = await SessionStorage.getItem(EXPLICIT_SIGN_OUT_KEY);
        if (isExpoGo && DEV_AUTH_ENABLED) {
          if (signedOut === "1") {
            setSessionToken(null);
            setUser(null);
            return;
          }
          setSessionToken(DEMO_SESSION_TOKEN);
          setUser(EXPO_GO_FALLBACK_USER);
          await persistSession({
            access_token: DEMO_SESSION_TOKEN,
            token_type: "bearer",
            user: EXPO_GO_FALLBACK_USER,
          });
          try {
            const session = await requestDemoSession();
            setSessionToken(session.access_token);
            setUser(session.user);
            await persistSession(session);
          } catch {
            // Keep the built-in demo token and fallback identity so Expo Go can still enter the app.
          }
          return;
        }
        const [storedTokenRaw, storedUserJson] = await Promise.all([
          SessionStorage.getItem(SESSION_TOKEN_KEY),
          SessionStorage.getItem(SESSION_USER_KEY),
        ]);
        let storedToken = storedTokenRaw;
        if (!DEV_AUTH_ENABLED && storedToken === DEMO_SESSION_TOKEN) {
          await Promise.all([SessionStorage.deleteItem(SESSION_TOKEN_KEY), SessionStorage.deleteItem(SESSION_USER_KEY)]);
          return;
        }
        let storedUser: SessionUser | null = null;
        if (storedUserJson) {
          try {
            storedUser = JSON.parse(storedUserJson) as SessionUser;
          } catch {
            storedUser = null;
          }
        }
        if (DEV_AUTH_ENABLED && storedUser?.email && DEMO_EMAILS.has(storedUser.email)) {
          try {
            const session = await requestDemoSession();
            await persistSession(session);
            storedToken = session.access_token;
            storedUser = session.user;
          } catch {
            // Keep existing session if migration fails.
          }
        }
        if (storedToken) {
          try {
            const verifiedUser = await apiRequest<SessionUser>("/auth/me", { token: storedToken });
            storedUser = verifiedUser;
            await SessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(storedUser));
          } catch {
            if (DEV_AUTH_ENABLED && storedUser?.email && DEMO_EMAILS.has(storedUser.email)) {
              try {
                const session = await requestDemoSession();
                await persistSession(session);
                storedToken = session.access_token;
                storedUser = session.user;
              } catch {
                storedToken = null;
                storedUser = null;
                await Promise.all([
                  SessionStorage.deleteItem(SESSION_TOKEN_KEY),
                  SessionStorage.deleteItem(SESSION_USER_KEY),
                ]);
              }
            } else {
              storedToken = null;
              storedUser = null;
              await Promise.all([
                SessionStorage.deleteItem(SESSION_TOKEN_KEY),
                SessionStorage.deleteItem(SESSION_USER_KEY),
              ]);
            }
          }
        }
        setSessionToken(storedToken);
        setUser(storedUser);
      } catch {
        await Promise.allSettled([
          SessionStorage.deleteItem(SESSION_TOKEN_KEY),
          SessionStorage.deleteItem(SESSION_USER_KEY),
        ]);
        setSessionToken(null);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    }

    void loadSession();
  }, [isExpoGo]);

  const signInWithGoogle = async () => {
    if (authBusy.current) return;
    if (!googleAvailable) throw new Error("Google sign-in is not available in this build.");
    if (!googleRequest) throw new Error("Sign-in is still loading. Please try again.");
    authBusy.current = true;
    setIsLoading(true);
    try {
      const result = await promptAsync();
      if (result.type === "cancel" || result.type === "dismiss") return;
      if (result.type !== "success") throw new Error("Google sign-in could not be completed. Please try again.");
      let idToken = result.params.id_token;
      if (!idToken && result.params.code && googleClientId) {
        const tokens = await exchangeCodeAsync({
          clientId: googleClientId, code: result.params.code,
          redirectUri: googleRequest.redirectUri,
          extraParams: { code_verifier: googleRequest.codeVerifier || "" },
        }, googleDiscovery);
        idToken = tokens.idToken || "";
      }
      if (!idToken) throw new Error("Google sign-in did not finish. Please try again.");
      const session = await apiRequest<SessionResponse>("/auth/google", {
        method: "POST", body: JSON.stringify({ id_token: idToken }),
      });
      await persistSession(session);
      setSessionToken(session.access_token);
      setUser(session.user);
    } finally {
      authBusy.current = false;
      setIsLoading(false);
    }
  };

  const signInWithDevEmail = async (email: string, displayName?: string) => {
    if (!DEV_AUTH_ENABLED) throw new Error("Test sign-in is available only in local development.");
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      throw new Error("Enter an email to continue.");
    }
    const trimmedName = displayName?.trim() || trimmedEmail.split("@")[0];
    setIsLoading(true);
    try {
      const session = await apiRequest<SessionResponse>("/auth/dev", {
        method: "POST",
        body: JSON.stringify({ email: trimmedEmail, display_name: trimmedName }),
      });
      await persistSession(session);
      setSessionToken(session.access_token);
      setUser(session.user);
    } finally {
      setIsLoading(false);
    }
  };

  const signInWithApple = async () => {
    if (authBusy.current) return;
    authBusy.current = true;
    setIsLoading(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        throw new Error("Apple sign-in did not return an identity token");
      }
      const displayName = credential.fullName?.givenName
        ? [credential.fullName.givenName, credential.fullName.familyName].filter(Boolean).join(" ")
        : undefined;
      const session = await apiRequest<SessionResponse>("/auth/apple", {
        method: "POST",
        body: JSON.stringify({ identity_token: credential.identityToken, display_name: displayName }),
      });
      await persistSession(session);
      setSessionToken(session.access_token);
      setUser(session.user);
    } catch (error) {
      if ((error as { code?: string }).code !== "ERR_REQUEST_CANCELED") throw error;
    } finally {
      authBusy.current = false;
      setIsLoading(false);
    }
  };

  const signInDemo = async () => {
    setIsLoading(true);
    try {
      const session = await requestDemoSession();
      setSessionToken(session.access_token);
      setUser(session.user);
      await persistSession(session);
    } finally {
      setIsLoading(false);
    }
  };

  const signOut = async () => {
    if (sessionToken && !isExpoGo) {
      await deactivatePushToken(sessionToken).catch(() => {});
    }
    // Clear every persisted key that carries user-scoped state. If you
    // add a new per-user cache, add its key here too — anything left
    // behind is visible to the NEXT account that signs in on the same
    // browser/device.
    await Promise.all([
      SessionStorage.deleteItem(SESSION_TOKEN_KEY),
      SessionStorage.deleteItem(SESSION_USER_KEY),
      SessionStorage.deleteItem(ONBOARDING_COMPLETED_KEY),
      clearRecentSearches(),
      SessionStorage.setItem(EXPLICIT_SIGN_OUT_KEY, "1"),
    ]);
    // STATE-02: drop viewer-scoped title state so the next account that
    // signs in on this device starts with a cold cache.
    clearTitleStateCache();
    publishTasteChange(null);
    // W09: drop the shared Swipe/Preview filter so a prior account's
    // "Horror" doesn't carry over to a new sign-in on the same device.
    const { clearDiscoveryFilter } = await import("@/lib/discovery-filter");
    clearDiscoveryFilter();
    setSessionToken(null);
    setUser(null);
  };

  const refreshSessionUser = async () => {
    if (!sessionToken) {
      return;
    }
    try {
      const nextUser = await apiRequest<SessionUser>("/auth/me", { token: sessionToken });
      await SessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(nextUser));
      setUser(nextUser);
    } catch {
      await Promise.all([
        SessionStorage.deleteItem(SESSION_TOKEN_KEY),
        SessionStorage.deleteItem(SESSION_USER_KEY),
      ]);
      setSessionToken(null);
      setUser(null);
    }
  };

  const updateSessionUser = async (next: Partial<SessionUser>) => {
    setUser((current) => {
      if (!current) {
        return current;
      }
      const merged = { ...current, ...next };
      void SessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(merged));
      return merged;
    });
  };

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        sessionToken,
        user,
        isExpoGo,
        googleAvailable,
        signInWithGoogle,
        signInWithApple,
        signInWithDevEmail,
        signInDemo,
        signOut,
        refreshSessionUser,
        updateSessionUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
