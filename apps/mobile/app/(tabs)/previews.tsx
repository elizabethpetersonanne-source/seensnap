/**
 * Previews — Previews spec §7 MVP.
 *
 * Vertical-snapping feed of official teasers/trailers. Each card is
 * a YouTube embed (autoplay + muted on entry; user can unmute to
 * satisfy autoplay policy). Save + open-details wired through the
 * existing sheets so nothing forks the title-action model.
 *
 * Deferred (spec §21 Phase 1.1+):
 *   - Send / share / add-to-team actions (using existing sheets when
 *     I re-open them here in the follow-up commit).
 *   - Structured preview_events analytics (currently uses trackEvent
 *     for impression / play / save-clicked).
 *   - Wi-Fi-only + reduced-motion autoplay preferences.
 *   - End-of-video Replay/Save/Next hold overlay.
 *   - Preview-engagement fast-changing profile (feed adapts only via
 *     the main recommendation engine for now).
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
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

import { CategoryChips, type CategoryFilter } from "@/components/category-chips";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
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

// Sep-22 brief §5: mute toggle must not rebuild the iframe. Keep the
// `mute` param out of the URL so state changes don't re-source the
// player, then drive mute/unmute via the YouTube IFrame API's
// postMessage command channel. Start-muted is still needed for the
// initial autoplay policy — that comes from `mute=1` on the initial
// src only, and only the FIRST render for a given key.
function youtubeEmbedUrl(key: string, autoplay: boolean, initialMuted: boolean): string {
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    mute: initialMuted ? "1" : "0",
    playsinline: "1",
    modestbranding: "1",
    rel: "0",
    enablejsapi: "1",
    // Origin is required by YouTube for postMessage command delivery;
    // omitted here because we render off `window.location.origin`
    // when available (see the embed HTML below).
  });
  return `https://www.youtube.com/embed/${key}?${params.toString()}`;
}

function YouTubeEmbed({
  videoKey,
  isActive,
  muted,
  width,
  height,
}: {
  videoKey: string;
  isActive: boolean;
  muted: boolean;
  width: number;
  height: number;
}) {
  // Ref that survives re-renders, only null when the iframe hasn't
  // mounted yet. `mute` state changes toggle via postMessage below,
  // NOT by re-rendering the iframe.
  const iframeIdRef = useRef<string>(`yt-${videoKey}-${Math.random().toString(36).slice(2, 8)}`);
  const iframeId = iframeIdRef.current;

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!isActive) return;
    const el = (typeof document !== "undefined" ? document.getElementById(iframeId) : null) as HTMLIFrameElement | null;
    if (!el || !el.contentWindow) return;
    // YouTube IFrame API accepts JSON-string postMessage commands.
    // "mute" / "unMute" toggle without touching the current time, so
    // the timestamp is preserved across taps of the sound button.
    const cmd = muted ? "mute" : "unMute";
    try {
      el.contentWindow.postMessage(
        JSON.stringify({ event: "command", func: cmd, args: [] }),
        "*",
      );
    } catch {
      // No-op — if the iframe isn't ready yet, the next re-mount will
      // pick up the correct initial muted state via the URL.
    }
  }, [muted, isActive, iframeId]);

  if (Platform.OS === "web") {
    if (!isActive) {
      return <View style={{ width, height, backgroundColor: "#000" }} />;
    }
    // src is STABLE per videoKey — mute state does NOT re-source.
    const src = youtubeEmbedUrl(videoKey, true, true);
    return (
      <View style={{ width, height, overflow: "hidden", backgroundColor: "#000" }}>
        {/* eslint-disable-next-line react/no-danger */}
        <div
          style={{ width: "100%", height: "100%" }}
          dangerouslySetInnerHTML={{
            __html: `<iframe id="${iframeId}" src="${src}" style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`,
          }}
        />
      </View>
    );
  }
  return (
    <View style={{ width, height, backgroundColor: "#000", justifyContent: "center", alignItems: "center" }}>
      <Ionicons name="play-circle-outline" size={72} color={colors.accent} />
      <Text style={{ color: colors.muted, fontFamily: fonts.sans, marginTop: 8 }}>
        Native player coming in the next build.
      </Text>
    </View>
  );
}

