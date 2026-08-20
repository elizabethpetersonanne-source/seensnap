import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SSLogo } from "@/components/branding/ss-logo";
import { colors, fonts, spacing } from "@/constants/theme";
import { parallaxScale, parallaxTranslate, useReduceMotion } from "@/lib/motion";
import { trackEvent } from "@/lib/analytics";
import { useUnreadNotifications } from "@/lib/unread-notifications";

/**
 * Cinematic Header — canonical big-hero header used on flagship surfaces (Discover,
 * Scene DNA, Watch Teams). Full-bleed backdrop imagery, real logo, big serif title,
 * optional supporting italic line, scroll-linked parallax + gentle collapse.
 *
 * Data rule: caller passes REAL entertainment imagery (poster/backdrop URL). Never
 * fabricate imagery. When `backdropSource` is null the header degrades to a solid
 * ink background — do not use a placeholder poster.
 */
/**
 * Responsive title sizing — never truncate a primary page title. Aggressive
 * ladder so long names like "SeenSnap Demo, this is your name" fit cleanly.
 * Combined with `numberOfLines={3}` + `adjustsFontSizeToFit` as safety nets.
 */
function responsiveTitleStyle(title: string) {
  const len = title.length;
  if (len > 42) return { fontSize: 18, lineHeight: 22, letterSpacing: -0.1 };
  if (len > 32) return { fontSize: 22, lineHeight: 26, letterSpacing: -0.2 };
  if (len > 22) return { fontSize: 26, lineHeight: 30, letterSpacing: -0.25 };
  if (len > 14) return { fontSize: 32, lineHeight: 36 };
  return {}; // default 40/44 from base style
}


