import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SSAnimatedRule } from "@/components/ss-animated-rule";
import { SSMotionBackdrop } from "@/components/ss-motion-backdrop";
import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { useCyclingBackdrop } from "@/lib/backdrop-pool";

import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  addRecentSearch,
  clearRecentSearches,
  getRecentSearches,
  removeRecentSearch,
} from "@/lib/recent-searches";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

// ─── Types ────────────────────────────────────────────────────────────────────

type TitleItem = {
  id: string;
  tmdb_id: number;
  content_type: string;
  title: string;
  overview?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  genres: string[];
  release_date?: string | null;
  runtime_minutes?: number | null;
  tmdb_rating?: number | null;
};

type TrendingResponse = {
  source_mode: string;
  display_label: string;
  generated_at: string;
  items: TitleItem[];
};

type SearchResultItem = {
  entity_type: string;
  entity_id: string;
  title: string;
  subtitle?: string | null;
  artwork?: string | null;
  year?: number | null;
  media_type?: string | null;
  route: string;
  source: string;
};

type SearchResponse = {
  query: string;
  movies: SearchResultItem[];
  series: SearchResultItem[];
  people: SearchResultItem[];
  collections: SearchResultItem[];
  my_stuff: SearchResultItem[];
};

type CollectionSummary = {
  slug: string;
  title: string;
  subtitle?: string | null;
  thesis?: string | null;
  collection_type: string;
  media_scope: string;
  poster_urls: string[];
  item_count?: number | null;
};

type RecommendationItem = {
  title: TitleItem;
  reason: string;
};

// ─── /discover/feed structured module contract ───────────────────────────────
// Matches build_discover_feed on the backend. Client renders whatever modules
// the server returns; module eligibility is decided server-side (§27) so an
// absent module means the data didn't qualify — the client never fabricates.
type FeedItem = {
  impression_id: string | null;
  title: TitleItem;
  score: number | null;
  confidence: string | null;
  reasons: { type: string; signal_type?: string; signal_name?: string; hits?: number; score?: number }[];
  reason_template: string | null;
};

type DiscoverModule =
  | {
      type: "contextual_pick";
      window: string;
      mode: string;
      label: string;
      item: FeedItem;
    }
  | {
      type: "personalized_rail" | "because_you" | "team_recommendation" | "trending" | "exploration_rail";
      key: string;
      label: string;
      subtitle?: string;
      items: FeedItem[];
    };

type DiscoverContext = {
  window: string;
  display_label: string;
  is_weekend: boolean;
  recommended_mode: string;
  confidence: string;
  local_hour: number;
};

type DiscoverFeedResponse = {
  context: DiscoverContext;
  user_stage: "cold_start" | "emerging" | "personalized";
  modules: DiscoverModule[];
};

// ─── Search result type tabs ──────────────────────────────────────────────────

const SEARCH_TABS = [
  { key: "all", label: "All" },
  { key: "movies", label: "Movies" },
  { key: "series", label: "Series" },
  { key: "people", label: "People" },
  { key: "collections", label: "Collections" },
] as const;

type SearchTab = (typeof SEARCH_TABS)[number]["key"];

// ─── Components ───────────────────────────────────────────────────────────────

function PosterCard({
  item,
  onPress,
  rank,
  showRank = false,
}: {
  item: TitleItem | SearchResultItem;
  onPress: () => void;
  rank?: number;
  showRank?: boolean;
}) {
  const poster = "poster_url" in item
    ? (item as TitleItem).poster_url
    : (item as SearchResultItem).artwork;
  const title = item.title;
  const year = "release_date" in item && (item as TitleItem).release_date
    ? new Date((item as TitleItem).release_date!)
    : null;
  const yearNum = year ? year.getFullYear() : ("year" in item ? (item as SearchResultItem).year : null);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.posterCard, pressed && styles.pressed]}>
      <View style={styles.posterImageWrap}>
        {poster ? (
          <Image source={{ uri: poster }} style={styles.posterImage} resizeMode="cover" />
        ) : (
          <View style={[styles.posterImage, styles.posterPlaceholder]}>
            <Ionicons name="film-outline" size={20} color={colors.muted2} />
          </View>
        )}
        {showRank && rank !== undefined && (
          <View style={styles.rankBadge}>
            <Text style={styles.rankText}>{rank}</Text>
          </View>
        )}
      </View>
      <Text style={styles.posterTitle} numberOfLines={2}>{title}</Text>
      {yearNum ? <Text style={styles.posterYear}>{yearNum}</Text> : null}
    </Pressable>
  );
}

