import { Ionicons } from "@expo/vector-icons";
import { type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Tabs } from "expo-router";
import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, fonts, motion, rules } from "@/constants/theme";

type TabRouteName =
  | "index"
  | "social"
  | "swipe"
  | "previews"
  | "for-you"
  | "my-picks"
  | "teams"
  | "settings";

// Search moved out of the tab bar — accessed via magnifying-glass icon on the
// Discover header. Route file (search.tsx) still exists and is navigable.
// Social brief §2 promotes Social to a primary nav destination — it lives
// between Discover and Swipe so the social loop is one tap from home.
const TAB_CONFIG: Record<
  TabRouteName,
  { label: string; icon: keyof typeof Ionicons.glyphMap; iconFocused: keyof typeof Ionicons.glyphMap }
> = {
  index: { label: "Discover", icon: "compass-outline", iconFocused: "compass" },
  social: { label: "Social", icon: "people-circle-outline", iconFocused: "people-circle" },
  swipe: { label: "Swipe", icon: "layers-outline", iconFocused: "layers" },
  // Previews spec §6 — dedicated top-level destination. Play-in-frame icon.
  previews: { label: "Previews", icon: "play-circle-outline", iconFocused: "play-circle" },
  "for-you": { label: "Scene DNA", icon: "map-outline", iconFocused: "map" },
  "my-picks": { label: "My Picks", icon: "bookmark-outline", iconFocused: "bookmark" },
  teams: { label: "Teams", icon: "people-outline", iconFocused: "people" },
  settings: { label: "Profile", icon: "person-outline", iconFocused: "person" },
};

function TabItem({
  routeName,
  isFocused,
  onPress,
  onLongPress,
}: {
  routeName: string;
  isFocused: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const config = TAB_CONFIG[routeName as TabRouteName] ?? {
    label: routeName,
    icon: "ellipse-outline" as keyof typeof Ionicons.glyphMap,
    iconFocused: "ellipse" as keyof typeof Ionicons.glyphMap,
  };

  const focusAnim = useRef(new Animated.Value(isFocused ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(focusAnim, {
      toValue: isFocused ? 1 : 0,
      duration: motion.timing.standard,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [isFocused, focusAnim]);

  const labelColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.muted2, colors.accent],
  });

  const ruleOpacity = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={styles.tab}>
      {/* Gold active rule at top */}
      <Animated.View style={[styles.activeRule, { opacity: ruleOpacity }]} />

      <View style={styles.tabInner}>
        <Ionicons
          name={isFocused ? config.iconFocused : config.icon}
          size={20}
          color={isFocused ? colors.accent : colors.muted2}
        />
        {/* Force single-line + shrink-to-fit so "Scene DNA" and "Watch Teams"
            stay centered under the icon on 7-tab layouts. */}
        <Animated.Text
          style={[styles.tabLabel, { color: labelColor }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {config.label}
        </Animated.Text>
      </View>
    </Pressable>
  );
}

function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;

        if (!(route.name in TAB_CONFIG)) return null;

        const onPress = () => {
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        const onLongPress = () => {
          navigation.emit({ type: "tabLongPress", target: route.key });
        };

        return (
          <TabItem
            key={route.key}
            routeName={route.name}
            isFocused={isFocused}
            onPress={onPress}
            onLongPress={onLongPress}
          />
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      initialRouteName="index"
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      {/* Search intentionally omitted from the tab bar — reached via the
          magnifying-glass icon on the Discover header. Route file still exists. */}
      <Tabs.Screen name="search" options={{ href: null }} />
      <Tabs.Screen name="social" />
      <Tabs.Screen name="swipe" />
      <Tabs.Screen name="previews" />
      <Tabs.Screen name="for-you" />
      <Tabs.Screen name="my-picks" />
      <Tabs.Screen name="teams" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.backgroundElevated,
    borderTopWidth: 1,
    borderTopColor: rules.default,
    flexDirection: "row",
    paddingTop: 0,
    ...Platform.select({
      ios: {
        shadowColor: colors.shadow,
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: -4 },
      },
      android: { elevation: 16 },
    }),
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingTop: 0,
  },
  activeRule: {
    height: 2,
    width: "100%",
    backgroundColor: colors.accent,
  },
  tabInner: {
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 8,
    paddingHorizontal: 2,
    width: "100%",
  },
  tabLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    textAlign: "center",
  },
});
