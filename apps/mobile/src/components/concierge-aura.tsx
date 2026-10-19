/**
 * Oct-18 Visual Design brief §7: Concierge aura.
 *
 * A soft peripheral glow (violet → indigo → magenta) around the
 * leading Concierge result. Low-opacity, slow, honest — never a
 * rainbow panel, never a chat-bubble decoration. Respects reduced
 * motion by holding a static tint instead of animating.
 *
 * React Native doesn't ship a gradient primitive. We approximate the
 * aura with four large translucent discs positioned behind the hero;
 * they bleed off the edges to create a peripheral falloff that reads
 * as atmosphere, not UI. Position/size are deliberate — placing them
 * on cardinal axes avoids visible bands that a linear-gradient would
 * produce when rendered via native views only.
 */
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";

import { colors } from "@/constants/theme";


export function ConciergeAura({
  width,
  height,
  intensity = 1,
}: {
  width: number;
  height: number;
  intensity?: number; // 0..1
}) {
  const breathe = useRef(new Animated.Value(0.5)).current;
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (cancelled) return;
      reducedMotionRef.current = on;
      if (on) return;
      // Slow 7-second breathing cycle — peripheral enough to read as
      // atmosphere, not animation. Respects reduced motion by not
      // starting at all when the OS flag is on.
      Animated.loop(
        Animated.sequence([
          Animated.timing(breathe, { toValue: 1, duration: 3500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(breathe, { toValue: 0.5, duration: 3500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ).start();
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [breathe]);

  const auraOpacity = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.14 * intensity, 0.22 * intensity] });

  const r = Math.max(width, height) * 0.9;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      <Animated.View
        style={[
          styles.disc,
          {
            width: r,
            height: r,
            borderRadius: r / 2,
            backgroundColor: colors.conciergeAuraA,
            top: -r * 0.35,
            left: -r * 0.25,
            opacity: auraOpacity,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.disc,
          {
            width: r,
            height: r,
            borderRadius: r / 2,
            backgroundColor: colors.conciergeAuraB,
            bottom: -r * 0.35,
            right: -r * 0.25,
            opacity: auraOpacity,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.disc,
          {
            width: r * 0.8,
            height: r * 0.8,
            borderRadius: r * 0.4,
            backgroundColor: colors.conciergeAuraC,
            top: -r * 0.1,
            right: -r * 0.3,
            opacity: auraOpacity,
          },
        ]}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  disc: {
    position: "absolute",
  },
});
