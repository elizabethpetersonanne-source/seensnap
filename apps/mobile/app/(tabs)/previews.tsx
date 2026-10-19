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
import { router, useLocalSearchParams } from "expo-router";
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
import YouTubePlayerComponent from "@/components/youtube-player";

import { AppHeader } from "@/components/headers/app-header";
import { CategoryChips, type CategoryFilter } from "@/components/category-chips";
import { OutlineActionRail } from "@/components/outline-action-rail";
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

// Platform-split YouTube player: web renders a raw <iframe> with
// IFrame API postMessage mute toggle; native renders via
// react-native-youtube-iframe (brief §3 fix 1 — real native playback).
// See src/components/youtube-player.tsx + youtube-player.native.tsx.
const YouTubeEmbed = YouTubePlayerComponent;

export default function PreviewsScreen() {
  const { sessionToken } = useAuth();
  const insets = useSafeAreaInsets();
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  // Sep-22 brief §14 "Watch previews": when launched from a ranked
  // list, the feed follows the OWNER'S order (not the viewer's
  // personalization). ranked_source="me" pulls from /me/favorites,
  // ranked_source=<user_id> pulls from /profiles/{id}/favorites/ranked.
  const params = useLocalSearchParams<{ ranked_source?: string }>();
  const rankedSource = params.ranked_source ?? null;

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
      // Sep-22 brief §14 list-order mode: fetch the ranked list first,
      // then resolve videos for each title in order. Category chips +
      // personalization are intentionally ignored — this is the
      // OWNER'S order, not a personalized re-rank.
      if (rankedSource) {
        const listUrl =
          rankedSource === "me"
            ? "/me/favorites/ranked?limit=100"
            : `/profiles/${rankedSource}/favorites/ranked?limit=100`;
        const listData = await apiRequest<{ items: { title_id: string }[] }>(listUrl, {
          token: sessionToken,
        });
        const orderedIds = listData.items.map((r) => r.title_id).join(",");
        if (!orderedIds) {
          setItems([]);
          setActiveIndex(0);
          setCursor(null);
          setHasMore(false);
          setFeedStatus("exhausted");
          return;
        }
        const listResp = await apiRequest<{ items: PreviewFeedItem[]; skipped_title_ids: string[] }>(
          `/previews/for-titles?ids=${encodeURIComponent(orderedIds)}`,
          { token: sessionToken },
        );
        setItems(listResp.items);
        setActiveIndex(0);
        setCursor(null);
        setHasMore(false);
        setFeedStatus(listResp.items.length > 0 ? "ready" : "exhausted");
        trackEvent("previews_feed_ranked_loaded", {
          source: rankedSource,
          count: listResp.items.length,
          skipped: listResp.skipped_title_ids.length,
        });
        return;
      }
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
  }, [sessionToken, rankedSource, categoryFilter.media_type, categoryFilter.genre]);

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
      <View style={styles.categoryOverlay}>
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
                        void openDetails(item.title_id);
                      }}
                      onTeam={() => {
                        trackEvent("preview_team_clicked", { title_id: item.title_id });
                        void openDetails(item.title_id);
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

      {/* Feed-position indicator + navigation controls — makes it
          obvious that the feed continues beyond the first card and
          gives keyboard / mouse users an explicit next/prev affordance.
          Hidden when loading / empty / error. */}
      {!loading && !error && items.length > 0 ? (
        <>
          <View style={[styles.positionBadge, { top: insets.top + 56 + 48 + 8 }]}>
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
