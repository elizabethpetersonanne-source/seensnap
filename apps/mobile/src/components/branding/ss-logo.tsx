import { Image, View, Text, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";
import { colors, fonts } from "@/constants/theme";
const mark = require("../../../assets/branding/seensnap-mark-gold.png");
const sizes = { sm: 20, md: 32, lg: 44, xl: 60 };
/** Approved gold emblem; one asset and consistent proportions on every screen. */
export function SSLogo({ variant = "gold", size = "md", style }: {
  variant?: "gold" | "white" | "mark"; size?: keyof typeof sizes | number;
  style?: StyleProp<ImageStyle | ViewStyle>;
}) {
  const height = typeof size === "number" ? size : sizes[size];
  const full = variant !== "mark";
  return <View accessible accessibilityRole="image" accessibilityLabel="SeenSnap"
    style={[{ height, width: height * (full ? 1.6 : 768 / 704), alignItems: "center", justifyContent: "center" }, style as StyleProp<ViewStyle>]}>
    <Image source={mark} resizeMode="contain" style={{ width: "100%", height: full ? "75%" : "100%" }} />
    {full ? <Text style={{ color: colors.accent, fontFamily: fonts.sansBold, fontSize: height * .18, letterSpacing: height * .025 }}>SEENSNAP</Text> : null}
  </View>;
}
