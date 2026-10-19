/**
 * Oct-18 build brief §4 shared primitive: HeroFourSection.
 *
 * One dominant hero + four smaller posters. Used in every applicable
 * discovery section (For You, every category, Concierge results,
 * My Picks shelves, Teams sections, Profile sections). Horizontal
 * continuation changes within the four-poster strip; vertical scroll
 * changes between sections. The four-poster row must NEVER repeat
 * the hero or show invented ordinal labels.
 *
 * Reusable to every surface — same geometry, same tap semantics.
 * Taps on the hero or on any smaller poster call onPressTitle with
 * the title; the Trailer control is a separate affordance that
 * routes to Preview with that exact title.
 */
import { Ionicons } from "@expo/vector-icons";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { colors, fonts, radii, rules, spacing } from "@/constants/theme";


export type HeroFourTitle = {
  id: string;
  title: string;
  poster_url?: string | null;
  backdrop_url?: string | null;
  year?: number | null;
  // Optional overlay badges — only used when evidence-backed per spec.
  // Never fabricated match-percentage values.
  rank_label?: string | null;      // e.g. "#2" from a ranked list
  context_label?: string | null;   // e.g. "NEW" | "↑ #3" from Social
};

export function HeroFourSection({
  sectionLabel,
  sectionTitle,
  hero,
  four,
  onPressTitle,
  onPressTrailer,
  onSeeAll,
  emptyMessage,
}: {
  sectionLabel?: string | null;      // short kicker e.g. "FOR YOU"
  sectionTitle?: string | null;      // section heading
  hero: HeroFourTitle | null;
  four: HeroFourTitle[];
  onPressTitle: (title: HeroFourTitle, origin: "hero" | "four") => void;
  // Explicit Trailer control — brief §2 resolution: tap on poster
  // opens title details/flip; the Trailer control routes to Preview.
  onPressTrailer?: (title: HeroFourTitle) => void;
  onSeeAll?: () => void;
  emptyMessage?: string | null;
}) {
  const { width } = useWindowDimensions();
  // Hero at ~86% viewport width, bounded by a reasonable upper width
  // on tablet/desktop. The four continuation posters flow in a
  // horizontally paging strip at a comfortable grid share.
  const heroWidth = Math.min(width - spacing.xl * 2, 520);
  const heroHeight = heroWidth * (3 / 2);
  const smallWidth = (heroWidth - 24) / 4;
  const smallHeight = smallWidth * (3 / 2);

  // Deduplicate the four against the hero so the row never repeats
  // the dominant title (brief §4 explicit rule).
  const smallList = four.filter((t) => (hero ? t.id !== hero.id : true)).slice(0, 4);

  return (
    <View style={styles.section}>
      {(sectionLabel || sectionTitle || onSeeAll) ? (
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            {sectionLabel ? <Text style={styles.kicker}>{sectionLabel}</Text> : null}
            {sectionTitle ? <Text style={styles.title}>{sectionTitle}</Text> : null}
          </View>
          {onSeeAll ? (
            <Pressable onPress={onSeeAll} hitSlop={10} accessibilityRole="button">
              <Text style={styles.seeAll}>See all</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {hero ? (
        <Pressable
          style={[styles.hero, { width: heroWidth, height: heroHeight }]}
          onPress={() => onPressTitle(hero, "hero")}
          accessibilityRole="button"
          accessibilityLabel={`Open ${hero.title}`}
        >
          {hero.poster_url ? (
            <Image source={{ uri: hero.poster_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
          ) : (
            <View style={styles.heroFallback}>
              <Ionicons name="film-outline" size={32} color={colors.muted} />
            </View>
          )}
          <View style={styles.heroShade} />
          {hero.context_label || hero.rank_label ? (
            <View style={styles.heroBadgeRow}>
              {hero.rank_label ? <Text style={styles.rankBadge}>{hero.rank_label}</Text> : null}
              {hero.context_label ? <Text style={styles.contextBadge}>{hero.context_label}</Text> : null}
            </View>
          ) : null}
          <View style={styles.heroMeta}>
            <Text style={styles.heroTitle} numberOfLines={2}>{hero.title}</Text>
            {hero.year ? <Text style={styles.heroYear}>{hero.year}</Text> : null}
          </View>
          {onPressTrailer ? (
            <Pressable
              style={styles.trailerPill}
              onPress={() => onPressTrailer(hero)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Play trailer for ${hero.title}`}
            >
              <Ionicons name="play" size={14} color={colors.background} />
              <Text style={styles.trailerPillText}>Trailer</Text>
            </Pressable>
          ) : null}
        </Pressable>
      ) : emptyMessage ? (
        <View style={[styles.heroEmpty, { width: heroWidth, height: heroHeight }]}>
          <Text style={styles.emptyText}>{emptyMessage}</Text>
        </View>
      ) : null}

      {smallList.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.smallScroll}
          contentContainerStyle={{ gap: 6, paddingRight: spacing.xl }}
        >
          {smallList.map((t) => (
            <Pressable
              key={t.id}
              style={[styles.smallCard, { width: smallWidth, height: smallHeight }]}
              onPress={() => onPressTitle(t, "four")}
              accessibilityRole="button"
              accessibilityLabel={`Open ${t.title}`}
            >
              {t.poster_url ? (
                <Image source={{ uri: t.poster_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
              ) : (
                <View style={styles.smallFallback}>
                  <Ionicons name="film-outline" size={16} color={colors.muted} />
                </View>
              )}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}


const styles = StyleSheet.create({
  section: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
  },
  kicker: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.4,
    color: colors.accent,
    textTransform: "uppercase",
  },
  title: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    color: colors.ink,
    marginTop: 2,
  },
  seeAll: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.6,
    color: colors.muted,
    textTransform: "uppercase",
  },
  hero: {
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.surface,
    alignSelf: "center",
  },
  heroEmpty: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    justifyContent: "center",
    alignItems: "center",
    alignSelf: "center",
  },
  heroFallback: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.14)",
  },
  heroBadgeRow: {
    position: "absolute",
    top: 10,
    left: 10,
    flexDirection: "row",
    gap: 6,
  },
  rankBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: colors.accent,
    color: colors.background,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.4,
    overflow: "hidden",
  },
  contextBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.55)",
    color: colors.ink,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.4,
    overflow: "hidden",
  },
  heroMeta: {
    position: "absolute",
    bottom: 10,
    left: 12,
    right: 12,
  },
  heroTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    color: colors.ink,
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  heroYear: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.ink,
    marginTop: 2,
    opacity: 0.9,
  },
  trailerPill: {
    position: "absolute",
    bottom: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  trailerPillText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.6,
    color: colors.background,
    textTransform: "uppercase",
  },
  smallScroll: {
    marginTop: 2,
  },
  smallCard: {
    borderRadius: radii.sm,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  smallFallback: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted,
    textAlign: "center",
    paddingHorizontal: spacing.md,
  },
});
