import { Redirect, Stack, useSegments, router } from "expo-router";
import * as Notifications from "expo-notifications";
import * as SessionStorage from "@/lib/session-storage";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View, ActivityIndicator, Platform } from "react-native";
import {
  BodoniModa_500Medium,
  BodoniModa_700Bold,
} from "@expo-google-fonts/bodoni-moda";
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
  useFonts,
} from "@expo-google-fonts/instrument-sans";
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from "@expo-google-fonts/ibm-plex-mono";

import { colors } from "@/constants/theme";
import { AuthProvider, useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/api";
import { BackdropPoolProvider } from "@/lib/backdrop-pool";
import { ONBOARDING_COMPLETED_KEY } from "@/lib/onboarding";
import { UnreadNotificationsProvider } from "@/lib/unread-notifications";
import { UnreadMessagesProvider } from "@/lib/unread-messages";

function BootScreen() {
  return (
    <View style={styles.boot}>
      <ActivityIndicator color={colors.accent} size="small" />
    </View>
  );
}

function AuthGate() {
  const { isLoading, sessionToken, isExpoGo } = useAuth();
  const segments = useSegments();
  const inAuthRoute = segments[0] === "sign-in";
  const inOnboarding = segments[0] === "onboarding";
  const responseListener = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    if (isExpoGo) return;
    // Notification response listeners only exist on native — expo-notifications
    // is a no-op module on web and calling these APIs throws.
    if (Platform.OS === "web") return;

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const route = response.notification.request.content.data?.route as string | undefined;
      if (route) {
        try { router.push(route as Parameters<typeof router.push>[0]); } catch { }
      }
    });

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const route = response.notification.request.content.data?.route as string | undefined;
      if (route) {
        try { router.push(route as Parameters<typeof router.push>[0]); } catch { }
      }
    });

    return () => { responseListener.current?.remove(); };
  }, [isExpoGo]);

  const [onboardingStatus, setOnboardingStatus] = useState<"unknown" | "completed" | "pending">("unknown");

  useEffect(() => {
    if (!sessionToken) {
      setOnboardingStatus("unknown");
      return;
    }

    let cancelled = false;

    async function checkOnboarding() {
      try {
        const cached = await SessionStorage.getItem(ONBOARDING_COMPLETED_KEY);
        if (cached === "true") {
          if (!cancelled) setOnboardingStatus("completed");
          return;
        }
        const prefs = await apiRequest<{ onboarding_completed: boolean }>("/me/preferences", {
          token: sessionToken!,
        });
        if (!cancelled) {
          if (prefs.onboarding_completed) {
            await SessionStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
            setOnboardingStatus("completed");
          } else {
            setOnboardingStatus("pending");
          }
        }
      } catch {
        // Fail open — don't strand the user on a network error
        if (!cancelled) setOnboardingStatus("completed");
      }
    }

    void checkOnboarding();
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  if (isLoading || (sessionToken && onboardingStatus === "unknown")) {
    return <BootScreen />;
  }

  if (!sessionToken && !inAuthRoute) {
    return <Redirect href="/sign-in" />;
  }

  if (sessionToken && inAuthRoute) {
    if (onboardingStatus === "pending") {
      return <Redirect href="/onboarding" />;
    }
    return <Redirect href="/(tabs)" />;
  }

  if (sessionToken && !inOnboarding && onboardingStatus === "pending") {
    return <Redirect href="/onboarding" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="profile/[userId]" />
      <Stack.Screen name="person/[tmdbId]" />
      <Stack.Screen name="what-next" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="teams/join" />
      <Stack.Screen name="notifications" options={{ animation: "slide_from_right" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    BodoniModa_500Medium,
    BodoniModa_700Bold,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });

  if (!fontsLoaded) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} size="small" />
      </View>
    );
  }

  return (
    <AuthProvider>
      <BackdropPoolProvider>
        <UnreadNotificationsProvider>
          <UnreadMessagesProvider>
            <AuthGate />
          </UnreadMessagesProvider>
        </UnreadNotificationsProvider>
      </BackdropPoolProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
});
