/**
 * Oct-18 UI/UX rebuild: My Picks.
 *
 * Five categories, full-screen hero + 4 continuation posters per
 * section, bottom pill nav. Each category pages vertically through
 * the user's full collection in groups of 5 (one hero + four).
 *
 * Spec image 6. Data source: GET /me/picks/collections (one round
 * trip returns all five categories).
 */
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { FullBleedPosterSection, type FullBleedTitle, type VerticalRailAction } from "@/components/full-bleed-poster-section";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  fetchPicksCollections,
  type PickList,
  type PickTitle,
  type PicksCollections,
} from "@/lib/picks";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";
import { trackEvent } from "@/lib/analytics";


type CategoryKey = "ranked_favorites" | "my_next_watch" | "favorites" | "watched" | "my_lists";

const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "ranked_favorites", label: "Ranked Favorites" },
  { key: "my_next_watch", label: "My Next Watch" },
  { key: "favorites", label: "Favorites" },
  { key: "watched", label: "Watched" },
  { key: "my_lists", label: "My Lists" },
];


function pickToFullBleed(t: PickTitle): FullBleedTitle {
  return {
    id: t.id,
    title: t.title,
    poster_url: t.poster_url,
    backdrop_url: t.backdrop_url,
    year: t.year,
    rank_label: t.rank_label,
    context_label: t.context_label,
    rating: t.personal_score,
  };
}


// Group a flat list into sections of 5 (one hero + four continuation).
function groupBySections(items: PickTitle[]): { hero: PickTitle; four: PickTitle[] }[] {
  const sections: { hero: PickTitle; four: PickTitle[] }[] = [];
  for (let i = 0; i < items.length; i += 5) {
    const slice = items.slice(i, i + 5);
    if (slice.length === 0) break;
    sections.push({ hero: slice[0], four: slice.slice(1, 5) });
  }
  return sections;
}


