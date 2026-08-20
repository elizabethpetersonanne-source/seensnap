import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SSLogo } from "@/components/branding/ss-logo";
import { colors, fonts, rules, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";
import { useUnreadNotifications } from "@/lib/unread-notifications";

/**
 * Compact / Utility Header — tighter vertical rhythm than SSCinematicHeader so
 * archive-style content (My Picks, Search, Settings) starts sooner. No hero
 * imagery. Uses the SeenSnap mark on the left, large title on its own line.
 *
 * No eyebrow-label decoration by default. If you need context above the title,
 * pass `supporting` (italic serif) — used sparingly and only when adding real info.
 */
/** Responsive scaling so long titles wrap into 2–3 lines instead of ellipsizing.
 *  Aggressive thresholds — real-world display names ("SeenSnap Demo, this is
 *  your name") must fit without adjustsFontSizeToFit alone. */
function responsiveTitleStyle(title: string) {
  const len = title.length;
  if (len > 42) return { fontSize: 16, lineHeight: 20 };
  if (len > 32) return { fontSize: 20, lineHeight: 24 };
  if (len > 22) return { fontSize: 24, lineHeight: 28 };
  if (len > 14) return { fontSize: 28, lineHeight: 32 };
  return {}; // default 32/36
}


export function SSCompactHeader({
  title,
  supporting,
  right,
  showLogo = true,
  bottomRule = true,
  style,
}: {
  title: string;
  supporting?: string;
  right?: ReactNode;
  showLogo?: boolean;
  bottomRule?: boolean;
  style?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  const { count: unreadCount } = useUnreadNotifications();
  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + spacing.sm },
        bottomRule && styles.rule,
        style,
      ]}
    >
      <View style={styles.topRow}>
        {showLogo ? <SSLogo variant="gold" size="sm" /> : <View />}
        <View style={styles.rightActions}>
          {right}
          <Pressable
            onPress={() => {
              trackEvent("search_opened", { entry_point: "compact_header" });
              router.push("/(tabs)/search");
            }}
            hitSlop={10}
            style={styles.compactSearchBtn}
          >
            <Ionicons name="search" size={18} color={colors.ink} />
          </Pressable>
          <Pressable
            onPress={() => router.push("/notifications")}
            hitSlop={10}
            style={styles.compactSearchBtn}
          >
            <Ionicons name="notifications-outline" size={18} color={colors.ink} />
            {unreadCount > 0 ? (
              <View style={styles.compactBadge}>
                <Text style={styles.compactBadgeText}>
                  {unreadCount > 9 ? "9+" : String(unreadCount)}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>
      {/* Never ellipsize primary page titles. Scale down for long strings so the
          title still fits without getting cut off. */}
      <Text
        style={[styles.title, responsiveTitleStyle(title)]}
        numberOfLines={3}
        ellipsizeMode="clip"
        adjustsFontSizeToFit
        minimumFontScale={0.55}
      >
        {title}
      </Text>
      {supporting ? (
        <Text style={styles.supporting} numberOfLines={2}>
          {supporting}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.background,
  },
  rule: {
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  rightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  compactSearchBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  compactBadge: {
    position: "absolute",
    top: 2,
    right: 2,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    paddingHorizontal: 3,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  compactBadgeText: {
    color: colors.paperInk,
    fontFamily: fonts.monoSemiBold,
    fontSize: 8,
  },
  title: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.4,
  },
  supporting: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
});
