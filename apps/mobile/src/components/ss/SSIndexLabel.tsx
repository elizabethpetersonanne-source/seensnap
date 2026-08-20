import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts } from "@/constants/theme";

type SSIndexLabelProps = {
  label: string;
  active?: boolean;
  gold?: boolean;
  style?: ViewStyle;
  size?: "xs" | "sm" | "md";
};

const SIZES = { xs: 8, sm: 9, md: 10 };

export function SSIndexLabel({ label, active = false, gold = false, style, size = "sm" }: SSIndexLabelProps) {
  const color = gold || active ? colors.accent : colors.muted2;
  const fontSize = SIZES[size];

  return (
    <View style={[styles.wrap, style]}>
      <Text style={[styles.text, { color, fontSize }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: "flex-start",
  },
  text: {
    fontFamily: fonts.monoSemiBold,
    letterSpacing: 1.1,
    lineHeight: 14,
  },
});
