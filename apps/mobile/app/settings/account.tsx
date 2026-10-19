/**
 * Oct-18 UI/UX rebuild: Account sub-screen.
 * Spec image 4 (step 8). Signed-in-with, subscription, legal, delete.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PremiumPaywallSheet } from "@/components/premium-paywall-sheet";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useEntitlement } from "@/lib/entitlement";


type Me = {
  user_id: string;
  email: string | null;
  display_name: string;
  username: string;
};


export default function AccountSettingsScreen() {
  const { sessionToken, signOut } = useAuth();
  const entitlement = useEntitlement(sessionToken);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPaywall, setShowPaywall] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    apiRequest<Me>("/me", { token: sessionToken })
      .then((res) => { if (!cancelled) setMe(res); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionToken]);

  async function handleDeleteAccount() {
    if (!sessionToken || deleting) return;
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        "Delete account?",
        "This permanently removes your profile, lists, ratings and activity. This cannot be undone.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: "Delete", style: "destructive", onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;
    setDeleting(true);
    try {
      await apiRequest("/auth/me", { method: "DELETE", token: sessionToken });
      await signOut();
      router.replace("/sign-in");
    } catch (err) {
      Alert.alert("Could not delete account", err instanceof Error ? err.message : "Try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Account</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.groupTitle}>Signed in</Text>
          <View style={styles.row}>
            <Ionicons name="mail-outline" size={18} color={colors.ink} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{me?.display_name ?? ""}</Text>
              <Text style={styles.rowSub}>{me?.email ?? "—"}</Text>
            </View>
          </View>

          <Text style={styles.groupTitle}>Subscription</Text>
          <View style={styles.row}>
            <Ionicons name="trophy-outline" size={18} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{entitlement?.tier === "premium" ? "SeenSnap Premium" : "Free Plan"}</Text>
              <Text style={styles.rowSub}>
                {entitlement?.is_beta
                  ? "Granted during beta — no billing yet."
                  : entitlement?.tier === "premium"
                  ? "Thanks for supporting SeenSnap."
                  : "Upgrade for the full SceneDNA."}
              </Text>
            </View>
            {entitlement?.tier !== "premium" ? (
              <Pressable style={styles.upgradeBtn} onPress={() => setShowPaywall(true)}>
                <Text style={styles.upgradeLabel}>Upgrade</Text>
              </Pressable>
            ) : null}
          </View>

          <Text style={styles.groupTitle}>Legal</Text>
          <Pressable style={styles.rowBtn} onPress={() => Linking.openURL("https://seensnap.com/terms").catch(() => {})}>
            <Ionicons name="document-text-outline" size={18} color={colors.ink} />
            <Text style={styles.rowBtnLabel}>Terms of Service</Text>
            <Ionicons name="open-outline" size={14} color={colors.muted2} />
          </Pressable>
          <Pressable style={styles.rowBtn} onPress={() => Linking.openURL("https://seensnap.com/privacy").catch(() => {})}>
            <Ionicons name="shield-outline" size={18} color={colors.ink} />
            <Text style={styles.rowBtnLabel}>Privacy Policy</Text>
            <Ionicons name="open-outline" size={14} color={colors.muted2} />
          </Pressable>

          <Pressable
            style={[styles.deleteBtn, deleting && { opacity: 0.5 }]}
            onPress={handleDeleteAccount}
            disabled={deleting}
          >
            <Ionicons name="trash-outline" size={18} color={colors.danger} />
            <Text style={styles.deleteLabel}>{deleting ? "Deleting…" : "Delete Account"}</Text>
          </Pressable>
        </ScrollView>
      )}

      <PremiumPaywallSheet
        visible={showPaywall}
        onClose={() => setShowPaywall(false)}
      />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  closeBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 15 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.lg, gap: 8 },
  groupTitle: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.1,
    marginTop: 12,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  rowBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  rowTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  rowSub: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  rowBtnLabel: { flex: 1, fontFamily: fonts.sans, color: colors.ink, fontSize: 14 },
  upgradeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  upgradeLabel: { fontFamily: fonts.sansSemiBold, color: "#0b0f17", fontSize: 11, letterSpacing: 0.3 },
  deleteBtn: {
    marginTop: spacing.xl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: radii.md,
    backgroundColor: "rgba(224,112,112,0.1)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(224,112,112,0.4)",
  },
  deleteLabel: { fontFamily: fonts.sansSemiBold, color: colors.danger, fontSize: 14 },
});