export default function MyPicksScreen() {
  const { sessionToken } = useAuth();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const [data, setData] = useState<PicksCollections | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("ranked_favorites");

  const [titleModalId, setTitleModalId] = useState<string | null>(null);
  const [universalTitle, setUniversalTitle] = useState<UniversalTitle | null>(null);
  const [titleLoading, setTitleLoading] = useState(false);

  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!sessionToken) return;
      setLoading(true);
      fetchPicksCollections(sessionToken)
        .then((res) => { if (!cancelled) setData(res); })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, [sessionToken]),
  );

  const reservedBottomNav = 56 + insets.bottom + 48; // tab bar + pill nav
  const sectionHeight = height - insets.top - reservedBottomNav;

  const items: PickTitle[] = useMemo(() => {
    if (!data) return [];
    if (activeCategory === "my_lists") {
      // Each list becomes a "section" with its own hero (first title) + up to 4 more.
      return data.my_lists.flatMap((list) => list.titles);
    }
    return (data[activeCategory] as PickTitle[]) ?? [];
  }, [data, activeCategory]);

  const sections = useMemo(() => {
    if (activeCategory !== "my_lists") return groupBySections(items);
    // For my_lists, group one section PER list rather than slicing by 5.
    if (!data) return [];
    return data.my_lists
      .filter((l) => l.titles.length > 0)
      .map((l) => ({
        hero: { ...l.titles[0], context_label: l.name.toUpperCase() },
        four: l.titles.slice(1, 5),
        listMeta: l,
      }));
  }, [data, activeCategory, items]);

  async function openTitle(titleId: string) {
    if (!sessionToken) return;
    setTitleModalId(titleId);
    setTitleLoading(true);
    try {
      const detail = await fetchUniversalTitle(sessionToken, titleId);
      setUniversalTitle(detail);
    } catch {
      setUniversalTitle(null);
    } finally {
      setTitleLoading(false);
    }
  }

  function closeTitle() {
    setTitleModalId(null);
    setUniversalTitle(null);
  }

  function buildRail(title: PickTitle): VerticalRailAction[] {
    // Social actions only make sense on Ranked Favorites (others see
    // your rank), per spec "Social actions (others viewing)".
    // On personal categories we show the viewer's own actions only.
    const isSocialSurface = activeCategory === "ranked_favorites";
    const base: VerticalRailAction[] = [];
    if (isSocialSurface) {
      base.push(
        { key: "like", icon: "heart-outline", label: "Like", count: null },
        { key: "comment", icon: "chatbubble-outline", label: "Comment", count: null },
      );
    }
    base.push(
      {
        key: "save",
        icon: "bookmark-outline",
        label: "Save",
        onPress: () => {
          setSaveTitleId(title.id);
          setShowSaveSheet(true);
          trackEvent("my_picks_save", { title_id: title.id, category: activeCategory });
        },
      },
      {
        key: "send",
        icon: "paper-plane-outline",
        label: "Send",
        onPress: () => {
          trackEvent("my_picks_send", { title_id: title.id, category: activeCategory });
          void Share.share({ message: `${title.title} — on SeenSnap` }).catch(() => {});
        },
      },
      {
        key: "team",
        icon: "people-outline",
        label: "Add to a team",
        onPress: () => {
          trackEvent("my_picks_team", { title_id: title.id, category: activeCategory });
          void openTitle(title.id);
        },
      },
      {
        key: "rate",
        icon: title.personal_score != null ? "star" : "star-outline",
        label: title.personal_score != null ? `Your rating ${title.personal_score}` : "Rate",
        count: title.personal_score ?? null,
        active: title.personal_score != null,
        onPress: () => {
          trackEvent("my_picks_rate", { title_id: title.id, category: activeCategory });
          void openTitle(title.id);
        },
      },
    );
    return base;
  }

  const activeCategoryLabel = CATEGORIES.find((c) => c.key === activeCategory)?.label ?? "";

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={[styles.header, { paddingTop: 8 }]}>
        <Ionicons name="camera-outline" size={18} color={colors.accent} />
        <Text style={styles.headerTitle}>My Picks</Text>
      </View>
      <View style={styles.sectionKicker}>
        <Text style={styles.sectionKickerLabel}>{activeCategoryLabel.toUpperCase()}</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.accent} style={{ marginLeft: 4 }} />
      </View>

      {loading && !data ? (
        <View style={[styles.center, { height: sectionHeight }]}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : sections.length === 0 ? (
        <View style={[styles.center, { height: sectionHeight }]}>
          <Ionicons name="bookmark-outline" size={28} color={colors.muted} />
          <Text style={styles.emptyTitle}>Nothing here yet.</Text>
          <Text style={styles.emptyBody}>
            {activeCategory === "ranked_favorites"
              ? "Rank your Top 20 to see them here."
              : activeCategory === "my_next_watch"
              ? "Save a title to your Next Watch list."
              : activeCategory === "favorites"
              ? "Rate titles 8 or higher and they'll land here."
              : activeCategory === "watched"
              ? "Mark titles watched and they'll appear here."
              : "Create a list and add titles."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(section, i) => `${activeCategory}-${section.hero.id}-${i}`}
          snapToInterval={sectionHeight}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <View style={{ height: sectionHeight }}>
              <FullBleedPosterSection
                heroHeight={sectionHeight}
                hero={pickToFullBleed(item.hero)}
                four={item.four.map(pickToFullBleed)}
                onPressHero={() => void openTitle(item.hero.id)}
                onPressContinuation={(t) => void openTitle(t.id)}
                railActions={buildRail(item.hero)}
              />
            </View>
          )}
        />
      )}

      <View style={[styles.pillNav, { bottom: insets.bottom + 56 }]}>
        {CATEGORIES.map((cat, idx) => {
          const active = cat.key === activeCategory;
          return (
            <Pressable
              key={cat.key}
              onPress={() => {
                setActiveCategory(cat.key);
                trackEvent("my_picks_category_changed", { category: cat.key });
              }}
              hitSlop={6}
              style={styles.pillBtn}
            >
              <View style={[styles.pillDot, active && styles.pillDotActive]} />
              <Text style={[styles.pillLabel, active && styles.pillLabelActive]} numberOfLines={1}>
                {cat.label}
              </Text>
              {idx < CATEGORIES.length - 1 ? (
                <Ionicons name="chevron-forward" size={11} color={colors.muted2} style={{ marginHorizontal: 2 }} />
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <UniversalTitleModal
        visible={titleModalId !== null}
        title={universalTitle}
        loading={titleLoading}
        onClose={closeTitle}
      />

      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="my_picks"
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onSaved={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
      />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingBottom: 4,
    backgroundColor: "#000",
    zIndex: 10,
  },
  headerTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 15,
  },
  sectionKicker: {
    position: "absolute",
    top: 48,
    left: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 10,
  },
  sectionKickerLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    gap: 8,
  },
  emptyTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 18,
    marginTop: 8,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    textAlign: "center",
    maxWidth: 280,
  },
  pillNav: {
    position: "absolute",
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
  },
  pillBtn: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
  },
  pillDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.3)",
    marginRight: 5,
  },
  pillDotActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pillLabel: {
    fontFamily: fonts.sansMedium,
    color: colors.muted,
    fontSize: 10,
    letterSpacing: 0.3,
    flexShrink: 1,
  },
  pillLabelActive: {
    color: colors.ink,
  },
});
