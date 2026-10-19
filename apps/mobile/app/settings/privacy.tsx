/**
 * Oct-18 UI/UX rebuild: Privacy & Visibility sub-screen.
 * Spec image 4 (step 6). Public vs Followers-only + activity toggles.
 *
 * These settings are stored locally for now — the backend doesn't yet
 * enforce profile visibility beyond the explicit publication model
 * (brief §6). This screen gives users the control surface so the
 * server can wire them in behind the scenes.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";


type Visibility = "public" | "followers";


export default function PrivacySettingsScreen() {
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [showActivity, setShowActivity] = useState(true);
  const [showTeams, setShowTeams] = useState(true);
  const [showLists, setShowLists] = useState(true);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Privacy & Visibility</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.groupTitle}>Profile visibility</Text>

        <Pressable style={styles.option} onPress={() => setVisibility("public")}>
          <View style={styles.optionIcon}>
            <Ionicons name="earth-outline" size={18} color={colors.ink} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.optionTitle}>Public profile</Text>
            <Text style={styles.optionBody}>Anyone can find and view your profile.</Text>
          </View>
          {visibility === "public" ? (
            <Ionicons name="checkmark-circle" size={18} color={colors.accent} />
          ) : (
            <View style={styles.optionCircle} />
          )}
        </Pressable>

        <Pressable style={styles.option} onPress={() => setVisibility("followers")}>
          <View style={styles.optionIcon}>
            <Ionicons name="people-outline" size={18} color={colors.ink} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.optionTitle}>Followers only</Text>
            <Text style={styles.optionBody}>Only approved followers can see your profile.</Text>
          </View>
          {visibility === "followers" ? (
            <Ionicons name="checkmark-circle" size={18} color={colors.accent} />
          ) : (
            <View style={styles.optionCircle} />
          )}
        </Pressable>

        <Text style={styles.groupTitle}>Activity to show</Text>

        <ToggleRow icon="pulse-outline" label="Show my activity" body="Ratings, lists and activity in feed" value={showActivity} onToggle={setShowActivity} />
        <ToggleRow icon="people" label="Show my Watch Teams" body="Keep your teams private" value={showTeams} onToggle={setShowTeams} />
        <ToggleRow icon="list" label="Show my public lists" body="Allow others to discover your lists" value={showLists} onToggle={setShowLists} />
      </ScrollView>
    </SafeAreaView>
  );
}


function ToggleRow({
  icon,
  label,
  body,
  value,
  onToggle,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  body: string;
  value: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.optionIcon}>
        <Ionicons name={icon} size={18} color={colors.ink} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.optionTitle}>{label}</Text>
        <Text style={styles.optionBody}>{body}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: "rgba(255,255,255,0.1)", true: colors.accent }}
        thumbColor={colors.ink}
      />
    </View>
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
  groupTitle: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.1,
    marginTop: 12,
    marginBottom: 4,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  optionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  optionTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  optionBody: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  optionCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
  },
});
