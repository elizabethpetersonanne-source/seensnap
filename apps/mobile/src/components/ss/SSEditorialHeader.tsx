import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts, rules, spacing } from "@/constants/theme";

type SSEditorialHeaderProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  rule?: boolean;
  index?: string;
  style?: ViewStyle;
  titleSize?: "sm" | "md" | "lg" | "xl";
  light?: boolean;
};

const TITLE_SIZES = {
  sm: 22,
  md: 28,
  lg: 36,
  xl: 48,
};

export function SSEditorialHeader({
  eyebrow,
  title,
  subtitle,
  rule = false,
  index,
  style,
  titleSize = "lg",
  light = false,
}: SSEditorialHeaderProps) {
  const textColor = light ? colors.paperInk : colors.ink;
  const mutedColor = light ? "rgba(17,23,36,0.6)" : colors.muted;

  return (
    <View style={[styles.container, style]}>
      {eyebrow || index ? (
        <View style={styles.eyebrowRow}>
          {index ? <Text style={[styles.index, { color: colors.accent }]}>{index}</Text> : null}
          {eyebrow ? (
            <Text style={[styles.eyebrow, { color: light ? "#785d12" : colors.accent }]}>
              {eyebrow.toUpperCase()}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Text style={[styles.title, { fontSize: TITLE_SIZES[titleSize], color: textColor }]}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: mutedColor }]}>{subtitle}</Text>
      ) : null}
      {rule ? <View style={[styles.rule, { backgroundColor: rules.gold }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  index: {
    fontFamily: fonts.serif,
    fontSize: 13,
    lineHeight: 16,
  },
  eyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.4,
  },
  title: {
    fontFamily: fonts.serif,
    lineHeight: 1.05 * 36,
    letterSpacing: -0.02 * 36,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 2,
  },
  rule: {
    height: 1,
    marginTop: spacing.sm,
  },
});
