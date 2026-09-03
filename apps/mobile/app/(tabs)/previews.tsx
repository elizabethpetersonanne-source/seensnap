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
};

function youtubeEmbedUrl(key: string, autoplay: boolean, muted: boolean): string {
  // playsinline=1 keeps playback inside the frame on iOS Safari.
  // modestbranding=1 hides the YouTube ribbon; rel=0 keeps end-card
  // recommendations restricted to the same channel per YouTube API
  // params spec (which is the least-worst behavior without a paid
  // player). enablejsapi=1 in case a future commit wants IFrame API
  // control (mute/pause).
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    mute: muted ? "1" : "0",
    playsinline: "1",
    modestbranding: "1",
    rel: "0",
    enablejsapi: "1",
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
  if (Platform.OS === "web") {
    // Native <iframe> for web — RN-Web will render the tag as-is when
    // we render it via createElement. We use a React fragment escape
    // through a dangerouslySetInnerHTML div because JSX doesn't have
    // an <iframe> component here. Only the ACTIVE card should embed
    // to avoid multiple audio players (spec §7.3 "only one player
    // may be active at a time").
    if (!isActive) {
      return <View style={{ width, height, backgroundColor: "#000" }} />;
    }
    const src = youtubeEmbedUrl(videoKey, true, muted);
    return (
      <View style={{ width, height, overflow: "hidden", backgroundColor: "#000" }}>
        {/* eslint-disable-next-line react/no-danger */}
        <div
          style={{ width: "100%", height: "100%" }}
          dangerouslySetInnerHTML={{
            __html: `<iframe src="${src}" style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`,
          }}
        />
      </View>
    );
  }
  // Native — MVP shows a placeholder until we wire in expo-web-browser
  // or react-native-youtube-iframe. Native previews ship in Phase 1.1
  // once the web target is proven.
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

  const RESERVED_BOTTOM_NAV = 66;
  const cardHeight = viewportHeight - insets.top - insets.bottom - RESERVED_BOTTOM_NAV;
  const videoWidth = Math.min(viewportWidth - 24, 720);
  const videoHeight = Math.min(cardHeight * 0.55, videoWidth * 0.5625);

  const loadFeed = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      // Ask for 25 — the backend over-fetches candidates 3x on top of
      // this because many recs don't have TMDB videos, but 25 keeps
      // the feed feeling deep even if only a fraction resolve.
      const resp = await apiRequest<PreviewFeedResponse>("/previews/feed?limit=25", {
        token: sessionToken,
      });
      setItems(resp.items);
      setActiveIndex(0);
      trackEvent("previews_feed_loaded", { count: resp.items.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load previews.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useFocusEffect(
    useCallback(() => {
      if (items.length === 0) void loadFeed();
    }, [items.length, loadFeed]),
  );

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
          <View style={[styles.positionBadge, { top: insets.top + 12 }]}>
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
            <View
              style={[styles.firstUseHint, { bottom: 66 + insets.bottom + 78 }]}
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
