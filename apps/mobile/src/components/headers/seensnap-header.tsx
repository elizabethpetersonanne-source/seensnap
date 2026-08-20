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
import { colors, fonts, header, rules } from "@/constants/theme";
import { parallaxScale, parallaxTranslate, useReduceMotion } from "@/lib/motion";
import { trackEvent } from "@/lib/analytics";
import { useUnreadNotifications } from "@/lib/unread-notifications";

/**
 * SeenSnapHeader — the ONE header component used by every primary destination.
 * Replaces per-screen ad-hoc headers so switching tabs feels like changing
 * channels in one cinematic OS instead of moving between six microsites
 * (per Unified Header System brief §1, §28, §29).
 *
 * Two variants:
 *   - "standard"   → Discover, My Picks, Watch Teams (overview + detail),
 *                    Profile, SceneDNA. ~300px tall.
 *   - "immersive"  → Swipe only. Slightly taller because the current title
 *                    artwork IS the context, but geometry of the global rail
 *                    stays IDENTICAL to standard.
 *
 * Rules enforced by this component (per brief §2, §3, §10, §21, §24):
 *   1. The global rail (logo · optional contextualAction · Search · Bell) is
 *      always in the same position. No screen can override its geometry.
 *   2. Tap SeenSnap logo → navigate to Discover (§25).
 *   3. Search + notifications icons come from tokens; every screen shares
 *      identical size, icon, and destination (§23–§24).
 *   4. Long titles wrap to max 2 lines (§8, §21) — never auto-scale down.
 *   5. Artwork resolves cleanly into the app background via a gradient stack
 *      defined in tokens (§4, §19). There is never a hard artwork/UI boundary.
 *   6. On scroll: full hero → compact rail, driven by scrollY (§22).
 *
 * Everything visible below the header is destination personality (§27, §28).
 */

type SubtitleStyle = "editorial" | "utility";
type Subtitle = string | { text: string; style: SubtitleStyle } | null | undefined;

type Props = {
  variant?: "standard" | "immersive";
  title: string;
  subtitle?: Subtitle;
  /** Backdrop from a resolved semantic source (per §16 destination rules). */
  artworkSource?: string | null;
  /** Advanced: caller-supplied backdrop content (e.g. My Picks poster mosaic). */
  artworkNode?: ReactNode;
  /** Slot BEFORE Search/Bell for a single contextual action ('+' etc.). */
  contextualAction?: ReactNode;
  scrollY?: Animated.Value;
  /** When artwork is null, this seed varies the fallback accent placement so
   *  different tabs' cold-start states don't look identical. */
  fallbackSeed?: number;
  style?: ViewStyle;
};

function isEditorialSubtitle(sub: Subtitle): sub is { text: string; style: SubtitleStyle } {
  return typeof sub === "object" && sub !== null && "style" in sub;
}

/** Two H1 sizes: the standard token size, and a slightly smaller size for
 *  long titles. Never auto-fit; wrap up to 2 lines per §8 + §21. */
function h1Style(title: string) {
  return title.length > 18
    ? { fontSize: header.H1_LONG_SIZE, lineHeight: header.H1_LONG_LINE_HEIGHT }
    : {};
}

