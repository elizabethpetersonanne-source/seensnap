/**
 * Oct-18 UI/UX rebuild: FullBleedPosterSection.
 *
 * Spec reference: Teams team-home, My Picks category pages, Profile
 * Ranked Favorites screen. Edge-to-edge hero poster with a bottom-up
 * cinematic gradient, a right-side vertical action rail, and (optional)
 * a 4-poster continuation strip pinned to the bottom.
 *
 * This primitive is deliberately "data in, taps out" — the owning
 * screen hands it a hero + four + handlers, and gets back tap events.
 * No fetching, no modal state. Keeps it reusable across Teams, My
 * Picks, Profile Ranked Favorites, and anywhere else we need the
 * same cinematic treatment.
 */
import { Ionicons } from "@expo/vector-icons";
import { useMemo } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";


export type FullBleedTitle = {
  id: string;
  title: string;
  poster_url?: string | null;
  backdrop_url?: string | null;
  year?: number | null;
  rank_label?: string | null;    // "#1" overlay for ranked lists
  context_label?: string | null; // e.g. "Sofia added this · 2d ago"
  rating?: number | null;        // 1-10 personal; shown on star when set
  // Pre-rendered title treatment (e.g. "DUNE PART TWO" with custom
  // kerning). When absent the section renders the plain title.
  stylized_title?: string | null;
};


export type VerticalRailAction = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  count?: number | null;
  active?: boolean;
  onPress?: () => void;
};