function SearchResultRow({
  item,
  onPress,
}: {
  item: SearchResultItem;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.searchRow, pressed && styles.pressed]}
    >
      {item.artwork ? (
        <Image source={{ uri: item.artwork }} style={styles.searchRowArt} resizeMode="cover" />
      ) : (
        <View style={[styles.searchRowArt, styles.searchRowArtPlaceholder]}>
          <Ionicons
            name={
              item.entity_type === "person"
                ? "person-outline"
                : item.entity_type === "collection"
                ? "library-outline"
                : "film-outline"
            }
            size={14}
            color={colors.muted2}
          />
        </View>
      )}
      <View style={styles.searchRowText}>
        <Text style={styles.searchRowTitle} numberOfLines={1}>{item.title}</Text>
        {item.subtitle ? (
          <Text style={styles.searchRowSub} numberOfLines={1}>{item.subtitle}</Text>
        ) : null}
      </View>
      <Text style={styles.searchRowType}>
        {item.entity_type === "series" ? "SERIES" : item.entity_type.toUpperCase()}
      </Text>
    </Pressable>
  );
}

function CollectionCard({
  coll,
  onPress,
}: {
  coll: CollectionSummary;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.collectionCard, pressed && styles.pressed]}
    >
      <View style={styles.collectionPosters}>
        {coll.poster_urls.slice(0, 3).map((url, i) => (
          <Image
            key={i}
            source={{ uri: url }}
            style={[styles.collectionPoster, { zIndex: 3 - i, marginLeft: i > 0 ? -20 : 0 }]}
            resizeMode="cover"
          />
        ))}
        {coll.poster_urls.length === 0 && (
          <View style={[styles.collectionPoster, styles.posterPlaceholder]}>
            <Ionicons name="library-outline" size={16} color={colors.muted2} />
          </View>
        )}
      </View>
      <View style={styles.collectionInfo}>
        <Text style={styles.collectionType}>
          {coll.collection_type === "dynamic_discover" ? "CURATED" : coll.collection_type.toUpperCase()}
        </Text>
        <Text style={styles.collectionTitle} numberOfLines={2}>{coll.title}</Text>
        {coll.subtitle ? (
          <Text style={styles.collectionSub} numberOfLines={2}>{coll.subtitle}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={14} color={colors.muted2} />
    </Pressable>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DiscoverScreen() {
  const { sessionToken } = useAuth();

  // Search state
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchTab, setSearchTab] = useState<SearchTab>("all");
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Discover content
  const [trending, setTrending] = useState<TrendingResponse | null>(null);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [recommendations, setRecommendations] = useState<RecommendationItem[]>([]);
  // Unified Discover feed (SceneDNA brief §28) — one server call returns
  // ordered modules the client renders directly. Replaces the prior three
  // parallel endpoints + hardcoded module order.
  const [discoverFeed, setDiscoverFeed] = useState<DiscoverFeedResponse | null>(null);
  const [discoverFeedLoading, setDiscoverFeedLoading] = useState(true);

  // Title modal
  const [selectedTitleId, setSelectedTitleId] = useState<string | null>(null);
  const [universalTitle, setUniversalTitle] = useState<UniversalTitle | null>(null);
  const [titleModalVisible, setTitleModalVisible] = useState(false);
  const [titleLoading, setTitleLoading] = useState(false);

  const searchInputRef = useRef<TextInput>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const [isFocused, setIsFocused] = useState(true);

  // ── Load discover content ─────────────────────────────────────────────────

  async function loadTrending() {
    if (!sessionToken) return;
    try {
      const result = await apiRequest<TrendingResponse>("/discover/trending?limit=12", {
        token: sessionToken,
      });
      setTrending(result);
    } catch {
      // silently degrade — trending stays null
    } finally {
      setTrendingLoading(false);
    }
  }

  async function loadCollections() {
    if (!sessionToken) return;
    try {
      const result = await apiRequest<CollectionSummary[]>("/collections?limit=18", {
        token: sessionToken,
      });
      // Show up to 18 curated collections per product ask — was capped
      // to 3 previously as an editorial preview. The Collections module
      // scrolls horizontally so the extra rows don't crowd the page.
      setCollections(result.slice(0, 18));
    } catch {
      // silently degrade
    } finally {
      setCollectionsLoading(false);
    }
  }

  async function loadRecommendations() {
    if (!sessionToken) return;
    try {
      const result = await apiRequest<RecommendationItem[]>(
        "/titles/recommendations/for-me?limit=12",
        { token: sessionToken }
      );
      setRecommendations(result);
    } catch {
      // silently degrade — module hidden when empty
    }
  }

  async function loadDiscoverFeed() {
    if (!sessionToken) return;
    setDiscoverFeedLoading(true);
    try {
      // Pass the client's local hour so context resolution matches the user's
      // clock (backend defaults to server time otherwise).
      const localHour = new Date().getHours();
      const result = await apiRequest<DiscoverFeedResponse>(
        `/discover/feed?local_hour=${localHour}`,
        { token: sessionToken },
      );
      setDiscoverFeed(result);
    } catch {
      // silently degrade — falls back to the legacy trending/for-you/collections
      // triple below if this endpoint is unreachable.
    } finally {
      setDiscoverFeedLoading(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      void loadDiscoverFeed();
      void loadTrending();       // still fetched for the header backdrop cycling
      void loadCollections();    // editorial collections stay a separate module
      void loadRecommendations();
      void getRecentSearches().then(setRecentSearches);
      trackEvent("discover_viewed", {});
      return () => setIsFocused(false);
    }, [sessionToken])
  );

  // ── Search ────────────────────────────────────────────────────────────────

  function activateSearch() {
    setSearchActive(true);
    void getRecentSearches().then(setRecentSearches);
    trackEvent("search_opened", { entry_point: "discover" });
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }

  function deactivateSearch() {
    setSearchActive(false);
    setQuery("");
    setSearchResults(null);
    setSearchLoading(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current.cancelled = true;
    abortRef.current = { cancelled: false };
  }

  function handleQueryChange(text: string) {
    setQuery(text);
    if (!text.trim()) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    if (text.trim().length < 2) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchLoading(true);

    const token = abortRef.current;
    debounceRef.current = setTimeout(async () => {
      if (!sessionToken || token.cancelled) return;
      try {
        const result = await apiRequest<SearchResponse>(
          `/search/global?q=${encodeURIComponent(text.trim())}`,
          { token: sessionToken }
        );
        if (!token.cancelled) {
          setSearchResults(result);
          trackEvent("search_submitted", { query_length: text.trim().length });
        }
      } catch {
        // keep existing results
      } finally {
        if (!token.cancelled) setSearchLoading(false);
      }
    }, 250);
  }

  async function handleSearchSubmit() {
    const q = query.trim();
    if (!q) return;
    await addRecentSearch(q);
    setRecentSearches(await getRecentSearches());
  }

  async function handleRecentSearchTap(q: string) {
    setQuery(q);
    handleQueryChange(q);
  }

  async function handleRemoveRecent(q: string) {
    const updated = await removeRecentSearch(q);
    setRecentSearches(updated);
  }

  async function handleClearRecents() {
    await clearRecentSearches();
    setRecentSearches([]);
  }

  function handleSearchResultPress(item: SearchResultItem) {
    trackEvent("search_result_clicked", {
      entity_type: item.entity_type,
      source: item.source,
    });
    void addRecentSearch(query.trim());
    if (item.entity_type === "movie" || item.entity_type === "series") {
      openTitleModal(item.entity_id);
    } else if (item.entity_type === "collection") {
      deactivateSearch();
      // Navigate to collection screen (future route)
    } else {
      deactivateSearch();
    }
  }

  // ── Title modal ───────────────────────────────────────────────────────────

  async function openTitleModal(titleId: string) {
    if (!sessionToken) return;
    setSelectedTitleId(titleId);
    setTitleLoading(true);
    setTitleModalVisible(true);
    try {
      const ut = await fetchUniversalTitle(sessionToken, titleId);
      setUniversalTitle(ut);
    } catch {
      setTitleModalVisible(false);
    } finally {
      setTitleLoading(false);
    }
  }

  // ── Computed search results for current tab ────────────────────────────────

  function getTabResults(): SearchResultItem[] {
    if (!searchResults) return [];
    switch (searchTab) {
      case "movies": return searchResults.movies;
      case "series": return searchResults.series;
      case "people": return searchResults.people;
      case "collections": return searchResults.collections;
      default: {
        const all = [
          ...searchResults.movies.slice(0, 4),
          ...searchResults.series.slice(0, 4),
          ...searchResults.people.slice(0, 3),
          ...searchResults.collections.slice(0, 3),
          ...searchResults.my_stuff.slice(0, 2),
        ];
        return all;
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const HERO_EXPANDED = 190;
  const HERO_COMPACT = 52;

  const headerHeight = scrollY.interpolate({
    inputRange: [0, 130],
    outputRange: [HERO_EXPANDED, HERO_COMPACT],
    extrapolate: "clamp",
  });

  const heroContentOpacity = scrollY.interpolate({
    inputRange: [0, 90],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  const compactTitleOpacity = scrollY.interpolate({
    inputRange: [70, 130],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });

  // Prefer real landscape backdrops; never stretch a poster into a header.
  // Cycle across the top 3 trending items so the header refreshes each time
  // the tab regains focus rather than pinning to trending[0] forever.
  const trendingBackdrop = useCyclingBackdrop([
    trending?.items[0]?.backdrop_url,
    trending?.items[1]?.backdrop_url,
    trending?.items[2]?.backdrop_url,
  ]);

  return (
    <SafeAreaView style={styles.root} edges={["left", "right"]}>
      {/* Unified Header System brief §7 taxonomy — H1 reinforces navigation.
          "What's next?" moved to Swipe (where it belongs); Discover's H1 IS
          "Discover" so the tab bar and page title agree. Same SeenSnapHeader
          instance used everywhere. */}
      <SeenSnapHeader
        title="Discover"
        artworkSource={trendingBackdrop}
        scrollY={scrollY}
        fallbackSeed={1}
      />

      {/* ── Search bar ────────────────────────────────────────────────────── */}
      <Pressable
        style={styles.searchBarWrap}
        onPress={!searchActive ? activateSearch : undefined}
      >
        <View style={[styles.searchBar, searchActive && styles.searchBarActive]}>
          <Ionicons
            name="search"
            size={14}
            color={searchActive ? colors.accent : colors.muted2}
            style={styles.searchIcon}
          />
          <TextInput
            ref={searchInputRef}
            style={styles.searchInput}
            placeholder="Search films, series, people & collections"
            placeholderTextColor={colors.muted2}
            value={query}
            onChangeText={handleQueryChange}
            onFocus={activateSearch}
            onSubmitEditing={handleSearchSubmit}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchActive && (
            <Pressable onPress={deactivateSearch} hitSlop={10}>
              <Text style={styles.searchCancel}>Cancel</Text>
            </Pressable>
          )}
        </View>
      </Pressable>

      {/* ── Search active: results ─────────────────────────────────────────── */}
      {searchActive ? (
        <View style={styles.searchOverlay}>
          {/* Type tabs */}
          {searchResults && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.tabsScroll}
              contentContainerStyle={styles.tabsContent}
            >
              {SEARCH_TABS.map((tab) => (
                <Pressable
                  key={tab.key}
                  onPress={() => setSearchTab(tab.key)}
                  style={[styles.tab, searchTab === tab.key && styles.tabActive]}
                >
                  <Text style={[styles.tabText, searchTab === tab.key && styles.tabTextActive]}>
                    {tab.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {/* Results */}
          {searchLoading ? (
            <View style={styles.searchCenter}>
              <ActivityIndicator color={colors.accent} size="small" />
            </View>
          ) : searchResults ? (
            getTabResults().length > 0 ? (
              <FlatList
                data={getTabResults()}
                keyExtractor={(item, i) => `${item.entity_type}-${item.entity_id}-${i}`}
                renderItem={({ item }) => (
                  <SearchResultRow
                    item={item}
                    onPress={() => handleSearchResultPress(item)}
                  />
                )}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 40 }}
              />
            ) : (
              <View style={styles.searchCenter}>
                <Text style={styles.emptyTitle}>No results</Text>
                <Text style={styles.emptyBody}>Try a different title, person, or collection name.</Text>
              </View>
            )
          ) : (
            /* Recent searches */
            <View style={styles.recentsWrap}>
              {recentSearches.length > 0 ? (
                <>
                  <View style={styles.recentsHeader}>
                    <Text style={styles.recentsLabel}>RECENT</Text>
                    <Pressable onPress={handleClearRecents} hitSlop={8}>
                      <Text style={styles.recentsClear}>Clear all</Text>
                    </Pressable>
                  </View>
                  {recentSearches.map((q) => (
                    <Pressable
                      key={q}
                      style={styles.recentRow}
                      onPress={() => void handleRecentSearchTap(q)}
                    >
                      <Ionicons name="time-outline" size={13} color={colors.muted2} />
                      <Text style={styles.recentText}>{q}</Text>
                      <Pressable onPress={() => void handleRemoveRecent(q)} hitSlop={10}>
                        <Ionicons name="close" size={13} color={colors.muted2} />
                      </Pressable>
                    </Pressable>
                  ))}
                </>
              ) : (
                <View style={styles.searchCenter}>
                  <Text style={styles.emptyBody}>Search for films, series, or people.</Text>
                </View>
              )}
            </View>
          )}
        </View>
      ) : (
        /* ── Discover modules ───────────────────────────────────────────── */
        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: false }
          )}
          scrollEventThrottle={16}
        >
          {/* Primary nav row — quick jumps to the three most-used destinations. */}
          <View style={styles.quickNavRow}>
            {[
              { key: "swipe", label: "Swipe", icon: "layers" as const, route: "/(tabs)/swipe" as const },
              { key: "my-picks", label: "My Picks", icon: "bookmark" as const, route: "/(tabs)/my-picks" as const },
              { key: "teams", label: "Watch Teams", icon: "people" as const, route: "/(tabs)/teams" as const },
            ].map((tile) => (
              <Pressable
                key={tile.key}
                style={({ pressed }) => [styles.quickNavTile, pressed && styles.quickNavTilePressed]}
                onPress={() => {
                  trackEvent("discover_quick_nav", { destination: tile.key });
                  router.push(tile.route);
                }}
              >
                <View style={styles.quickNavIconWrap}>
                  <Ionicons name={tile.icon} size={22} color={colors.accent} />
                </View>
                {/* Single-line label with aggressive auto-shrink so "Watch Teams"
                    or any future long label never wraps/clips. */}
                <Text
                  style={styles.quickNavLabel}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.5}
                >
                  {tile.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Dynamic module stack from /discover/feed. Backend decides which
              modules qualify (§27); client renders in order. Contextual hero
              gets a dedicated card treatment; every rail-type module renders
              through the shared rail block. Falls back to a lightweight
              loading state on first paint. */}
          {discoverFeedLoading && !discoverFeed ? (
            <View style={styles.moduleLoading}>
              <ActivityIndicator color={colors.accent} size="small" />
            </View>
          ) : null}
          {discoverFeed?.modules.map((mod, moduleIndex) => {
            if (mod.type === "contextual_pick") {
              const t = mod.item.title;
              return (
                <View key={`ctx-${mod.window}-${moduleIndex}`} style={styles.contextualHero}>
                  <Text style={styles.contextualHeroKicker}>{mod.label.toUpperCase()}</Text>
                  <Pressable
                    onPress={() => {
                      trackEvent("discover_contextual_pick_opened", {
                        window: mod.window,
                        mode: mod.mode,
                        content_id: t.id,
                        impression_id: mod.item.impression_id,
                      });
                      void openTitleModal(t.id);
                    }}
                    style={styles.contextualHeroCard}
                  >
                    {t.backdrop_url ? (
                      <Image source={{ uri: t.backdrop_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                    ) : null}
                    <View style={styles.contextualHeroShade} />
                    <View style={styles.contextualHeroBody}>
                      <Text style={styles.contextualHeroTitle} numberOfLines={2}>{t.title}</Text>
                      {mod.item.reason_template ? (
                        <Text style={styles.contextualHeroReason} numberOfLines={2}>{mod.item.reason_template}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                </View>
              );
            }
            // All rail-shaped modules (personalized_rail, because_you,
            // team_recommendation, trending, exploration_rail).
            if (!mod.items || mod.items.length === 0) return null;
            return (
              <View key={`${mod.type}-${mod.key}-${moduleIndex}`} style={styles.module}>
                <View style={styles.moduleHeader}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.moduleTitle}>{mod.label}</Text>
                    {mod.subtitle ? (
                      <Text style={styles.moduleSubtitle} numberOfLines={1}>{mod.subtitle}</Text>
                    ) : null}
                  </View>
                  {mod.type === "personalized_rail" ? (
                    <Pressable onPress={() => router.push("/(tabs)/for-you")} hitSlop={10}>
                      <Text style={styles.seeAll}>SEE ALL</Text>
                    </Pressable>
                  ) : null}
                </View>
                <FlatList
                  data={mod.items}
                  keyExtractor={(item) => `${mod.key}-${item.title.id}`}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.railContent}
                  renderItem={({ item, index }) => (
                    <PosterCard
                      item={item.title}
                      onPress={() => {
                        trackEvent("discover_item_clicked", {
                          module_type: mod.type,
                          module_key: mod.key,
                          content_id: item.title.id,
                          rank: index + 1,
                          impression_id: item.impression_id,
                        });
                        void openTitleModal(item.title.id);
                      }}
                    />
                  )}
                />
              </View>
            );
          })}

          {/* Modules 4–5: Collections */}
          {(collectionsLoading || collections.length > 0) && (
            <View style={styles.module}>
              <View style={styles.moduleHeader}>
                <View>
                  <Text style={styles.moduleTitle}>Collections</Text>
                </View>
                <Pressable onPress={() => router.push("/collections")} hitSlop={10}>
                  <Text style={styles.seeAll}>BROWSE ALL</Text>
                </Pressable>
              </View>

              {collectionsLoading ? (
                <View style={styles.moduleLoading}>
                  <ActivityIndicator color={colors.accent} size="small" />
                </View>
              ) : (
                <View style={styles.collectionList}>
                  {collections.map((coll) => (
                    <CollectionCard
                      key={coll.slug}
                      coll={coll}
                      onPress={() => {
                        trackEvent("collection_opened", {
                          collection_id: coll.slug,
                          entry_point: "discover",
                          collection_type: coll.collection_type,
                        });
                        router.push(`/collections/${coll.slug}`);
                      }}
                    />
                  ))}
                </View>
              )}
            </View>
          )}

          <View style={{ height: 40 }} />
        </Animated.ScrollView>
      )}

      {/* ── Title modal ───────────────────────────────────────────────────── */}
      {titleModalVisible && (
        <UniversalTitleModal
          visible={titleModalVisible}
          title={universalTitle}
          loading={titleLoading}
          onClose={() => {
            setTitleModalVisible(false);
            setUniversalTitle(null);
            setSelectedTitleId(null);
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const POSTER_W = 100;
const POSTER_H = 150;
const COLLECTION_POSTER_W = 64;
const COLLECTION_POSTER_H = 96;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Living hero header
  heroShell: {
    overflow: "hidden",
    backgroundColor: colors.background,
  },
  backdropShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7,11,18,0.55)",
  },
  backdropShadeLeft: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "55%",
    backgroundColor: "rgba(7,11,18,0.72)",
  },
  heroBody: {
    position: "absolute",
    left: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: 5,
  },
  compactBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: 14,
    justifyContent: "flex-end",
  },
  compactTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.ink,
    letterSpacing: -0.2,
  },
  heroEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: "uppercase",
  },
  heroTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 32,
    lineHeight: 34,
    color: colors.ink,
    letterSpacing: -0.5,
  },

  // Search
  searchBarWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: rules.default,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    gap: spacing.sm,
  },
  searchBarActive: {
    borderColor: "rgba(244,196,48,0.4)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  searchIcon: { flexShrink: 0 },
  searchInput: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink,
    padding: 0,
  },
  searchCancel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.3,
    color: colors.accent,
    textTransform: "uppercase",
  },

  // Search overlay
  searchOverlay: {
    flex: 1,
  },
  tabsScroll: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  tabsContent: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: rules.default,
  },
  tabActive: {
    borderColor: "rgba(244,196,48,0.5)",
    backgroundColor: "rgba(244,196,48,0.06)",
  },
  tabText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.muted2,
    textTransform: "uppercase",
  },
  tabTextActive: {
    color: colors.accent,
  },

  // Search results
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    gap: spacing.md,
  },
  searchRowArt: {
    width: 40,
    height: 56,
    borderRadius: radii.sm,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  searchRowArtPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  searchRowText: { flex: 1, gap: 2 },
  searchRowTitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink,
  },
  searchRowSub: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.muted2,
  },
  searchRowType: {
    fontFamily: fonts.mono,
    fontSize: 8,
    letterSpacing: 0.5,
    color: colors.muted2,
    textTransform: "uppercase",
  },

  // Recent searches
  recentsWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  recentsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  recentsLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1,
    color: colors.muted2,
    textTransform: "uppercase",
  },
  recentsClear: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.accent,
    textTransform: "uppercase",
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  recentText: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted,
  },

  // Discover scroll
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 60 },

  // Magnifying-glass button in the Discover header's right slot (Search entry point).
  headerSearchBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },

  // Primary nav row (Swipe / My Picks / Watch Teams)
  quickNavRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  quickNavTile: {
    flex: 1,
    minHeight: 96,
    paddingVertical: 14,
    paddingHorizontal: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  quickNavTilePressed: {
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.04)",
  },
  quickNavIconWrap: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(244,196,48,0.08)",
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.18)",
  },
  quickNavGoldRule: {
    width: 20,
    height: 1,
    backgroundColor: rules.gold,
  },
  quickNavLabel: {
    fontFamily: fonts.serifBold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.ink,
    letterSpacing: -0.2,
    textAlign: "center",
    alignSelf: "stretch", // allow adjustsFontSizeToFit to know the width
  },

  // Swipe CTA
  swipeCta: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.18)",
    backgroundColor: "rgba(244,196,48,0.035)",
    overflow: "hidden",
  },
  swipeCtaInner: {
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  swipeCtaEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  swipeCtaTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  swipeCtaSub: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.muted,
  },
  swipeCtaAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingBottom: 2,
  },
  swipeCtaActionText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: "uppercase",
  },
  swipeCtaGoldBar: {
    height: 2,
    backgroundColor: "rgba(244,196,48,0.45)",
  },

  // Module structure
  module: {
    marginBottom: spacing.xl,
  },
  moduleHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  moduleMeta: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: "uppercase",
    marginBottom: 3,
  },
  moduleGoldRule: {
    height: 1,
    width: 24,
    backgroundColor: "rgba(244,196,48,0.4)",
    marginBottom: 4,
  },
  moduleTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  moduleSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
    letterSpacing: 0.1,
  },
  // Contextual hero card — brief §12. Single high-confidence pick keyed to
  // the current context window ("Movie Night", "Late Night", etc.).
  contextualHero: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    gap: 8,
  },
  contextualHeroKicker: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
  },
  contextualHeroCard: {
    height: 200,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  contextualHeroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(4,8,14,0.60)",
  },
  contextualHeroBody: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 16,
    gap: 6,
  },
  contextualHeroTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 26,
    lineHeight: 30,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  contextualHeroReason: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 13,
    lineHeight: 18,
    color: "rgba(243,239,229,0.85)",
  },
  moduleLoading: {
    height: POSTER_H,
    alignItems: "center",
    justifyContent: "center",
  },
  moduleEmpty: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  seeAll: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.8,
    color: colors.accent,
    textTransform: "uppercase",
    paddingBottom: 3,
  },

  // Poster rail
  railContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  posterCard: {
    width: POSTER_W,
    gap: 5,
  },
  posterImageWrap: {
    position: "relative",
  },
  posterImage: {
    width: POSTER_W,
    height: POSTER_H,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  posterPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  posterTitle: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.muted,
    lineHeight: 15,
  },
  posterYear: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.muted2,
    letterSpacing: 0.3,
  },
  rankBadge: {
    position: "absolute",
    top: 5,
    left: 5,
    backgroundColor: "rgba(7,11,18,0.85)",
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  rankText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    color: colors.accent,
    letterSpacing: 0.5,
  },

  // Collections
  collectionList: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  collectionCard: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.default,
    padding: spacing.md,
    gap: spacing.md,
  },
  collectionPosters: {
    flexDirection: "row",
    width: COLLECTION_POSTER_W * 1.6,
    height: COLLECTION_POSTER_H,
    position: "relative",
    flexShrink: 0,
  },
  collectionPoster: {
    width: COLLECTION_POSTER_W,
    height: COLLECTION_POSTER_H,
    position: "absolute",
    top: 0,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  collectionInfo: {
    flex: 1,
    gap: 3,
  },
  collectionType: {
    fontFamily: fonts.mono,
    fontSize: 8,
    letterSpacing: 1,
    color: colors.accent,
    textTransform: "uppercase",
  },
  collectionTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 16,
    color: colors.ink,
    letterSpacing: -0.2,
  },
  collectionSub: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.muted2,
    lineHeight: 15,
  },

  // Shared
  separator: {
    height: 1,
    backgroundColor: rules.default,
    marginHorizontal: spacing.lg,
  },
  searchCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    paddingTop: 60,
    gap: spacing.sm,
  },
  emptyTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 26,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 19,
  },
  pressed: { opacity: 0.7 },
});
