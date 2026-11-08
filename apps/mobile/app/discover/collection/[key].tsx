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
import { useEffect, useRef, useState } from "react";
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
import { apiRequest, ApiError } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import {
  fetchUniversalTitle,
  type UniversalTitle,
} from "@/lib/universal-title";

const VALID_KEYS = new Set(["for-you", "trending", "now-in-theaters"]);

const COLLECTION_TITLE: Record<string, string> = {
  "for-you": "For You",
  trending: "Trending",
  "now-in-theaters": "In Theaters Now",
};

const COLLECTION_SUBTITLE: Record<string, string> = {
  "for-you": "Picks informed by your ratings and saves",
  trending: "Popular this week",
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
  const { key, media } = useLocalSearchParams<{
    key?: string;
    media?: string;
  }>();
  const { width } = useWindowDimensions();

  const validKey = typeof key === "string" && VALID_KEYS.has(key) ? key : null;
  const [mediaFilter, setMediaFilter] = useState<"movie" | "tv">(
    media === "tv" ? "tv" : "movie",
  );

  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [needsReset, setNeedsReset] = useState(false);
  const scope = `${sessionToken}|${validKey}|${mediaFilter}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const activeRequest = useRef<object | null>(null);
  const titleRequest = useRef(0);
  const [items, setItems] = useState<CollectionTitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [titleModalId, setTitleModalId] = useState<string | null>(null);
  const [universalTitle, setUniversalTitle] = useState<UniversalTitle | null>(
    null,
  );
  const [titleLoading, setTitleLoading] = useState(false);

  async function load(cursor: string | null = null) {
    if (!sessionToken || !validKey) return;
    const request = {};
    activeRequest.current = request;
    const ownerScope = scope;
    setLoading(true);
    setError(null);
    setNeedsReset(false);
    if (!cursor) {
      setItems([]);
      setNextCursor(null);
    }
    try {
      const result = await apiRequest<{
        items: Array<Record<string, unknown>>;
        next_cursor: string | null;
        display_label: string;
      }>(
        `/discover/collection/${validKey}?media=${mediaFilter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { token: sessionToken, timeoutMs: 50000 },
      );
      if (scopeRef.current !== ownerScope || activeRequest.current !== request)
        return;
      const incoming = result.items
        .map(normalizeTitle)
        .filter((t): t is CollectionTitle => !!t);
      setItems((previous) => [
        ...new Map(
          [...(cursor ? previous : []), ...incoming].map((t) => [t.id, t]),
        ).values(),
      ]);
      setNextCursor(result.next_cursor);
      setSourceLabel(result.display_label);
    } catch (err) {
      if (scopeRef.current !== ownerScope || activeRequest.current !== request)
        return;
      setNeedsReset(err instanceof ApiError && err.status === 409);
      setError("Couldn't load these titles. Please try again.");
    } finally {
      if (
        scopeRef.current === ownerScope &&
        activeRequest.current === request
      ) {
        setLoading(false);
        activeRequest.current = null;
      }
    }
  }

  useEffect(() => {
    setUniversalTitle(null);
    setTitleModalId(null);
    titleRequest.current++;
    setSourceLabel("");
    void load();
    return () => {
      activeRequest.current = null;
      titleRequest.current++;
    };
  }, [sessionToken, validKey, mediaFilter]);

  async function openTitle(titleId: string) {
    if (!sessionToken) return;
    const request = ++titleRequest.current,
      ownerScope = scope;
    setTitleModalId(titleId);
    setUniversalTitle(null);
    setTitleLoading(true);
    try {
      const detail = await fetchUniversalTitle(sessionToken, titleId);
      if (request === titleRequest.current && scopeRef.current === ownerScope)
        setUniversalTitle(detail);
    } catch {
      if (request === titleRequest.current) setUniversalTitle(null);
    } finally {
      if (request === titleRequest.current) setTitleLoading(false);
    }
  }

  const cols = Math.max(
    2,
    Math.min(5, Math.floor((width - spacing.lg * 2) / 160)),
  );
  const gap = 10;
  const sidePadding = spacing.lg;
  const posterWidth = (width - sidePadding * 2 - gap * (cols - 1)) / cols;
  const posterHeight = posterWidth * (3 / 2);

  if (!validKey) {
    return (
      <SafeAreaView style={styles.root} edges={[]}>
        <AppHeader
          variant="detail"
          leftKind="back"
          title="Unavailable"
          hideProfileAvatar
        />
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
        <Text style={styles.subheadText}>
          {sourceLabel || COLLECTION_SUBTITLE[validKey]}
        </Text>
        {showToggle ? (
          <MediaToggle
            value={mediaFilter}
            onChange={(next) => {
              setMediaFilter(next);
              trackEvent("collection_media_toggle", {
                collection: validKey,
                media: next,
              });
            }}
          />
        ) : null}
      </View>

      {loading && items.length === 0 ? (
        <LoadingView />
      ) : error && items.length === 0 ? (
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
          key={cols}
          ListFooterComponent={
            <View style={{ paddingVertical: 20, gap: 12 }}>
              {error ? (
                <Text accessibilityRole="alert" style={{ color: colors.muted }}>
                  {error}
                </Text>
              ) : null}
              {loading ? (
                <ActivityIndicator color={colors.accent} />
              ) : nextCursor || needsReset ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void load(needsReset ? null : nextCursor)}
                  style={{
                    minHeight: 44,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: colors.accent }}>
                    {needsReset
                      ? "Refresh collection"
                      : error
                        ? "Try again"
                        : "Load more"}
                  </Text>
                </Pressable>
              ) : (
                <Text style={{ color: colors.muted }}>
                  You're all caught up.
                </Text>
              )}
            </View>
          }
          data={items}
          keyExtractor={(item) => item.id}
          numColumns={cols}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                trackEvent("collection_item_opened", {
                  collection: validKey,
                  title_id: item.id,
                });
                void openTitle(item.id);
              }}
              style={({ pressed }) => [
                styles.card,
                { width: posterWidth },
                pressed && { opacity: 0.78 },
              ]}
            >
              <View style={{ width: posterWidth, height: posterHeight }}>
                {item.poster_url ? (
                  <Image
                    source={{ uri: item.poster_url }}
                    style={styles.poster}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[styles.poster, styles.posterFallback]}>
                    <Ionicons
                      name="film-outline"
                      size={20}
                      color={colors.muted2}
                    />
                  </View>
                )}
              </View>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {item.title}
              </Text>
              {item.year ? (
                <Text style={styles.cardYear}>{item.year}</Text>
              ) : null}
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
  const year = release
    ? new Date(release).getFullYear()
    : ((src.year as number | null) ?? null);
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
