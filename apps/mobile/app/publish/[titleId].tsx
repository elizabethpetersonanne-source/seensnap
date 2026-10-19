/**
 * Oct-18 build brief §6 explicit publication composer.
 *
 * Private save / rate / rank NEVER auto-publishes. When the user
 * wants to broadcast, they open this composer, write an optional
 * Take (≤ 300 chars), and tap Publish. The server snapshots the
 * historical rating and ranked position so later private edits
 * never silently rewrite this post.
 *
 * Query params: titleId (required), kind (defaults to rated_title),
 * optional listId / teamId for list/team-scoped kinds.
 */
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";


const SUPPORTED_KINDS = [
  { key: "rated_title", label: "Rated this title" },
  { key: "ranked_change", label: "Ranked change" },
  { key: "added_to_list", label: "Added to a list" },
  { key: "list_published", label: "Published a list" },
  { key: "watched_team", label: "Watched with a team" },
] as const;

type Visibility = "public" | "followers";

type PublishResponse = {
  event_id: string;
  created_at: string;
  kind: string;
  visibility: string;
};


export default function PublishActivityScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    titleId?: string;
    kind?: string;
    listId?: string;
    teamId?: string;
  }>();
  const { sessionToken } = useAuth();

  const titleId = typeof params.titleId === "string" ? params.titleId : undefined;
  const initialKind = typeof params.kind === "string" ? params.kind : "rated_title";

  const [title, setTitle] = useState<UniversalTitle | null>(null);
  const [kind, setKind] = useState<string>(initialKind);
  const [take, setTake] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionToken || !titleId) return;
    let cancelled = false;
    fetchUniversalTitle(sessionToken, titleId)
      .then((t) => { if (!cancelled) setTitle(t); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionToken, titleId]);

  async function submit() {
    if (!sessionToken || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiRequest<PublishResponse>("/me/activity/publish", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({
          kind,
          title_id: titleId ?? null,
          list_id: params.listId ?? null,
          team_id: params.teamId ?? null,
          take: take.trim() || null,
          visibility,
        }),
      });
      trackEvent("activity_published", { kind, visibility, event_id: res.event_id });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish.");
    } finally {
      setSubmitting(false);
    }
  }

  const takeRemaining = 300 - take.length;

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Share to Social</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.eyebrow}>EXPLICIT PUBLICATION</Text>
          <Text style={styles.lead}>
            This stays private unless you post it. Your private rating and ranked position
            stay out of the feed until you decide otherwise.
          </Text>

          {title ? (
            <View style={styles.titleCard}>
              <Text style={styles.titleName} numberOfLines={2}>{title.title}</Text>
              {title.year ? <Text style={styles.titleYear}>{title.year}</Text> : null}
            </View>
          ) : null}

          <Text style={styles.sectionLabel}>What are you sharing?</Text>
          <View style={styles.kindGrid}>
            {SUPPORTED_KINDS.map((k) => (
              <Pressable
                key={k.key}
                style={({ pressed }) => [
                  styles.kindChip,
                  kind === k.key && styles.kindChipActive,
                  pressed && { opacity: 0.75 },
                ]}
                onPress={() => setKind(k.key)}
              >
                <Text style={[styles.kindChipLabel, kind === k.key && styles.kindChipLabelActive]}>
                  {k.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Add a Take (optional)</Text>
          <TextInput
            style={styles.takeInput}
            placeholder="A line or two of context…"
            placeholderTextColor={colors.muted2}
            value={take}
            onChangeText={(txt) => txt.length <= 300 && setTake(txt)}
            multiline
            maxLength={300}
            textAlignVertical="top"
          />
          <Text style={[styles.counter, takeRemaining <= 20 && styles.counterLow]}>
            {takeRemaining} left
          </Text>

          <Text style={styles.sectionLabel}>Visibility</Text>
          <View style={styles.visibilityRow}>
            {(["public", "followers"] as Visibility[]).map((v) => (
              <Pressable
                key={v}
                onPress={() => setVisibility(v)}
                style={({ pressed }) => [
                  styles.visibilityOption,
                  visibility === v && styles.visibilityOptionActive,
                  pressed && { opacity: 0.75 },
                ]}
              >
                <Ionicons
                  name={v === "public" ? "earth-outline" : "people-outline"}
                  size={16}
                  color={visibility === v ? colors.accent : colors.muted}
                />
                <Text style={[styles.visibilityLabel, visibility === v && styles.visibilityLabelActive]}>
                  {v === "public" ? "Public" : "Followers only"}
                </Text>
              </Pressable>
            ))}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            onPress={submit}
            disabled={submitting || !titleId}
            style={({ pressed }) => [
              styles.publishBtn,
              (submitting || !titleId) && styles.publishBtnDisabled,
              pressed && !submitting && { opacity: 0.85 },
            ]}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#0b0f17" />
            ) : (
              <>
                <Ionicons name="send" size={16} color="#0b0f17" />
                <Text style={styles.publishBtnLabel}>Publish</Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
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
    width: 24,
    height: 24,
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
    paddingBottom: spacing.xl,
  },
  eyebrow: {
    fontFamily: fonts.monoMedium,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  lead: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: spacing.lg,
  },
  titleCard: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    marginBottom: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.1)",
  },
  titleName: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 18,
    lineHeight: 22,
  },
  titleYear: {
    marginTop: 4,
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  sectionLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.1,
    marginTop: spacing.sm,
    marginBottom: 8,
  },
  kindGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: spacing.sm,
  },
  kindChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: colors.surface,
  },
  kindChipActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(255,230,0,0.1)",
  },
  kindChipLabel: {
    fontFamily: fonts.sansMedium,
    color: colors.muted,
    fontSize: 12,
  },
  kindChipLabelActive: {
    color: colors.ink,
  },
  takeInput: {
    minHeight: 96,
    maxHeight: 160,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  counter: {
    marginTop: 4,
    textAlign: "right",
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 11,
  },
  counterLow: {
    color: colors.accent,
  },
  visibilityRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  visibilityOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: colors.surface,
  },
  visibilityOptionActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(255,230,0,0.1)",
  },
  visibilityLabel: {
    fontFamily: fonts.sansMedium,
    color: colors.muted,
    fontSize: 12,
  },
  visibilityLabelActive: {
    color: colors.ink,
  },
  error: {
    marginTop: spacing.md,
    color: colors.danger,
    fontFamily: fonts.sansMedium,
    fontSize: 12,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.08)",
  },
  publishBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    backgroundColor: colors.accent,
    borderRadius: radii.md,
  },
  publishBtnDisabled: {
    opacity: 0.4,
  },
  publishBtnLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    fontSize: 14,
    letterSpacing: 0.4,
  },
});