export default function PreviewsScreen() {
  const { sessionToken } = useAuth();
  const insets = useSafeAreaInsets();
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();

  const [items, setItems] = useState<PreviewFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const seenImpressionsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<FlatList<PreviewFeedItem>>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>({ media_type: null, genre: null });
  // Cursor for the next page. null means the feed hasn't been fetched
  // yet OR the pool is exhausted (see hasMore below).
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedStatus, setFeedStatus] = useState<"ready" | "pending" | "exhausted">("ready");

  const RESERVED_BOTTOM_NAV = 66;
  const cardHeight = viewportHeight - insets.top - insets.bottom - RESERVED_BOTTOM_NAV;
  const videoWidth = Math.min(viewportWidth - 24, 720);
  const videoHeight = Math.min(cardHeight * 0.55, videoWidth * 0.5625);

  const loadFeed = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ limit: "25" });
      if (categoryFilter.media_type) p.set("preferred_type", categoryFilter.media_type);
      if (categoryFilter.genre) p.set("genre", categoryFilter.genre);
      const resp = await apiRequest<PreviewFeedResponse>(`/previews/feed?${p.toString()}`, {
        token: sessionToken,
      });
      setItems(resp.items);
      setActiveIndex(0);
      setCursor(resp.next_cursor);
      setHasMore(resp.has_more);
      setFeedStatus(resp.status);
      trackEvent("previews_feed_loaded", { count: resp.items.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load previews.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken, categoryFilter.media_type, categoryFilter.genre]);

  // Continuation fetch — appends to the end of the current list.
  // Called when the user is ~5 items away from the tail per §4.
  const loadMore = useCallback(async () => {
    if (!sessionToken || !hasMore || loadingMore || !cursor) return;
    setLoadingMore(true);
    try {
      const p = new URLSearchParams({ limit: "25", cursor });
      if (categoryFilter.media_type) p.set("preferred_type", categoryFilter.media_type);
      if (categoryFilter.genre) p.set("genre", categoryFilter.genre);
      const resp = await apiRequest<PreviewFeedResponse>(`/previews/feed?${p.toString()}`, {
        token: sessionToken,
      });
      setItems((prev) => {
        // Append + dedupe by feed_item_id so a late duplicate can't
        // jump the viewport per §4 "append without jumping".
        const seen = new Set(prev.map((it) => it.feed_item_id));
        const merged = [...prev];
        for (const it of resp.items) {
          if (!seen.has(it.feed_item_id)) merged.push(it);
        }
        return merged;
      });
      setCursor(resp.next_cursor);
      setHasMore(resp.has_more);
      setFeedStatus(resp.status);
      trackEvent("previews_feed_more", { added: resp.items.length, has_more: resp.has_more });
    } catch (e) {
      trackEvent("previews_feed_more_error", {});
    } finally {
      setLoadingMore(false);
    }
  }, [sessionToken, cursor, hasMore, loadingMore, categoryFilter.media_type, categoryFilter.genre]);

  // Prefetch when ~5 items remain per spec §4.
  useEffect(() => {
    if (items.length === 0) return;
    if (activeIndex >= items.length - 5 && hasMore && !loadingMore) {
      void loadMore();
    }
  }, [activeIndex, items.length, hasMore, loadingMore, loadMore]);

  useFocusEffect(
    useCallback(() => {
      if (items.length === 0) void loadFeed();
    }, [items.length, loadFeed]),
  );

  // Reload when the filter changes (independent of first-mount focus).
  useEffect(() => {
    setItems([]);
    setActiveIndex(0);
    seenImpressionsRef.current = new Set();
    void loadFeed();
    // loadFeed is stable per (sessionToken, filter); intentionally
    // not putting loadFeed itself in the deps to keep this a filter
    // watcher, not a general-purpose reloader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryFilter.media_type, categoryFilter.genre]);

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
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      {/* Mirror-image Swipe|Previews mode toggle per Sep-22 brief §1.
          Tapping Swipe returns to the /swipe route without unmounting
          Previews' queue (both screens live in the same tabs stack). */}
      <View style={styles.modeToggleRow}>
        <Pressable
          style={styles.modeChip}
          onPress={() => router.push("/swipe")}
          accessibilityRole="button"
          accessibilityLabel="Switch to Swipe"
        >
          <Ionicons name="layers-outline" size={14} color={colors.ink} />
          <Text style={styles.modeChipText}>Swipe</Text>
        </Pressable>
        <View style={[styles.modeChip, styles.modeChipActive]}>
          <Ionicons name="play-circle" size={14} color={colors.background} />
          <Text style={styles.modeChipTextActive}>Previews</Text>
        </View>
      </View>
      {/* Category chips row — same component the Swipe screen uses so
          filter semantics are identical across the two discovery modes.
          Positioned as a floating overlay so it doesn't shrink the
          paging viewport. */}
      <View style={[styles.categoryOverlay, { top: insets.top + 12 + 40 + 36 }]}>
        <CategoryChips value={categoryFilter} onChange={setCategoryFilter} />
      </View>
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
            Save a few titles or swipe through some picks so we know what to line up here.
          </Text>
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
            const isActive = index === activeIndex;
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
                    />
                  </View>
                  <View style={styles.meta}>
                    <Text style={styles.videoBadge}>
                      {item.video.type.toUpperCase()}
                      {item.video.official ? "  ·  OFFICIAL" : ""}
                    </Text>
                    <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
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
                    <Pressable
                      style={styles.actionPrimary}
                      onPress={() => {
                        setSaveTitleId(item.title_id);
                        setShowSaveSheet(true);
                        trackEvent("preview_save_clicked", { title_id: item.title_id });
                      }}
                    >
                      <Ionicons name="bookmark-outline" size={18} color={colors.background} />
                      <Text style={styles.actionPrimaryText}>Save</Text>
                    </Pressable>
                    <Pressable
                      style={styles.actionSecondary}
                      onPress={() => void openDetails(item.title_id)}
                    >
                      <Ionicons name="information-circle-outline" size={18} color={colors.ink} />
                      <Text style={styles.actionSecondaryText}>Details</Text>
                    </Pressable>
                    <Pressable
                      style={styles.actionSecondary}
                      onPress={() => setMuted((m) => !m)}
                      accessibilityLabel={muted ? "Unmute preview" : "Mute preview"}
                    >
                      <Ionicons
                        name={muted ? "volume-mute-outline" : "volume-high-outline"}
                        size={18}
                        color={colors.ink}
                      />
                      <Text style={styles.actionSecondaryText}>{muted ? "Sound" : "Mute"}</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      {/* Feed-position indicator + navigation controls — makes it
          obvious that the feed continues beyond the first card and
          gives keyboard / mouse users an explicit next/prev affordance.
          Hidden when loading / empty / error. */}
      {!loading && !error && items.length > 0 ? (
        <>
          <View style={[styles.positionBadge, { top: insets.top + 12 + 40 }]}>
            <Text style={styles.positionBadgeText}>
              {activeIndex + 1} / {items.length}
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
          ) : null}
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
    position: "absolute",
    left: 12,
    right: 12,
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
    flexDirection: "row",
    gap: 10,
    width: "100%",
    maxWidth: 720,
    marginTop: 8,
    paddingHorizontal: 4,
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
