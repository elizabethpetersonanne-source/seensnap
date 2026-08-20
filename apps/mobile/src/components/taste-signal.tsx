import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

/**
 * TasteSignal — canonical chip for surfacing a taste label, genre, platform, mood
 * or Scene DNA signal. Two variants:
 *   - "line"    : bordered chip, dim ink text (default; use in dense clusters)
 *   - "prime"   : filled chip with gold accent (for the strongest / hero signal)
 *
 * Optional numeric index (01, 02, 03) mirrors the SeenSnap "signal rank" language.
 * Optional icon for extra affordance (e.g. genre glyph). No decoration for its own
 * sake — index or icon should always add real information.
 */
export type TasteSignalVariant = "line" | "prime";

export function TasteSignal({
  label,
  index,
  icon,
  variant = "line",
  onPress,
  style,
}: {
  label: string;
  index?: number | string;
  icon?: keyof typeof Ionicons.glyphMap;
  variant?: TasteSignalVariant;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const isPrime = variant === "prime";
  const indexStr =
    typeof index === "number" ? String(index).padStart(2, "0") : index;
  return (
    <View
      style={[
        styles.base,
        isPrime ? styles.prime : styles.line,
        style,
      ]}
    >
      {indexStr ? (
        <Text style={[styles.index, isPrime && styles.indexPrime]}>{indexStr}</Text>
      ) : null}
      {icon ? (
        <Ionicons name={icon} size={11} color={isPrime ? colors.background : colors.accent} />
      ) : null}
      <Text style={[styles.label, isPrime && styles.labelPrime]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
  },
  line: {
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: "transparent",
  },
  prime: {
    backgroundColor: colors.accent,
  },
  index: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 0.8,
    color: colors.accent,
  },
  indexPrime: {
    color: colors.paperInk,
  },
  label: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
    color: colors.ink,
    letterSpacing: 0.1,
  },
  labelPrime: {
    color: colors.paperInk,
    fontFamily: fonts.sansBold,
  },
});