export function FullBleedPosterSection({
  hero,
  four,
  heroHeight,
  sectionKicker,
  onPressHero,
  onPressContinuation,
  railActions,
  // Overlay slot renders in the lower-left over the gradient — used by
  // callers that need a hand-crafted treatment (e.g. Social post with
  // actor avatar + big rating).
  overlay,
}: {
  hero: FullBleedTitle | null;
  four: FullBleedTitle[];
  heroHeight?: number;
  sectionKicker?: string | null;
  onPressHero: () => void;
  onPressContinuation?: (title: FullBleedTitle, index: number) => void;
  railActions: VerticalRailAction[];
  overlay?: React.ReactNode;
}) {
  const { width, height } = useWindowDimensions();
  const resolvedHeroHeight = heroHeight ?? Math.min(height * 0.78, 820);

  // Full continuation list: the strip no longer caps at 4 — the brief
  // §5 says "Horizontal movement continues the smaller-poster sequence,"
  // so the strip scrolls horizontally when there are more than 4.
  const smallList = useMemo(
    () => (hero ? four.filter((t) => t.id !== hero.id) : four),
    [hero, four],
  );
  const smallWidth = (width - spacing.lg * 2 - 24) / 4;
  const smallHeight = smallWidth * (3 / 2);
  const scrolls = smallList.length > 4;

  const posterSource = hero?.backdrop_url || hero?.poster_url;

  return (
    <View style={[styles.wrap, { height: resolvedHeroHeight }]}>
      <Pressable onPress={onPressHero} style={StyleSheet.absoluteFill}>
        {posterSource ? (
          <Image
            source={{ uri: posterSource }}
            style={StyleSheet.absoluteFillObject}
            resizeMode="cover"
          />
        ) : (
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.surfaceMuted }]} />
        )}
        {/* Bottom-up cinematic gradient. React Native doesn't ship with
            a gradient primitive, so we stack three progressive dark
            overlays — gets us the editorial feel without a native dep. */}
        <View style={[styles.shadeBottom, { height: resolvedHeroHeight * 0.6 }]} />
        <View style={[styles.shadeTop, { height: resolvedHeroHeight * 0.25 }]} />
      </Pressable>

      {sectionKicker ? (
        <View style={styles.kickerRow}>
          <Text style={styles.kicker}>{sectionKicker}</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.accent} style={{ marginLeft: 4 }} />
        </View>
      ) : null}

      {/* Overlay slot or default title treatment */}
      <View style={styles.heroBody} pointerEvents="box-none">
        {overlay ? (
          overlay
        ) : hero ? (
          <>
            {hero.context_label ? (
              <Text style={styles.contextLabel} numberOfLines={1}>{hero.context_label}</Text>
            ) : null}
            <Text style={styles.heroTitle} numberOfLines={2}>
              {hero.stylized_title ?? hero.title}
            </Text>
            {hero.year ? <Text style={styles.heroYear}>{hero.year}</Text> : null}
          </>
        ) : null}
      </View>

      {/* Big rank overlay (top-left) when the hero is ranked. Keeps the
          #1 badge dominant without competing with the title. */}
      {hero?.rank_label ? (
        <View style={styles.rankOverlay} pointerEvents="none">
          <Text style={styles.rankOverlayText}>{hero.rank_label}</Text>
        </View>
      ) : null}

      {/* Vertical action rail — right side, outline icons, no backplates. */}
      {railActions.length > 0 ? (
        <View style={styles.railWrap} pointerEvents="box-none">
          {railActions.map((action) => (
            <Pressable
              key={action.key}
              onPress={action.onPress}
              hitSlop={10}
              accessibilityLabel={action.label}
              style={styles.railBtn}
            >
              <Ionicons
                name={action.icon}
                size={26}
                color={action.active ? colors.accent : colors.ink}
              />
              {action.count != null ? (
                <Text style={[styles.railCount, action.active && styles.railCountActive]}>
                  {formatCount(action.count)}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Continuation strip pinned to the bottom. Horizontally
          scrollable when more than 4 — brief §5 "Horizontal movement
          continues the smaller-poster sequence." */}
      {smallList.length > 0 ? (
        scrolls ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.continuationScroll, { bottom: spacing.sm }]}
            contentContainerStyle={styles.continuationScrollContent}
          >
            {smallList.map((t, idx) => (
              <Pressable
                key={t.id}
                onPress={() => onPressContinuation?.(t, idx)}
                style={[styles.continuationCard, { width: smallWidth }]}
              >
                {t.rank_label ? (
                  <Text style={styles.continuationRankAbove} numberOfLines={1}>
                    {t.rank_label.replace(/^#/, "")}
                  </Text>
                ) : null}
                <View style={{ width: smallWidth, height: smallHeight }}>
                  {t.poster_url ? (
                    <Image source={{ uri: t.poster_url }} style={styles.continuationPoster} resizeMode="cover" />
                  ) : (
                    <View style={[styles.continuationPoster, styles.continuationFallback]}>
                      <Ionicons name="film-outline" size={16} color={colors.muted2} />
                    </View>
                  )}
                </View>
                <Text style={styles.continuationCaption} numberOfLines={1}>{t.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <View style={[styles.continuationRow, { bottom: spacing.sm }]}>
            {smallList.map((t, idx) => (
              <Pressable
                key={t.id}
                onPress={() => onPressContinuation?.(t, idx)}
                style={[styles.continuationCard, { width: smallWidth }]}
              >
                {t.rank_label ? (
                  <Text style={styles.continuationRankAbove} numberOfLines={1}>
                    {t.rank_label.replace(/^#/, "")}
                  </Text>
                ) : null}
                <View style={{ width: smallWidth, height: smallHeight }}>
                  {t.poster_url ? (
                    <Image source={{ uri: t.poster_url }} style={styles.continuationPoster} resizeMode="cover" />
                  ) : (
                    <View style={[styles.continuationPoster, styles.continuationFallback]}>
                      <Ionicons name="film-outline" size={16} color={colors.muted2} />
                    </View>
                  )}
                </View>
                <Text style={styles.continuationCaption} numberOfLines={1}>{t.title}</Text>
              </Pressable>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}


function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}


const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    backgroundColor: "#000",
    overflow: "hidden",
    position: "relative",
  },
  shadeBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(7,11,18,0.72)",
  },
  shadeTop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: "rgba(7,11,18,0.42)",
  },
  kickerRow: {
    position: "absolute",
    top: spacing.md,
    left: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 2,
  },
  kicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  heroBody: {
    position: "absolute",
    left: spacing.lg,
    right: 92,
    bottom: 170,
    zIndex: 2,
  },
  heroTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.3,
  },
  heroYear: {
    marginTop: 6,
    fontFamily: fonts.monoMedium,
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.8,
  },
  contextLabel: {
    marginBottom: 8,
    fontFamily: fonts.monoSemiBold,
    color: colors.ink,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    opacity: 0.9,
  },
  rankOverlay: {
    position: "absolute",
    left: spacing.lg,
    top: "22%",
    zIndex: 1,
  },
  rankOverlayText: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 180,
    lineHeight: 180,
    letterSpacing: -4,
    opacity: 0.92,
  },
  railWrap: {
    position: "absolute",
    right: spacing.md,
    top: "32%",
    gap: spacing.md,
    zIndex: 3,
  },
  railBtn: {
    alignItems: "center",
    paddingVertical: 4,
    minWidth: 44,
  },
  railCount: {
    marginTop: 2,
    fontFamily: fonts.monoMedium,
    color: colors.ink,
    fontSize: 11,
  },
  railCountActive: {
    color: colors.accent,
  },
  continuationRow: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: "row",
    justifyContent: "space-between",
    zIndex: 2,
  },
  continuationScroll: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 2,
  },
  continuationScrollContent: {
    paddingHorizontal: spacing.lg,
    gap: 8,
    flexDirection: "row",
  },
  continuationCard: {
    position: "relative",
    alignItems: "center",
  },
  continuationRankAbove: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 15,
    letterSpacing: -0.2,
    marginBottom: 2,
  },
  continuationPoster: {
    width: "100%",
    height: "100%",
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  continuationFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  continuationRankBadge: {
    position: "absolute",
    top: -2,
    left: -2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: radii.sm,
  },
  continuationRankText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 12,
    letterSpacing: 0.5,
  },
  continuationCaption: {
    marginTop: 4,
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    textAlign: "center",
  },
});
