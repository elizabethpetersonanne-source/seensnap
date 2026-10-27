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
  // STATE-02: a rating transition also implies watched=true (server
  // enforces this). Mirror the save/watched state onto the shared
  // title-state cache so Discover/Picks/Teams cards update too.
  // Dynamic import keeps the two modules decoupled and avoids a
  // cycle with the auth logout hook which also imports title-state.
  void import("@/lib/title-state").then(({ patchTitleState }) => {
    patchTitleState(snapshot.title_id, {
      watched: snapshot.watched_state === "watched",
      updated_at: snapshot.updated_at,
    });
  });
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
 * Sep-22 brief §7 watch status control. Small pill with Want to Watch
 * / Watched. Kept alongside the RatingBadge so title cards can show
 * both at once. Uses the same shared /me/ratings endpoints for
 * persistence and the same pub-sub for cross-mount reconciliation.
 */
export function WatchStatusToggle({
  token,
  titleId,
  snapshot,
  onChanged,
  compact = false,
}: {
  token: string | null;
  titleId: string | null;
  snapshot: RatingSnapshot | null;
  onChanged?: (next: RatingSnapshot) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmWantOpen, setConfirmWantOpen] = useState(false);

  async function setWatched() {
    if (!token || !titleId || busy) return;
    setBusy(true);
    try {
      const next = await apiRequest<RatingSnapshot>(
        `/me/ratings/${titleId}/status`,
        {
          method: "PATCH",
          token,
          body: JSON.stringify({ watched_state: "watched" }),
        },
      );
      broadcast(next);
      onChanged?.(next);
    } catch {
      // silent — status change is best-effort at the pill level
    } finally {
      setBusy(false);
    }
  }

  async function setWantToWatch(confirmClear = false) {
    if (!token || !titleId || busy) return;
    setBusy(true);
    try {
      const next = await apiRequest<RatingSnapshot>(
        `/me/ratings/${titleId}/status`,
        {
          method: "PATCH",
          token,
          body: JSON.stringify({
            watched_state: "want_to_watch",
            confirm_clear_rating: confirmClear,
          }),
        },
      );
      broadcast(next);
      onChanged?.(next);
      setConfirmWantOpen(false);
    } catch (e) {
      // Server returns 409 with confirm_required if a rating exists.
      if (e instanceof Error && e.message.toLowerCase().includes("confirm")) {
        setConfirmWantOpen(true);
      }
    } finally {
      setBusy(false);
    }
  }

  const isWatched = snapshot?.watched_state === "watched" || snapshot?.score != null;
  const label = isWatched ? "Watched" : "Want to Watch";
  return (
    <>
      <Pressable
        onPress={() => (isWatched ? void setWantToWatch(false) : void setWatched())}
        disabled={busy}
        style={[
          styles.badge,
          isWatched ? styles.badgeRated : styles.badgeUnrated,
          compact && styles.badgeCompact,
          busy && { opacity: 0.5 },
        ]}
      >
        <Ionicons
          name={isWatched ? "checkmark-circle" : "eye-outline"}
          size={compact ? 11 : 13}
          color={isWatched ? colors.accent : colors.ink}
        />
        <Text style={[styles.badgeText, isWatched && styles.badgeTextRated, compact && { fontSize: 10 }]}>
          {label}
        </Text>
      </Pressable>
      <Modal visible={confirmWantOpen} transparent animationType="fade" onRequestClose={() => setConfirmWantOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setConfirmWantOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.title}>Remove rating?</Text>
            <Text style={styles.titleName}>
              Moving to Want to Watch will clear your existing rating.
            </Text>
            <View style={styles.actions}>
              <Pressable style={styles.actionSecondary} onPress={() => setConfirmWantOpen(false)}>
                <Text style={styles.actionSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.actionPrimary}
                onPress={() => void setWantToWatch(true)}
              >
                <Text style={styles.actionPrimaryText}>Clear + move</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * Oct-18 build brief §4 shared visual primitive: InlineRatingRail.
 *
 * Horizontal 1-10 rail that expands LEFTWARD from a star icon. Commits
 * once (tap-to-rate), collapses back to the star + score display.
 * No bottom sheet, no five-star control, no modal.
 *
 * Replaces the modal-based RatingEditor at every surface that already
 * owns a title context (Swipe card, Preview card, title modal, social
 * feed title card). Modal-based rating is still available via
 * RatingEditor for surfaces that don't have horizontal rail room
 * (e.g. a cramped list row) — the two share the same /me/ratings API
 * and broadcast state via subscribeRatingChanges.
 */
export function InlineRatingRail({
  token,
  titleId,
  snapshot,
  onChanged,
  size = "md",
  alignRight = true,
}: {
  token: string | null;
  titleId: string | null;
  snapshot: RatingSnapshot | null;
  onChanged?: (next: RatingSnapshot) => void;
  size?: "sm" | "md" | "lg";
  // When true (default) the rail anchors at the right and expands
  // left so the star stays at the trailing edge of the row.
  alignRight?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const score = snapshot?.score ?? null;

  const starSize = size === "sm" ? 16 : size === "lg" ? 24 : 20;
  const cellSize = size === "sm" ? 24 : size === "lg" ? 34 : 28;

  async function commit(n: number) {
    if (!token || !titleId || saving) return;
    setSaving(true);
    setPending(n);
    try {
      const next = await apiRequest<RatingSnapshot>(`/me/ratings/${titleId}`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          score: n,
          expected_version: snapshot?.version ?? undefined,
        }),
      });
      broadcast(next);
      onChanged?.(next);
      setExpanded(false);
    } catch {
      // keep expanded so the user can retry
    } finally {
      setSaving(false);
      setPending(null);
    }
  }

  if (!expanded) {
    return (
      <Pressable
        onPress={() => setExpanded(true)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={score != null ? `Your rating ${score} out of 10 — tap to change` : "Tap to rate 1 to 10"}
        style={styles.railStarContainer}
      >
        <Ionicons
          name={score != null ? "star" : "star-outline"}
          size={starSize}
          color={score != null ? colors.accent : colors.ink}
        />
        {score != null ? (
          <Text style={[styles.railScore, size === "sm" && { fontSize: 11 }]}>
            {score}/10
          </Text>
        ) : null}
      </Pressable>
    );
  }

  // Expanded: 10 cells to the left of the star (unless alignRight=false).
  return (
    <View
      style={[
        styles.railExpanded,
        alignRight ? { flexDirection: "row-reverse" } : { flexDirection: "row" },
      ]}
    >
      <Pressable
        onPress={() => setExpanded(false)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Close rating rail"
        style={styles.railStarContainer}
      >
        <Ionicons
          name={score != null ? "star" : "star-outline"}
          size={starSize}
          color={colors.accent}
        />
      </Pressable>
      <View style={[styles.railCells, { marginRight: alignRight ? 6 : 0, marginLeft: alignRight ? 0 : 6 }]}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
          const active = (pending ?? score) === n;
          return (
            <Pressable
              key={n}
              onPress={() => void commit(n)}
              disabled={saving}
              style={[
                styles.railCell,
                { width: cellSize, height: cellSize },
                active && styles.railCellActive,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Rate ${n}`}
            >
              {saving && pending === n ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text style={[styles.railCellText, active && styles.railCellTextActive]}>{n}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
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
    minWidth: 44,
    height: 48,
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
    fontFamily: fonts.sansBold,
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
    backgroundColor: "rgba(255,230,0,0.10)",
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
  railStarContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  railScore: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.ink,
    letterSpacing: 0.4,
  },
  railExpanded: {
    alignItems: "center",
    gap: 6,
  },
  railCells: {
    flexDirection: "row",
    gap: 3,
  },
  railCell: {
    borderRadius: 4,
    borderWidth: 1,
    borderColor: rules.default,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "transparent",
  },
  railCellActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  railCellText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    color: colors.ink,
  },
  railCellTextActive: {
    color: colors.background,
  },
});
