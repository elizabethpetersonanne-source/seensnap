import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  AppState,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  confirmHandoffWatched,
  dismissHandoffNotYet,
  fetchOpenHandoffs,
  type WatchHandoff,
} from "@/lib/watch-handoff";


/**
 * Oct-18 build brief §8: when the user returns from a provider launch
 * (10-min threshold enforced server-side), surface a Did you watch?
 * card. Confirming routes through the canonical title_state service
 * via /me/handoffs/{id}/watched — never writes to Rating directly.
 */
export function DidYouWatchPrompt() {
  const { sessionToken } = useAuth();
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = useState<WatchHandoff[]>([]);
  const [showRating, setShowRating] = useState(false);
  const translateY = useRef(new Animated.Value(140)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const current = queue[0] ?? null;

  // Poll on foreground. Non-trivial debounce isn't needed — AppState
  // only fires once per transition.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (!sessionToken) return;
      const open = await fetchOpenHandoffs(sessionToken);
      if (!cancelled) setQueue(open);
    }

    void poll();
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void poll();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [sessionToken]);

  // Slide in on first prompt in the queue.
  useEffect(() => {
    if (!current) {
      Animated.parallel([
        Animated.timing(translateY, { toValue: 140, duration: 180, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
      return;
    }
    setShowRating(false);
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [current?.id, translateY, opacity]);

  function popQueue() {
    setQueue((q) => q.slice(1));
  }

  async function handleWatched(rating: number | null) {
    if (!sessionToken || !current) return;
    try {
      await confirmHandoffWatched(sessionToken, current.id, rating);
    } catch {
      // Fail silent — handoff stays open so the server can retry next session.
    }
    popQueue();
  }

  async function handleNotYet() {
    if (!sessionToken || !current) return;
    try {
      await dismissHandoffNotYet(sessionToken, current.id);
    } catch {}
    popQueue();
  }

  if (!current) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { bottom: insets.bottom + 90, transform: [{ translateY }], opacity },
      ]}
    >
      <View style={styles.card}>
        {current.poster_url ? (
          <Image source={{ uri: current.poster_url }} style={styles.poster} />
        ) : (
          <View style={[styles.poster, styles.posterFallback]}>
            <Ionicons name="film-outline" size={22} color={colors.muted2} />
          </View>
        )}
        <View style={styles.body}>
          <Text style={styles.eyebrow}>DID YOU WATCH?</Text>
          <Text style={styles.title} numberOfLines={2}>{current.title}</Text>

          {!showRating ? (
            <View style={styles.row}>
              <Pressable
                hitSlop={8}
                onPress={() => setShowRating(true)}
                style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.btnPressed]}
              >
                <Text style={styles.btnPrimaryLabel}>Yes</Text>
              </Pressable>
              <Pressable
                hitSlop={8}
                onPress={handleNotYet}
                style={({ pressed }) => [styles.btn, styles.btnSecondary, pressed && styles.btnPressed]}
              >
                <Text style={styles.btnSecondaryLabel}>Not yet</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.ratingWrap}>
              <Text style={styles.ratingLabel}>Rate it 1–10</Text>
              <View style={styles.ratingRow}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <Pressable
                    key={n}
                    hitSlop={4}
                    onPress={() => void handleWatched(n)}
                    style={({ pressed }) => [styles.ratingCell, pressed && styles.btnPressed]}
                  >
                    <Text style={styles.ratingCellLabel}>{n}</Text>
                  </Pressable>
                ))}
                <Pressable
                  hitSlop={10}
                  onPress={() => void handleWatched(null)}
                  style={({ pressed }) => [styles.skipRating, pressed && styles.btnPressed]}
                >
                  <Text style={styles.skipRatingLabel}>Skip</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
        <Pressable
          hitSlop={10}
          onPress={popQueue}
          style={styles.dismiss}
          accessibilityLabel="Dismiss"
        >
          <Ionicons name="close" size={16} color={colors.muted2} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
  },
  card: {
    flexDirection: "row",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(244,196,48,0.28)",
    padding: spacing.sm,
    alignItems: "center",
  },
  poster: {
    width: 42,
    height: 60,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  posterFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    fontFamily: fonts.monoMedium,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  title: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 15,
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  btn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  btnPrimary: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  btnPrimaryLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    fontSize: 12,
    letterSpacing: 0.4,
  },
  btnSecondary: {
    backgroundColor: "transparent",
    borderColor: "rgba(255,255,255,0.18)",
  },
  btnSecondaryLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.4,
  },
  btnPressed: {
    opacity: 0.7,
  },
  ratingWrap: {
    gap: 4,
  },
  ratingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexWrap: "wrap",
  },
  ratingLabel: {
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.8,
  },
  ratingCell: {
    width: 22,
    height: 22,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  ratingCellLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.ink,
    fontSize: 11,
  },
  skipRating: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  skipRatingLabel: {
    fontFamily: fonts.sansMedium,
    color: colors.muted2,
    fontSize: 11,
  },
  dismiss: {
    padding: 4,
  },
});
