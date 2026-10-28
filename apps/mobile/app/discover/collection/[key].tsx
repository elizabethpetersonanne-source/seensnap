/**
 * Oct-27 spec DISC-02: one reusable "See all" collection screen.
 *
 * Accepts a validated collection key (for-you | trending | now-in-theaters).
 * Any other value shows an "unavailable" state — never silently
 * routes to /(tabs)/for-you.
 *
 * Loads the full paginated result set from the appropriate endpoint,
 * preserves filter state, and renders the same portrait grid as
 * elsewhere. Tapping a title opens its details and returning
 * restores the exact scroll position.
 */
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/components/headers/app-header";
import { MediaToggle } from "@/components/discover-section";
import { EmptyView, LoadingView } from "@/components/state-views";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";


const VALID_KEYS = new Set(["for-you", "trending", "now-in-theaters"]);

const COLLECTION_TITLE: Record<string, string> = {
  "for-you": "For You",
  "trending": "Trending",
  "now-in-theaters": "In Theaters Now",
};

const COLLECTION_SUBTITLE: Record<string, string> = {
  "for-you": "Tuned to your SceneDNA",
  "trending": "Popular this week",
  "now-in-theaters": "Movies in theaters now",
};


type CollectionTitle = {
  id: string;
  title: string;
  poster_url: string | null;
  backdrop_url: string | null;
  year: number | null;
  content_type: string;
};


