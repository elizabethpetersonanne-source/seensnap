/**
 * Oct-18 UI/UX rebuild: Settings menu.
 *
 * Spec image 4 (step 2). Clean 7-row list + Log Out at the bottom.
 * Each row routes to a dedicated sub-screen under /settings/*.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";


type Row = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  path?: string;
};

const ROWS: Row[] = [
  { key: "edit", icon: "person-circle-outline", title: "Edit Profile", body: "Photo, name, bio and more", path: "/settings/edit-profile" },
  { key: "scenedna", icon: "sparkles-outline", title: "Your SceneDNA", body: "Signals, evidence and corrections", path: "/scene-dna" },
  { key: "notifications", icon: "notifications-outline", title: "Notifications", body: "Control what you want to receive", path: "/settings/notifications" },
  { key: "streaming", icon: "tv-outline", title: "Streaming Services", body: "Connect your accounts", path: "/settings/streaming" },
  { key: "privacy", icon: "eye-outline", title: "Privacy & Visibility", body: "Control your profile and activity", path: "/settings/privacy" },
  { key: "blocked", icon: "ban-outline", title: "Blocked Users", body: "Manage blocked accounts", path: "/settings/blocked" },
  { key: "account", icon: "card-outline", title: "Account", body: "Subscription and account details", path: "/settings/account" },
  { key: "help", icon: "help-circle-outline", title: "Help & Support", body: "Get help or contact us", path: "/settings/help" },
];


export default function SettingsScreen() {
  const { signOut } = useAuth();

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="close" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {ROWS.map((row) => (
          <Pressable
            key={row.key}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            onPress={() => row.path && router.push(row.path as Parameters<typeof router.push>[0])}
          >
            <View style={styles.rowIcon}>
              <Ionicons name={row.icon} size={20} color={colors.ink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{row.title}</Text>
              <Text style={styles.rowBody}>{row.body}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted2} />
          </Pressable>
        ))}

        <Pressable
          style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.8 }]}
          onPress={() => void signOut()}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          <Text style={styles.logoutLabel}>Log Out</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 15,
  },
  body: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    marginBottom: 8,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
  },
  rowBody: {
    marginTop: 2,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
  },
  logoutBtn: {
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
  logoutLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.danger,
    fontSize: 14,
    letterSpacing: 0.3,
  },
});
