/** The five app destinations remain reachable while browsing detail screens. */
import { Ionicons } from "@expo/vector-icons";
import { router, useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { Keyboard, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/lib/auth";
import { colors } from "@/constants/theme";
const destinations = [
  ["Discover", "compass-outline", "/(tabs)"],
  ["Social", "people-circle-outline", "/(tabs)/social"],
  ["Swipe", "layers-outline", "/(tabs)/swipe"],
  ["My Picks", "bookmark-outline", "/(tabs)/my-picks"],
  ["Teams", "people-outline", "/(tabs)/teams"],
] as const;
export function DetailNavigation() {
  const segments = useSegments();
  const { sessionToken } = useAuth();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () =>
        setKeyboard(true),
      ),
      hide = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  if (
    !sessionToken ||
    keyboard ||
    ["(tabs)", "sign-in", "onboarding", "publish", "add-to-story"].includes(
      segments[0],
    )
  )
    return null;
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        backgroundColor: colors.background,
        borderTopWidth: 1,
        borderTopColor: colors.surface,
        paddingBottom: Math.max(insets.bottom, 8),
        paddingTop: 6,
      }}
    >
      {destinations.map(([label, icon, path]) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={`Go to ${label}`}
          style={{
            flex: 1,
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
          onPress={() => router.dismissTo(path)}
        >
          <Ionicons name={icon} size={20} color={colors.muted} />
          <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
