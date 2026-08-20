import { PropsWithChildren } from "react";
import {
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";

import { colors, spacing } from "@/constants/theme";

type SSScreenProps = PropsWithChildren<{
  scroll?: boolean;
  paper?: boolean;
  style?: ViewStyle;
  contentStyle?: ViewStyle;
  edges?: ("top" | "bottom" | "left" | "right")[];
}>;

export function SSScreen({
  children,
  scroll = false,
  paper = false,
  style,
  contentStyle,
}: SSScreenProps) {
  const bg = paper ? colors.paper : colors.background;

  if (scroll) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bg }, style]}>
        <StatusBar barStyle={paper ? "dark-content" : "light-content"} />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.scrollContent, contentStyle]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bg }, style]}>
      <StatusBar barStyle={paper ? "dark-content" : "light-content"} />
      <View style={[styles.fill, contentStyle]}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  fill: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
});
