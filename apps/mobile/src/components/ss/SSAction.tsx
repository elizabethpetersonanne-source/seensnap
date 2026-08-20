import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  type PressableProps,
  type ViewStyle,
} from "react-native";
import { useRef } from "react";

import { colors, fonts, radii, spacing } from "@/constants/theme";

type SSActionVariant = "primary" | "secondary" | "text" | "destructive" | "ghost";
type SSActionSize = "sm" | "md" | "lg";

type SSActionProps = PressableProps & {
  label: string;
  variant?: SSActionVariant;
  size?: SSActionSize;
  style?: ViewStyle;
  fullWidth?: boolean;
};

const SIZE_PAD = {
  sm: { paddingVertical: 9, paddingHorizontal: 14 },
  md: { paddingVertical: 13, paddingHorizontal: spacing.lg },
  lg: { paddingVertical: 16, paddingHorizontal: spacing.xl },
};

const SIZE_TEXT = { sm: 12, md: 14, lg: 15 };

export function SSAction({
  label,
  variant = "primary",
  size = "md",
  style,
  fullWidth = false,
  ...rest
}: SSActionProps) {
  const scale = useRef(new Animated.Value(1)).current;

  function onPressIn() {
    Animated.timing(scale, { toValue: 0.97, duration: 80, useNativeDriver: true }).start();
  }
  function onPressOut() {
    Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }).start();
  }

  const containerStyle: ViewStyle[] = [
    styles.base,
    SIZE_PAD[size],
    variantContainer[variant],
    fullWidth ? { width: "100%" } : {},
  ];

  return (
    <Pressable
      {...rest}
      onPressIn={(e) => { onPressIn(); rest.onPressIn?.(e); }}
      onPressOut={(e) => { onPressOut(); rest.onPressOut?.(e); }}
    >
      <Animated.View style={[...containerStyle, { transform: [{ scale }] }, style]}>
        <Text style={[styles.label, { fontSize: SIZE_TEXT[size] }, variantText[variant]]}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const variantContainer: Record<SSActionVariant, ViewStyle> = {
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
  },
  secondary: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    borderRadius: radii.sm,
  },
  ghost: {
    borderRadius: radii.sm,
  },
  text: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  destructive: {
    borderWidth: 1,
    borderColor: "rgba(224,112,112,0.35)",
    borderRadius: radii.sm,
  },
};

const variantText: Record<SSActionVariant, object> = {
  primary: { color: colors.paperInk, fontFamily: fonts.sansBold },
  secondary: { color: colors.ink, fontFamily: fonts.sansSemiBold },
  ghost: { color: colors.muted, fontFamily: fonts.sansMedium },
  text: { color: colors.accent, fontFamily: fonts.sansMedium },
  destructive: { color: colors.danger, fontFamily: fonts.sansMedium },
};

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  label: {
    letterSpacing: 0.2,
  },
});
