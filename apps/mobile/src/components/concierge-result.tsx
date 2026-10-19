/**
 * Oct-18 Visual Design brief §7: Concierge result presentation.
 *
 * - Short, pullquote-style rationale (the "response") up top.
 * - A horizontal strip of poster options (up to 8) — users scan the
 *   full set rather than being funneled into a single hero.
 * - Soft peripheral aura behind the whole block (handled by caller).
 * - "Refine this" affordance for continuing the conversation in
 *   the same decision (no new allowance consumed server-side).
 *
 * NOT a chat bubble. NOT a robot-mascot block. NOT a text-heavy AI
 * dashboard. Reads as editorial curation.
 */
import { Ionicons } from "@expo/vector-icons";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import type { ConciergeTitleCard } from "@/components/concierge-composer";


export function ConciergeResult({
  rationale,
  titles,
  onPressTitle,
  onRefine,
}: {
  rationale: string;
  titles: ConciergeTitleCard[];
  onPressTitle: (t: ConciergeTitleCard) => void;
  onRefine?: () => void;
}) {
  const visible = titles.slice(0, 8);
  return (
    <View style={styles.wrap}>
      <View style={styles.kickerRow}>
        <Ionicons name="sparkles" size={11} color={colors.accent} />
        <Text style={styles.kicker}>CONCIERGE RESPONSE</Text>
      </View>

      {rationale ? (
        <View style={styles.responseBlock}>
          <View style={styles.responseRule} />
          <Text style={styles.responseText}>{rationale}</Text>
        </View>
      ) : null}

      <Text style={styles.optionsLabel}>
        {visible.length === 1 ? "1 option" : `${visible.length} options`}
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {visible.map((t, idx) => (
          <Pressable
            key={t.title_id}
            onPress={() => onPressTitle(t)}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.78 }]}
          >
            {t.poster_url ? (
              <Image source={{ uri: t.poster_url }} style={styles.poster} resizeMode="cover" />
            ) : (
              <View style={[styles.poster, styles.posterFallback]}>
                <Ionicons name="film-outline" size={16} color={colors.muted2} />
              </View>
            )}
            <Text style={styles.cardTitle} numberOfLines={2}>{t.title}</Text>
            <Text style={styles.cardMeta}>
              {[t.year, t.media_type === "movie" ? "Movie" : "Series"].filter(Boolean).join(" · ")}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {onRefine ? (
        <Pressable onPress={onRefine} hitSlop={6} style={styles.refineBtn}>
          <Ionicons name="arrow-redo-outline" size={13} color={colors.accent} />
          <Text style={styles.refineLabel}>Refine this</Text>
        </Pressable>
      ) : null}
    </View>
  );
}


const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: 10,
  },
  kickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  kicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  responseBlock: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 2,
  },
  responseRule: {
    width: 2,
    backgroundColor: colors.accent,
    opacity: 0.6,
  },
  responseText: {
    flex: 1,
    fontFamily: fonts.serif,
    color: colors.ink,
    fontSize: 16,
    lineHeight: 22,
    fontStyle: "italic",
  },
  optionsLabel: {
    marginTop: 4,
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 1,
  },
  strip: {
    gap: 10,
    paddingVertical: 4,
    paddingRight: spacing.lg,
  },
  card: {
    width: 112,
    gap: 6,
  },
  poster: {
    width: 112,
    height: 168,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  posterFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 12,
    lineHeight: 15,
  },
  cardMeta: {
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.4,
  },
  refineBtn: {
    marginTop: 4,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  refineLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
});
