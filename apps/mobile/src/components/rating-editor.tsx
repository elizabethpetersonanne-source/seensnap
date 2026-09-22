/**
 * Universal 1-10 rating editor.
 *
 * Sep-22 execution brief §7: single reusable editor consumed by every
 * title-bearing surface (Discover cards, Swipe, Previews, My Picks,
 * title detail, Social feed, Teams). Nothing outside this component
 * writes to /me/ratings so the backend contract stays exact.
 *
 * Values in [1, 10] as integers. `null` = unrated. Submitting a
 * rating implicitly marks the title Watched (server enforces this).
 * "Clear rating" keeps Watched status but drops the numeric score.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { apiRequest } from "@/lib/api";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

export type WatchedState = "want_to_watch" | "watched";

export type RatingSnapshot = {
  title_id: string;
  score: number | null;
  watched_state: WatchedState;
  version: number;
  updated_at: string | null;
};

// A module-level pub-sub so a rating change in ANY editor instance
// immediately updates every other mounted card / row displaying the
// same title, without every consumer having to subscribe to a global
// store. Keeps the "sticky rating everywhere" promise cheap.
type Listener = (title_id: string, next: RatingSnapshot) => void;
const listeners = new Set<Listener>();
export function subscribeRatingChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function broadcast(snapshot: RatingSnapshot) {
  listeners.forEach((l) => l(snapshot.title_id, snapshot));
}

const SCORE_LABELS: Record<number, string> = {
  1: "Didn't like it",
  10: "Loved it",
};

export function RatingEditor({
  visible,
  token,
  titleId,
  titleName,
  initial,
  onClose,
  onChanged,
}: {
  visible: boolean;
  token: string | null;
  titleId: string | null;
  titleName?: string | null;
  initial: RatingSnapshot | null;
  onClose: () => void;
  onChanged?: (next: RatingSnapshot) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPending(initial?.score ?? null);
    setError(null);
  }, [visible, initial?.score]);

  async function submit() {
    if (!token || !titleId || pending == null) return;
    setSaving(true);
    setError(null);
    try {
      const next = await apiRequest<RatingSnapshot>(`/me/ratings/${titleId}`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          score: pending,
          expected_version: initial?.version ?? undefined,
        }),
      });
      broadcast(next);
      onChanged?.(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save rating");
    } finally {
      setSaving(false);
    }
  }

  async function clearScore() {
    if (!token || !titleId) return;
    setSaving(true);
    setError(null);
    try {
      const next = await apiRequest<RatingSnapshot>(`/me/ratings/${titleId}`, {
        method: "DELETE",
        token,
      });
      broadcast(next);
      onChanged?.(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't clear rating");
    } finally {
      setSaving(false);
    }
  }

  const hasExisting = (initial?.score ?? null) !== null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title}>Your rating</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>
          {titleName ? (
            <Text style={styles.titleName} numberOfLines={2}>{titleName}</Text>
          ) : null}
          <View style={styles.grid}>
            {[1, 2, 3, 4, 5].map((n) => (
              <ScoreCell key={n} n={n} pending={pending} setPending={setPending} />
            ))}
          </View>
          <View style={styles.grid}>
            {[6, 7, 8, 9, 10].map((n) => (
              <ScoreCell key={n} n={n} pending={pending} setPending={setPending} />
            ))}
          </View>
          <View style={styles.helperRow}>
            <Text style={styles.helperText}>
              {pending != null && SCORE_LABELS[pending]
                ? `${pending} · ${SCORE_LABELS[pending]}`
                : pending != null
                  ? `${pending} / 10`
                  : "Tap a number to rate"}
            </Text>
          </View>
          <Text style={styles.footnote}>
            Submitting a rating marks this title Watched.
          </Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.actions}>
            {hasExisting ? (
              <Pressable
                onPress={() => void clearScore()}
                disabled={saving}
                style={styles.actionSecondary}
                accessibilityLabel="Clear rating"
              >
                <Text style={styles.actionSecondaryText}>Clear rating</Text>
              </Pressable>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <Pressable
              onPress={() => void submit()}
              disabled={saving || pending == null || pending === initial?.score}
              style={[
                styles.actionPrimary,
                (saving || pending == null || pending === initial?.score) && { opacity: 0.5 },
              ]}
            >
              {saving ? (
                <ActivityIndicator color={colors.background} />
              ) : (
                <Text style={styles.actionPrimaryText}>
                  {hasExisting ? "Save changes" : "Save rating"}
                </Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ScoreCell({ n, pending, setPending }: { n: number; pending: number | null; setPending: (v: number) => void }) {
  const active = pending === n;
  return (
    <Pressable
      onPress={() => setPending(n)}
      style={[styles.cell, active && styles.cellActive]}
      accessibilityLabel={`Rate ${n} out of 10`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.cellText, active && styles.cellTextActive]}>{n}</Text>
    </Pressable>
  );
}

/**
 * Compact score badge for use inside title cards / rows.
 * Renders `You · 8/10` when scored, `Rate it` when unrated.
 */
export function RatingBadge({
  snapshot,
  onPress,
  compact = false,
}: {
  snapshot: RatingSnapshot | null;
  onPress?: () => void;
  compact?: boolean;
}) {
  const isRated = snapshot?.score != null;
  const label = isRated
    ? compact
      ? `You · ${snapshot!.score}/10`
      : `Your rating ${snapshot!.score}/10`
    : "Rate it";
  return (
    <Pressable
      onPress={onPress}
      style={[styles.badge, isRated ? styles.badgeRated : styles.badgeUnrated, compact && styles.badgeCompact]}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      {isRated ? (
        <Ionicons name="star" size={compact ? 11 : 13} color={colors.accent} />
      ) : (
        <Ionicons name="star-outline" size={compact ? 11 : 13} color={colors.ink} />
      )}
      <Text style={[styles.badgeText, isRated && styles.badgeTextRated, compact && { fontSize: 10 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.62)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  sheet: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: colors.background,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    color: colors.ink,
  },
  titleName: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted,
  },
  grid: {
    flexDirection: "row",
    gap: 8,
  },
  cell: {
    flex: 1,
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: rules.default,
    justifyContent: "center",
    alignItems: "center",
  },
  cellActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  cellText: {
    fontFamily: fonts.serifBold,
    fontSize: 18,
    color: colors.ink,
  },
  cellTextActive: {
    color: colors.background,
  },
  helperRow: {
    alignItems: "center",
    marginTop: 4,
  },
  helperText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.5,
  },
  footnote: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.muted,
    textAlign: "center",
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.danger ?? "#e07070",
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.sm,
  },
  actionSecondary: {
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 6,
  },
  actionSecondaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.ink,
    textTransform: "uppercase",
  },
  actionPrimary: {
    flex: 1.4,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 6,
  },
  actionPrimaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.background,
    textTransform: "uppercase",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeCompact: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeRated: {
    borderColor: colors.accent,
    backgroundColor: "rgba(244,196,48,0.10)",
  },
  badgeUnrated: {
    borderColor: rules.default,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  badgeText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.4,
    color: colors.ink,
  },
  badgeTextRated: {
    color: colors.ink,
    fontFamily: fonts.monoSemiBold,
  },
});
