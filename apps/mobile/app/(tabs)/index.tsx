import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { AppHeader } from "@/components/headers/app-header";
import { useCyclingBackdrop } from "@/lib/backdrop-pool";

import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { ConciergeComposer, type ConciergeDecisionResponse, type ConciergeTitleCard } from "@/components/concierge-composer";
import { ConciergeEmptyState } from "@/components/concierge-empty-state";
import { ConciergeListPicker } from "@/components/concierge-list-picker";
import { ConciergeResult } from "@/components/concierge-result";
import { DiscoverSection, MediaToggle, type DiscoverTitle } from "@/components/discover-section";
import { HeroFourSection, type HeroFourTitle } from "@/components/hero-four-section";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useEntitlement } from "@/lib/entitlement";
import { Avatar } from "@/components/avatar";
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

function conciergeTitleToHero(t: ConciergeTitleCard): HeroFourTitle {
  return {
    id: t.title_id,
    title: t.title,
    poster_url: t.poster_url,
    backdrop_url: t.backdrop_url,
    year: t.year,
  };
}

function titleItemToDiscover(t: TitleItem): DiscoverTitle {
  return {
    id: t.id,
    title: t.title,
    poster_url: t.poster_url ?? null,
    backdrop_url: t.backdrop_url ?? null,
    year: t.release_date ? new Date(t.release_date).getFullYear() : null,
  };
}

function feedItemToDiscover(item: FeedItem): DiscoverTitle {
  return titleItemToDiscover(item.title);
}

