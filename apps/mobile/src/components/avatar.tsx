import { useEffect, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";

import { colors } from "@/constants/theme";
import { resolveMediaUrl } from "@/lib/api";

/**
 * Round user avatar.
 *
 * Load order:
 *   1. Real uploaded/Google avatar URL (from `uri`).
 *   2. If null or failed to load → initials fallback (colored circle with
 *      the user's first letter). NO cartoon-avatar service — an obvious
 *      placeholder that's obviously the app's own beats a random-looking
 *      cartoon that reads as fake identity.
 *
 * Background color for the initials is derived from the label so different
 * users get visually distinct fallbacks even when none have photos.
 */

// Seven curated tones that work on the dark canvas. Kept small so the same
// name lands on the same tone every time (deterministic).
const FALLBACK_TONES = [
  "#c69a52", // amber
  "#7a9ec7", // dusty blue
  "#a184c9", // muted plum
  "#8bb591", // sage
  "#c98080", // faded rose
  "#7f9b9c", // teal grey
  "#b7a56a", // ochre
] as const;

function toneFor(label: string): string {
  if (!label) return FALLBACK_TONES[0];
  let h = 0;
  for (let i = 0; i < label.length; i += 1) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_TONES[h % FALLBACK_TONES.length];
}

export function Avatar({
  uri,
  label,
  size,
  style,
}: {
  uri?: string | null;
  label: string;
  size: number;
  style?: object;
}) {
  const resolvedUri = useMemo(() => resolveMediaUrl(uri), [uri]);
  const [failed, setFailed] = useState(false);

  // Reset failed flag if the source URL changes.
  useEffect(() => {
    setFailed(false);
  }, [resolvedUri]);

  const baseStyle = { width: size, height: size, borderRadius: size / 2 };
  const initial = (label?.trim()?.slice(0, 1) ?? "?").toUpperCase();
  const tone = toneFor(label);

  if (resolvedUri && !failed) {
    return (
      <Image
        source={{ uri: resolvedUri }}
        style={[baseStyle, { backgroundColor: colors.backgroundElevated }, style]}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <View
      style={[
        baseStyle,
        {
          backgroundColor: tone,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Text
        style={{
          color: colors.background,
          fontWeight: "800",
          fontSize: Math.max(size * 0.42, 12),
          letterSpacing: 0.5,
        }}
      >
        {initial}
      </Text>
    </View>
  );
}
