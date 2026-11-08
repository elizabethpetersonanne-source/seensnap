import { useState } from "react";
import { SceneDnaBadge } from "@/components/scene-dna-badge";
/**
 * Oct-19 Discover simplified mock (mock A — Cinematic Concierge).
 *
 * One Discover section: optional eyebrow / title / subtitle / toggle,
 * a landscape hero backdrop with the title overlay, and a row of
 * four portrait posters with captions underneath. Used by FOR YOU,
 * TRENDING and NOW IN THEATERS.
 *
 * Different from FullBleedPosterSection which is for immersive
 * full-screen pages (Teams, My Picks). Discover is a scrollable
 * canvas, so sections stack inline.
 */
import { Ionicons } from "@expo/vector-icons";
import {
  Image,
  ScrollView,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";

export type DiscoverTitle = {
  id: string;
  title: string;
  poster_url: string | null;
  backdrop_url: string | null;
  year: number | null;
};

export function DiscoverSection({
  kicker,
  subtitle,
  rightSlot,
  locationLabel,
  hero,
  four,
  onPressTitle,
  onAction,
  onSeeAll,
}: {
  kicker: string;
  subtitle?: string | null;
  rightSlot?: React.ReactNode;
  locationLabel?: string | null;
  hero: DiscoverTitle | null;
  four: DiscoverTitle[];
  onPressTitle: (t: DiscoverTitle) => void;
  onAction?: (
    action: "save" | "send" | "team" | "rate",
    title: DiscoverTitle,
  ) => void;
  onSeeAll?: () => void;
}) {
  const { width } = useWindowDimensions();
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const [stripWidth, setStripWidth] = useState(width);
  const [browseOffset, setBrowseOffset] = useState(0);
  const candidates = [...(hero ? [hero] : []), ...four].filter(
    (item, i, all) => all.findIndex((x) => x.id === item.id) === i,
  );
  const featured = candidates.find((t) => t.id === featuredId) ?? hero;
  const remaining = candidates.filter((t) => t.id !== featured?.id);
  const sidePadding = spacing.lg;
  const gap = 8;
  const smallWidth = Math.min(140, Math.max(64, (stripWidth - gap * 3) / 4));
  const smallHeight = smallWidth * (3 / 2);
  const heroHeight = Math.min(220, (width - sidePadding * 2) * 0.56);

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>{kicker}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {locationLabel ? (
            <View style={styles.locationRow}>
              <Ionicons name="location-sharp" size={12} color={colors.muted} />
              <Text style={styles.locationLabel}>{locationLabel}</Text>
            </View>
          ) : null}
        </View>
        {rightSlot ?? null}
      </View>

      {featured ? (
        <Pressable
          onPress={() => onPressTitle(featured)}
          accessibilityRole="button"
          accessibilityLabel={`Open details for ${featured.title}`}
          style={({ pressed }) => [
            styles.hero,
            { height: heroHeight },
            pressed && { opacity: 0.9 },
          ]}
        >
          {featured.backdrop_url || featured.poster_url ? (
            <Image
              source={{
                uri: featured.backdrop_url || featured.poster_url || "",
              }}
              style={StyleSheet.absoluteFillObject}
              resizeMode="cover"
            />
          ) : null}
          <View style={styles.heroShade} />
          <View style={styles.heroCaption}>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {featured.title}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {featured ? <SceneDnaBadge titleId={featured.id} /> : null}
      {featured && onAction ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(
            [
              { action: "save", label: "Save", icon: "bookmark-outline" },
              { action: "send", label: "Send", icon: "paper-plane-outline" },
              { action: "team", label: "Watch Team", icon: "people-outline" },
              { action: "rate", label: "Rate", icon: "star-outline" },
            ] as const
          ).map((button) => (
            <Pressable
              key={button.action}
              accessibilityRole="button"
              accessibilityLabel={`${button.label}: ${featured.title}`}
              onPress={() => onAction(button.action, featured)}
              style={{
                minWidth: 64,
                minHeight: 44,
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <Ionicons name={button.icon} size={18} color={colors.ink} />
              <Text
                style={{ color: colors.ink, fontSize: 12, textAlign: "center" }}
              >
                {button.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {remaining.length > 0 ? (
        <View onLayout={(e) => setStripWidth(e.nativeEvent.layout.width)}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            onScroll={(e) =>
              setBrowseOffset(
                Math.floor(e.nativeEvent.contentOffset.x / (smallWidth + gap)),
              )
            }
            scrollEventThrottle={100}
            contentContainerStyle={[styles.fourRow, { gap }]}
          >
            {remaining.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setFeaturedId(t.id)}
                accessibilityRole="button"
                accessibilityLabel={`Feature ${t.title}`}
                style={({ pressed }) => [
                  styles.smallCard,
                  { width: smallWidth },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <View style={{ width: smallWidth, height: smallHeight }}>
                  {t.poster_url ? (
                    <Image
                      source={{ uri: t.poster_url }}
                      style={styles.smallPoster}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={[styles.smallPoster, styles.smallFallback]}>
                      <Ionicons
                        name="film-outline"
                        size={16}
                        color={colors.muted2}
                      />
                    </View>
                  )}
                </View>
                <Text style={styles.smallCaption} numberOfLines={2}>
                  {t.title}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          {remaining.length > 4 ? (
            <Text style={styles.locationLabel}>
              {Math.min(browseOffset + 1, remaining.length)}–
              {Math.min(browseOffset + 4, remaining.length)} of{" "}
              {remaining.length} · Swipe to browse
            </Text>
          ) : null}
        </View>
      ) : null}

      {onSeeAll ? (
        <Pressable
          onPress={onSeeAll}
          hitSlop={6}
          style={[styles.seeAllRow, { minHeight: 44 }]}
        >
          <Text style={styles.seeAllLabel}>See all</Text>
          <Ionicons name="arrow-forward" size={13} color={colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function MediaToggle({
  value,
  onChange,
}: {
  value: "movie" | "tv";
  onChange: (next: "movie" | "tv") => void;
}) {
  return (
    <View style={styles.toggle}>
      {(["movie", "tv"] as const).map((opt) => {
        const active = value === opt;
        return (
          <Pressable
            key={opt}
            onPress={() => onChange(opt)}
            style={[styles.toggleOpt, active && styles.toggleOptActive]}
          >
            <Text
              style={[styles.toggleLabel, active && styles.toggleLabelActive]}
            >
              {opt === "movie" ? "Movies" : "TV"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 20,
    letterSpacing: 0.6,
  },
  subtitle: {
    marginTop: 2,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
  },
  locationRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  locationLabel: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
  },
  hero: {
    width: "100%",
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.surfaceMuted,
    position: "relative",
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  heroCaption: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
  },
  heroTitle: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  fourRow: {
    flexDirection: "row",
  },
  smallCard: {
    gap: 6,
  },
  smallPoster: {
    width: "100%",
    height: "100%",
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  smallFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  smallCaption: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 10,
    letterSpacing: 0.4,
    textAlign: "center",
    textTransform: "uppercase",
  },
  seeAllRow: {
    marginTop: 4,
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  seeAllLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.accent,
    fontSize: 12,
  },

  toggle: {
    flexDirection: "row",
    borderRadius: 999,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
  },
  toggleOpt: {
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  toggleOptActive: {
    backgroundColor: colors.accent,
  },
  toggleLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.muted,
    fontSize: 12,
  },
  toggleLabelActive: {
    color: colors.background,
  },
});
