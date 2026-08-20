import { PropsWithChildren } from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

import { colors, fonts, rules, spacing } from "@/constants/theme";

type ScreenProps = PropsWithChildren<{
  title: string;
  subtitle?: string;
  eyebrow?: string;
}>;

export function Screen({ title, subtitle, eyebrow, children }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          {eyebrow ? (
            <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>
          ) : null}
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          <View style={styles.rule} />
        </View>
        <View style={styles.body}>{children}</View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  header: {
    paddingBottom: spacing.lg,
    gap: 5,
  },
  eyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.4,
    color: colors.accent,
  },
  title: {
    fontFamily: fonts.serifBold,
    fontSize: 32,
    lineHeight: 36,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
  },
  rule: {
    height: 1,
    backgroundColor: rules.gold,
    marginTop: spacing.sm,
  },
  body: {
    flex: 1,
    gap: spacing.md,
  },
});
