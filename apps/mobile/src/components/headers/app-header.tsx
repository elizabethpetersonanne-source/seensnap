/**
 * Oct-19 Header & Logo Standardization brief.
 *
 * ONE shared top bar used across every destination. Three variants
 * depending on navigation context:
 *
 *   - "primary"    Mark + title + optional right action
 *   - "immersive"  Mark + SWIPE/PREVIEW selector + empty right
 *   - "detail"     Back + title + optional action (modal variant uses close)
 *
 * All variants share:
 *   - 56 logical-pixel content row (not including the top safe-area inset)
 *   - 16/20 horizontal inset
 *   - Equal 44–48 left/right slots so the title stays centered
 *   - Instrument Sans semibold title
 *   - Yellow brand mark
 *
 * Owns the top safe-area inset exactly once. Screens that use this
 * header must NOT also pass `edges=['top']` to a SafeAreaView around it.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { SSLogo } from "@/components/branding/ss-logo";
import { colors, fonts } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { fetchNotifications } from "@/lib/notifications";


export type AppHeaderMode = "swipe" | "preview";


export const APP_HEADER_ROW_HEIGHT = 56;


function HeaderSlot({
  children,
  onPress,
  accessibilityLabel,
  side,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  side: "left" | "right";
}) {
  if (!children) {
    return <View style={styles.slot} />;
  }
  if (!onPress) {
    return (
      <View style={[styles.slot, side === "left" ? styles.slotLeftAlign : styles.slotRightAlign]}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.slot,
        side === "left" ? styles.slotLeftAlign : styles.slotRightAlign,
        pressed && { opacity: 0.6 },
      ]}
    >
      {children}
    </Pressable>
  );
}


export function AppHeader({
  variant = "primary",
  title,
  mode,
  onModeChange,
  rightSlot,
  rightExtras,
  onLeftPress,
  leftKind = "mark",
  transparent = false,
  ownsSafeArea = true,
  hideProfileAvatar = false,
}: {
  variant?: "primary" | "immersive" | "detail";
  title?: string | null;
  mode?: AppHeaderMode;
  onModeChange?: (mode: AppHeaderMode) => void;
  // Fully replaces the right slot (power users / modal save button).
  rightSlot?: React.ReactNode;
  // Adds an icon or action to the LEFT of the sticky profile avatar
  // (e.g. the Teams '+' create-team button). Normal case.
  rightExtras?: React.ReactNode;
  onLeftPress?: () => void;
  leftKind?: "mark" | "back" | "close";
  // Opt out of the sticky profile avatar (modals, settings).
  hideProfileAvatar?: boolean;
  // Immersive surfaces that render over artwork pass transparent=true
  // and apply their own scrim behind the row.
  transparent?: boolean;
  // When this header is NOT inside a SafeAreaView edges=['top'] parent,
  // leave ownsSafeArea=true so it adds the top inset itself. Set it to
  // false if the parent already provided the inset.
  ownsSafeArea?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user, sessionToken } = useAuth();
  const hz = width < 380 ? 16 : 20;

  // Notifications bell on primary surfaces (regression fix: the
  // old legacy headers had a bell; the Oct-19 AppHeader was
  // shipped without one and users lost the entry point). Poll
  // unread count on mount + on app foreground.
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!sessionToken || variant !== "primary" || hideProfileAvatar) return;
    let cancelled = false;
    async function poll() {
      if (!sessionToken) return;
      try {
        const res = await fetchNotifications(sessionToken);
        if (!cancelled) setUnread(res.unread_count ?? 0);
      } catch {
        // ignore — stale 0 is better than an error badge
      }
    }
    void poll();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [sessionToken, variant, hideProfileAvatar]);

  // Default right slot: Notifications + Chat + profile avatar.
  // CHAT-01 + notifications regression fix.
  const defaultRight = !hideProfileAvatar && variant === "primary" && user?.user_id ? (
    <View style={styles.rightCluster}>
      <Pressable
        onPress={() => router.push("/notifications")}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={unread > 0 ? `Open notifications, ${unread} unread` : "Open notifications"}
        style={styles.chatBtn}
      >
        <Ionicons name="notifications-outline" size={20} color={colors.ink} />
        {unread > 0 ? (
          <View style={styles.unreadDot}>
            <Text style={styles.unreadDotText}>{unread > 9 ? "9+" : String(unread)}</Text>
          </View>
        ) : null}
      </Pressable>
      <Pressable
        onPress={() => router.push("/messages")}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Open messages"
        style={styles.chatBtn}
      >
        <Ionicons name="chatbubble-outline" size={20} color={colors.ink} />
      </Pressable>
      <Pressable
        onPress={() => router.push(`/profile/${user.user_id}`)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Open your profile"
      >
        <Avatar
          uri={user.avatar_url ?? null}
          label={user.display_name ?? user.email ?? ""}
          size={30}
        />
      </Pressable>
    </View>
  ) : null;

  const resolvedRight = rightSlot !== undefined ? rightSlot : (
    rightExtras ? (
      <View style={styles.rightCluster}>
        {rightExtras}
        {defaultRight}
      </View>
    ) : (
      defaultRight
    )
  );

  function handleLeft() {
    if (onLeftPress) return onLeftPress();
    if (leftKind === "mark") {
      // Tap the logo = Discover tab. Doesn't push a new Discover screen.
      router.push("/(tabs)");
      return;
    }
    router.back();
  }

  return (
    <View
      style={[
        styles.wrap,
        transparent ? null : styles.wrapOpaque,
        { paddingTop: ownsSafeArea ? insets.top : 0 },
      ]}
    >
      <View style={[styles.row, { paddingHorizontal: hz }]}>
        {/* Centered title / selector is absolutely positioned so its
            baseline stays locked to the viewport regardless of whether
            the slots are symmetric. */}
        <View style={styles.center}>
          {variant === "immersive" && mode && onModeChange ? (
            <ModeSelector mode={mode} onChange={onModeChange} />
          ) : title ? (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
        </View>

        <HeaderSlot
          side="left"
          onPress={handleLeft}
          accessibilityLabel={
            leftKind === "mark"
              ? "SeenSnap — open Discover"
              : leftKind === "close"
              ? "Close"
              : "Back"
          }
        >
          {leftKind === "mark" ? (
            <SSLogo variant="mark" size={34} />
          ) : (
            <Ionicons
              name={leftKind === "close" ? "close" : "chevron-back"}
              size={24}
              color={colors.ink}
            />
          )}
        </HeaderSlot>

        <View style={{ flex: 1 }} />

        <HeaderSlot side="right">{resolvedRight}</HeaderSlot>
      </View>
    </View>
  );
}


