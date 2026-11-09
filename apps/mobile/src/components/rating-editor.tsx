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
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Keyboard,
  ScrollView,
  useWindowDimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { patchTitleState } from "@/lib/title-state";
import { apiRequest, ApiError } from "@/lib/api";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

export type WatchedState = "want_to_watch" | "watched";

export type RatingSnapshot = {
  title_id: string;
  score: number | null;
  watched_state: WatchedState;
  version: number;
  updated_at: string | null;
  in_next_watch?: boolean | null;
  is_saved_anywhere?: boolean | null;
  saved_list_ids?: string[] | null;
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
  listeners.forEach((l) => {
    try {
      l(snapshot.title_id, snapshot);
    } catch {}
  });
  patchTitleState(snapshot.title_id, {
    watched: snapshot.watched_state === "watched",
    updated_at: snapshot.updated_at,
    ...(snapshot.is_saved_anywhere != null
      ? { saved: snapshot.is_saved_anywhere }
      : {}),
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
  const [current, setCurrent] = useState<RatingSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const busy = useRef(false);
  const generation = useRef(0);
  const context = useRef({ token, titleId, visible });
  // Read on render as well as effect cleanup so a late response cannot cross
  // accounts or close an editor now showing another title.
  context.current = { token, titleId, visible };
  function stillCurrent(version: number) {
    return (
      generation.current === version &&
      context.current.token === token &&
      context.current.titleId === titleId &&
      context.current.visible
    );
  }
  const { height, width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const columns = fontScale > 1.3 || width < 320 ? 3 : 5;
  const numbers = Array.from({ length: 10 }, (_, i) => i + 1);
  const rows = Array.from({ length: Math.ceil(10 / columns) }, (_, i) =>
    numbers.slice(i * columns, (i + 1) * columns),
  );

  useEffect(() => {
    generation.current++;
    busy.current = false;
    setSaving(false);
    if (!visible || !titleId || !token) return;
    let active = true;
    Keyboard.dismiss();
    setPending(initial?.score ?? null);
    setCurrent(null);
    setError(null);
    setLoading(true);
    // Every entry point gets a real concurrency token, including My Picks.
    apiRequest<RatingSnapshot>(`/me/ratings/${titleId}`, { token })
      .then((next) => {
        if (active) {
          setCurrent(next);
          setPending(next.score);
        }
      })
      .catch(() => {
        if (active)
          setError("Couldn't load your rating. Tap Retry to try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [visible, titleId, token, reload]);

  function close() {
    if (!busy.current) onClose();
  }

  function handleError(e: unknown) {
    if (e instanceof ApiError && e.status === 409) {
      const detail = e.detail as { current?: RatingSnapshot } | null;
      if (detail?.current) setCurrent(detail.current);
      setError(
        "Your rating changed elsewhere. Your selection is kept; save again to apply it.",
      );
    } else {
      setError("Couldn't save your rating. Please try again.");
    }
  }

  async function submit() {
    if (!token || !titleId || pending == null || !current || busy.current)
      return;
    const version = generation.current;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await apiRequest<RatingSnapshot>(`/me/ratings/${titleId}`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          score: pending,
          expected_version: current.version,
        }),
      });
      if (!stillCurrent(version)) return;
      broadcast(next);
      onChanged?.(next);
      onClose();
    } catch (e) {
      if (stillCurrent(version)) handleError(e);
    } finally {
      if (stillCurrent(version)) {
        busy.current = false;
        setSaving(false);
      }
    }
  }

  async function clearScore() {
    if (!token || !titleId || !current || busy.current) return;
    const version = generation.current;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await apiRequest<RatingSnapshot>(
        `/me/ratings/${titleId}?expected_version=${current.version}`,
        {
          method: "DELETE",
          token,
        },
      );
      if (!stillCurrent(version)) return;
      broadcast(next);
      onChanged?.(next);
      onClose();
    } catch (e) {
      if (stillCurrent(version)) handleError(e);
    } finally {
      if (stillCurrent(version)) {
        busy.current = false;
        setSaving(false);
      }
    }
  }

  const hasExisting = current?.score != null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
    >
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable
          style={[
            styles.sheet,
            { maxHeight: height - insets.top - insets.bottom - 24 },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 16 }}
          >
            <View style={styles.header}>
              <Text style={styles.title}>Your rating</Text>
              <Pressable
                onPress={close}
                style={styles.closeButton}
                accessibilityRole="button"
                accessibilityLabel="Close rating editor"
              >
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>
            {titleName ? (
              <Text style={styles.titleName} numberOfLines={2}>
                {titleName}
              </Text>
            ) : null}
            {loading ? (
              <ActivityIndicator
                color={colors.accent}
                accessibilityLabel="Loading your rating"
              />
            ) : null}
            {rows.map((row, index) => (
              <View key={index} style={styles.grid}>
                {row.map((n) => (
                  <ScoreCell
                    key={n}
                    n={n}
                    pending={pending}
                    setPending={setPending}
                    disabled={saving || loading || !current}
                  />
                ))}
                {Array.from({ length: columns - row.length }, (_, i) => (
                  <View key={`blank-${i}`} style={{ flex: 1 }} />
                ))}
              </View>
            ))}
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
            {error ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {error}
              </Text>
            ) : null}
            {!current && !loading ? (
              <Pressable
                style={styles.actionSecondary}
                onPress={() => setReload((n) => n + 1)}
              >
                <Text style={styles.actionSecondaryText}>Retry</Text>
              </Pressable>
            ) : null}
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
                disabled={
                  saving ||
                  loading ||
                  !current ||
                  pending == null ||
                  pending === current.score
                }
                style={[
                  styles.actionPrimary,
                  (saving ||
                    loading ||
                    !current ||
                    pending == null ||
                    pending === current.score) && { opacity: 0.5 },
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
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ScoreCell({
  n,
  pending,
  setPending,
  disabled,
}: {
  n: number;
  pending: number | null;
  setPending: (v: number) => void;
  disabled: boolean;
}) {
  const active = pending === n;
  return (
    <Pressable
      disabled={disabled}
      onPress={() => setPending(n)}
      style={[styles.cell, active && styles.cellActive]}
      accessibilityLabel={`Rate ${n} out of 10`}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
    >
      <Text style={[styles.cellText, active && styles.cellTextActive]}>
        {n}
      </Text>
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
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<RatingSnapshot | null>(null);
  const lock = useRef(false),
    generation = useRef(0);
  const context = useRef({ token, titleId });
  context.current = { token, titleId };
  useEffect(() => {
    generation.current++;
    lock.current = false;
    setBusy(false);
    setError(null);
    setConfirmation(null);
    return () => {
      generation.current++;
    };
  }, [token, titleId]);

  async function changeStatus(
    watchedState: WatchedState,
    confirmed: RatingSnapshot | null = null,
  ) {
    if (!token || !titleId || lock.current) return;
    const version = generation.current;
    const active = () =>
      generation.current === version &&
      context.current.token === token &&
      context.current.titleId === titleId;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const observed =
        confirmed ??
        snapshot ??
        (await apiRequest<RatingSnapshot>(`/me/ratings/${titleId}`, { token }));
      if (!active()) return;
      if (
        watchedState === "want_to_watch" &&
        observed.score !== null &&
        !confirmed
      ) {
        setConfirmation(observed);
        return;
      }
      const next = await apiRequest<RatingSnapshot>(
        `/me/ratings/${titleId}/status`,
        {
          token,
          method: "PATCH",
          body: JSON.stringify({
            watched_state: watchedState,
            confirm_clear_rating: !!confirmed,
            expected_version: observed.version,
          }),
        },
      );
      if (!active()) return;
      broadcast(next);
      onChanged?.(next);
      setConfirmation(null);
    } catch (e) {
      if (!active()) return;
      const detail =
        e instanceof ApiError
          ? (e.detail as { code?: string; current?: RatingSnapshot })
          : null;
      if (detail?.code === "confirm_required" && detail.current)
        setConfirmation(detail.current);
      else if (detail?.code === "version_conflict") {
        setConfirmation(null);
        if (detail.current) {
          broadcast(detail.current);
          onChanged?.(detail.current);
        }
        setError(
          "This title changed elsewhere. Review its current status and try again.",
        );
      } else setError("Your status was not saved. Please try again.");
    } finally {
      if (active()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const isWatched =
    snapshot?.watched_state === "watched" || snapshot?.score != null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          isWatched ? "Change Watched to Want to Watch" : "Mark as Watched"
        }
        disabled={busy}
        onPress={() =>
          void changeStatus(isWatched ? "want_to_watch" : "watched")
        }
        style={[
          styles.badge,
          isWatched ? styles.badgeRated : styles.badgeUnrated,
          compact && styles.badgeCompact,
          { minHeight: 44, minWidth: 44 },
          busy && { opacity: 0.5 },
        ]}
      >
        <Ionicons
          name={isWatched ? "checkmark-circle" : "eye-outline"}
          size={compact ? 14 : 16}
          color={isWatched ? colors.accent : colors.ink}
        />
        <Text style={[styles.badgeText, isWatched && styles.badgeTextRated]}>
          {isWatched ? "Watched" : "Want to Watch"}
        </Text>
      </Pressable>
      {error && !confirmation ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
      <ConfirmDialog
        visible={!!confirmation}
        title="Remove rating?"
        busy={busy}
        confirmLabel="Clear + move"
        message={`Moving to Want to Watch will clear your existing rating.${error ? "\n\n" + error : ""}`}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void changeStatus("want_to_watch", confirmation)}
      />
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
  const score = snapshot?.score ?? null;
  return (
    <>
      <Pressable
        onPress={(event) => {
          event.stopPropagation();
          setExpanded(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={
          score != null
            ? `Your rating ${score} out of 10. Change rating`
            : "Rate this title"
        }
        style={styles.railStarContainer}
      >
        <Ionicons
          name={score != null ? "star" : "star-outline"}
          size={size === "lg" ? 24 : 20}
          color={score != null ? colors.accent : colors.ink}
        />
        {score != null ? (
          <Text style={styles.railScore}>{score}/10</Text>
        ) : null}
      </Pressable>
      <RatingEditor
        visible={expanded}
        token={token}
        titleId={titleId}
        initial={snapshot}
        onClose={() => setExpanded(false)}
        onChanged={onChanged}
      />
    </>
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
      style={[
        styles.badge,
        isRated ? styles.badgeRated : styles.badgeUnrated,
        compact && styles.badgeCompact,
      ]}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      {isRated ? (
        <Ionicons name="star" size={compact ? 11 : 13} color={colors.accent} />
      ) : (
        <Ionicons
          name="star-outline"
          size={compact ? 11 : 13}
          color={colors.ink}
        />
      )}
      <Text
        style={[
          styles.badgeText,
          isRated && styles.badgeTextRated,
          compact && { fontSize: 10 },
        ]}
      >
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
    padding: 12,
  },
  sheet: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: colors.background,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    padding: 16,
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
    minHeight: 48,
    paddingVertical: 10,
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
    fontSize: 14,
    color: colors.muted,
    letterSpacing: 0.5,
  },
  footnote: {
    fontFamily: fonts.sans,
    fontSize: 14,
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
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  railStarContainer: {
    minWidth: 44,
    minHeight: 44,
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
