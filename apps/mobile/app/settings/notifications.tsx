/**
 * Oct-18 UI/UX rebuild: Notifications sub-screen.
 * Spec image 4 (step 4). Grouped toggles for Social / Teams / Activity.
 *
 * Backs onto GET/PATCH /me/preferences for the master notifications
 * switch; per-channel toggles are stored locally for now (the backend
 * only has a single switch, so flipping a per-channel toggle while
 * the master is off is a no-op).
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";


const GROUPS: { title: string; items: { key: string; icon: keyof typeof Ionicons.glyphMap; label: string }[] }[] = [
  {
    title: "Social",
    items: [
      { key: "likes_comments", icon: "heart-outline", label: "Likes and comments" },
      { key: "followers", icon: "person-add-outline", label: "New followers" },
      { key: "mentions", icon: "at-outline", label: "Mentions" },
      { key: "messages", icon: "mail-outline", label: "Messages" },
    ],
  },
  {
    title: "Watch Teams",
    items: [
      { key: "team_invites", icon: "people-outline", label: "Team invites" },
      { key: "team_activity", icon: "people", label: "Team activity" },
    ],
  },
  {
    title: "Your activity",
    items: [
      { key: "ranking_changes", icon: "stats-chart-outline", label: "Ranking changes" },
      { key: "list_activity", icon: "list-outline", label: "List activity" },
      { key: "recommendations", icon: "sparkles-outline", label: "Recommendations" },
    ],
  },
];


export default function NotificationsSettingsScreen() {
  const { sessionToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [masterOn, setMasterOn] = useState(true);
  const [channels, setChannels] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    apiRequest<{ notifications_enabled: boolean }>("/me/preferences", { token: sessionToken })
      .then((res) => { if (!cancelled) setMasterOn(res.notifications_enabled); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    const initial: Record<string, boolean> = {};
    GROUPS.forEach((g) => g.items.forEach((i) => (initial[i.key] = true)));
    setChannels(initial);
    return () => { cancelled = true; };
  }, [sessionToken]);

  async function toggleMaster(next: boolean) {
    setMasterOn(next);
    if (!sessionToken) return;
    try {
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ notifications_enabled: next }),
      });
    } catch {
      setMasterOn(!next);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.masterRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.masterTitle}>Notifications</Text>
              <Text style={styles.masterSub}>Enable push alerts across the app.</Text>
            </View>
            <Switch
              value={masterOn}
              onValueChange={toggleMaster}
              trackColor={{ false: "rgba(255,255,255,0.1)", true: colors.accent }}
              thumbColor={colors.ink}
            />
          </View>

          {GROUPS.map((group) => (
            <View key={group.title} style={styles.group}>
              <Text style={styles.groupTitle}>{group.title}</Text>
              {group.items.map((item) => (
                <View key={item.key} style={styles.row}>
                  <Ionicons name={item.icon} size={18} color={colors.ink} />
                  <Text style={styles.rowLabel}>{item.label}</Text>
                  <Switch
                    value={masterOn && (channels[item.key] ?? true)}
                    onValueChange={(v) => setChannels((c) => ({ ...c, [item.key]: v }))}
                    disabled={!masterOn}
                    trackColor={{ false: "rgba(255,255,255,0.1)", true: colors.accent }}
                    thumbColor={colors.ink}
                  />
                </View>
              ))}
            </View>
          ))}
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
  body: { padding: spacing.lg, gap: 12 },
  masterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    marginBottom: 8,
  },
  masterTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  masterSub: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  group: { gap: 2 },
  groupTitle: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.1,
    marginTop: 8,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
  },
  rowLabel: { flex: 1, fontFamily: fonts.sans, color: colors.ink, fontSize: 13 },
});
