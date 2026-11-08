import { SceneDnaBadge } from "@/components/scene-dna-badge";
/** Continuous previews with shared filters, stable list order and direct title actions. */
import { usePlaybackMute } from "@/lib/playback-preference";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import YouTubePlayerComponent from "@/components/youtube-player";

import { AppHeader } from "@/components/headers/app-header";
import { CategoryChips, type CategoryFilter } from "@/components/category-chips";
import { useDiscoveryFilter } from "@/lib/discovery-filter";
import { OutlineActionRail } from "@/components/outline-action-rail";
import { TitleActionSheets, type TitleActionTarget } from "@/components/title-action-sheets";
import { subscribeTitleState } from "@/lib/title-state";
import { subscribeRatingChanges } from "@/components/rating-editor";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { apiRequest, ApiError, resolveMediaUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

type PreviewVideo = {
  provider: string;
  external_key: string;
  type: string;
  name: string;
  official: boolean;
};

type PreviewReason = { type: string; label: string };

type PreviewFeedItem = {
  feed_item_id: string;
  title_id: string;
  tmdb_id: number;
  media_type: string;
  title: string;
  year: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  video: PreviewVideo;
  reason: PreviewReason;
};

type PreviewFeedResponse = {
  session_id: string;
  items: PreviewFeedItem[];
  next_cursor: string | null;
  has_more: boolean;
  status: "ready" | "pending" | "exhausted";
};

// Platform-split YouTube player: web renders a raw <iframe> with
// IFrame API postMessage mute toggle; native renders via
// react-native-youtube-iframe (brief §3 fix 1 — real native playback).
// See src/components/youtube-player.tsx + youtube-player.native.tsx.
const YouTubeEmbed = YouTubePlayerComponent;

export default function PreviewsScreen() {
  const { sessionToken, user } = useAuth();
  const focused = useIsFocused();
  const [actionTarget, setActionTarget] = useState<TitleActionTarget | null>(null);
  const insets = useSafeAreaInsets();
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  // Sep-22 brief §14 "Watch previews": when launched from a ranked
  // list, the feed follows the OWNER'S order (not the viewer's
  // personalization). ranked_source="me" pulls from /me/favorites,
  // ranked_source=<user_id> pulls from /profiles/{id}/favorites/ranked.
  const params = useLocalSearchParams<{ ranked_source?: string; list_id?: string; owner_id?: string }>();
  const rankedSource = params.ranked_source ?? null;
  const listId = params.list_id ?? null;
  // When list_id is set AND owner_id is a different user, we fetch
  // via the viewer-aware /profiles/{owner_id}/lists/{list_id} path.
  // Omitting owner_id (or passing self) uses /me/watchlist/lists/{id}.
  const listOwnerId = params.owner_id ?? null;

  const [items, setItems] = useState<PreviewFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = usePlaybackMute();
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const seenImpressionsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<FlatList<PreviewFeedItem>>(null);
  // W09: shared Swipe/Preview filter session. Picking Comedy on
  // Swipe propagates here and vice versa.
  const [categoryFilter, setCategoryFilter, filterReady] = useDiscoveryFilter();
  const generationRef = useRef(0);
  const pageRequestRef = useRef<number | null>(null);
  const emptyPagesRef = useRef(0);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Cursor for the next page. null means the feed hasn't been fetched
  // yet OR the pool is exhausted (see hasMore below).
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedStatus, setFeedStatus] = useState<"ready" | "pending" | "exhausted">("ready");

  const [availableHeight, setAvailableHeight] = useState(0);
  const cardHeight = availableHeight || Math.max(320, viewportHeight - insets.top - insets.bottom - 180);
  const videoWidth = Math.min(viewportWidth - 24, 720, Math.max(200, cardHeight * 0.48) * 16 / 9);
  const videoHeight = videoWidth * 9 / 16;

  const fetchPage = useCallback(async (nextCursor: string | null): Promise<PreviewFeedResponse> => {
    if (rankedSource || listId) {
      const offset = Number(nextCursor?.replace("list:", "") ?? 0);
      const ownList = !!listId && (!listOwnerId || listOwnerId === "me" || listOwnerId === user?.user_id);
      const url = listId
        ? ownList ? `/me/watchlist/lists/${listId}` : `/profiles/${listOwnerId}/lists/${listId}?limit=20&offset=${offset}`
        : rankedSource === "me" ? `/me/favorites/ranked?limit=20&offset=${offset}`
          : `/profiles/${rankedSource}/favorites/ranked?limit=20&offset=${offset}`;
      const raw = await apiRequest<{ items: { title_id?: string; content_title_id?: string }[]; total?: number; item_count?: number }>(url, { token: sessionToken });
      const rows = ownList ? raw.items.slice(offset, offset + 20) : raw.items;
      const ids = rows.map((row) => row.title_id ?? row.content_title_id).filter(Boolean);
      const total = raw.total ?? raw.item_count ?? raw.items.length;
      const nextOffset = offset + rows.length;
      const more = rows.length > 0 && nextOffset < total;
      const resolved = ids.length ? await apiRequest<{ items: PreviewFeedItem[] }>(
        `/previews/for-titles?ids=${encodeURIComponent(ids.join(","))}`, { token: sessionToken, timeoutMs: 90000 },
      ) : { items: [] };
      return { session_id: `list:${listId ?? rankedSource}`, items: resolved.items,
        next_cursor: more ? `list:${nextOffset}` : null, has_more: more,
        status: resolved.items.length ? "ready" : more ? "pending" : "exhausted" };
    }
    const query = new URLSearchParams({ limit: "20" });
    if (categoryFilter.media_type) query.set("preferred_type", categoryFilter.media_type);
    if (categoryFilter.genre) query.set("genre", categoryFilter.genre);
    if (nextCursor) query.set("cursor", nextCursor);
    return apiRequest<PreviewFeedResponse>(`/previews/feed?${query}`, { token: sessionToken, timeoutMs: 90000 });
  }, [sessionToken, user?.user_id, listId, listOwnerId, rankedSource, categoryFilter.media_type, categoryFilter.genre]);

  const loadFeed = useCallback(async () => {
    if (!sessionToken || !filterReady) return;
    const generation = ++generationRef.current;
    pageRequestRef.current = null; emptyPagesRef.current = 0;
    setItems([]); setActiveIndex(0); setCursor(null); setLoadingMore(false);
    setLoading(true); setError(null); setMoreError(null);
    seenImpressionsRef.current.clear();
    try {
      const response = await fetchPage(null);
      if (generation !== generationRef.current) return;
      setItems(response.items); setCursor(response.next_cursor);
      setHasMore(response.has_more); setFeedStatus(response.status);
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    } catch (e) {
      if (generation === generationRef.current) setError(e instanceof Error ? e.message : "Couldn't load previews.");
    } finally { if (generation === generationRef.current) setLoading(false); }
  }, [sessionToken, filterReady, fetchPage]);

  useEffect(() => { void loadFeed(); return () => { generationRef.current++; }; }, [loadFeed]);

  const loadMore = useCallback(async () => {
    if (!sessionToken || !cursor || !hasMore || pageRequestRef.current !== null) return;
    const generation = generationRef.current;
    pageRequestRef.current = generation; setLoadingMore(true); setMoreError(null);
    try {
      const response = await fetchPage(cursor);
      if (generation !== generationRef.current) return;
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.title_id));
        return [...previous, ...response.items.filter((item) => {
          if (seen.has(item.title_id)) return false;
          seen.add(item.title_id); return true;
        })];
      });
      setCursor(response.next_cursor); setHasMore(response.has_more); setFeedStatus(response.status);
      emptyPagesRef.current = response.items.length ? 0 : emptyPagesRef.current + 1;
      if (emptyPagesRef.current >= 3 && response.has_more) setMoreError("Still looking for playable previews. Tap Continue to search further.");
    } catch (e) {
      if (generation === generationRef.current) {
        if (e instanceof ApiError && e.status === 409) { setCursor(null); setHasMore(false); }
        setMoreError(e instanceof Error ? e.message : "Couldn't load more previews. Retry keeps your filters.");
      }
    } finally {
      if (pageRequestRef.current === generation) { pageRequestRef.current = null; setLoadingMore(false); }
    }
  }, [sessionToken, cursor, hasMore, fetchPage]);

  useEffect(() => {
    if (!loading && !error && !moreError && !loadingMore && hasMore && activeIndex >= items.length - 5) void loadMore();
  }, [loading, error, moreError, loadingMore, hasMore, activeIndex, items.length, loadMore]);

  useEffect(() => {
    if (rankedSource || listId) return;
    const remove = (id: string) => setItems((previous) => previous.filter((item, index) => index <= activeIndex || item.title_id !== id));
    const stopState = subscribeTitleState((state) => { if (state.saved || state.watched) remove(state.title_id); });
    const stopRating = subscribeRatingChanges((id, state) => { if (state.watched_state === "watched") remove(id); });
    return () => { stopState(); stopRating(); };
  }, [activeIndex, rankedSource, listId]);

  // Impression event when a card becomes active — spec §12 events.
  useEffect(() => {
    const item = items[activeIndex];
    if (!item) return;
    const key = item.feed_item_id;
    if (seenImpressionsRef.current.has(key)) return;
    seenImpressionsRef.current.add(key);
    trackEvent("preview_impression", {
      feed_item_id: item.feed_item_id,
      title_id: item.title_id,
      video_provider: item.video.provider,
      video_key: item.video.external_key,
      video_type: item.video.type,
    });
  }, [activeIndex, items]);

  function handleViewableChange(ev: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = ev.nativeEvent.contentOffset.y;
    const next = Math.round(y / cardHeight);
    if (next !== activeIndex && next >= 0 && next < items.length) {
      setActiveIndex(next);
    }
  }

  async function openDetails(titleId: string) {
    if (!sessionToken) return;
    setShowDetails(true);
    setDetailLoading(true);
    setDetailTitle(null);
    trackEvent("preview_details_opened", { title_id: titleId });
    try {
      const detail = await fetchUniversalTitle(sessionToken, titleId);
      setDetailTitle(detail);
    } catch {
      setDetailTitle(null);
    } finally {
      setDetailLoading(false);
    }
  }

  const emptyState = !loading && !error && items.length === 0;

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      {/* Oct-19 Header Standardization: shared immersive AppHeader.
          Same selector instance + metrics as Swipe. */}
      <AppHeader
        variant="immersive"
        mode="preview"
        onModeChange={(next) => {
          if (next === "swipe") router.push("/swipe");
        }}
      />
      {/* Category chips below the header. No magic absolute offsets. */}
      {!rankedSource && !listId ? <View style={styles.categoryOverlay}>
        <CategoryChips value={categoryFilter} onChange={setCategoryFilter} />
      </View> : null}
      {moreError ? <Pressable onPress={() => void (cursor ? loadMore() : loadFeed())} style={{ padding: 12, minHeight: 44 }}>
        <Text style={styles.errorText}>{moreError} Continue</Text>
      </Pressable> : null}
      <View style={{ flex: 1 }} onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.centerHint}>Finding something worth watching…</Text>
        </View>
      ) : error ? (
        <View style={styles.centerFill}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void loadFeed()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : emptyState ? (
        <View style={styles.centerFill}>
          <Ionicons name="film-outline" size={40} color={colors.accent} />
          <Text style={styles.emptyTitle}>No previews yet</Text>
          <Text style={styles.emptyBody}>
            {loadingMore ? "Looking for more playable previews…" : hasMore ? "More titles are available to check." : "No more playable previews in this selection. Try another category."}
          </Text>
          {hasMore && !loadingMore ? <Pressable style={styles.retryBtn} onPress={() => void loadMore()}><Text style={styles.retryText}>Continue</Text></Pressable> : null}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(item) => item.feed_item_id}
          pagingEnabled
          snapToInterval={cardHeight}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          onScroll={handleViewableChange}
          scrollEventThrottle={100}
          getItemLayout={(_, index) => ({ length: cardHeight, offset: cardHeight * index, index })}
          renderItem={({ item, index }) => {
            const isActive = focused && !showDetails && !showSaveSheet && !actionTarget && index === activeIndex;
            const backdrop = resolveMediaUrl(item.backdrop_url) ?? resolveMediaUrl(item.poster_url);
            return (
              <View style={[styles.card, { height: cardHeight }]}>
                {backdrop ? (
                  <Image
                    source={{ uri: backdrop }}
                    style={StyleSheet.absoluteFillObject}
                    resizeMode="cover"
                    blurRadius={40}
                  />
                ) : null}
                <View style={styles.cardShade} />
                <View style={styles.cardContent}>
                  <View style={styles.videoWrap}>
                    <YouTubeEmbed
                      videoKey={item.video.external_key}
                      isActive={isActive}
                      muted={muted}
                      width={videoWidth}
                      height={videoHeight}
                      // PRE-01: native YT controls are the fullscreen
                      // entry point — iOS presents a landscape-capable
                      // player when the user taps the FS icon.
                      showControls={isActive}
                    />
                  </View>
                  <View style={styles.meta}>
                    <Text style={styles.videoBadge}>
                      {item.video.type.toUpperCase()}
                      {item.video.official ? "  ·  OFFICIAL" : ""}
                    </Text>
                    <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
                    {isActive ? <SceneDnaBadge titleId={item.title_id} /> : null}
                    <Text style={styles.subMeta}>
                      {[
                        item.media_type === "movie" ? "FILM" : "SERIES",
                        item.year ?? "",
                      ]
                        .filter(Boolean)
                        .join("  ·  ")}
                    </Text>
                    <Text style={styles.reason} numberOfLines={2}>{item.reason.label}</Text>
                  </View>
                  <View style={styles.actionRow}>
                    {/* Oct-18 §4 OutlineActionRail: no backplates;
                        Save/Send/Team/Rate as outline-only icons. */}
                    <OutlineActionRail
                      variant="discovery"
                      token={sessionToken}
                      titleId={item.title_id}
                      saved={false}
                      onSave={() => {
                        setSaveTitleId(item.title_id);
                        setShowSaveSheet(true);
                        trackEvent("preview_save_clicked", { title_id: item.title_id });
                      }}
                      onSend={() => {
                        trackEvent("preview_send_clicked", { title_id: item.title_id });
                        setActionTarget({ action: "send", id: item.title_id, title: item.title, poster: item.poster_url });
                      }}
                      onTeam={() => {
                        trackEvent("preview_team_clicked", { title_id: item.title_id });
                        setActionTarget({ action: "team", id: item.title_id, title: item.title, poster: item.poster_url });
                      }}
                      ratingSnapshot={null}
                    />
                  </View>
                  <View style={styles.secondaryActionRow}>
                    <Pressable
                      hitSlop={10}
                      onPress={() => void openDetails(item.title_id)}
                      style={({ pressed }) => [styles.secondaryActionBtn, pressed && { opacity: 0.6 }]}
                    >
                      <Ionicons name="information-circle-outline" size={16} color={colors.ink} />
                      <Text style={styles.secondaryActionLabel}>Details</Text>
                    </Pressable>
                    <Pressable
                      hitSlop={10}
                      onPress={() => setMuted((m) => !m)}
                      accessibilityLabel={muted ? "Unmute preview" : "Mute preview"}
                      style={({ pressed }) => [styles.secondaryActionBtn, pressed && { opacity: 0.6 }]}
                    >
                      <Ionicons
                        name={muted ? "volume-mute-outline" : "volume-high-outline"}
                        size={16}
                        color={colors.ink}
                      />
                      <Text style={styles.secondaryActionLabel}>{muted ? "Sound" : "Mute"}</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      </View>
      {/* Feed-position indicator + navigation controls — makes it
          obvious that the feed continues beyond the first card and
          gives keyboard / mouse users an explicit next/prev affordance.
          Hidden when loading / empty / error. */}
      {!loading && !error && items.length > 0 ? (
        <>
          <View style={[styles.positionBadge, { top: insets.top + 56 + 48 + 8 }]}>
            <Text style={styles.positionBadgeText}>
              {activeIndex + 1}
            </Text>
          </View>
          {activeIndex > 0 ? (
            <Pressable
              style={[styles.navChevron, styles.navChevronTop, { top: insets.top + 12 }]}
              onPress={() => {
                const target = Math.max(0, activeIndex - 1);
                listRef.current?.scrollToIndex({ index: target, animated: true });
              }}
              accessibilityLabel="Previous preview"
            >
              <Ionicons name="chevron-up" size={22} color={colors.ink} />
            </Pressable>
          ) : null}
          {activeIndex < items.length - 1 ? (
            <Pressable
              style={[
                styles.navChevron,
                styles.navChevronBottom,
                { bottom: 66 + insets.bottom + 16 },
              ]}
              onPress={() => {
                const target = Math.min(items.length - 1, activeIndex + 1);
                listRef.current?.scrollToIndex({ index: target, animated: true });
              }}
              accessibilityLabel="Next preview"
            >
              <Ionicons name="chevron-down" size={22} color={colors.ink} />
            </Pressable>
          ) : (
            /* Last card: show a 'Load more previews' button so the user
                can refresh the feed instead of being stuck. */
            <Pressable
              style={[
                styles.loadMoreCta,
                { bottom: 66 + insets.bottom + 16 },
              ]}
              onPress={() => {
                trackEvent("previews_refresh_clicked", { items_seen: items.length });
                void (cursor && hasMore ? loadMore() : loadFeed());
              }}
              accessibilityLabel={hasMore ? "Load more previews" : "Refresh previews"}
            >
              <Ionicons name="refresh" size={16} color={colors.background} />
              <Text style={styles.loadMoreCtaLabel}>{loadingMore ? "LOADING…" : hasMore ? "CONTINUE" : "REFRESH"}</Text>
            </Pressable>
          )}
          {activeIndex === 0 ? (
            // Anchored to the TOP so it never covers the Save / Details /
            // Sound action row at the bottom of the card. Sits just below
            // the position badge and next to the up-chevron (which is
            // absent on card 1). The next chevron sits at the very bottom
            // so users still know to scroll.
            <View
              style={[styles.firstUseHint, { top: insets.top + 56 }]}
              pointerEvents="none"
            >
              <Ionicons name="arrow-down" size={14} color={colors.background} />
              <Text style={styles.firstUseHintText}>
                Scroll or tap ⌄ for the next preview
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      <TitleActionSheets target={actionTarget} token={sessionToken} source="previews" onClose={() => setActionTarget(null)} />
      <SaveToListSheet
        visible={showSaveSheet}
        titleId={saveTitleId}
        token={sessionToken}
        source="previews"
        onClose={() => setShowSaveSheet(false)}
      />
      <UniversalTitleModal
        visible={showDetails}
        loading={detailLoading}
        title={detailTitle}
        onClose={() => setShowDetails(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#000",
  },
  modeToggleRow: {
    position: "absolute",
    top: 12,
    left: 12,
    flexDirection: "row",
    gap: 8,
    zIndex: 10,
  },
  categoryOverlay: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    zIndex: 9,
  },
  modeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  modeChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  modeChipText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.ink,
    textTransform: "uppercase",
  },
  modeChipTextActive: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.background,
    textTransform: "uppercase",
  },
  centerFill: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  centerHint: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.muted,
    marginTop: 8,
  },
  errorText: {
    fontFamily: fonts.sans,
    color: colors.muted,
    textAlign: "center",
  },
  retryBtn: {
    minHeight: 44,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.pill,
  },
  retryText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.ink,
  },
  emptyTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
    maxWidth: 320,
  },
  card: {
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  cardShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  cardContent: {
    width: "100%",
    paddingHorizontal: 12,
    gap: 16,
    alignItems: "center",
  },
  videoWrap: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#000",
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  meta: {
    width: "100%",
    maxWidth: 720,
    gap: 6,
    paddingHorizontal: 4,
  },
  videoBadge: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.accent,
  },
  title: {
    fontFamily: fonts.serifBold,
    fontSize: 24,
    lineHeight: 28,
    color: colors.ink,
  },
  subMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.muted,
  },
  reason: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    marginTop: 4,
  },
  actionRow: {
    width: "100%",
    maxWidth: 720,
    marginTop: 8,
    paddingHorizontal: 4,
  },
  secondaryActionRow: {
    flexDirection: "row",
    gap: 14,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  secondaryActionBtn: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
  },
  secondaryActionLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.ink,
    textTransform: "uppercase",
  },
  actionPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    flex: 1.4,
    minHeight: 44,
    backgroundColor: colors.accent,
    borderRadius: 6,
  },
  actionPrimaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.background,
    textTransform: "uppercase",
  },
  actionSecondary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 6,
  },
  actionSecondaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.ink,
    textTransform: "uppercase",
  },
  positionBadge: {
    position: "absolute",
    right: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  positionBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.ink,
  },
  navChevron: {
    position: "absolute",
    left: 12,
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    justifyContent: "center",
    alignItems: "center",
  },
  navChevronTop: {},
  navChevronBottom: {},
  loadMoreCta: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.accent,
    zIndex: 10,
  },
  loadMoreCtaLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.background,
    fontSize: 12,
    letterSpacing: 1.1,
  },
  firstUseHint: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  firstUseHintText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.background,
  },
});
