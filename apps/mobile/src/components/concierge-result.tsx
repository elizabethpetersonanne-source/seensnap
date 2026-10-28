/**
 * Concierge result — hero + four small posters.
 *
 * Oct-27 brief chunk E:
 * - Render ONE featured poster plus four smaller posters per spec.
 * - Tapping a smaller poster PROMOTES it (makes it the featured
 *   poster) — does not open details.
 * - Tapping the featured poster opens full TMDB details.
 * - A compact row of follow-up chips sits below ("Shorter", "Different
 *   options", "More like this", "Undo", "New search").
 * - Shorter chip only shows when runtime is a meaningful constraint
 *   (either runtime_max is set, or the user's current intent included
 *   a runtime-ish phrase).
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import type { ConciergeTitleCard } from "@/components/concierge-composer";


export type ConciergeRefineKind =
  | "shorter"
  | "longer"
  | "different_options"
  | "more_like_selected"
  | "edit"
  | "undo"
  | "new_search";


export function ConciergeResult({
  rationale,
  titles,
  constraints,
  canUndo,
  status,
  partialReason,
  requestedCount,
  exactMatchCount,
  titleRationales,
  onPressFeatured,
  onRefine,
  onSave,
  onSend,
  onAddToTeam,
  onRate,
}: {
  rationale: string;
  titles: ConciergeTitleCard[];
  constraints?: Record<string, unknown> | null;
  canUndo?: boolean;
  // CON04: truthful partial-state banner. When status === "partial"
  // we show "N of M" with a reason, so the user understands why we
  // returned fewer than requested.
  status?: "ready" | "partial" | "unavailable" | "empty" | "error" | "allowance_exhausted";
  partialReason?: string | null;
  requestedCount?: number;
  exactMatchCount?: number;
  // C16: per-title "why this fits" — rendered under the featured
  // hero when present so promoting a thumbnail changes the copy.
  titleRationales?: Record<string, string>;
  onPressFeatured: (t: ConciergeTitleCard) => void;
  onRefine?: (kind: ConciergeRefineKind, extra?: { featured_title_id?: string }) => void;
  // Oct-27 brief: Save / Send / Watch Team / Rate action rail on
  // the Concierge result. Each receives the currently-featured
  // title so the viewer acts on the one they're looking at.
  onSave?: (t: ConciergeTitleCard) => void;
  onSend?: (t: ConciergeTitleCard) => void;
  onAddToTeam?: (t: ConciergeTitleCard) => void;
  onRate?: (t: ConciergeTitleCard) => void;
}) {
  const [featuredId, setFeaturedId] = useState<string | null>(null);

  // Reset promotion when the backing title set changes (new turn).
  useEffect(() => {
    setFeaturedId(null);
  }, [titles.map((t) => t.title_id).join("|")]);

  if (titles.length === 0) return null;
  const featured = titles.find((t) => t.title_id === featuredId) ?? titles[0];
  const continuation = titles.filter((t) => t.title_id !== featured.title_id).slice(0, 4);
  // C16: per-title rationale takes precedence over the shared one so
  // promoting a thumbnail changes the explanation. Falls back to the
  // model's shared rationale when none is available for the featured.
  const featuredRationale = ((titleRationales ?? {})[featured.title_id] ?? "").trim();
  const effectiveRationale = featuredRationale || rationale;

  const runtimeConstrained =
    (constraints && (typeof constraints.runtime_max === "number" || typeof constraints.runtime_min === "number")) ||
    false;

  return (
    <View style={styles.wrap}>
      <View style={styles.kickerRow}>
        <Ionicons name="sparkles" size={11} color={colors.accent} />
        <Text style={styles.kicker}>CONCIERGE RESPONSE</Text>
      </View>

      {effectiveRationale ? (
        <View style={styles.responseBlock}>
          <View style={styles.responseRule} />
          <Text style={styles.responseText}>{effectiveRationale}</Text>
        </View>
      ) : null}

      {/* Featured poster — large, tap opens details. */}
      <Pressable
        onPress={() => onPressFeatured(featured)}
        style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
        accessibilityLabel={`Open ${featured.title}`}
      >
        {featured.backdrop_url || featured.poster_url ? (
          <Image
            source={{ uri: featured.backdrop_url ?? featured.poster_url ?? "" }}
            style={StyleSheet.absoluteFillObject}
            resizeMode="cover"
          />
        ) : null}
        <View style={styles.heroShade} />
        <View style={styles.heroBody}>
          <Text style={styles.heroTitle} numberOfLines={2}>{featured.title}</Text>
          <Text style={styles.heroMeta}>
            {[featured.year, featured.media_type === "movie" ? "FILM" : "SERIES"].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </Pressable>

      {/* Action rail — operates on the FEATURED title. Save / Send /
          Watch Team / Rate per Oct-27 personalization brief. */}
      {(onSave || onSend || onAddToTeam || onRate) ? (
        <View style={styles.actionRail}>
          {onSave ? (
            <Pressable
              onPress={() => onSave(featured)}
              hitSlop={6}
              style={styles.actionBtn}
              accessibilityRole="button"
              accessibilityLabel={`Save ${featured.title}`}
            >
              <Ionicons name="bookmark-outline" size={22} color={colors.ink} />
            </Pressable>
          ) : null}
          {onSend ? (
            <Pressable
              onPress={() => onSend(featured)}
              hitSlop={6}
              style={styles.actionBtn}
              accessibilityRole="button"
              accessibilityLabel={`Send ${featured.title}`}
            >
              <Ionicons name="paper-plane-outline" size={22} color={colors.ink} />
            </Pressable>
          ) : null}
          {onAddToTeam ? (
            <Pressable
              onPress={() => onAddToTeam(featured)}
              hitSlop={6}
              style={styles.actionBtn}
              accessibilityRole="button"
              accessibilityLabel={`Add ${featured.title} to a Watch Team`}
            >
              <Ionicons name="people-outline" size={22} color={colors.ink} />
            </Pressable>
          ) : null}
          {onRate ? (
            <Pressable
              onPress={() => onRate(featured)}
              hitSlop={6}
              style={styles.actionBtn}
              accessibilityRole="button"
              accessibilityLabel={`Rate ${featured.title}`}
            >
              <Ionicons name="star-outline" size={22} color={colors.ink} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Continuation strip — up to four smaller posters. Tap promotes. */}
      {continuation.length > 0 ? (
        <View
          // Oct-27 fix: force a remount of the strip on every title
          // set change so the Image components reload cleanly after
          // a refinement — otherwise iOS can hold onto the previous
          // decoded poster even after the URI prop updates.
          key={titles.map((t) => t.title_id).join("|")}
          style={styles.continuationRow}
        >
          {continuation.map((t) => (
            <Pressable
              key={t.title_id}
              onPress={() => setFeaturedId(t.title_id)}
              style={({ pressed }) => [styles.smallCard, pressed && { opacity: 0.78 }]}
              accessibilityRole="button"
              accessibilityLabel={`Feature ${t.title}`}
            >
              {t.poster_url ? (
                <Image source={{ uri: t.poster_url }} style={styles.smallPoster} resizeMode="cover" />
              ) : (
                <View style={[styles.smallPoster, styles.smallPosterFallback]}>
                  <Ionicons name="film-outline" size={14} color={colors.muted2} />
                </View>
              )}
              <Text style={styles.smallTitle} numberOfLines={2}>{t.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {status === "partial" && (requestedCount ?? 5) > 1 ? (
        <Text style={styles.lowCountNote}>
          {partialNoteFor({
            titles: exactMatchCount ?? titles.length,
            requested: requestedCount ?? 5,
            reason: partialReason ?? null,
          })}
        </Text>
      ) : null}

      {/* Follow-up chips. Order: refinements first, then undo / new. */}
      {onRefine ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow} directionalLockEnabled>
          {runtimeConstrained ? (
            <RefineChip label="Shorter" onPress={() => onRefine("shorter")} />
          ) : null}
          {runtimeConstrained ? (
            <RefineChip label="Longer" onPress={() => onRefine("longer")} />
          ) : null}
          <RefineChip label="Different options" onPress={() => onRefine("different_options")} />
          <RefineChip
            label={`More like ${truncate(featured.title, 18)}`}
            onPress={() => onRefine("more_like_selected", { featured_title_id: featured.title_id })}
          />
          {canUndo ? <RefineChip label="Undo" onPress={() => onRefine("undo")} /> : null}
          <RefineChip label="New search" onPress={() => onRefine("new_search")} />
        </ScrollView>
      ) : null}
    </View>
  );
}

function RefineChip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.chip, pressed && { opacity: 0.75 }]}
    >
      <Text style={styles.chipLabel}>{label}</Text>
    </Pressable>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}


function partialNoteFor({
  titles,
  requested,
  reason,
}: {
  titles: number;
  requested: number;
  reason: string | null;
}): string {
  const prefix = titles === 1 ? "I found 1 match" : `I found ${titles} of ${requested}`;
  switch (reason) {
    case "upstream_failure":
      return `${prefix}, but couldn't finish checking the others. Retry below.`;
    case "retrieval_budget_reached":
      return `${prefix} within this turn's budget. Try an adjustment below for more.`;
    case "metadata_unavailable":
      return `${prefix}; some titles were missing metadata and were skipped.`;
    case "source_exhausted":
      return `${prefix} in that source. Try broadening or picking a different list.`;
    default:
      return `${prefix} — try an adjustment below for more.`;
  }
}


const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: 12,
  },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  responseBlock: { flexDirection: "row", gap: 10, paddingVertical: 2 },
  responseRule: { width: 2, backgroundColor: colors.accent, opacity: 0.6 },
  responseText: {
    flex: 1,
    fontFamily: fonts.serif,
    color: colors.ink,
    fontSize: 16,
    lineHeight: 22,
    fontStyle: "italic",
  },
  heroCard: {
    height: 260,
    borderRadius: radii.md,
    overflow: "hidden",
    position: "relative",
    backgroundColor: colors.surfaceMuted,
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.42)",
  },
  heroBody: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 12,
    gap: 4,
  },
  heroTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 22,
    letterSpacing: -0.3,
  },
  heroMeta: {
    fontFamily: fonts.monoSemiBold,
    color: "rgba(255,255,255,0.9)",
    fontSize: 11,
    letterSpacing: 1.3,
  },
  continuationRow: {
    flexDirection: "row",
    gap: 8,
  },
  smallCard: {
    flex: 1,
    gap: 4,
  },
  smallPoster: {
    width: "100%",
    aspectRatio: 2 / 3,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  smallPosterFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  smallTitle: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 10,
    lineHeight: 13,
  },
  lowCountNote: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 11,
  },
  chipRow: {
    flexDirection: "row",
    gap: 6,
    paddingRight: 32,
  },
  chip: {
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  chipLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 12,
    letterSpacing: 0.2,
  },
  actionRail: {
    flexDirection: "row",
    gap: 24,
    paddingVertical: 4,
    alignItems: "center",
  },
  actionBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
