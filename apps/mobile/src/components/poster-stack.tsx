import { useEffect, useMemo, useRef } from "react";
import { Animated, Image, StyleSheet, View, type ViewStyle } from "react-native";

import { colors, radii, rules } from "@/constants/theme";
import { posterSettle, posterSettleStyle, useReduceMotion } from "@/lib/motion";

/**
 * PosterStack — a small cluster of real title posters that "settle" into place
 * on mount and gently drift when active. Used inside headers on Scene DNA,
 * My Picks and Watch Teams to make the surface feel poster-anchored.
 *
 * Data rule: pass ONLY real TMDB-backed poster URLs. If the caller has fewer
 * than `count` posters, we render whatever's available — never fabricate.
 */
export function PosterStack({
  posters,
  count = 3,
  size = 96,
  style,
  driftActive = true,
}: {
  posters: (string | null | undefined)[];
  count?: number;
  size?: number;
  style?: ViewStyle;
  driftActive?: boolean;
}) {
  const reduce = useReduceMotion();
  const items = useMemo(
    () => (posters || []).filter((p): p is string => Boolean(p)).slice(0, count),
    [posters, count],
  );

  // One Animated.Value per poster for the settle-in stagger.
  const settleRefs = useRef<Animated.Value[]>(items.map(() => new Animated.Value(0)));
  // Keep the refs array length in sync with items length.
  if (settleRefs.current.length !== items.length) {
    settleRefs.current = items.map(() => new Animated.Value(0));
  }

  // Continuous subtle drift for the whole stack (turns off under Reduce Motion).
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Kick off the settle-in on mount / when items change.
    settleRefs.current.forEach((v) => v.setValue(0));
    posterSettle(settleRefs.current, { delayEach: 90 }).start();
  }, [items]);

  useEffect(() => {
    if (reduce || !driftActive) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 5200, useNativeDriver: true }),
        Animated.timing(drift, { toValue: 0, duration: 5200, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [drift, reduce, driftActive]);

  const driftTy = drift.interpolate({ inputRange: [0, 1], outputRange: [-3, 3] });

  if (items.length === 0) {
    // Truthful empty: no fabricated posters. A framed placeholder box conveys the
    // shape without lying about content — the caller supplies imagery when it exists.
    return (
      <View style={[styles.container, { height: size * 1.5 }, style]}>
        <View style={[styles.placeholder, { width: size, height: size * 1.5 }]} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { height: size * 1.5 }, style]}>
      {items.map((uri, i) => {
        // Stagger the horizontal offset so the posters overlap like a contact sheet.
        const centerOffset = (i - (items.length - 1) / 2) * (size * 0.72);
        const rotation = (i - (items.length - 1) / 2) * 5; // degrees
        return (
          <Animated.View
            key={`${uri}-${i}`}
            style={[
              styles.poster,
              {
                width: size,
                height: size * 1.5,
                transform: [
                  { translateX: centerOffset },
                  { translateY: driftTy },
                  { rotate: `${rotation}deg` },
                ],
                zIndex: i === Math.floor(items.length / 2) ? 3 : items.length - Math.abs(i - Math.floor(items.length / 2)),
              },
              posterSettleStyle(settleRefs.current[i] ?? new Animated.Value(1)),
            ]}
          >
            <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  poster: {
    position: "absolute",
    borderRadius: radii.sm,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
    // Subtle shadow to lift the stack off the header surface.
    shadowColor: colors.shadow,
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  placeholder: {
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: rules.default,
  },
});
