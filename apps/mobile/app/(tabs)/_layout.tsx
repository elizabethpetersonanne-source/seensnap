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
  | "my-picks"
  | "teams";

// Oct-18 build brief §3 explicit resolution: the bottom nav is
// Discover · Social · Swipe · My Picks · Teams. Profile is reached
// through the Discover avatar (top-right) and contextual identity
// links elsewhere — there is no sixth tab for Profile / SceneDNA /
// Settings. The `settings` route stays in the router so deep links
// resolve; it's rendered from the avatar menu rather than the bar.
const TAB_CONFIG: Record<
  TabRouteName,
  { label: string; icon: keyof typeof Ionicons.glyphMap; iconFocused: keyof typeof Ionicons.glyphMap }
> = {
  index: { label: "Discover", icon: "compass-outline", iconFocused: "compass" },
  social: { label: "Social", icon: "people-circle-outline", iconFocused: "people-circle" },
  swipe: { label: "Swipe", icon: "layers-outline", iconFocused: "layers" },
  "my-picks": { label: "My Picks", icon: "bookmark-outline", iconFocused: "bookmark" },
  teams: { label: "Teams", icon: "people-outline", iconFocused: "people" },
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

  // Swipe is the primary action — rendered as a large filled accent
  // disc that lifts above the other tabs (Instagram story-circle style).
  const isPrimary = routeName === "swipe";

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

  if (isPrimary) {
    return (
      <Pressable onPress={onPress} onLongPress={onLongPress} style={styles.primaryTab}>
        <View style={[styles.primaryDisc, isFocused && styles.primaryDiscFocused]}>
          <Ionicons
            name={isFocused ? config.iconFocused : config.icon}
            size={30}
            color={colors.background}
          />
        </View>
        <Animated.Text
          style={[styles.primaryLabel, { color: labelColor }]}
          numberOfLines={1}
        >
          {config.label}
        </Animated.Text>
      </Pressable>
    );
  }

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
      <Tabs.Screen name="social" />
      <Tabs.Screen name="swipe" />
      <Tabs.Screen name="my-picks" />
      <Tabs.Screen name="teams" />
      {/* Non-tab-bar routes retained so deep links / old URLs still
          resolve. Setting href: null keeps them in the router but
          hides them from the bottom bar. Previews is now reachable
          from the Swipe|Previews mode toggle; Scene DNA is reachable
          from Profile; Teams is reachable from Social; Search is
          reachable from the Discover magnifying glass. */}
      <Tabs.Screen name="search" options={{ href: null }} />
      <Tabs.Screen name="previews" options={{ href: null }} />
      <Tabs.Screen name="for-you" options={{ href: null }} />
      <Tabs.Screen name="settings" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.backgroundElevated,
    borderTopWidth: 1,
    borderTopColor: rules.default,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingTop: 0,
    // Give the primary disc headroom to lift above the top border.
    overflow: "visible",
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
  primaryTab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: -20,
  },
  primaryDisc: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: colors.backgroundElevated,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.35,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 10 },
    }),
  },
  primaryDiscFocused: {
    backgroundColor: colors.accent,
  },
  primaryLabel: {
    marginTop: 4,
    fontFamily: fonts.monoSemiBold,
    fontSize: 8,
    letterSpacing: 0.6,
    textTransform: "uppercase",
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
