import { Redirect, Stack, useSegments, usePathname, useGlobalSearchParams, router } from "expo-router";
import * as Notifications from "expo-notifications";
import * as SessionStorage from "@/lib/session-storage";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View, ActivityIndicator, Platform, Text, Pressable } from "react-native";
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

import { safeReturnPath } from "@/lib/return-path";
import { colors } from "@/constants/theme";
import { DetailNavigation } from "@/components/detail-navigation";
import { DidYouWatchPrompt } from "@/components/did-you-watch-prompt";
import { AuthProvider, useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/api";
import { BackdropPoolProvider } from "@/lib/backdrop-pool";
import { onboardingCompletedKey, subscribeOnboardingCompletion } from "@/lib/onboarding";
import { UnreadNotificationsProvider } from "@/lib/unread-notifications";
import { UnreadMessagesProvider } from "@/lib/unread-messages";
import { resolveNotificationDestination } from "@/lib/notifications";

function BootScreen() {
  return (
    <View style={styles.boot}>
      <ActivityIndicator color={colors.accent} size="small" />
    </View>
  );
}

function AuthGate() {
  const { isLoading, sessionToken, isExpoGo, user } = useAuth();
  const segments = useSegments();
  const pathname = usePathname();
  const routeParams = useGlobalSearchParams();
  const returnTo = safeReturnPath(routeParams.returnTo);
  const requestedPath = safeReturnPath(pathname + (pathname === "/teams/join" && typeof routeParams.code === "string" ? `?code=${routeParams.code}` : ""));
  const inAuthRoute = segments[0] === "sign-in";
  const publicListRoute = segments[0] === "lists" || segments[0] === "list";
  const inOnboarding = segments[0] === "onboarding";
  const responseListener = useRef<{ remove: () => void } | null>(null);
  const openedNotifications = useRef(new Set<string>());

  useEffect(() => {
    if (isExpoGo || !sessionToken) return;
    // Notification response listeners only exist on native — expo-notifications
    // is a no-op module on web and calling these APIs throws.
    if (Platform.OS === "web") return;

    let cancelled = false;
    async function openResponse(response: Notifications.NotificationResponse | null) {
      if (!response || !sessionToken) return;
      const id = response.notification.request.content.data?.notificationId;
      if (typeof id !== "string" || openedNotifications.current.has(id)) return;
      try {
        const destination = await resolveNotificationDestination(sessionToken, id);
        if (cancelled) return;
        openedNotifications.current.add(id);
        router.push((destination.available ? destination.route : "/notifications") as Parameters<typeof router.push>[0]);
      } catch { if (!cancelled) router.push("/notifications"); }
    }
    responseListener.current = Notifications.addNotificationResponseReceivedListener((r) => { void openResponse(r); });
    void Notifications.getLastNotificationResponseAsync().then(openResponse).catch(() => {});

    return () => { cancelled = true; responseListener.current?.remove(); };
  }, [isExpoGo, sessionToken]);

  type OnboardingStatus = "unknown" | "completed" | "pending" | "error";
  const [onboarding, setOnboarding] = useState<{owner:string|null;status:OnboardingStatus}>({owner:null,status:"unknown"});
  const [onboardingRetry,setOnboardingRetry]=useState(0);
  const onboardingGeneration=useRef(0);
  const onboardingStatus=onboarding.owner===user?.user_id?onboarding.status:"unknown";

  useEffect(() => subscribeOnboardingCompletion((userId) => {
    if (userId === user?.user_id) {
      // An older GET must not reopen onboarding after an accepted completion.
      onboardingGeneration.current++;
      setOnboarding({owner:userId,status:"completed"});
    }
  }), [user?.user_id]);

  useEffect(() => {
    const generation=++onboardingGeneration.current;
    const owner=user?.user_id;
    if (!sessionToken || !owner) {
      setOnboarding({owner:null,status:"unknown"});
      return;
    }
    let cancelled = false;
    const active=()=>!cancelled&&generation===onboardingGeneration.current;
    setOnboarding({owner,status:"unknown"});
    async function checkOnboarding() {
      const cached=await SessionStorage.getItem(onboardingCompletedKey(owner!)).catch(()=>null);
      if(!active())return;
      if(cached==='true'){setOnboarding({owner:owner!,status:'completed'});return;}
      try {
        const prefs = await apiRequest<{ onboarding_completed: boolean }>("/me/preferences", {token: sessionToken!});
        if(!active())return;
        setOnboarding({owner:owner!,status:prefs.onboarding_completed?'completed':'pending'});
        if(prefs.onboarding_completed)void SessionStorage.setItem(onboardingCompletedKey(owner!),"true").catch(()=>{});
      } catch {
        if(active())setOnboarding({owner:owner!,status:'error'});
      }
    }
    void checkOnboarding();
    return () => { cancelled = true; };
  }, [sessionToken, user?.user_id,onboardingRetry]);

  if (isLoading || (sessionToken && onboardingStatus === "unknown")) {
    return <BootScreen />;
  }

  if(sessionToken&&onboardingStatus==='error'&&!inOnboarding){
    return <View style={[styles.boot,{padding:24,gap:20}]}><Text accessibilityRole="alert" style={{color:colors.ink,fontSize:18,textAlign:'center'}}>We couldn't restore your account progress. Please reconnect and try again.</Text><Pressable onPress={()=>setOnboardingRetry(n=>n+1)} style={{minHeight:48,justifyContent:'center'}}><Text style={{color:colors.accent,fontSize:17}}>Retry</Text></Pressable><Pressable onPress={()=>router.replace({pathname:'/onboarding',params:(returnTo??requestedPath)?{returnTo:(returnTo??requestedPath)!}:{}})} style={{minHeight:48,justifyContent:'center'}}><Text style={{color:colors.ink,fontSize:16}}>Continue setup on this device</Text></Pressable></View>;
  }

  if(sessionToken&&inOnboarding&&onboardingStatus==='completed'){
    return <Redirect href={(returnTo??"/(tabs)") as Parameters<typeof router.replace>[0]} />;
  }

  if (!sessionToken && !inAuthRoute && !publicListRoute) {
    return <Redirect href={{pathname:"/sign-in",params:requestedPath?{returnTo:requestedPath}:{}}} />;
  }

  if (sessionToken && inAuthRoute) {
    if (onboardingStatus === "pending") {
      return <Redirect href={{pathname:"/onboarding",params:(returnTo??requestedPath)?{returnTo:(returnTo??requestedPath)!}:{}}} />;
    }
    return <Redirect href={(returnTo??"/(tabs)") as Parameters<typeof router.replace>[0]} />;
  }

  if (sessionToken && !inOnboarding && onboardingStatus === "pending") {
    return <Redirect href={{pathname:"/onboarding",params:(returnTo??requestedPath)?{returnTo:(returnTo??requestedPath)!}:{}}} />;
  }

  return (
    <View style={{flex:1}}>
      <View style={{flex:1}}><Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="profile/[userId]" />
        <Stack.Screen name="person/[tmdbId]" />
        <Stack.Screen name="what-next" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="teams/join" />
        <Stack.Screen name="notifications" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="publish/[titleId]" options={{ animation: "slide_from_bottom", presentation: "modal" }} />
        <Stack.Screen name="add-to-story" options={{ animation: "slide_from_bottom", presentation: "modal" }} />
        <Stack.Screen name="teams/[teamId]/home" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="teams/[teamId]/add-title" options={{ animation: "slide_from_bottom", presentation: "modal" }} />
        <Stack.Screen name="scene-dna" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="discover/collection/[key]" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/edit-profile" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/notifications" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/streaming" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/privacy" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/blocked" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/account" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/help" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings/report-a-problem" options={{ animation: "slide_from_right" }} />
        {/* LINK-01: title share resolver — see app/share/t/[kind]/[id].tsx */}
        <Stack.Screen name="share/t/[kind]/[id]" options={{ headerShown: false, animation: "fade" }} />
        {/* PICKS-01: dedicated New List surface for My Picks → My Lists. */}
        <Stack.Screen name="favorites/new-list" options={{ animation: "slide_from_bottom" }} />
        {/* R05: rated-but-not-ranked list + bulk-add surface. */}
        <Stack.Screen name="favorites/unplaced" options={{ animation: "slide_from_right" }} />
        {/* Compose a new direct message. */}
        <Stack.Screen name="messages/new" options={{ animation: "slide_from_right" }} />
        {/* List detail — edit, remove titles, watch previews. */}
        <Stack.Screen name="favorites/list/[listId]" options={{ animation: "slide_from_right" }} />
        {/* All of another user's ranked favorites, tapped from profile. */}
        <Stack.Screen name="profile/ranked/[userId]" options={{ animation: "slide_from_right" }} />
      </Stack></View>
      <DetailNavigation />
      {/* Oct-18 §8: Did you watch? overlay on meaningful return from a provider launch. */}
      <DidYouWatchPrompt />
    </View>
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