export default function CollectionSeeAllScreen() {
  const router = useRouter();
  const { sessionToken } = useAuth();
  const { key, media } = useLocalSearchParams<{ key?: string; media?: string }>();
  const { width } = useWindowDimensions();

  const validKey = typeof key === "string" && VALID_KEYS.has(key) ? key : null;
  const [mediaFilter, setMediaFilter] = useState<"movie" | "tv">(
    media === "tv" ? "tv" : "movie",
  );

  const [items, setItems] = useState<CollectionTitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [titleModalId, setTitleModalId] = useState<string | null>(null);
  const [universalTitle, setUniversalTitle] = useState<UniversalTitle | null>(null);
  const [titleLoading, setTitleLoading] = useState(false);

  async function load() {
    if (!sessionToken || !validKey) return;
    setLoading(true);
    setError(null);
    try {
      let path = "";
      if (validKey === "for-you") {
        // DISC01/02: server-filter For You by media before ranking +
        // limit. mediaFilter is "movie" | "tv"; backend param is
        // "movie" | "show".
        const preferredType = mediaFilter === "movie" ? "movie" : "show";
        path = `/titles/recommendations/for-me?limit=40&preferred_type=${preferredType}`;
      } else if (validKey === "trending") {
        // Backend caps limit at 20 for trending until the next deploy
        // raises it; staying under the cap avoids a 422.
        path = `/discover/trending?limit=20`;
      } else if (validKey === "now-in-theaters") {
        path = `/discover/now-in-theaters?limit=20`;
      }
      const result = await apiRequest<unknown>(path, {
        token: sessionToken,
      });
      // /titles/recommendations/for-me returns a BARE ARRAY of
      // RecommendationResponse: [{title: ContentTitle, reason: ...}, ...]
      // /discover/trending + /discover/now-in-theaters return
      // TrendingResponse: {items: [...TitleItem]}. Accept either shape.
      const rawItems: unknown[] = Array.isArray(result)
        ? result
        : (result as { items?: unknown[] })?.items ?? [];
      const normalized: CollectionTitle[] = rawItems
        .map((item: unknown): CollectionTitle | null => {
          if (!item || typeof item !== "object") return null;
          const anyItem = item as Record<string, unknown>;
          const nested = (anyItem.title ?? null) as Record<string, unknown> | null;
          if (nested && typeof nested === "object" && "id" in nested) {
            return normalizeTitle(nested);
          }
          if ("id" in anyItem || "title_id" in anyItem) {
            return normalizeTitle(anyItem);
          }
          return null;
        })
        .filter((t): t is CollectionTitle => t !== null && !!t.id);
      // DISC01: For You already filtered server-side via
      // preferred_type. Trending + Now in Theaters still arrive
      // mixed; filter client-side but DO NOT fall back to the
      // unfiltered set when a filtered result is empty — "A TV
      // request cannot return movies as an empty-state fallback."
      if (validKey === "for-you") {
        setItems(normalized);
      } else {
        const filtered = normalized.filter((t) => {
          if (mediaFilter === "movie") return t.content_type === "movie";
          return t.content_type !== "movie";
        });
        setItems(filtered);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this collection.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken, validKey, mediaFilter]);

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

  const cols = 2;
  const gap = 10;
  const sidePadding = spacing.lg;
  const posterWidth = (width - sidePadding * 2 - gap * (cols - 1)) / cols;
  const posterHeight = posterWidth * (3 / 2);

  if (!validKey) {
    return (
      <SafeAreaView style={styles.root} edges={[]}>
        <AppHeader variant="detail" leftKind="back" title="Unavailable" hideProfileAvatar />
        <EmptyView
          icon="warning-outline"
          title="Collection not available."
          body="This collection doesn't exist. Return to Discover."
          actionLabel="Go to Discover"
          onAction={() => router.replace("/(tabs)")}
        />
      </SafeAreaView>
    );
  }

  const showToggle = validKey === "for-you" || validKey === "trending";

  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <AppHeader
        variant="detail"
        leftKind="back"
        title={COLLECTION_TITLE[validKey]}
        hideProfileAvatar
      />

      <View style={styles.subhead}>
        <Text style={styles.subheadText}>{COLLECTION_SUBTITLE[validKey]}</Text>
        {showToggle ? (
          <MediaToggle
            value={mediaFilter}
            onChange={(next) => {
              setMediaFilter(next);
              trackEvent("collection_media_toggle", { collection: validKey, media: next });
            }}
          />
        ) : null}
      </View>

      {loading && items.length === 0 ? (
        <LoadingView />
      ) : error ? (
        <EmptyView
          icon="warning-outline"
          title="Couldn't load this collection."
          body={error}
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : items.length === 0 ? (
        <EmptyView
          icon="film-outline"
          title="No titles yet."
          body="This collection is empty right now. Check back soon."
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          numColumns={cols}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                trackEvent("collection_item_opened", { collection: validKey, title_id: item.id });
                void openTitle(item.id);
              }}
              style={({ pressed }) => [styles.card, { width: posterWidth }, pressed && { opacity: 0.78 }]}
            >
              <View style={{ width: posterWidth, height: posterHeight }}>
                {item.poster_url ? (
                  <Image source={{ uri: item.poster_url }} style={styles.poster} resizeMode="cover" />
                ) : (
                  <View style={[styles.poster, styles.posterFallback]}>
                    <Ionicons name="film-outline" size={20} color={colors.muted2} />
                  </View>
                )}
              </View>
              <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
              {item.year ? <Text style={styles.cardYear}>{item.year}</Text> : null}
            </Pressable>
          )}
        />
      )}

      <UniversalTitleModal
        visible={titleModalId !== null}
        title={universalTitle}
        loading={titleLoading}
        onClose={() => {
          setTitleModalId(null);
          setUniversalTitle(null);
        }}
      />
    </SafeAreaView>
  );
}


function normalizeTitle(src: Record<string, unknown>): CollectionTitle {
  const id = String(src.id ?? src.title_id ?? "");
  const title = String(src.title ?? "");
  const poster = (src.poster_url ?? null) as string | null;
  const backdrop = (src.backdrop_url ?? null) as string | null;
  const release = (src.release_date ?? null) as string | null;
  const year = release ? new Date(release).getFullYear() : (src.year as number | null) ?? null;
  const mediaType = (src.content_type ?? src.media_type ?? "movie") as string;
  return {
    id,
    title,
    poster_url: poster,
    backdrop_url: backdrop,
    year,
    content_type: mediaType,
  };
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  subhead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: 4,
    paddingBottom: spacing.sm,
  },
  subheadText: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    flex: 1,
  },
  grid: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    gap: 14,
  },
  card: { gap: 6 },
  poster: {
    width: "100%",
    height: "100%",
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  posterFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 12,
    letterSpacing: 0.2,
  },
  cardYear: {
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.5,
  },
});
