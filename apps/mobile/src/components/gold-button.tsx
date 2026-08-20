import { Ionicons } from "@expo/vector-icons";
import { useRef } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";

import { colors, fonts, motion } from "@/constants/theme";

type GoldButtonProps = {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  size?: "sm" | "md" | "lg";
  style?: object;
};

export function GoldButton({ label, onPress, icon, size = "md", style }: GoldButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => Animated.timing(scale, { toValue: 0.97, duration: 80, useNativeDriver: true }).start()}
      onPressOut={() => Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }).start()}
    >
      <Animated.View style={[styles.base, SIZE_STYLES[size], style, { transform: [{ scale }] }]}>
        {icon ? <Ionicons name={icon} size={ICON_SIZES[size]} color={colors.paperInk} /> : null}
        <Text style={[styles.label, LABEL_STYLES[size]]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

const SIZE_STYLES = {
  sm: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 2 },
  md: { paddingHorizontal: 20, paddingVertical: 13, borderRadius: 2 },
  lg: { paddingHorizontal: 24, paddingVertical: 15, borderRadius: 2 },
};

const LABEL_STYLES = {
  sm: { fontSize: 10 },
  md: { fontSize: 11 },
  lg: { fontSize: 12 },
};

const ICON_SIZES = { sm: 14, md: 16, lg: 17 };

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: colors.accent,
  },
  label: {
    fontFamily: fonts.monoSemiBold,
    color: colors.paperInk,
    letterSpacing: 1.0,
    textTransform: "uppercase",
  },
});
