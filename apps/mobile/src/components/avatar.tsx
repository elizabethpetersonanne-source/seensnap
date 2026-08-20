import { useEffect, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";

import { colors } from "@/constants/theme";
import { resolveMediaUrl } from "@/lib/api";

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
  const resolvedUri = resolveMediaUrl(uri);
  const pravatarUri = `https://api.dicebear.com/7.x/avataaars/png?seed=${encodeURIComponent(
    label.toLowerCase().replace(/\s+/g, "-")
  )}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf&size=150`;
  const sources = useMemo(
    () => [resolvedUri, pravatarUri].filter((u): u is string => Boolean(u)),
    [resolvedUri, pravatarUri]
  );
  const [srcIdx, setSrcIdx] = useState(0);
  useEffect(() => { setSrcIdx(0); }, [uri]);

  const activeUri = sources[srcIdx] ?? null;
  const baseStyle = { width: size, height: size, borderRadius: size / 2 };

  if (activeUri) {
    return (
      <Image
        source={{ uri: activeUri }}
        style={[baseStyle, { backgroundColor: colors.backgroundElevated }, style]}
        onError={() => setSrcIdx((i) => Math.min(i + 1, sources.length - 1))}
      />
    );
  }

  return (
    <View
      style={[
        baseStyle,
        {
          backgroundColor: colors.surfaceSoft,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Text
        style={{
          color: colors.ink,
          fontWeight: "800",
          fontSize: Math.max(size * 0.38, 11),
        }}
      >
        {label.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}
