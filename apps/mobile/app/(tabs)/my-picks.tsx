/**
 * Oct-18 UI/UX rebuild: My Picks.
 *
 * Five categories, full-screen hero + 4 continuation posters per
 * section. Browse sections vertically and titles horizontally. Selection
 * never changes the underlying personal ranking.
 *
 * Spec image 6. Data source: GET /me/picks/collections (one round
 * trip returns all five categories).
 */
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { SafeAreaView } from "react-native-safe-area-context";

import { AddToTeamSheet } from "@/components/add-to-team-sheet";
import { apiRequest } from "@/lib/api";
import { AppHeader } from "@/components/headers/app-header";
import { FullBleedPosterSection, type FullBleedTitle, type VerticalRailAction } from "@/components/full-bleed-poster-section";
import { RatingEditor, type RatingSnapshot, subscribeRatingChanges } from "@/components/rating-editor";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { subscribeTitleState } from "@/lib/title-state";
import { EmptyView, LoadingView } from "@/components/state-views";
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
import { shareTitle } from "@/lib/share";
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


export default function MyPicksScreen() {
  const { sessionToken } = useAuth();
  const { height } = useWindowDimensions();

  const [teamTarget, setTeamTarget] = useState<PickTitle | null>(null);
  const [pageErrors, setPageErrors] = useState<Record<string, string>>({});
  const pageBusy = useRef(new Set<string>());
  const [headerHeights, setHeaderHeights] = useState<Record<string, number>>({});
  const [featured, setFeatured] = useState<Record<string, string>>({});
  const [sectionHeight, setSectionHeight] = useState(Math.max(320, height - 160));
  const dataRef = useRef<PicksCollections | null>(null);
  const requestGeneration = useRef(0);
  const [loadError, setLoadError] = useState(false);
  const [data, setData] = useState<PicksCollections | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => {
    requestGeneration.current += 1;
    dataRef.current = null;
    setData(null); setFeatured({}); setLoading(true); setLoadError(false);
    setPageErrors({}); pageBusy.current.clear();
  }, [sessionToken]);

  const [titleModalId, setTitleModalId] = useState<string | null>(null);
  const [universalTitle, setUniversalTitle] = useState<UniversalTitle | null>(null);
  const [titleLoading, setTitleLoading] = useState(false);

  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  // A41–A45: inline rating editor opens straight from the My Picks
  // hero without routing through the full title modal.
  const [rateTarget, setRateTarget] = useState<{ titleId: string; titleName: string; snapshot: RatingSnapshot | null } | null>(null);

  const refetch = useCallback(() => {
    if (!sessionToken) return () => {};
    const generation = ++requestGeneration.current;
    let cancelled = false;
    setLoadError(false);
    fetchPicksCollections(sessionToken, dataRef.current)
      .then((res) => { if (!cancelled && generation === requestGeneration.current) setData(res); })
      .catch(() => { if (!cancelled && generation === requestGeneration.current) setLoadError(true); })
      .finally(() => { if (!cancelled && generation === requestGeneration.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionToken]);
  useFocusEffect(refetch);

  // A46–A47: subscribe to the shared title-state pub/sub so a save
  // or watched flip triggered from another surface (feed card,
  // concierge result, title modal) refreshes My Picks without
  // waiting for a tab-away/tab-back cycle. Debounced via a timer
  // ref so a burst of changes collapses into one refetch.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const scheduleRefetch = () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => { refetch(); }, 300);
    };
    const unsubState = subscribeTitleState(() => scheduleRefetch());
    const unsubRating = subscribeRatingChanges(() => scheduleRefetch());
    return () => {
      unsubState();
      unsubRating();
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [refetch]);

  type Section = {
    key: string;
    category: CategoryKey;
    label: string;
    titles: PickTitle[];
    total: number;
    listMeta?: PickList;
  };
  const sections = useMemo<Section[]>(() => {
    if (!data) return [];
    const main = CATEGORIES.filter(c => c.key !== "my_lists").map(c => {
      const key = c.key as Exclude<CategoryKey, "my_lists">;
      return { key, category: c.key, label: c.label, titles: data[key], total: data[`${key}_count`] ?? data[key].length };
    });
    const lists = [...data.my_lists].sort((a, b) => Number(!!a.is_previous_collection) - Number(!!b.is_previous_collection));
    return [...main, { key: "my_lists", category: "my_lists" as const, label: "My Lists", titles: [], total: lists.length }, ...lists.map(list => ({
      key: `list-${list.id}`, category: "my_lists" as const,
      label: list.is_previous_collection ? `Previous collections · ${list.name}` : list.name,
      titles: list.titles, total: list.total_count ?? list.titles.length, listMeta: list,
    }))];
  }, [data]);

  async function loadMoreTitles(section: Section) {
    const { key, titles, total, listMeta } = section;
    if (!sessionToken || !data || key === "my_lists" || pageBusy.current.has(key) || titles.length >= total) return;
    pageBusy.current.add(key);
    setPageErrors(prior => ({ ...prior, [key]: "" }));
    const generation = requestGeneration.current;
    try {
      const path = listMeta ? `/me/picks/lists/${listMeta.id}/titles` : `/me/picks/collections/${key}`;
      const page = await apiRequest<{ items: PickTitle[]; total: number }>(`${path}?limit=100&offset=${titles.length}`, { token: sessionToken });
      if (generation !== requestGeneration.current) return;
      setData(prior => {
        if (!prior) return prior;
        const merge = (old: PickTitle[]) => [...new Map([...old, ...page.items].map(t => [t.id, t])).values()];
        if (listMeta) return { ...prior, my_lists: prior.my_lists.map(list => list.id === listMeta.id ? { ...list, titles: merge(list.titles), total_count: page.total } : list) };
        const category = section.category as Exclude<CategoryKey, "my_lists">;
        return { ...prior, [category]: merge(prior[category]), [category + "_count"]: page.total };
      });
    } catch { setPageErrors(prior => ({ ...prior, [key]: "Could not load more titles. Tap to retry." })); }
    finally { pageBusy.current.delete(key); }
  }

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

  function buildRail(title: PickTitle, activeCategory: CategoryKey): VerticalRailAction[] {
    const base: VerticalRailAction[] = [];
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
          void (async () => {
            if (!sessionToken) return;
            try {
              const detail = title.tmdb_id ? { tmdbId: title.tmdb_id, mediaType: title.media_type === "movie" ? "movie" as const : "tv" as const } : await fetchUniversalTitle(sessionToken, title.id);
              await shareTitle({ titleId: title.id, displayTitle: title.title, tmdbId: detail.tmdbId, mediaType: detail.mediaType, entryPoint: "my_picks" });
            } catch { Alert.alert("Couldn’t share this title", "Please try again."); }
          })();
        },
      },
      {
        key: "team",
        icon: "people-outline",
        label: "Add to a team",
        onPress: () => {
          trackEvent("my_picks_team", { title_id: title.id, category: activeCategory });
          setTeamTarget(title);
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
          // A41–A45: open the inline rating editor directly — a 7/10
          // commit should take one tap, not five taps through the
          // full title modal.
          setRateTarget({
            titleId: title.id,
            titleName: title.title,
            snapshot: title.personal_score != null
              ? {
                  title_id: title.id,
                  score: title.personal_score,
                  watched_state: "watched",
                  version: 0,
                  updated_at: null,
                }
              : null,
          });
        },
      },
    );
    return base;
  }

  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <AppHeader variant="primary" title="My Picks" />
      {loadError ? <Pressable accessibilityRole="button" onPress={refetch} style={{ padding: 12, minHeight: 44 }}><Text style={{ color: colors.accent }}>Couldn't refresh your picks. Tap to retry.</Text></Pressable> : null}
      <View style={{ flex: 1 }} onLayout={event => setSectionHeight(Math.max(280, event.nativeEvent.layout.height))}>
      {loading && !data ? <LoadingView height={sectionHeight} /> : (
        <FlatList
          data={sections}
          extraData={featured}
          keyExtractor={section => section.key}
          snapToInterval={sectionHeight}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            const hero = item.titles.find(t => t.id === featured[item.key]) ?? item.titles[0];
            const posterHeight = Math.max(220, sectionHeight - (headerHeights[item.key] ?? 52));
            return <View style={{ height: sectionHeight }}>
              <View onLayout={event => { const measured = event.nativeEvent.layout.height; setHeaderHeights(prior => prior[item.key] === measured ? prior : { ...prior, [item.key]: measured }); }} style={[styles.sectionKicker, { minHeight: 52, flexWrap: "wrap", gap: 8 }]}>
                <Pressable onPress={() => { if (item.listMeta) router.push(`/favorites/list/${item.listMeta.id}`); }} style={{ flex: 1, minWidth: 110, minHeight: 44, justifyContent: "center" }}>
                  <Text style={styles.sectionKickerLabel} numberOfLines={2}>{item.label}</Text>
                  {item.category === "ranked_favorites" && (data?.rated_unplaced_count ?? 0) > 0 ?
                    <Pressable accessibilityRole="button" accessibilityLabel="Add rated titles to your ranking" onPress={() => router.push("/favorites/unplaced")}>
                      <Text style={[styles.sectionKickerCount, { color: colors.accent }]}>{item.total} titles · {data?.rated_unplaced_count} rated titles to add</Text>
                    </Pressable> : <Text style={styles.sectionKickerCount}>{item.total} {item.key === "my_lists" ? "lists" : "titles"}</Text>}
                </Pressable>
                {item.category === "ranked_favorites" ? <Pressable accessibilityRole="button" accessibilityLabel="Edit ranking order" onPress={() => router.push("/favorites/ranked")} style={[styles.editOrderBtn, { minHeight: 44 }]}><Text style={styles.editOrderBtnLabel}>Edit order</Text></Pressable> : null}
                {item.key === "my_lists" ? <Pressable accessibilityRole="button" onPress={() => router.push("/favorites/new-list")} style={[styles.newListBtn, { minHeight: 44 }]}><Text style={styles.newListBtnLabel}>New list</Text></Pressable> : null}
                {item.listMeta ? <Pressable accessibilityRole="button" accessibilityLabel={`Manage ${item.listMeta.name}`} onPress={() => router.push(`/favorites/list/${item.listMeta!.id}`)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.accent }}>Manage</Text></Pressable> : null}
              </View>
              {pageErrors[item.key] ? <Pressable onPress={() => void loadMoreTitles(item)} style={{ position: "absolute", zIndex: 10, top: 56, left: 12, right: 12, backgroundColor: colors.background, padding: 12 }}><Text style={{ color: colors.accent }}>{pageErrors[item.key]}</Text></Pressable> : null}
              {hero ? <FullBleedPosterSection
                heroHeight={posterHeight}
                hero={pickToFullBleed(hero)}
                four={item.titles.map(pickToFullBleed)}
                onPressHero={() => void openTitle(hero.id)}
                onPressContinuation={title => setFeatured(prior => ({ ...prior, [item.key]: title.id }))}
                railActions={buildRail(hero, item.category)}
                onEndReached={() => void loadMoreTitles(item)}
                continuationBottomOffset={12}
              /> : <EmptyView
                height={posterHeight}
                icon="bookmark-outline"
                title={item.key === "my_lists" ? "Your collections" : "Nothing here yet"}
                body={item.key === "my_lists" ? (item.total ? "Swipe up to browse and manage your lists, including any previous collections." : "Create a list to organize your next movie night.") : item.listMeta ? "This list is ready for titles. Use Save on any title to add it here." : item.category === "ranked_favorites" ? "Rate a title to start your ranking. You can change the order anytime." : item.category === "favorites" ? "Titles you rate 8 or higher appear here." : item.category === "watched" ? "Titles you've watched appear here." : "Swipe right or save a title to My Next Watch."}
                actionLabel={item.listMeta ? "Manage list" : item.key === "my_lists" ? "New list" : "Discover titles"}
                onAction={() => item.listMeta ? router.push(`/favorites/list/${item.listMeta.id}`) : item.key === "my_lists" ? router.push("/favorites/new-list") : router.push("/(tabs)/swipe")}
              />}
            </View>;
          }}
        />
      )}
      </View>

      <AddToTeamSheet visible={!!teamTarget} token={sessionToken} title={teamTarget} onClose={() => setTeamTarget(null)} />
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
      <RatingEditor
        visible={rateTarget !== null}
        token={sessionToken}
        titleId={rateTarget?.titleId ?? null}
        titleName={rateTarget?.titleName ?? null}
        initial={rateTarget?.snapshot ?? null}
        onClose={() => setRateTarget(null)}
        onChanged={() => setRateTarget(null)}
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
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
  },
  sectionKickerLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  sectionKickerCount: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.2,
  },
  sectionKickerCountLink: {
    color: colors.accent,
    textDecorationLine: "underline",
  },
  newListBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  newListBtnLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.background,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  editOrderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  editOrderBtnLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.background,
    fontSize: 10,
    letterSpacing: 1.2,
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
  // Oct-27 user ask: pill nav is bigger and left-aligned (not spread
  // across the whole width). Horizontal scroll keeps all five pills
  // reachable without squeezing.
  pillNav: {
    position: "absolute",
    left: 0,
    right: 0,
    maxHeight: 56,
  },
  pillNavContent: {
    paddingHorizontal: spacing.lg,
    gap: 8,
    alignItems: "center",
  },
  pillBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
  },
  pillBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pillLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 13,
    letterSpacing: 0.2,
  },
  pillLabelActive: {
    color: colors.background,
  },
});
