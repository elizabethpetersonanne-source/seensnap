import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts } from "@/constants/theme";

type SSMetadataRailProps = {
  items: (string | null | undefined)[];
  style?: ViewStyle;
  light?: boolean;
  size?: "xs" | "sm" | "md";
};

const SIZES = { xs: 9, sm: 10, md: 11 };

export function SSMetadataRail({ items, style, light = false, size = "sm" }: SSMetadataRailProps) {
  const filtered = items.filter(Boolean) as string[];
  if (filtered.length === 0) return null;

  const textColor = light ? "rgba(17,23,36,0.55)" : colors.muted2;
  const sepColor = light ? "rgba(17,23,36,0.25)" : "rgba(255,255,255,0.22)";
  const fontSize = SIZES[size];

  return (
    <View style={[styles.rail, style]}>
      {filtered.map((item, i) => (
        <View key={i} style={styles.item}>
          {i > 0 ? (
            <Text style={[styles.sep, { color: sepColor, fontSize }]}> / </Text>
          ) : null}
          <Text style={[styles.text, { color: textColor, fontSize }]}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
  },
  sep: {
    fontFamily: fonts.mono,
    lineHeight: 16,
  },
  text: {
    fontFamily: fonts.mono,
    letterSpacing: 0.4,
    lineHeight: 16,
  },
});
