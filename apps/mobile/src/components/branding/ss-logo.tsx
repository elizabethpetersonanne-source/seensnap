import { Image, StyleSheet, View, type ImageStyle, type ViewStyle } from "react-native";

/**
 * Canonical SeenSnap logo. Uses the real PNG assets — never redraw or text-approximate.
 *
 * variants:
 *   - "gold"     — full mark on transparent (camera+play mark + "SeenSnap" wordmark + tagline). Use on dark hero surfaces.
 *   - "white"    — same layout, white. Use over rich imagery where gold would clash.
 *   - "mark"     — icon-only (crop from full logo via width; height controls). For nav bars, tight spaces.
 *
 * sizes: "sm" (24), "md" (32), "lg" (44), "xl" (64), or explicit numeric height.
 */

// Actual PNG asset registry — matches files at apps/mobile/assets/branding/
// Both gold and white variants are the same layout (mark above wordmark); pick by canvas contrast.
const ASSETS = {
  gold: require("../../../assets/branding/seensnap-logo-gold.png"),
  white: require("../../../assets/branding/seensnap-logo-white-v2.png"),
};

type SSLogoVariant = "gold" | "white" | "mark";
type SSLogoSize = "sm" | "md" | "lg" | "xl" | number;

const SIZE_MAP: Record<Exclude<SSLogoSize, number>, number> = {
  sm: 20,
  md: 28,
  lg: 40,
  xl: 60,
};

export function SSLogo({
  variant = "gold",
  size = "md",
  style,
}: {
  variant?: SSLogoVariant;
  size?: SSLogoSize;
  style?: ViewStyle;
}) {
  const heightPx = typeof size === "number" ? size : SIZE_MAP[size];
  // The full-logo PNGs are ~2000 × 1200 (roughly 1.67:1). The mark alone (top ~55%) is ~1:1.
  // For "mark" variant, we clip the wordmark by rendering the same source cropped.
  const isMarkOnly = variant === "mark";
  const src = variant === "white" ? ASSETS.white : ASSETS.gold;
  const aspectRatio = isMarkOnly ? 1 : 1.67;
  const width = heightPx * aspectRatio;

  if (isMarkOnly) {
    // Render only the top 55% of the source (the camera+play mark) via a clipped container.
    // The full source is ~1.67:1; the mark occupies roughly the upper 55% square.
    const containerH = heightPx;
    const sourceH = heightPx * (1 / 0.55); // scale up so 55% == our target height
    return (
      <View style={[{ width: containerH, height: containerH, overflow: "hidden" }, style]}>
        <Image
          source={src}
          style={{ width: containerH, height: sourceH, resizeMode: "cover" }}
        />
      </View>
    );
  }

  return (
    <Image source={src} style={[styles.full, { width, height: heightPx } as ImageStyle, style]} />
  );
}

const styles = StyleSheet.create({
  full: {
    resizeMode: "contain",
  },
});
