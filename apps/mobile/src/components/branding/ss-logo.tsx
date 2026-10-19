import { Image, StyleSheet, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";

/**
 * Canonical SeenSnap logo.
 *
 * variants:
 *   - "gold"  — full stacked lockup (camera+play mark + "SeenSnap" wordmark + tagline). Welcome / sign-in / share graphics only.
 *   - "white" — same lockup, white. Over rich imagery where gold would clash.
 *   - "mark"  — the stacked lockup rendered compact for app bars.
 *               Uses the REAL approved SeenSnap asset at `contain`
 *               so every element (camera + wordmark + tagline)
 *               stays legible and nothing is clipped.
 *
 * `size` is the asset HEIGHT. The width is derived from the real
 * aspect ratio so the asset is never squished or stretched.
 *
 * sizes: "sm" (20), "md" (32), "lg" (44), "xl" (60), or explicit numeric height.
 */

const ASSETS = {
  gold: require("../../../assets/branding/seensnap-logo-gold.png"),
  white: require("../../../assets/branding/seensnap-logo-white-v2.png"),
  // Compact gold mark + wordmark (no tagline) — the approved asset
  // the user supplied for the app bar.
  mark: require("../../../assets/branding/seensnap-mark-gold.png"),
};

type SSLogoVariant = "gold" | "white" | "mark";
type SSLogoSize = "sm" | "md" | "lg" | "xl" | number;

const SIZE_MAP: Record<Exclude<SSLogoSize, number>, number> = {
  sm: 20,
  md: 32,
  lg: 44,
  xl: 60,
};

// Real asset aspect ratio (width / height). The master PNGs are
// stacked: camera glyph above "SeenSnap" wordmark above tagline.
const LOGO_ASPECT_RATIO = 1.6;

export function SSLogo({
  variant = "gold",
  size = "md",
  style,
}: {
  variant?: SSLogoVariant;
  size?: SSLogoSize;
  style?: StyleProp<ImageStyle | ViewStyle>;
}) {
  const heightPx = typeof size === "number" ? size : SIZE_MAP[size];
  // Variant-specific real assets. Mark is the compact gold camera +
  // "SeenSnap" wordmark the user supplied; its aspect ratio differs
  // from the full stacked lockups.
  const src =
    variant === "mark" ? ASSETS.mark : variant === "white" ? ASSETS.white : ASSETS.gold;
  // Mark asset is roughly 1:1 (camera on top, small wordmark below).
  // Full lockups are wider.
  const aspect = variant === "mark" ? 1 : LOGO_ASPECT_RATIO;
  const width = heightPx * aspect;
  return (
    <Image
      source={src}
      style={[styles.full, { width, height: heightPx } as ImageStyle, style as StyleProp<ImageStyle>]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="SeenSnap"
    />
  );
}

const styles = StyleSheet.create({
  full: {
    resizeMode: "contain",
  },
});
