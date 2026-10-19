/**
 * Oct-18 UI/UX rebuild: Help & Support sub-screen.
 * Spec image 4 (step 9).
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";


const OPTIONS: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string; url?: string; email?: string }[] = [
  { icon: "book-outline", title: "Help Center", body: "Browse articles and guides", url: "https://seensnap.com/help" },
  { icon: "mail-outline", title: "Contact Us", body: "Send us a message", email: "support@seensnap.com" },
  { icon: "megaphone-outline", title: "Send Feedback", body: "Help us make SeenSnap better", email: "feedback@seensnap.com" },
  { icon: "warning-outline", title: "Report a Problem", body: "Something not working?", email: "bugs@seensnap.com" },
];


export default function HelpSettingsScreen() {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Help & Support</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {OPTIONS.map((o) => (
          <Pressable
            key={o.title}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            onPress={() => {
              if (o.url) Linking.openURL(o.url).catch(() => {});
              else if (o.email) Linking.openURL(`mailto:${o.email}`).catch(() => {});
            }}
          >
            <View style={styles.rowIcon}>
              <Ionicons name={o.icon} size={18} color={colors.ink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{o.title}</Text>
              <Text style={styles.rowBody}>{o.body}</Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={colors.muted2} />
          </Pressable>
        ))}
      </ScrollView>
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
  body: { padding: spacing.lg, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  rowBody: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
});