export function SSCinematicHeader({
  title,
  supporting,
  backdropSource,
  backdropNode,
  scrollY,
  logoVariant = "white",
  minHeight = 260,
  maxHeight = 340,
  right,
  onPressLogo,
  fallbackSeed = 0,
  children,
  style,
}: {
  title: string;
  supporting?: string;
  /** Simple case: a single landscape backdrop URL. Runs through the safety policy upstream. */
  backdropSource?: string | null;
  /** Advanced: caller-supplied backdrop content (e.g. real-poster mosaic for
   *  My Picks / Scene DNA). Rendered in the same absolute-fill layer + covered
   *  by the same text-safe gradient. Takes precedence over `backdropSource`. */
  backdropNode?: ReactNode;
  scrollY?: Animated.Value;
  logoVariant?: "white" | "gold" | "mark";
  minHeight?: number;
  maxHeight?: number;
  right?: ReactNode;
  onPressLogo?: () => void;
  /** When the brand fallback is shown (no backdrop image), this seed shifts the
   *  accent placement so different tabs' fallbacks visually differentiate. */
  fallbackSeed?: number;
  children?: ReactNode;
  style?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const { count: unreadCount } = useUnreadNotifications();

  // Ambient drift — very subtle, only when Reduce Motion is off.
  const ambient = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ambient, { toValue: 1, duration: 14000, useNativeDriver: true }),
        Animated.timing(ambient, { toValue: 0, duration: 14000, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [ambient, reduce]);

  const ambientTx = ambient.interpolate({ inputRange: [0, 1], outputRange: [-8, 8] });
  const ambientTy = ambient.interpolate({ inputRange: [0, 1], outputRange: [4, -4] });

  // Native-driver-safe scroll animations only: transform + opacity. Layout properties
  // like `height` cannot be animated with the native driver (parent Animated.event uses
  // useNativeDriver:true). The visual collapse comes from translating the content upward
  // and slightly scaling the title — the shell keeps a fixed maxHeight.
  const heightRange = maxHeight - minHeight;
  const backdropTranslate = scrollY ? parallaxTranslate(scrollY, 0.4, heightRange) : 0;
  const backdropScale = scrollY ? parallaxScale(scrollY) : 1;
  const contentTranslateY = scrollY
    ? scrollY.interpolate({
        inputRange: [0, heightRange],
        outputRange: [0, -heightRange * 0.55],
        extrapolate: "clamp",
      })
    : 0;
  const contentOpacity = scrollY
    ? scrollY.interpolate({
        inputRange: [0, heightRange * 0.6, heightRange],
        outputRange: [1, 0.9, 0.6],
        extrapolate: "clamp",
      })
    : 1;
  const titleScale = scrollY
    ? scrollY.interpolate({
        inputRange: [0, heightRange],
        outputRange: [1, 0.86],
        extrapolate: "clamp",
      })
    : 1;

  return (
    <View style={[styles.root, { height: maxHeight }, style]}>
      {/* Backdrop layer — caller-supplied node takes precedence, then URL, then solid ink. */}
      {backdropNode ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {backdropNode}
        </View>
      ) : backdropSource ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              transform: reduce
                ? [{ scale: backdropScale }]
                : [
                    { translateX: ambientTx },
                    { translateY: Animated.add(ambientTy, backdropTranslate as Animated.Value) },
                    { scale: backdropScale },
                  ],
            },
          ]}
        >
          <Image
            source={{ uri: backdropSource }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        </Animated.View>
      ) : (
        /* Branded fallback — never leave the header feeling empty when data
           is still loading or the source has no landscape backdrop. A subtle
           radial-style gold accent + midnight base still reads as SeenSnap.
           `fallbackSeed` varies the accent placement per tab so cold-start
           headers don't look identical across surfaces. */
        <View style={[StyleSheet.absoluteFill, styles.brandFallback]}>
          <View style={[
            styles.brandFallbackAccentA,
            { top: -80 + (fallbackSeed % 3) * 40, left: -60 + (fallbackSeed % 4) * 30 },
          ]} />
          <View style={[
            styles.brandFallbackAccentB,
            { bottom: -100 + (fallbackSeed % 2) * 30, right: -80 + (fallbackSeed % 3) * 25 },
          ]} />
        </View>
      )}

      {/* Vertical readability gradient — top slight, bottom strong so title reads over any image */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.gradientTop]} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.gradientBottom]} />

      {/* Top row: logo + caller actions + PERSISTENT search icon (always last). */}
      <View style={[styles.topRow, { paddingTop: insets.top + spacing.xs }]}>
        <Pressable onPress={onPressLogo} hitSlop={8} disabled={!onPressLogo}>
          <SSLogo variant={logoVariant} size="lg" />
        </Pressable>
        <View style={styles.rightActions}>
          {right}
          <Pressable
            onPress={() => {
              trackEvent("search_opened", { entry_point: "cinematic_header" });
              router.push("/(tabs)/search");
            }}
            hitSlop={10}
            style={styles.persistentSearchBtn}
          >
            <Ionicons name="search" size={18} color={colors.ink} />
          </Pressable>
          <Pressable
            onPress={() => router.push("/notifications")}
            hitSlop={10}
            style={styles.persistentSearchBtn}
          >
            <Ionicons name="notifications-outline" size={18} color={colors.ink} />
            {unreadCount > 0 ? (
              <View style={styles.persistentBadge}>
                <Text style={styles.persistentBadgeText}>
                  {unreadCount > 9 ? "9+" : String(unreadCount)}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>

      {/* Content: title, supporting, children — animated together with translateY + opacity
          (both native-driver safe) to give the illusion of collapse on scroll.

          Per forensic-audit remediation: page titles must NEVER ellipsize. We size
          the title responsively based on measured string length so long names like
          "SeenSnap Demo, this is your name" wrap to 2 lines instead of truncating. */}
      <Animated.View
        style={[
          styles.contentBlock,
          { opacity: contentOpacity, transform: [{ translateY: contentTranslateY }] },
        ]}
      >
        {children}
        <Animated.Text
          style={[
            styles.title,
            responsiveTitleStyle(title),
            { transform: [{ scale: titleScale }] },
          ]}
          numberOfLines={3}
          ellipsizeMode="clip"
          adjustsFontSizeToFit
          minimumFontScale={0.55}
        >
          {title}
        </Animated.Text>
        {supporting ? (
          <Text style={styles.supporting} numberOfLines={2}>
            {supporting}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: "100%",
    overflow: "hidden",
    backgroundColor: colors.velvet,
  },
  brandFallback: {
    backgroundColor: colors.velvet,
  },
  brandFallbackAccentA: {
    position: "absolute",
    width: 260,
    height: 260,
    borderRadius: 260,
    backgroundColor: "rgba(244,196,48,0.08)",
  },
  brandFallbackAccentB: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 320,
    backgroundColor: "rgba(244,196,48,0.05)",
  },
  gradientTop: {
    // A subtle top-fade for status bar readability.
    backgroundColor: "rgba(3,5,10,0.35)",
    height: "45%",
  },
  gradientBottom: {
    top: "45%",
    backgroundColor: "rgba(3,5,10,0.60)",
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  rightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  persistentSearchBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  persistentBadge: {
    position: "absolute",
    top: 3,
    right: 3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  persistentBadgeText: {
    color: colors.paperInk,
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 0.2,
  },
  contentBlock: {
    position: "absolute",
    bottom: spacing.lg,
    left: spacing.lg,
    right: spacing.lg,
  },
  title: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 40,
    lineHeight: 44,
    letterSpacing: -0.5,
    ...Platform.select({
      ios: {
        textShadowColor: "rgba(2,4,8,0.55)",
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 8,
      },
      android: {},
    }),
  },
  supporting: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    color: "rgba(243,239,229,0.82)",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    letterSpacing: 0.1,
  },
});
