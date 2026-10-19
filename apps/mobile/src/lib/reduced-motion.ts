import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Oct-18 Visual Design brief §12: respect reduced motion for flips,
 * aura and timed transitions. Components that run looping or
 * decorative animations should branch on this hook and either hold
 * a static final frame or disable the loop entirely.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (!cancelled) setReduced(Boolean(on));
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (on) => {
      setReduced(Boolean(on));
    });
    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, []);

  return reduced;
}
