import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts, rules, spacing } from "@/constants/theme";

type SSEmptyStateProps = {
  index?: string;
  title: string;
  body?: string;
  cta?: string;
  onCta?: () => void;
  style?: ViewStyle;
};

export function SSEmptyState({ index, title, body, cta, onCta, style }: SSEmptyStateProps) {
  return (
    <View style={[styles.container, style]}>
      {index ? (
        <Text style={styles.index}>{index}</Text>
      ) : null}
      <View style={[styles.rule, { backgroundColor: rules.gold }]} />
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {cta && onCta ? (
        <Pressable onPress={onCta} style={styles.cta}>
          <Text style={styles.ctaText}>{cta}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  index: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    color: colors.muted2,
    textTransform: "uppercase",
  },
  rule: {
    height: 1,
    width: 40,
  },
  title: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    maxWidth: 300,
  },
  cta: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(244,196,48,0.40)",
    alignSelf: "flex-start",
  },
  ctaText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
    color: colors.accent,
    letterSpacing: 0.2,
  },
});
