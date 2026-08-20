import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { selectSafeBackdropAt } from "@/lib/backdrop";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

type SearchResultItem = {
  entity_type: "movie" | "series" | "person" | "collection" | "list" | "team";
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

const DEBOUNCE_MS = 280;

type TrendingTitle = {
  id: string;
  title: string;
  content_type: string;
  poster_url?: string | null;
  backdrop_url?: string | null;
  release_date?: string | null;
};

export default function SearchScreen() {
  const { sessionToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trending, setTrending] = useState<TrendingTitle[]>([]);

  const [modalVisible, setModalVisible] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalTitle, setModalTitle] = useState<UniversalTitle | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch trending on mount so the empty state has real, tappable content —
  // audit called out the plain text-only empty state as unfinished.
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    apiRequest<TrendingTitle[]>("/titles/trending?limit=12", { token: sessionToken })
      .then((data) => {
        if (!cancelled) setTrending(data ?? []);
      })
      .catch(() => {
        // Non-blocking — empty state falls back to text prompt.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!sessionToken) return;
      const trimmed = q.trim();
      if (!trimmed) {
        setResults(null);
        setIsLoading(false);
        setError(null);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const data = await apiRequest<SearchResponse>(
          `/search/global?q=${encodeURIComponent(trimmed)}`,
          { token: sessionToken }
        );
        setResults(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
        setResults(null);
      } finally {
        setIsLoading(false);
      }
    },
    [sessionToken]
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(query), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  async function openTitle(entity_id: string) {
    if (!sessionToken) return;
    setModalVisible(true);
    setModalLoading(true);
    setModalTitle(null);
    try {
      const t = await fetchUniversalTitle(sessionToken, entity_id);
      setModalTitle(t);
    } catch {
      setModalVisible(false);
    } finally {
      setModalLoading(false);
    }
  }

  function handleItemPress(item: SearchResultItem) {
    if (item.entity_type === "movie" || item.entity_type === "series") {
      void openTitle(item.entity_id);
    } else if (item.entity_type === "person") {
      router.push(`/person/${item.entity_id}` as never);
    } else if (item.entity_type === "collection") {
      router.push(`/collections/${item.entity_id}`);
    } else if (item.entity_type === "team") {
      router.push(`/teams/${item.entity_id}` as never);
    }
    // list: no-op for now.
  }

  const hasQuery = query.trim().length > 0;
  const totalResults = useMemo(() => {
    if (!results) return 0;
    return (
      results.movies.length +
      results.series.length +
      results.people.length +
      results.collections.length +
      results.my_stuff.length
    );
  }, [results]);

  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SeenSnapHeader
          title="Search"
          subtitle="What are you looking for?"
          artworkSource={selectSafeBackdropAt(
            trending.map((t) => t.backdrop_url),
            3,
          )}
          fallbackSeed={2}
        />

        <View style={styles.searchBar}>
          <Ionicons name="search" size={16} color={colors.muted2} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Search movies, series, people…"
            placeholderTextColor={colors.muted2}
            value={query}
            onChangeText={setQuery}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {hasQuery ? (
            <Pressable onPress={() => setQuery("")} hitSlop={10}>
              <Ionicons name="close-circle" size={16} color={colors.muted2} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {!hasQuery ? (
            <View style={styles.discoveryEmpty}>
              <Text style={styles.discoveryPrompt}>
                What are you looking for tonight?
              </Text>
              {trending.length > 0 ? (
                <>
                  <Text style={styles.discoverySectionLabel}>TRENDING</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.trendingRail}
                    keyboardShouldPersistTaps="handled"
                  >
                    {trending.map((t) => (
                      <Pressable
                        key={t.id}
                        style={({ pressed }) => [
                          styles.trendingCard,
                          pressed && { opacity: 0.75 },
                        ]}
                        onPress={() => void openTitle(t.id)}
                      >
                        {t.poster_url ? (
                          <Image
                            source={{ uri: t.poster_url }}
                            style={styles.trendingPoster}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={[styles.trendingPoster, styles.trendingPosterFallback]}>
                            <Ionicons name="film" size={20} color={colors.muted2} />
                          </View>
                        )}
                        <Text style={styles.trendingTitleText} numberOfLines={2}>
                          {t.title}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
              ) : null}
            </View>
          ) : null}

          {hasQuery && isLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : null}

          {hasQuery && !isLoading && error ? (
            <View style={styles.empty}>
              <Text style={styles.emptyKicker}>ERROR</Text>
              <Text style={styles.emptyBody}>{error}</Text>
            </View>
          ) : null}

          {hasQuery && !isLoading && !error && results && totalResults === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyKicker}>NO RESULTS</Text>
              <Text style={styles.emptyTitle}>Nothing in the scene{"\n"}yet.</Text>
              <Text style={styles.emptyBody}>
                Check the spelling or try a different title, actor or director.
              </Text>
            </View>
          ) : null}

          {hasQuery && !isLoading && results ? (
            <>
              <ResultSection label="MOVIES" items={results.movies} onItemPress={handleItemPress} />
              <ResultSection label="SERIES" items={results.series} onItemPress={handleItemPress} />
              <ResultSection label="PEOPLE" items={results.people} onItemPress={handleItemPress} isPerson />
              <ResultSection
                label="COLLECTIONS"
                items={results.collections}
                onItemPress={handleItemPress}
              />
              <ResultSection
                label="MY STUFF"
                items={results.my_stuff}
                onItemPress={handleItemPress}
              />
            </>
          ) : null}

          <View style={{ height: spacing.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>

      <UniversalTitleModal
        visible={modalVisible}
        loading={modalLoading}
        title={modalTitle}
        onClose={() => {
          setModalVisible(false);
          setModalTitle(null);
        }}
      />
    </SafeAreaView>
  );
}

function ResultSection({
  label,
  items,
  onItemPress,
  isPerson = false,
}: {
  label: string;
  items: SearchResultItem[];
  onItemPress: (item: SearchResultItem) => void;
  isPerson?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <View style={styles.sectionRule} />
        <Text style={styles.sectionCount}>{items.length}</Text>
      </View>
      <View style={styles.list}>
        {items.map((item) => (
          <ResultRow
            key={`${item.entity_type}-${item.entity_id}`}
            item={item}
            isPerson={isPerson}
            onPress={() => onItemPress(item)}
          />
        ))}
      </View>
    </View>
  );
}

function ResultRow({
  item,
  isPerson,
  onPress,
}: {
  item: SearchResultItem;
  isPerson: boolean;
  onPress: () => void;
}) {
  const tappable = item.entity_type !== "list";
  return (
    <Pressable
      onPress={tappable ? onPress : undefined}
      style={({ pressed }) => [styles.row, pressed && tappable && styles.rowPressed]}
    >
      {item.artwork ? (
        <Image
          source={{ uri: item.artwork }}
          style={[styles.artwork, isPerson && styles.artworkPerson]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.artwork, isPerson && styles.artworkPerson, styles.artworkFallback]}>
          <Ionicons
            name={isPerson ? "person" : item.entity_type === "collection" ? "library" : "film"}
            size={16}
            color={colors.muted2}
          />
        </View>
      )}
      <View style={styles.rowMeta}>
        <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {[
            item.entity_type === "movie"
              ? "FILM"
              : item.entity_type === "series"
              ? "SERIES"
              : item.entity_type.toUpperCase(),
            item.year,
            item.subtitle,
          ]
            .filter(Boolean)
            .join("  ·  ")}
        </Text>
      </View>
      {tappable ? (
        <Ionicons name="chevron-forward" size={14} color={colors.muted2} />
      ) : (
        <Text style={styles.soonLabel}>SOON</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  eyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.8,
    color: colors.accent,
  },
  title: {
    fontFamily: fonts.serifBold,
    fontSize: 30,
    color: colors.ink,
    marginTop: 2,
    letterSpacing: -0.5,
  },
  searchBar: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.ink,
    paddingVertical: 0,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  discoveryEmpty: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  discoveryPrompt: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 18,
    lineHeight: 26,
    color: colors.muted,
  },
  discoverySectionLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: colors.accent,
    marginTop: spacing.md,
  },
  trendingRail: {
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  trendingCard: {
    width: 108,
    gap: 6,
  },
  trendingPoster: {
    width: 108,
    height: 162,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  trendingPosterFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.backgroundElevated,
  },
  trendingTitleText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 11,
    lineHeight: 15,
    color: colors.ink,
  },
  empty: {
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  emptyKicker: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: colors.accent,
  },
  emptyTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 28,
    lineHeight: 32,
    color: colors.ink,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 22,
    color: colors.muted,
    marginTop: spacing.xs,
  },
  loading: {
    paddingTop: spacing.xl,
    alignItems: "center",
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: colors.accent,
  },
  sectionRule: {
    flex: 1,
    height: 1,
    backgroundColor: rules.default,
  },
  sectionCount: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.muted2,
  },
  list: {
    gap: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
  },
  rowPressed: { opacity: 0.7 },
  artwork: {
    width: 42,
    height: 62,
    borderRadius: radii.sm,
    backgroundColor: colors.backgroundElevated,
  },
  artworkPerson: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
  },
  artworkFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  rowMeta: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    color: colors.ink,
    lineHeight: 18,
  },
  rowSubtitle: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.4,
    color: colors.muted2,
  },
  soonLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.2,
    color: colors.muted2,
  },
});
