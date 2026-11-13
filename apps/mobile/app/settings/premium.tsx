import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { colors, fonts } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { fetchEntitlement, type EntitlementResponse } from "@/lib/entitlement";

export default function PremiumSettings() {
  const { sessionToken } = useAuth();
  const [membership, setMembership] = useState<EntitlementResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    setMembership(null); setError(null);
    if (sessionToken) void fetchEntitlement(sessionToken).then(value => { if (active) setMembership(value); })
      .catch(() => { if (active) setError("Couldn't load your membership. Please retry."); });
    return () => { active = false; };
  }, [sessionToken, reload]));
  const purchased = membership?.sources.includes("purchase");
  const text = { color: colors.ink, fontFamily: fonts.sans, fontSize: 16, lineHeight: 24 };
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
    <AppHeader variant="detail" leftKind="back" title="SeenSnap Premium" ownsSafeArea={false} />
    <ScrollView contentContainerStyle={{ width: "100%", maxWidth: 640, alignSelf: "center", padding: 24, gap: 20, paddingBottom: 48 }}>
      {!membership && !error ? <ActivityIndicator color={colors.accent} /> : null}
      {error ? <View><Text style={text}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setReload(n => n + 1)} style={{ paddingVertical: 14 }}><Text style={{ ...text, color: colors.accent }}>Retry membership</Text></Pressable></View> : null}
      {membership ? <>
        <Text style={{ ...text, fontFamily: fonts.serifBold, fontSize: 28, lineHeight: 34 }}>{membership.tier === "premium" ? "Premium is active" : "Your membership"}</Text>
        <Text style={text}>{membership.is_beta ? "Premium is included during beta. No payment, trial renewal or cancellation is required." : membership.tier === "premium" ? "Your Premium access is confirmed." : "You are on the Free plan. Paid upgrades are not available in this beta."}</Text>
        <Text style={{ ...text, color: colors.accent }}>Included with Premium</Text>
        {["SeenSnap Concierge, with recommendations shaped by your request and your picks.", "SceneDNA insights into your ratings, genres and title preferences.", "Personal recommendations and shared discovery with your Watch Teams."].map(benefit => <Text key={benefit} style={text}>{benefit}</Text>)}
        <Text style={{ ...text, fontFamily: fonts.sansSemiBold }}>Membership management</Text>
        <Text style={text}>{membership.expires_at ? `Access through ${new Date(membership.expires_at).toLocaleDateString()}.` : "No scheduled expiry."}</Text>
        {purchased ? <View style={{ gap: 12 }}><Text style={text}>Manage or cancel with the store where you subscribed.</Text>{[["App Store subscriptions", "https://apps.apple.com/account/subscriptions"], ["Google Play subscriptions", "https://play.google.com/store/account/subscriptions"]].map(([label, url]) => <Pressable key={url} accessibilityRole="button" style={{ minHeight: 48, justifyContent: "center" }} onPress={() => Linking.openURL(url).catch(() => setError("Couldn't open subscription management."))}><Text style={{ ...text, color: colors.accent }}>{label}</Text></Pressable>)}</View> : <Text style={text}>{membership.is_beta ? "There is no paid subscription to manage during beta." : "This access is managed by SeenSnap. Contact support from Help & Support for membership questions."}</Text>}
      </> : null}
    </ScrollView>
  </SafeAreaView>;
}