function ModeSelector({ mode, onChange }: { mode: AppHeaderMode; onChange: (next: AppHeaderMode) => void }) {
  return (
    <View style={styles.modeSelector}>
      {(["swipe", "preview"] as AppHeaderMode[]).map((m) => {
        const active = mode === m;
        return (
          <Pressable
            key={m}
            onPress={() => onChange(m)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={styles.modeOption}
          >
            <Text style={[styles.modeLabel, active && styles.modeLabelActive]}>
              {m === "swipe" ? "SWIPE" : "PREVIEW"}
            </Text>
            {active ? <View style={styles.modeUnderline} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}


const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    zIndex: 10,
  },
  wrapOpaque: {
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: APP_HEADER_ROW_HEIGHT,
  },
  slot: {
    minWidth: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  slotLeftAlign: {
    alignItems: "flex-start",
    paddingLeft: 2,
  },
  slotRightAlign: {
    alignItems: "flex-end",
    paddingRight: 2,
  },
  center: {
    position: "absolute",
    left: 60,
    right: 60,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
    pointerEvents: "box-none",
  },
  title: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: 0.1,
  },
  modeSelector: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
  },
  modeOption: {
    alignItems: "center",
    paddingVertical: 4,
  },
  modeLabel: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    letterSpacing: 1.3,
    color: colors.muted,
    textTransform: "uppercase",
  },
  modeLabelActive: {
    color: colors.ink,
  },
  modeUnderline: {
    marginTop: 4,
    height: 2,
    width: 24,
    backgroundColor: colors.accent,
    borderRadius: 1,
  },
  rightCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  chatBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  unreadDot: {
    position: "absolute",
    top: 4,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDotText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.background,
    fontSize: 10,
    letterSpacing: 0,
  },
});
