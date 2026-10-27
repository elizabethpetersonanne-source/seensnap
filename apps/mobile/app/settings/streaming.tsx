/**
 * Oct-18 UI/UX rebuild: Streaming Services sub-screen.
 * Spec image 4 (step 5). Connect / Connected list, tap to toggle.
 * Backs onto /me/preferences.connected_streaming_services.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { STREAMING_SERVICES } from "@/lib/streaming";


type Prefs = {
  connected_streaming_services: string[];
};


export default function StreamingSettingsScreen() {
  const { sessionToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState<string[]>([]);

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    apiRequest<Prefs>("/me/preferences", { token: sessionToken })
      .then((res) => { if (!cancelled) setConnected(res.connected_streaming_services ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionToken]);

  async function toggle(serviceId: string) {
    if (!sessionToken) return;
    const next = connected.includes(serviceId)
      ? connected.filter((s) => s !== serviceId)
      : [...connected, serviceId];
    setConnected(next);
    try {
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ connected_streaming_services: next }),
      });
    } catch {
      // Revert on failure.
      setConnected(connected);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Streaming Services</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.lead}>
            Pick the services you subscribe to. We'll use this to filter Where to Watch
            cards so recommendations stay useful. This is a selected subscription — it
            doesn't log in to the provider for you.
          </Text>
          {STREAMING_SERVICES.map((service) => {
            const on = connected.includes(service.id);
            return (
              <Pressable
                key={service.id}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={() => void toggle(service.id)}
              >
                <View style={[styles.logo, { backgroundColor: service.color }]}>
                  <Text style={[styles.logoText, { color: service.textColor }]}>{service.shortName}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.serviceName}>{service.name}</Text>
                  <Text style={styles.serviceSub}>
                    {on ? "Selected subscription" : "Tap to add"}
                  </Text>
                </View>
                {on ? (
                  <View style={styles.connectedPill}>
                    <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                    <Text style={styles.connectedLabel}>Selected</Text>
                  </View>
                ) : (
                  <View style={styles.connectBtn}>
                    <Text style={styles.connectLabel}>Add</Text>
                    <Ionicons name="add" size={14} color={colors.accent} />
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
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
  lead: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontFamily: fonts.sansBold, fontSize: 13 },
  serviceName: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  serviceSub: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 11 },
  connectedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(74,222,128,0.1)",
  },
  connectedLabel: { fontFamily: fonts.sansSemiBold, color: colors.success, fontSize: 11 },
  connectBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
  },
  connectLabel: { fontFamily: fonts.sansSemiBold, color: colors.accent, fontSize: 11 },
});