function feedItemToHero(item: FeedItem): HeroFourTitle {
  const releaseDate = item.title.release_date ? new Date(item.title.release_date) : null;
  return {
    id: item.title.id,
    title: item.title.title,
    poster_url: item.title.poster_url,
    backdrop_url: item.title.backdrop_url,
    year: releaseDate ? releaseDate.getFullYear() : null,
  };
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DiscoverScreen() {
  const { sessionToken, user } = useAuth();

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

  // Oct-18 §4 Concierge
  const entitlement = useEntitlement(sessionToken);
  const [conciergeDecision, setConciergeDecision] = useState<ConciergeDecisionResponse | null>(null);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [showListPicker, setShowListPicker] = useState(false);

  // Oct-19 Discover rebrief: Now in Theaters uses TMDB now_playing.
  const [nowInTheatersItems, setNowInTheatersItems] = useState<TitleItem[]>([]);
  const [nowInTheatersLoading, setNowInTheatersLoading] = useState(true);
  // Oct-27 spec CON-01: Concierge background = highest-ranked MOVIE
  // from the viewer's Ranked Favorites. A series ranked above it does
  // NOT become the background.
  const [conciergeBackdropUri, setConciergeBackdropUri] = useState<string | null>(null);
  const [nowInTheatersError, setNowInTheatersError] = useState<string | null>(null);

  // Media-type toggles for For You + Trending (mock A).
  const [forYouMedia, setForYouMedia] = useState<"movie" | "tv">("movie");
  // DISC01/02: server-filtered For You source. Fetched on media
  // toggle so the result is authoritative instead of a local filter
  // over a mixed-media mixed response.
  const [forYouFiltered, setForYouFiltered] = useState<RecommendationItem[] | null>(null);
  const [forYouLoading, setForYouLoading] = useState(false);
  const [trendingMedia, setTrendingMedia] = useState<"movie" | "tv">("movie");

  const searchInputRef = useRef<TextInput>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const [isFocused, setIsFocused] = useState(true);

  // ── Load discover content ─────────────────────────────────────────────────

  async function loadTrending(mediaOverride?: "movie" | "tv") {
    if (!sessionToken) return;
    try {
      const media = mediaOverride ?? trendingMedia;
      // DISC01: server-filtered trending so the toggle produces a
      // media-matched set instead of client-side filtering a tiny
      // mixed pool.
      const result = await apiRequest<TrendingResponse>(
        `/discover/trending?limit=12&media_type=${media === "movie" ? "movie" : "tv"}`,
        { token: sessionToken },
      );
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
      // DISC01/02: server-side media filter BEFORE candidate limit
      // and ranking. We pass preferred_type through so a TV request
      // never falls back to movies by filtering a small mixed set.
      const preferredType = forYouMedia === "movie" ? "movie" : "show";
      const result = await apiRequest<RecommendationItem[]>(
        `/titles/recommendations/for-me?limit=12&preferred_type=${preferredType}`,
        { token: sessionToken }
      );
      setRecommendations(result);
    } catch {
      // silently degrade — module hidden when empty
    }
  }

  // DISC01: when the Trending toggle flips, refetch server-filtered
  // trending so the carousel actually swaps media types instead of
  // filtering client-side on a 12-item mixed pool.
  useEffect(() => {
    if (!sessionToken) return;
    setTrendingLoading(true);
    void loadTrending(trendingMedia);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendingMedia, sessionToken]);

  // DISC01/02/03: whenever the For You media toggle changes, fetch
  // a server-filtered rec list. This replaces the previous local
  // filter + unfiltered fallback that could show movies when the
  // user asked for TV.
  useEffect(() => {
    let cancelled = false;
    async function loadFiltered() {
      if (!sessionToken) {
        setForYouFiltered(null);
        return;
      }
      setForYouLoading(true);
      try {
        const preferredType = forYouMedia === "movie" ? "movie" : "show";
        const result = await apiRequest<RecommendationItem[]>(
          `/titles/recommendations/for-me?limit=12&preferred_type=${preferredType}`,
          { token: sessionToken },
        );
        if (!cancelled) setForYouFiltered(result);
      } catch {
        if (!cancelled) setForYouFiltered([]);
      } finally {
        if (!cancelled) setForYouLoading(false);
      }
    }
    void loadFiltered();
    return () => { cancelled = true; };
  }, [forYouMedia, sessionToken]);

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

  async function loadNowInTheaters() {
    if (!sessionToken) return;
    setNowInTheatersLoading(true);
    setNowInTheatersError(null);
    try {
      const result = await apiRequest<TrendingResponse>("/discover/now-in-theaters?limit=12", {
        token: sessionToken,
      });
      setNowInTheatersItems(result.items ?? []);
    } catch (err) {
      setNowInTheatersError(err instanceof Error ? err.message : "Could not load now in theaters");
    } finally {
      setNowInTheatersLoading(false);
    }
  }

  async function loadConciergeBackdrop() {
    if (!sessionToken) return;
    try {
      // Oct-27 spec CON-01: owner's highest-ranked MOVIE from Ranked
      // Favorites. Concierge follow-up chunk F: resolve across the
      // FULL ranking, not just the top 20 — a cinephile whose top 20
      // is all series shouldn't get a dark backdrop when they have a
      // film at #42.
      type RankedResp = { items: { title_id: string; title: string; poster_url: string | null; media_type: string; backdrop_url?: string | null }[] };
      const res = await apiRequest<RankedResp>("/me/favorites/ranked?limit=500", { token: sessionToken });
      const topMovie = (res.items ?? []).find((it) => it.media_type === "movie");
      if (topMovie) {
        // Prefer high-res backdrop; fall back to poster.
        setConciergeBackdropUri(topMovie.backdrop_url || topMovie.poster_url || null);
      } else {
        // No ranked movie — intentional dark background per spec; do
        // NOT invent a #1 favorite from Trending.
        setConciergeBackdropUri(null);
      }
    } catch {
      // Honest unavailable: dark background, no fake backdrop.
      setConciergeBackdropUri(null);
    }
  }

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      void loadDiscoverFeed();
      void loadTrending();       // still fetched for the header backdrop cycling
      void loadCollections();    // editorial collections stay a separate module
      void loadNowInTheaters();
      void loadConciergeBackdrop();
      // loadRecommendations() removed — it called /titles/recommendations/for-me
      // (the slow SceneDNA-fanout endpoint that spins up 10 TMDB related-titles
      // calls per request) but nothing on Discover actually consumed the
      // resulting `recommendations` state. It was a dead prefetch that added
      // several seconds to first paint. The discover_feed endpoint already
      // provides personalized rails from the same recommendation service via
      // the unified /discover/feed response.
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
      {/* Oct-19 Header Standardization brief: shared compact AppHeader.
          Avatar is sticky (built in to AppHeader) so profile is one
          tap away from every tab. */}
      <AppHeader variant="primary" title="Discover" />

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
          {/* Oct-27 spec CON-01: SeenSnap Concierge card.
              Background is the owner's highest-ranked MOVIE from
              Ranked Favorites (resolved via /me/favorites/ranked).
              Falls back to the branded dark background if no ranked
              movie exists — no invented #1 favorite. */}
          {entitlement ? (
            <ConciergeComposer
              token={sessionToken}
              tier={entitlement.tier}
              allowanceRemaining={null}
              allowanceCap={entitlement.concierge_monthly_cap}
              resetsAt={null}
              backdropUri={conciergeBackdropUri}
              onDecision={(decision) => {
                setConciergeDecision(decision);
                trackEvent("concierge_decision", {
                  status: decision.status,
                  title_count: decision.titles.length,
                });
              }}
            />
          ) : null}

          {/* Concierge result — hero + four small posters + follow-up chips. */}
          {conciergeDecision && (conciergeDecision.status === "ready" || conciergeDecision.status === "partial") && conciergeDecision.titles.length > 0 ? (
            <ConciergeResult
              rationale={conciergeDecision.rationale}
              titles={conciergeDecision.titles}
              constraints={conciergeDecision.constraints ?? undefined}
              status={conciergeDecision.status}
              partialReason={conciergeDecision.partial_reason ?? null}
              requestedCount={conciergeDecision.requested_count ?? 5}
              exactMatchCount={conciergeDecision.exact_match_count ?? conciergeDecision.titles.length}
              titleRationales={conciergeDecision.title_rationales ?? {}}
              canUndo={(conciergeDecision as unknown as { _turn_count?: number })._turn_count !== undefined && (conciergeDecision as unknown as { _turn_count?: number })._turn_count! > 1}
              onPressFeatured={(t) => {
                trackEvent("concierge_title_opened", { title_id: t.title_id, decision_id: conciergeDecision.decision_id });
                void openTitleModal(t.title_id);
              }}
              onSave={(t) => {
                trackEvent("concierge_save", { title_id: t.title_id });
                setSaveTitleId(t.title_id);
                setShowSaveSheet(true);
              }}
              onSend={(t) => {
                trackEvent("concierge_send", { title_id: t.title_id });
                void openTitleModal(t.title_id);
              }}
              onAddToTeam={(t) => {
                trackEvent("concierge_team", { title_id: t.title_id });
                void openTitleModal(t.title_id);
              }}
              onRate={(t) => {
                trackEvent("concierge_rate", { title_id: t.title_id });
                void openTitleModal(t.title_id);
              }}
              onRefine={async (kind, extra) => {
                if (!sessionToken || !conciergeDecision.decision_id) return;
                trackEvent("concierge_refine", { kind, decision_id: conciergeDecision.decision_id });
                if (kind === "new_search") {
                  setConciergeDecision(null);
                  return;
                }
                try {
                  const idempotency_key = `concierge-refine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                  const res = await apiRequest<ConciergeDecisionResponse>(
                    `/me/concierge/decision/${conciergeDecision.decision_id}/refine`,
                    {
                      method: "POST",
                      token: sessionToken,
                      body: JSON.stringify({
                        kind,
                        featured_title_id: extra?.featured_title_id,
                        idempotency_key,
                      }),
                    },
                  );
                  // Carry a turn counter forward so the Undo chip can
                  // show after the first refinement.
                  const priorTurns = (conciergeDecision as unknown as { _turn_count?: number })._turn_count ?? 1;
                  setConciergeDecision({
                    ...res,
                    _intent: conciergeDecision._intent ?? null,
                    _turn_count: priorTurns + 1,
                  } as unknown as ConciergeDecisionResponse);
                } catch {
                  // Keep the current result; the user can retry.
                }
              }}
            />
          ) : null}

          {/* Chunk D: empty / no-exact-match → diagnosis + adjustment chips */}
          {conciergeDecision && conciergeDecision.status === "empty" ? (
            <ConciergeEmptyState
              statusDetail={conciergeDecision.status_detail}
              originalIntent={conciergeDecision._intent ?? null}
              rationale={conciergeDecision.rationale}
              partialReason={conciergeDecision.partial_reason ?? null}
              onApplyAdjustment={async (prompt) => {
                if (!sessionToken || !prompt.trim()) return;
                trackEvent("concierge_adjustment_applied", { status_detail: conciergeDecision.status_detail });
                // Chunk E completion: for "from my saved list" asks
                // without a named list, open the picker instead of
                // re-firing another needs_list_selection.
                if (conciergeDecision.status_detail === "needs_list_selection") {
                  setShowListPicker(true);
                  return;
                }
                try {
                  const idempotency_key = `concierge-adj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                  const res = await apiRequest<ConciergeDecisionResponse>("/me/concierge/decision", {
                    method: "POST",
                    token: sessionToken,
                    body: JSON.stringify({ intent: prompt, idempotency_key }),
                  });
                  setConciergeDecision({ ...res, _intent: prompt });
                } catch {
                  // Keep the current empty state visible; user can retry.
                }
              }}
            />
          ) : null}

          <ConciergeListPicker
            visible={showListPicker}
            onCancel={() => setShowListPicker(false)}
            onPick={async (listId, listName) => {
              setShowListPicker(false);
              if (!sessionToken) return;
              trackEvent("concierge_list_pick", { list_id: listId });
              const prompt =
                conciergeDecision?._intent ??
                `Help me pick from my list "${listName}".`;
              try {
                const idempotency_key = `concierge-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const res = await apiRequest<ConciergeDecisionResponse>("/me/concierge/decision", {
                  method: "POST",
                  token: sessionToken,
                  body: JSON.stringify({
                    intent: prompt,
                    collection_list_id: listId,
                    idempotency_key,
                  }),
                });
                setConciergeDecision({ ...res, _intent: prompt });
              } catch {
                // Keep whatever's on screen so the user can retry.
              }
            }}
          />

          {/* Oct-27 spec DISC-01: shortcut row removed. Concierge
              input + For You / Trending / Now in Theaters sections
              are the only landing content. Swipe, My Picks and Watch
              Teams remain accessible via the tab bar. */}

          {/* Oct-27 user ask: single accent CTA that opens the full
              SceneDNA panel. Premium star indicates deeper analysis
              lives behind the panel. */}
          <Pressable
            style={({ pressed }) => [styles.sceneDnaCta, pressed && { opacity: 0.78 }]}
            onPress={() => {
              trackEvent("discover_scene_dna_cta");
              router.push("/scene-dna");
            }}
            accessibilityRole="button"
            accessibilityLabel="View your SceneDNA — premium analysis"
          >
            <Ionicons name="sparkles" size={18} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.sceneDnaCtaTitle}>View your SceneDNA</Text>
              <Text style={styles.sceneDnaCtaBody}>
                Signals, evidence and the taste model behind your recs.
              </Text>
            </View>
            <View style={styles.sceneDnaCtaPremium}>
              <Ionicons name="star" size={11} color={colors.background} />
              <Text style={styles.sceneDnaCtaPremiumLabel}>PREMIUM</Text>
            </View>
          </Pressable>

          {/* Oct-19 Discover simplified mock A: three cinematic
              sections — For You, Trending, Now in Theaters. Each one
              is a section header + hero backdrop with title overlay +
              row of four portrait posters with uppercase captions. */}

          {/* 1 · For You — explicitly SceneDNA-driven. DISC01/02/03:
              uses the server-filtered forYouFiltered source so a TV
              request never falls back to movies. The /discover/feed
              module is kept as a secondary source for its subtitle
              label when available. */}
          {(() => {
            const forYouModule = discoverFeed?.modules.find(
              (m) => m.type === "personalized_rail" || m.type === "because_you",
            );
            // Primary source is the server-filtered rec list.
            const serverItems = forYouFiltered ?? [];
            if (serverItems.length > 0) {
              const subtitle = forYouModule?.type === "because_you"
                ? `${forYouModule.label} — tuned to your SceneDNA`
                : "Tuned to your SceneDNA";
              return (
                <DiscoverSection
                  kicker="FOR YOU"
                  subtitle={subtitle}
                  rightSlot={<MediaToggle value={forYouMedia} onChange={setForYouMedia} />}
                  hero={titleItemToDiscover(serverItems[0].title)}
                  four={serverItems.slice(1, 5).map((r) => titleItemToDiscover(r.title))}
                  onPressTitle={(t) => {
                    trackEvent("discover_item_clicked", { module: "for_you", content_id: t.id });
                    void openTitleModal(t.id);
                  }}
                  onSeeAll={() => router.push({
                    pathname: "/discover/collection/[key]",
                    params: { key: "for-you", media: forYouMedia },
                  })}
                />
              );
            }
            if (forYouLoading || discoverFeedLoading) {
              return (
                <View style={styles.moduleLoading}>
                  <ActivityIndicator color={colors.accent} size="small" />
                </View>
              );
            }
            return (
              <View style={styles.coldStartCard}>
                <Text style={styles.coldStartKicker}>FOR YOU</Text>
                <Text style={styles.coldStartTitle}>
                  {forYouMedia === "tv"
                    ? "No TV picks yet."
                    : "Your SceneDNA is still forming."}
                </Text>
                <Text style={styles.coldStartBody}>
                  {forYouMedia === "tv"
                    ? "Rate a few TV shows and your series recommendations will fill in. Movies may be ready right now — flip the toggle."
                    : "Rate titles, save them, and swipe through a few. The more you tell us, the sharper your recommendations get."}
                </Text>
                <Pressable onPress={() => router.push("/(tabs)/swipe")} style={styles.coldStartCta}>
                  <Text style={styles.coldStartCtaLabel}>START SWIPING</Text>
                </Pressable>
              </View>
            );
          })()}

          {/* 2 · Trending — dedicated /discover/trending (TMDB weekly) */}
          {trending && trending.items && trending.items.length > 0 ? (
            <DiscoverSection
              kicker="TRENDING"
              subtitle="Popular this week"
              rightSlot={<MediaToggle value={trendingMedia} onChange={setTrendingMedia} />}
              hero={titleItemToDiscover(trending.items[0])}
              four={trending.items.slice(1, 5).map(titleItemToDiscover)}
              onPressTitle={(t) => {
                trackEvent("discover_item_clicked", { module: "trending", content_id: t.id });
                void openTitleModal(t.id);
              }}
              onSeeAll={() => router.push({
                pathname: "/discover/collection/[key]",
                params: { key: "trending", media: trendingMedia },
              })}
            />
          ) : trendingLoading ? (
            <View style={styles.moduleLoading}>
              <ActivityIndicator color={colors.accent} size="small" />
            </View>
          ) : (
            // DISC01: honest empty state when the toggle produces no
            // results — never silently fall back to the unfiltered
            // pool.
            <View style={styles.coldStartCard}>
              <Text style={styles.coldStartKicker}>TRENDING</Text>
              <Text style={styles.coldStartTitle}>
                {trendingMedia === "tv" ? "No trending TV right now." : "No trending movies right now."}
              </Text>
              <Text style={styles.coldStartBody}>
                Try the other media type or check back later.
              </Text>
              <View style={{ alignSelf: "flex-end" }}>
                <MediaToggle value={trendingMedia} onChange={setTrendingMedia} />
              </View>
            </View>
          )}

          {/* 3 · In Theaters Now — /discover/now-in-theaters */}
          {nowInTheatersItems.length > 0 ? (
            <DiscoverSection
              kicker="NOW IN THEATERS"
              locationLabel="United States"
              hero={titleItemToDiscover(nowInTheatersItems[0])}
              four={nowInTheatersItems.slice(1, 5).map(titleItemToDiscover)}
              onPressTitle={(t) => {
                trackEvent("discover_item_clicked", { module: "now_in_theaters", content_id: t.id });
                void openTitleModal(t.id);
              }}
              onSeeAll={() => router.push({
                pathname: "/discover/collection/[key]",
                params: { key: "now-in-theaters" },
              })}
            />
          ) : nowInTheatersLoading ? (
            <View style={styles.moduleLoading}>
              <ActivityIndicator color={colors.accent} size="small" />
            </View>
          ) : (
            <View style={styles.coldStartCard}>
              <Text style={styles.coldStartKicker}>NOW IN THEATERS</Text>
              <Text style={styles.coldStartTitle}>Couldn't load today's lineup.</Text>
              <Text style={styles.coldStartBody}>
                {nowInTheatersError ?? "Pull to refresh in a moment."}
              </Text>
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
      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="concierge"
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
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    gap: spacing.sm,
    borderRadius: 999,
  },
  searchBarActive: {
    borderColor: "rgba(255,230,0,0.4)",
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
    borderColor: "rgba(255,230,0,0.5)",
    backgroundColor: "rgba(255,230,0,0.06)",
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

  sceneDnaCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 220, 90, 0.3)",
  },
  sceneDnaCtaTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
  },
  sceneDnaCtaBody: {
    marginTop: 2,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 15,
  },
  sceneDnaCtaPremium: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  sceneDnaCtaPremiumLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.background,
    fontSize: 9,
    letterSpacing: 1,
  },
  conciergeResultWrap: {
    position: "relative",
    overflow: "hidden",
  },
  conciergeLandingPremium: {
    paddingTop: 8,
  },
  conciergeLandingKicker: {
    paddingHorizontal: spacing.lg,
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  coldStartCard: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
    padding: spacing.lg,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: colors.surface,
    gap: 8,
  },
  coldStartKicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  coldStartTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 18,
    lineHeight: 22,
  },
  coldStartBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  coldStartCta: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  coldStartCtaLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    fontSize: 11,
    letterSpacing: 0.6,
  },
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
    backgroundColor: "rgba(255,230,0,0.04)",
  },
  quickNavIconWrap: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,230,0,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,230,0,0.18)",
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
    borderColor: "rgba(255,230,0,0.18)",
    backgroundColor: "rgba(255,230,0,0.035)",
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
    backgroundColor: "rgba(255,230,0,0.45)",
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
    backgroundColor: "rgba(255,230,0,0.4)",
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
