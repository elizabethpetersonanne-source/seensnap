/**
 * Oct-27 follow-up: tappable compatibility detail sheet.
 *
 * Fetches /profiles/{user_id}/compatibility (canonical score + the
 * shared genres/themes/titles that justify it) and renders a bottom
 * sheet. When evidence is thin (compatibility === null), shows a
 * Learning state instead of a fabricated breakdown.
 *
 * Opened from the compat badge on the "Your taste matches" carousel.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


type SharedTitle = {
  title_id: string;
  title: string;
  poster_url: string | null;
};

type CompatibilityResponse = {
  user_a: string;
  user_b: string;
  compatibility: number | null;
  top_shared_genres: string[];
  top_shared_titles: SharedTitle[];
  shared_labels: string[];
  shared_platforms: string[];
  summary: string | null;
  updated_at: string | null;
};


export function CompatibilitySheet({
  visible,
  userId,
  displayName,
  onClose,
}: {
  visible: boolean;
  userId: string | null;
  displayName: string | null;
  onClose: () => void;
}) {
  const { sessionToken } = useAuth();
  const [data, setData] = useState<CompatibilityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !userId || !sessionToken) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiRequest<CompatibilityResponse>(`/profiles/${userId}/compatibility`, { token: sessionToken })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load compatibility.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, userId, sessionToken]);

  const label = displayName ?? "This person";
  const compat = data?.compatibility ?? null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />

          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>SCENEDNA</Text>
              <Text style={styles.heading}>You and {label}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.ink} />
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
          ) : error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : !data ? null : (
            <ScrollView contentContainerStyle={styles.body}>
              {compat != null ? (
                <View style={styles.scoreRow}>
                  <View style={styles.scoreBadge}>
                    <Text style={styles.scoreBadgeText}>{compat}%</Text>
                  </View>
                  <Text style={styles.scoreCaption}>
                    Canonical compatibility across shared genres, favorite titles and themes.
                  </Text>
                </View>
              ) : (
                <View style={styles.learningBlock}>
                  <Ionicons name="hourglass-outline" size={20} color={colors.muted} />
                  <Text style={styles.learningTitle}>Still learning your taste.</Text>
                  <Text style={styles.learningBody}>
                    Rate a few more titles and we'll be able to compare you with {label}.
                  </Text>
                </View>
              )}

              {data.summary ? (
                <Text style={styles.summary}>{data.summary}</Text>
              ) : null}

              {data.top_shared_genres.length > 0 ? (
                <View style={styles.block}>
                  <Text style={styles.blockLabel}>SHARED GENRES</Text>
                  <View style={styles.chipRow}>
                    {data.top_shared_genres.map((g) => (
                      <View key={g} style={styles.chip}>
                        <Text style={styles.chipLabel}>{g}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {data.shared_labels.length > 0 ? (
                <View style={styles.block}>
                  <Text style={styles.blockLabel}>SHARED THEMES</Text>
                  <View style={styles.chipRow}>
                    {data.shared_labels.map((l) => (
                      <View key={l} style={styles.chip}>
                        <Text style={styles.chipLabel}>{l}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {data.top_shared_titles.length > 0 ? (
                <View style={styles.block}>
                  <Text style={styles.blockLabel}>SHARED FAVORITES</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                    {data.top_shared_titles.map((t) => (
                      <View key={t.title_id} style={styles.titleCard}>
                        {t.poster_url ? (
                          <Image source={{ uri: t.poster_url }} style={styles.titlePoster} />
                        ) : (
                          <View style={[styles.titlePoster, styles.titlePosterFallback]}>
                            <Ionicons name="film-outline" size={18} color={colors.muted2} />
                          </View>
                        )}
                        <Text style={styles.titleName} numberOfLines={2}>{t.title}</Text>
                      </View>
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              {data.shared_platforms.length > 0 ? (
                <View style={styles.block}>
                  <Text style={styles.blockLabel}>BOTH WATCH ON</Text>
                  <View style={styles.chipRow}>
                    {data.shared_platforms.map((p) => (
                      <View key={p} style={styles.chip}>
                        <Text style={styles.chipLabel}>{p}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {compat != null &&
                data.top_shared_genres.length === 0 &&
                data.top_shared_titles.length === 0 &&
                data.shared_labels.length === 0 ? (
                  <Text style={styles.sparseBody}>
                    The score is based on indirect signals; we don't have specific shared
                    favorites to show yet.
                  </Text>
                ) : null}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    maxHeight: "88%",
    minHeight: 320,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  eyebrow: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  heading: {
    marginTop: 4,
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 20,
    letterSpacing: -0.1,
  },
  body: { gap: spacing.lg, paddingBottom: spacing.xl },
  center: { paddingVertical: spacing.xl, alignItems: "center" },
  errorText: { fontFamily: fonts.sans, color: colors.danger, fontSize: 12 },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  scoreBadge: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  scoreBadgeText: {
    fontFamily: fonts.sansBold,
    color: colors.background,
    fontSize: 20,
    letterSpacing: -0.2,
  },
  scoreCaption: {
    flex: 1,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  learningBlock: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
    gap: 6,
  },
  learningTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  learningBody: { fontFamily: fonts.sans, color: colors.muted, fontSize: 12, lineHeight: 16 },
  summary: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
    fontStyle: "italic",
  },
  block: { gap: 8 },
  blockLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 10,
    letterSpacing: 1.1,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.1)",
  },
  chipLabel: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 11, letterSpacing: 0.3 },
  titleCard: { width: 92, gap: 6 },
  titlePoster: { width: 92, height: 138, borderRadius: radii.sm, backgroundColor: colors.surfaceMuted },
  titlePosterFallback: { alignItems: "center", justifyContent: "center" },
  titleName: { fontFamily: fonts.sans, color: colors.ink, fontSize: 11, lineHeight: 14 },
  sparseBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
    fontStyle: "italic",
  },
});
