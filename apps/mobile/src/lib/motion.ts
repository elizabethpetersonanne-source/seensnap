import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { motion } from "@/constants/theme";

/**
 * Respect iOS/Android "Reduce Motion" system setting. Screens should short-circuit
 * looping/parallax animations when this returns true. Static equivalents should still
 * look composed — don't just skip motion, prefer a non-moving fallback layout.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduce(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => {
      setReduce(v);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * Scroll-linked parallax helper. Returns an interpolated translateY that moves at
 * `factor` (0..1) of the scroll delta — lower = slower parallax.
 */
export function parallaxTranslate(
  scrollY: Animated.Value,
  factor = 0.35,
  maxOffset = 220,
): Animated.AnimatedInterpolation<number> {
  return scrollY.interpolate({
    inputRange: [-maxOffset, 0, maxOffset],
    outputRange: [-maxOffset * factor, 0, maxOffset * factor],
    extrapolate: "clamp",
  });
}

/**
 * Scroll-linked scale for a hero image (compresses upward on scroll-down, expands on
 * pull-down). Non-jarring, cinematic.
 */
export function parallaxScale(
  scrollY: Animated.Value,
  maxPull = 180,
): Animated.AnimatedInterpolation<number> {
  return scrollY.interpolate({
    inputRange: [-maxPull, 0, maxPull],
    outputRange: [1.18, 1.0, 0.94],
    extrapolate: "clamp",
  });
}

/**
 * Poster "settle" — stagger a set of posters dropping into place from above with
 * fade+translate+scale. Feels like a contact-sheet print settling. Fire once on mount.
 */
export function posterSettle(
  values: Animated.Value[],
  { delayEach = 65 }: { delayEach?: number } = {},
) {
  return Animated.stagger(
    delayEach,
    values.map((v) =>
      Animated.timing(v, {
        toValue: 1,
        duration: motion.timing.enter,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ),
  );
}

export function posterSettleStyle(value: Animated.Value, distance = 22) {
  return {
    opacity: value,
    transform: [
      {
        translateY: value.interpolate({ inputRange: [0, 1], outputRange: [-distance, 0] }),
      },
      {
        scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }),
      },
    ],
  };
}

export function staggerStyle(
  value: Animated.Value,
  index: number,
  distance = 18,
): { opacity: Animated.Value; transform: Array<{ translateY: Animated.AnimatedInterpolation<number> }> } {
  return {
    opacity: value,
    transform: [
      {
        translateY: value.interpolate({
          inputRange: [0, 1],
          outputRange: [distance + index * 4, 0],
        }),
      },
    ],
  };
}

export function runStagger(value: Animated.Value, duration = motion.timing.enter) {
  value.setValue(0);
  return Animated.timing(value, {
    toValue: 1,
    duration,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: true,
  });
}

export function fadeSlideIn(
  opacity: Animated.Value,
  translateY: Animated.Value,
  index: number,
) {
  const delay = Math.min(index * motion.timing.stagger, motion.timing.maxStagger);
  return Animated.parallel([
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.timing.enter,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }),
    Animated.timing(translateY, {
      toValue: 0,
      duration: motion.timing.enter,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }),
  ]);
}

export function pressIn(scale: Animated.Value) {
  Animated.spring(scale, { toValue: 0.95, ...motion.spring.press }).start();
}

export function pressOut(scale: Animated.Value) {
  Animated.spring(scale, { toValue: 1, ...motion.spring.soft }).start();
}

export function reactionPulse(scale: Animated.Value, onDone?: () => void) {
  Animated.sequence([
    Animated.spring(scale, { toValue: 1.16, ...motion.spring.react }),
    Animated.spring(scale, { toValue: 1, ...motion.spring.soft }),
  ]).start(onDone);
}

export function toastIn(
  opacity: Animated.Value,
  translateY: Animated.Value,
) {
  Animated.parallel([
    Animated.timing(opacity, { toValue: 1, duration: motion.timing.fast, useNativeDriver: true }),
    Animated.timing(translateY, { toValue: 0, duration: motion.timing.fast, easing: Easing.out(Easing.back(1.5)), useNativeDriver: true }),
  ]).start();
}

export function toastOut(
  opacity: Animated.Value,
  translateY: Animated.Value,
  onDone?: () => void,
) {
  Animated.parallel([
    Animated.timing(opacity, { toValue: 0, duration: motion.timing.standard, useNativeDriver: true }),
    Animated.timing(translateY, { toValue: 12, duration: motion.timing.standard, useNativeDriver: true }),
  ]).start(onDone);
}
