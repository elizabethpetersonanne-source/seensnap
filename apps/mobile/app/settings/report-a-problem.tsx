/**
 * Oct-27 spec SET-04: a working bug-report flow with description, optional
 * screenshots, optional device/app diagnostics and a clear submit
 * confirmation. Submissions are persisted as analytics events
 * (event="bug_report") so support can triage without new infra.
 */
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import {
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


export default function ReportAProblemScreen() {
  const { sessionToken, user } = useAuth();
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const diagnostics = useMemo(() => ({
    platform: Platform.OS,
    platform_version: String(Platform.Version ?? ""),
    app_version: Constants.expoConfig?.version ?? null,
    runtime_version: Constants.expoConfig?.runtimeVersion ?? null,
    sdk_version: Constants.expoConfig?.sdkVersion ?? null,
    user_id: user?.user_id ?? null,
  }), [user?.user_id]);

  async function pickScreenshot() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Allow photo access to attach screenshots.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: 3,
        quality: 0.6,
      });
      if (res.canceled) return;
      const uris = res.assets.map((a) => a.uri).slice(0, 3);
      setScreenshots((prev) => [...prev, ...uris].slice(0, 3));
    } catch {
      // non-fatal
    }
  }

  async function submit() {
    if (!description.trim()) {
      Alert.alert("Add a description", "Please describe what went wrong.");
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("/events", {
        method: "POST",
        token: sessionToken ?? undefined,
        body: JSON.stringify({
          event: "bug_report",
          platform: Platform.OS,
          app_build: Constants.expoConfig?.version ?? null,
          properties: {
            description: description.trim(),
            screenshot_count: screenshots.length,
            diagnostics: includeDiagnostics ? diagnostics : null,
          },
        }),
      });
      setSubmitted(true);
    } catch {
      Alert.alert("Couldn't submit", "Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Report a Problem</Text>
          <View style={{ width: 36 }} />
        </View>
        <View style={styles.confirmBody}>
          <View style={styles.confirmIcon}>
            <Ionicons name="checkmark" size={36} color={colors.background} />
          </View>
          <Text style={styles.confirmTitle}>Thanks — it's logged.</Text>
          <Text style={styles.confirmBodyText}>
            We received your report. If we need more detail we'll follow up at
            {user?.email ? ` ${user.email}` : " your account email"}.
          </Text>
          <Pressable onPress={() => router.back()} style={styles.doneBtn}>
            <Text style={styles.doneBtnLabel}>Done</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Report a Problem</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lead}>
          What went wrong? Give us as much detail as you can — screens, steps
          and anything you tried.
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Describe the problem…"
          placeholderTextColor={colors.muted2}
          multiline
          style={styles.input}
          textAlignVertical="top"
        />

        <View style={styles.block}>
          <Text style={styles.blockTitle}>Screenshots (optional)</Text>
          <Text style={styles.blockBody}>Attach up to 3.</Text>
          <View style={styles.thumbRow}>
            {screenshots.map((uri) => (
              <View key={uri} style={styles.thumb}>
                <Image source={{ uri }} style={styles.thumbImg} />
                <Pressable
                  onPress={() => setScreenshots((prev) => prev.filter((u) => u !== uri))}
                  hitSlop={6}
                  style={styles.thumbRemove}
                >
                  <Ionicons name="close" size={12} color={colors.ink} />
                </Pressable>
              </View>
            ))}
            {screenshots.length < 3 ? (
              <Pressable style={styles.thumbAdd} onPress={pickScreenshot}>
                <Ionicons name="add" size={22} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.block}>
          <View style={styles.diagRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.blockTitle}>Include diagnostics</Text>
              <Text style={styles.blockBody}>
                Platform, OS version, app build and user id. Helps us reproduce
                issues faster.
              </Text>
            </View>
            <Switch
              value={includeDiagnostics}
              onValueChange={setIncludeDiagnostics}
              trackColor={{ true: colors.accent, false: colors.surfaceMuted }}
            />
          </View>
          {includeDiagnostics ? (
            <View style={styles.diagPreview}>
              {Object.entries(diagnostics).map(([k, v]) => (
                <Text key={k} style={styles.diagLine}>
                  <Text style={styles.diagKey}>{k}</Text>  {String(v ?? "—")}
                </Text>
              ))}
            </View>
          ) : null}
        </View>

        <Pressable
          onPress={submit}
          disabled={submitting || !description.trim()}
          style={({ pressed }) => [
            styles.submitBtn,
            (submitting || !description.trim()) && { opacity: 0.4 },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.submitLabel}>{submitting ? "Submitting…" : "Submit report"}</Text>
        </Pressable>
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
  body: { padding: spacing.lg, gap: spacing.lg },
  lead: { fontFamily: fonts.sans, color: colors.muted, fontSize: 13, lineHeight: 19 },
  input: {
    minHeight: 160,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  block: {
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  blockTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  blockBody: { fontFamily: fonts.sans, color: colors.muted, fontSize: 12, lineHeight: 17 },
  diagRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  diagPreview: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.08)",
    gap: 4,
  },
  diagLine: { fontFamily: fonts.mono, color: colors.ink, fontSize: 11 },
  diagKey: { color: colors.muted },
  thumbRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  thumb: { width: 64, height: 64, borderRadius: radii.sm, overflow: "hidden", position: "relative" },
  thumbImg: { width: "100%", height: "100%" },
  thumbRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.75)",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbAdd: {
    width: 64,
    height: 64,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.muted2,
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: "center",
  },
  submitLabel: { fontFamily: fonts.sansSemiBold, color: colors.background, fontSize: 14, letterSpacing: 0.3 },

  confirmBody: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  confirmIcon: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accent,
    alignItems: "center", justifyContent: "center", marginBottom: spacing.md,
  },
  confirmTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 18 },
  confirmBodyText: { fontFamily: fonts.sans, color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  doneBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  doneBtnLabel: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
});