export function SeenSnapHeader({
  variant = "standard",
  title,
  subtitle,
  artworkSource,
  artworkNode,
  contextualAction,
  scrollY,
  fallbackSeed = 0,
  style,
}: Props) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const { count: unreadCount } = useUnreadNotifications();

  const maxHeight = variant === "immersive" ? header.IMMERSIVE_HEIGHT : header.STANDARD_HEIGHT;
  const minHeight = variant === "immersive" ? header.IMMERSIVE_MIN_HEIGHT : header.STANDARD_MIN_HEIGHT;
  const heightRange = Math.max(maxHeight - minHeight, 1);

  // Ambient drift — subtle, only when Reduce Motion is off. Applied via the
  // native driver so it never blocks the JS thread.
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
  const ambientTx = ambient.interpolate({ inputRange: [0, 1], outputRange: [-6, 6] });
  const ambientTy = ambient.interpolate({ inputRange: [0, 1], outputRange: [3, -3] });

  // Scroll-linked parallax + content collapse. Native-driver safe (transform +
  // opacity only). The shell keeps a fixed maxHeight so layout doesn't jump.
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
        outputRange: [1, 0.9, 0.35],
        extrapolate: "clamp",
      })
    : 1;

  const subtitleStyle: SubtitleStyle = isEditorialSubtitle(subtitle) ? subtitle.style : "editorial";
  const subtitleText = subtitle
    ? isEditorialSubtitle(subtitle)
      ? subtitle.text
      : (subtitle as string)
    : null;

  return (
    <View style={[styles.root, { height: maxHeight }, style]}>
      {/* Artwork layer — caller node takes precedence, then URL, then brand fallback. */}
      {artworkNode ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {artworkNode}
        </View>
      ) : artworkSource ? (
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
            source={{ uri: artworkSource }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        </Animated.View>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.brandFallback]}>
          <View
            style={[
              styles.brandAccentA,
              { top: -80 + (fallbackSeed % 3) * 40, left: -60 + (fallbackSeed % 4) * 30 },
            ]}
          />
          <View
            style={[
              styles.brandAccentB,
              { bottom: -100 + (fallbackSeed % 2) * 30, right: -80 + (fallbackSeed % 3) * 25 },
            ]}
          />
        </View>
      )}

      {/* Dark overlay for text safety over any imagery. */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.overlay]} />

      {/* Bottom-fade stack — three layered semi-transparent views approximate
          a smooth vertical gradient WITHOUT adding an expo-linear-gradient
          dependency. Each band gets darker toward the bottom so the title
          reads over any artwork. The prior implementation put a SOLID
          `colors.background` band over the last 13% of the header — which
          sat DIRECTLY on top of the H1 and clipped its bottom. Now the
          densest band is only ~92% opaque so title glyphs stay visible. */}
      <View pointerEvents="none" style={[styles.fadeBand, { top: "38%", height: "22%", backgroundColor: "rgba(7,11,18,0.28)" }]} />
      <View pointerEvents="none" style={[styles.fadeBand, { top: "60%", height: "22%", backgroundColor: "rgba(7,11,18,0.55)" }]} />
      <View pointerEvents="none" style={[styles.fadeBand, { top: "82%", height: "18%", backgroundColor: "rgba(7,11,18,0.82)" }]} />

      {/* Global rail — logo · contextual · search · bell. FIXED positions. */}
      <View style={[styles.rail, { paddingTop: insets.top + header.TOP_SAFE_OFFSET }]}>
        <Pressable
          onPress={() => {
            trackEvent("logo_tapped", { destination: "discover" });
            router.push("/(tabs)");
          }}
          hitSlop={8}
        >
          <SSLogo variant="white" size="lg" />
        </Pressable>
        <View style={styles.rightActions}>
          {contextualAction}
          <Pressable
            onPress={() => {
              trackEvent("search_opened", { entry_point: "seensnap_header" });
              router.push("/(tabs)/search");
            }}
            hitSlop={10}
            style={styles.actionBtn}
          >
            <Ionicons name="search" size={18} color={colors.ink} />
          </Pressable>
          <Pressable
            onPress={() => router.push("/notifications")}
            hitSlop={10}
            style={styles.actionBtn}
          >
            <Ionicons name="notifications-outline" size={18} color={colors.ink} />
            {unreadCount > 0 ? (
              <View style={styles.notifBadge}>
                <Text style={styles.notifBadgeText}>
                  {unreadCount > 9 ? "9+" : String(unreadCount)}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>

      {/* Content block — bottom-anchored, animated together on scroll. */}
      <Animated.View
        style={[
          styles.contentBlock,
          { opacity: contentOpacity, transform: [{ translateY: contentTranslateY }] },
        ]}
      >
        <Text style={[styles.title, h1Style(title)]} numberOfLines={2}>
          {title}
        </Text>
        {subtitleText ? (
          <Text
            style={[
              styles.subtitle,
              subtitleStyle === "utility" ? styles.subtitleUtility : styles.subtitleEditorial,
            ]}
            numberOfLines={2}
          >
            {subtitleText}
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
  brandFallback: { backgroundColor: colors.velvet },
  brandAccentA: {
    position: "absolute",
    width: 260,
    height: 260,
    borderRadius: 260,
    backgroundColor: "rgba(244,196,48,0.08)",
  },
  brandAccentB: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 320,
    backgroundColor: "rgba(244,196,48,0.05)",
  },
  overlay: { backgroundColor: header.OVERLAY },
  fadeBand: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  rail: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: header.HORIZONTAL_PADDING,
    height: header.RAIL_HEIGHT,
  },
  rightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: header.ACTION_GAP,
  },
  actionBtn: {
    width: header.ACTION_SIZE,
    height: header.ACTION_SIZE,
    borderRadius: header.ACTION_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: rules.default,
  },
  notifBadge: {
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
  notifBadgeText: {
    color: colors.paperInk,
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 0.2,
  },
  contentBlock: {
    position: "absolute",
    bottom: header.BOTTOM_PADDING,
    left: header.HORIZONTAL_PADDING,
    right: header.HORIZONTAL_PADDING,
  },
  title: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: header.H1_SIZE,
    lineHeight: header.H1_LINE_HEIGHT,
    letterSpacing: header.H1_LETTER_SPACING,
    ...Platform.select({
      ios: {
        textShadowColor: "rgba(2,4,8,0.55)",
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 8,
      },
      android: {},
    }),
  },
  subtitle: {
    marginTop: header.SUBTITLE_GAP,
    fontSize: header.SUBTITLE_SIZE,
    lineHeight: header.SUBTITLE_LINE_HEIGHT,
    color: "rgba(243,239,229,0.82)",
  },
  subtitleEditorial: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    letterSpacing: 0.1,
  },
  subtitleUtility: {
    fontFamily: fonts.mono,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontSize: 11,
  },
});
