import { AppHeader } from "@/components/headers/app-header";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
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


type Visibility = "public" | "followers";

type Prefs = {
  profile_visibility: Visibility;
  show_activity: boolean;
  show_teams: boolean;
  show_public_lists: boolean;
};


export default function PrivacySettingsScreen() {
  const { sessionToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true); setError(null); setPrefs(null);
    try {
      if (!sessionToken) return;
      const res = await apiRequest<Prefs>("/me/preferences", { token: sessionToken });
      if (generation.current === version) setPrefs(res);
    } catch {
      if (generation.current === version) setError("Couldn't load privacy settings. Retry before making changes.");
    } finally { if (generation.current === version) setLoading(false); }
  }, [sessionToken]);
  useEffect(() => {
    inFlight.current = false; setSaving(false); void load();
    return () => { generation.current++; };
  }, [load]);
  async function persist(update: Partial<Prefs>) {
    if (!sessionToken || !prefs || inFlight.current) return;
    const version = generation.current;
    inFlight.current = true; setSaving(true); setError(null);
    try {
      const res = await apiRequest<Prefs>("/me/preferences", {
        method: "PATCH", token: sessionToken, body: JSON.stringify(update),
      });
      if (generation.current === version) setPrefs(res);
    } catch {
      if (generation.current === version) setError("Your change could not be confirmed. Your last confirmed settings are shown. Please try again.");
    } finally {
      if (generation.current === version) { inFlight.current = false; setSaving(false); }
    }
  }
  const visibility = prefs?.profile_visibility;

  return (
    <SafeAreaView style={styles.root}>
      <AppHeader variant="detail" leftKind="back" title="Privacy & Visibility" ownsSafeArea={false} />

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {error ? <Text accessibilityLiveRegion="polite" style={styles.optionBody}>{error}</Text> : null}
          {!prefs ? <Pressable onPress={() => void load()} style={styles.option} accessibilityRole="button"><Text style={styles.optionTitle}>Retry</Text></Pressable> : null}
          {saving ? <Text accessibilityLiveRegion="polite" style={styles.optionBody}>Saving…</Text> : null}
          <Text style={styles.groupTitle}>Profile visibility</Text>

          <Pressable style={styles.option} disabled={saving || !prefs} onPress={() => void persist({ profile_visibility: "public" })}>
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

          <Pressable style={styles.option} disabled={saving || !prefs} onPress={() => void persist({ profile_visibility: "followers" })}>
            <View style={styles.optionIcon}>
              <Ionicons name="people-outline" size={18} color={colors.ink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.optionTitle}>Followers only</Text>
              <Text style={styles.optionBody}>Only people who follow you can see your profile. Following does not require approval.</Text>
            </View>
            {visibility === "followers" ? (
              <Ionicons name="checkmark-circle" size={18} color={colors.accent} />
            ) : (
              <View style={styles.optionCircle} />
            )}
          </Pressable>

          <Text style={styles.groupTitle}>Activity to show</Text>

          <ToggleRow icon="pulse-outline" label="Show my activity" body="Ratings, lists and activity in feed" disabled={saving || !prefs} value={prefs?.show_activity ?? false} onToggle={(v) => void persist({ show_activity: v })} />
          <ToggleRow icon="list" label="Show my public lists" body="Allow others to discover your lists" disabled={saving || !prefs} value={prefs?.show_public_lists ?? false} onToggle={(v) => void persist({ show_public_lists: v })} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}


function ToggleRow({
  icon,
  label,
  body,
  value,
  onToggle,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  body: string;
  value: boolean;
  disabled?: boolean;
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
        disabled={disabled}
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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
