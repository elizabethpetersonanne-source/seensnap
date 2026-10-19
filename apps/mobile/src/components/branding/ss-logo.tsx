import { Image, StyleSheet, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";

/**
 * Canonical SeenSnap logo.
 *
 * variants:
 *   - "gold"  — full stacked lockup (camera+play mark + "SeenSnap" wordmark + tagline). Welcome / sign-in / share graphics only.
 *   - "white" — same lockup, white. Over rich imagery where gold would clash.
 *   - "mark"  — icon-only camera/play glyph for the app bar. Rendered as an inline
 *               vector so it's crisp at any size and never clips a stacked raster.
 *
 * `size` always refers to the VISIBLE mark size. The surrounding slot
 * in AppHeader owns the touch target.
 *
 * sizes: "sm" (20), "md" (28), "lg" (40), "xl" (60), or explicit numeric height.
 */

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
  color,
}: {
  variant?: SSLogoVariant;
  size?: SSLogoSize;
  style?: StyleProp<ImageStyle | ViewStyle>;
  color?: string;
}) {
  const heightPx = typeof size === "number" ? size : SIZE_MAP[size];

  if (variant === "mark") {
    const tint = color ?? "#FFE600";
    // Inline vector camera+play glyph. The brief flagged raster
    // clipping as unreliable; building the mark from primitives means
    // the visible icon size equals `heightPx` with no cropping math.
    const bodyR = Math.round(heightPx * 0.18);
    const lensR = Math.round(heightPx * 0.24);
    const triW = Math.round(heightPx * 0.2);
    const triH = Math.round(heightPx * 0.22);
    const strokeW = Math.max(2, Math.round(heightPx * 0.08));
    return (
      <View style={[{ width: heightPx, height: heightPx, position: "relative" }, style]}>
        {/* Viewfinder bump on top */}
        <View
          style={{
            position: "absolute",
            top: 0,
            left: heightPx * 0.3,
            width: heightPx * 0.4,
            height: heightPx * 0.18,
            borderTopLeftRadius: bodyR * 0.6,
            borderTopRightRadius: bodyR * 0.6,
            borderWidth: strokeW,
            borderBottomWidth: 0,
            borderColor: tint,
          }}
        />
        {/* Camera body */}
        <View
          style={{
            position: "absolute",
            top: heightPx * 0.17,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: bodyR,
            borderWidth: strokeW,
            borderColor: tint,
          }}
        />
        {/* Lens ring */}
        <View
          style={{
            position: "absolute",
            top: heightPx / 2 - lensR + heightPx * 0.05,
            left: heightPx / 2 - lensR,
            width: lensR * 2,
            height: lensR * 2,
            borderRadius: lensR,
            borderWidth: strokeW,
            borderColor: tint,
          }}
        />
        {/* Play triangle inside lens */}
        <View
          style={{
            position: "absolute",
            top: heightPx / 2 - triH / 2 + heightPx * 0.05,
            left: heightPx / 2 - triW * 0.35,
            width: 0,
            height: 0,
            borderStyle: "solid",
            borderLeftWidth: triW,
            borderTopWidth: triH / 2,
            borderBottomWidth: triH / 2,
            borderLeftColor: tint,
            borderTopColor: "transparent",
            borderBottomColor: "transparent",
          }}
        />
      </View>
    );
  }

  // Full stacked lockup — welcome / sign-in / share graphics only.
  const aspectRatio = 1.67;
  const width = heightPx * aspectRatio;
  const src = variant === "white" ? ASSETS.white : ASSETS.gold;
  return (
    <Image source={src} style={[styles.full, { width, height: heightPx } as ImageStyle, style as StyleProp<ImageStyle>]} />
  );
}

const styles = StyleSheet.create({
  full: {
    resizeMode: "contain",
  },
});
