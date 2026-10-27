/**
 * Oct-27 Stefan/Caroline spec SET-02: Direct / Watch Teams / Social
 * notification groups, persisted per-channel on the server.
 *
 * Each toggle writes to /me/preferences.notification_channels; the
 * master switch continues to flip notifications_enabled. Backend
 * delivery is expected to AND the two (master && channel).
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


type Channel = { key: string; icon: keyof typeof Ionicons.glyphMap; label: string; body?: string };

const GROUPS: { title: string; description: string; items: Channel[] }[] = [
  {
    title: "Direct",
    description: "Someone reaches out to you specifically.",
    items: [
      { key: "direct_messages", icon: "mail-outline", label: "Messages" },
      { key: "direct_mentions", icon: "at-outline", label: "Mentions" },
      { key: "direct_reactions", icon: "heart-outline", label: "Likes and comments on your posts" },
      { key: "direct_followers", icon: "person-add-outline", label: "New followers" },
    ],
  },
  {
    title: "Watch Teams",
    description: "Updates from the teams you're part of.",
    items: [
      { key: "team_invites", icon: "people-outline", label: "Team invites" },
      { key: "team_activity", icon: "people", label: "Team activity" },
      { key: "team_watch_plans", icon: "calendar-outline", label: "Watch plans scheduled" },
    ],
  },
  {
    title: "Social",
    description: "What's happening in your social circles.",
    items: [
      { key: "social_posts", icon: "newspaper-outline", label: "Posts from people you follow" },
      { key: "social_lists", icon: "list-outline", label: "List activity" },
      { key: "social_recommendations", icon: "sparkles-outline", label: "Recommendations" },
    ],
  },
];


type PrefsResponse = {
  notifications_enabled: boolean;
  notification_channels: Record<string, boolean>;
};


export default function NotificationsSettingsScreen() {
  const { sessionToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [masterOn, setMasterOn] = useState(true);
  const [channels, setChannels] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    apiRequest<PrefsResponse>("/me/preferences", { token: sessionToken })
      .then((res) => {
        if (cancelled) return;
        setMasterOn(res.notifications_enabled);
        setChannels(res.notification_channels ?? {});
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
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

  async function toggleChannel(key: string, next: boolean) {
    const prev = channels[key];
    setChannels((c) => ({ ...c, [key]: next }));
    if (!sessionToken) return;
    try {
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ notification_channels: { [key]: next } }),
      });
    } catch {
      setChannels((c) => ({ ...c, [key]: prev ?? true }));
    }
  }

  function isOn(key: string) {
    return channels[key] ?? true;
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
              <Text style={styles.groupTitle}>{group.title.toUpperCase()}</Text>
              <Text style={styles.groupDesc}>{group.description}</Text>
              {group.items.map((item) => (
                <View key={item.key} style={styles.row}>
                  <Ionicons name={item.icon} size={18} color={colors.ink} />
                  <Text style={styles.rowLabel}>{item.label}</Text>
                  <Switch
                    value={masterOn && isOn(item.key)}
                    onValueChange={(v) => toggleChannel(item.key, v)}
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
  group: { gap: 2, marginTop: 8 },
  groupTitle: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.1,
    marginTop: 4,
    marginBottom: 2,
  },
  groupDesc: { fontFamily: fonts.sans, color: colors.muted2, fontSize: 11, marginBottom: 6 },
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
