import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Image,
  Linking,
  PanResponder,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AddToTeamSheet } from "@/components/add-to-team-sheet";
import { GoldButton } from "@/components/gold-button";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { WhatNextSkeleton } from "@/components/shimmer";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, radii, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { type StreamingAvailability, getStreamingServiceMeta } from "@/lib/streaming";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

type RecommendationItem = {
  title: {
    id: string;
    title: string;
    content_type: string;
    poster_url?: string | null;
    backdrop_url?: string | null;
    overview?: string | null;
    release_date?: string | null;
    genres?: string[];
    tmdb_rating?: number | null;
  };
  reason: string;
  seed_title_id?: string | null;
};

type SwipeDirection = "left" | "right" | "up";

type SwipeEvent = {
  item: RecommendationItem;
  direction: SwipeDirection;
  pauseMs: number;
};

type PreferencesResponse = {
  connected_streaming_services: string[];
};

const SWIPE_X_THRESHOLD = 110;
const SWIPE_UP_THRESHOLD = 100;
const SESSION_LENGTH = 20;
const SUPPRESSION_SWIPES = 50;

// Module-level — persists across re-renders and deck reloads within the app session.
const suppressedTitles = new Map<string, number>();
let globalSwipeCount = 0;

function applySuppression(items: RecommendationItem[]): RecommendationItem[] {
  return items.filter((item) => {
    const suppressedAt = suppressedTitles.get(item.title.id);
    return suppressedAt === undefined || globalSwipeCount - suppressedAt >= SUPPRESSION_SWIPES;
  });
}

function lightShuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default function WhatNextScreen() {
  const router = useRouter();
  const { genre: genreParam } = useLocalSearchParams<{ genre?: string }>();
  const { sessionToken } = useAuth();
  const [deck, setDeck] = useState<RecommendationItem[]>([]);
  const [detailCache, setDetailCache] = useState<Record<string, UniversalTitle>>({});
  const [preferredServices, setPreferredServices] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [swipes, setSwipes] = useState<SwipeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [addToTeamTitle, setAddToTeamTitle] = useState<{ id: string; title: string } | null>(null);
  const [showAddToTeam, setShowAddToTeam] = useState(false);
  const [sessionId, setSessionId] = useState(() => `what-next-${Date.now()}`);
  const pan = useRef(new Animated.ValueXY()).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const nextCardEntry = useRef(new Animated.Value(1)).current;
  const revealEntry = useRef(new Animated.Value(0)).current;
  const cardStartRef = useRef(Date.now());
  const currentIndexRef = useRef(0);
  const nextWatchListIdRef = useRef<string | null>(null);
  // Refs to always call latest versions from the stale panResponder closure
  const animateSwipeRef = useRef<(direction: SwipeDirection) => Promise<void>>(async () => {});
  const openDetailsForActiveRef = useRef<() => void>(() => {});
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTranslateY = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    currentIndexRef.current = currentIndex;
    cardStartRef.current = Date.now();
    pan.setValue({ x: 0, y: 0 });
    nextCardEntry.setValue(0.94);
    Animated.spring(nextCardEntry, { toValue: 1, bounciness: 8, speed: 14, useNativeDriver: false }).start();
  }, [currentIndex, pan, nextCardEntry]);

  useEffect(() => {
    async function loadDeck() {
      if (!sessionToken) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [items, preferences] = await Promise.all([
          apiRequest<RecommendationItem[]>("/titles/recommendations/for-me?limit=40", { token: sessionToken }),
          apiRequest<PreferencesResponse>("/me/preferences", { token: sessionToken }).catch(() => ({ connected_streaming_services: [] })),
        ]);
        const deduped = dedupeRecommendations(items);
        const suppressed = applySuppression(deduped);
        const shuffled = lightShuffle(suppressed.length >= 8 ? suppressed : deduped);
        const filtered = genreParam
          ? shuffled.filter((item) =>
              (item.title.genres ?? []).some((g) => g.toLowerCase().includes(genreParam.toLowerCase()))
            )
          : shuffled;
        setDeck(filtered.length >= 5 ? filtered : shuffled);
        setPreferredServices(preferences.connected_streaming_services ?? []);
        setCurrentIndex(0);
        setSwipes([]);
        setDetailCache({});
        setSessionId(`what-next-${Date.now()}`);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load your swipe deck");
      } finally {
        setLoading(false);
      }
    }
    void loadDeck();
  }, [sessionToken]);

  const activeCard = deck[currentIndex] ?? null;
  const nextCards = deck.slice(currentIndex + 1, currentIndex + 3);
  const currentDetail = activeCard ? detailCache[activeCard.title.id] ?? null : null;
  const revealCandidate = useMemo(() => chooseReveal(swipes, deck), [swipes, deck]);
  const revealVisible = swipes.length >= SESSION_LENGTH || (!activeCard && swipes.length > 0);
  const revealDetail = revealCandidate ? detailCache[revealCandidate.title.id] ?? null : null;
  const progress = Math.min(swipes.length, SESSION_LENGTH);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress / SESSION_LENGTH,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [progress, progressAnim]);

  useEffect(() => {
    if (revealVisible) {
      revealEntry.setValue(0);
      Animated.spring(revealEntry, { toValue: 1, damping: 18, stiffness: 140, useNativeDriver: true }).start();
    }
  }, [revealVisible, revealEntry]);

  useEffect(() => {
    async function hydrateCard() {
      if (!sessionToken || !activeCard || detailCache[activeCard.title.id]) {
        return;
      }
      try {
        const detail = await fetchUniversalTitle(sessionToken, activeCard.title.id, {
          id: activeCard.title.id,
          title: activeCard.title.title,
          content_type: activeCard.title.content_type,
          poster_url: activeCard.title.poster_url,
          backdrop_url: activeCard.title.backdrop_url,
          overview: activeCard.title.overview,
        });
        setDetailCache((current) => ({ ...current, [activeCard.title.id]: detail }));
      } catch {
        // keep the swipe session moving even if enrichment fails
      }
    }
    void hydrateCard();
  }, [activeCard, detailCache, sessionToken]);

  const rotation = pan.x.interpolate({
    inputRange: [-180, 0, 180],
    outputRange: ["-12deg", "0deg", "12deg"],
  });
  const choiceOpacity = pan.x.interpolate({
    inputRange: [-140, -40, 0, 40, 140],
    outputRange: [1, 0.2, 0, 0.2, 1],
  });
  const superlikeOpacity = pan.y.interpolate({
    inputRange: [-140, -60, 0],
    outputRange: [1, 0.2, 0],
  });
  const backdropParallax = pan.x.interpolate({
    inputRange: [-250, 0, 250],
    outputRange: [15, 0, -15],
    extrapolate: "clamp",
  });
  const badgeScale = pan.x.interpolate({
    inputRange: [-SWIPE_X_THRESHOLD, -50, 0, 50, SWIPE_X_THRESHOLD],
    outputRange: [1.18, 1.0, 1.0, 1.0, 1.18],
    extrapolate: "clamp",
  });
  const superlikeScale = pan.y.interpolate({
    inputRange: [-SWIPE_UP_THRESHOLD, -50, 0],
    outputRange: [1.18, 1.0, 1.0],
    extrapolate: "clamp",
  });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > SWIPE_X_THRESHOLD) {
          void animateSwipeRef.current("right");
          return;
        }
        if (gesture.dx < -SWIPE_X_THRESHOLD) {
          void animateSwipeRef.current("left");
          return;
        }
        if (gesture.dy < -SWIPE_UP_THRESHOLD) {
          void animateSwipeRef.current("up");
          return;
        }
        if (Math.abs(gesture.dx) < 8 && Math.abs(gesture.dy) < 8) {
          openDetailsForActiveRef.current();
          return;
        }
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          friction: 6,
          tension: 80,
          useNativeDriver: false,
        }).start();
      },
    })
  ).current;

  async function animateSwipe(direction: SwipeDirection) {
    const toValue =
      direction === "left"
        ? { x: -420, y: 40 }
        : direction === "right"
          ? { x: 420, y: 40 }
          : { x: 0, y: -420 };

    await new Promise<void>((resolve) => {
      Animated.timing(pan, {
        toValue,
        duration: 220,
        useNativeDriver: false,
      }).start(() => resolve());
    });

    // commitSwipe is synchronous for state updates; the API telemetry fires in the
    // background so pan reset below is not delayed by a network round-trip.
    commitSwipe(direction);
    pan.setValue({ x: 0, y: 0 });
  }

  function commitSwipe(direction: SwipeDirection) {
    if (!sessionToken) {
      return;
    }
    const item = deck[currentIndexRef.current];
    if (!item) {
      return;
    }
    const pauseMs = Math.max(Date.now() - cardStartRef.current, 0);
    globalSwipeCount++;
    if (direction === "left") {
      suppressedTitles.set(item.title.id, globalSwipeCount);
    }
    setSwipes((current) => [...current, { item, direction, pauseMs }]);
    setCurrentIndex((current) => current + 1);
    if (direction === "right") {
      void saveToNextWatch(item.title.id, item.title.title);
    }
    trackEvent(`swipe_${direction}`, {
      title_id: item.title.id,
      session_id: sessionId,
      pause_ms: pauseMs,
    });

    void apiRequest("/titles/swipes", {
      method: "POST",
      token: sessionToken,
      body: JSON.stringify({
        title_id: item.title.id,
        direction,
        pause_ms: pauseMs,
        session_id: sessionId,
        reason: item.reason,
      }),
    }).catch(() => {});
  }

  async function openDetails(item: RecommendationItem | null) {
    if (!sessionToken || !item) {
      return;
    }
    setShowDetails(true);
    setDetailLoading(true);
    try {
      const detail = detailCache[item.title.id]
        ?? (await fetchUniversalTitle(sessionToken, item.title.id, {
          id: item.title.id,
          title: item.title.title,
          content_type: item.title.content_type,
          poster_url: item.title.poster_url,
          backdrop_url: item.title.backdrop_url,
          overview: item.title.overview,
        }));
      setDetailCache((current) => ({ ...current, [item.title.id]: detail }));
      setDetailTitle(detail);
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Could not load title details");
      setDetailTitle(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function streamReveal() {
    if (!revealDetail) {
      await openDetails(revealCandidate);
      return;
    }
    const primary = rankStreamingOptions(revealDetail.streamingAvailability, preferredServices)[0] ?? null;
    const target = primary?.appUrl || primary?.webUrl;
    if (!target) {
      await openDetails(revealCandidate);
      return;
    }
    trackEvent("recommendation_accept", { title_id: revealDetail.id, session_id: sessionId, source: "what_next" });
    await Linking.openURL(target);
  }

  function showToast(message: string) {
    setToastMessage(message);
    setToastVisible(true);
    toastOpacity.setValue(0);
    toastTranslateY.setValue(12);
    Animated.parallel([
      Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(toastTranslateY, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(() => {
      setTimeout(() => {
        Animated.parallel([
          Animated.timing(toastOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
          Animated.timing(toastTranslateY, { toValue: 12, duration: 220, useNativeDriver: true }),
        ]).start(() => setToastVisible(false));
      }, 2200);
    });
  }

  async function saveToNextWatch(titleId: string, titleName: string) {
    if (!sessionToken) {
      return;
    }
    try {
      if (!nextWatchListIdRef.current) {
        const lists = await apiRequest<Array<{ id: string; name: string }>>("/me/watchlist/lists", { token: sessionToken });
        const existing = lists.find((l) => l.name.toLowerCase() === "my next watch");
        if (existing) {
          nextWatchListIdRef.current = existing.id;
        } else {
          const created = await apiRequest<{ id: string; name: string }>("/me/watchlist/lists", {
            method: "POST",
            token: sessionToken,
            body: JSON.stringify({ name: "My Next Watch", description: "Titles to watch next, from What's Next" }),
          });
          nextWatchListIdRef.current = created.id;
        }
      }
      await apiRequest("/me/watchlist/items", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ content_title_id: titleId, list_id: nextWatchListIdRef.current, added_via: "what_next_heart" }),
      });
      showToast(`"${titleName}" added to My Next Watch`);
    } catch {
      // silent — don't interrupt the swipe flow
    }
  }

  async function restartSession() {
    if (!sessionToken) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await apiRequest<RecommendationItem[]>("/titles/recommendations/for-me?limit=40", { token: sessionToken });
      const deduped = dedupeRecommendations(items);
      const suppressed = applySuppression(deduped);
      setDeck(lightShuffle(suppressed.length >= 8 ? suppressed : deduped));
      setCurrentIndex(0);
      setSwipes([]);
      setSessionId(`what-next-${Date.now()}`);
      pan.setValue({ x: 0, y: 0 });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to rebuild your swipe deck");
    } finally {
      setLoading(false);
    }
  }

  const activeBackdrop = resolveMediaUrl(currentDetail?.backdropUrl || activeCard?.title.backdrop_url || activeCard?.title.poster_url || null);
  const activePoster = resolveMediaUrl(currentDetail?.posterUrl || activeCard?.title.poster_url || null);
  const activeTags = buildTasteTags(activeCard, currentDetail);
  const activeStreaming = rankStreamingOptions(currentDetail?.streamingAvailability ?? [], preferredServices).slice(0, 3);

  // Sync refs so panResponder (created once) always calls latest closures
  animateSwipeRef.current = animateSwipe;
  openDetailsForActiveRef.current = () => { void openDetails(activeCard); };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.background}>
        {activeBackdrop ? (
          <Animated.Image
            source={{ uri: activeBackdrop }}
            style={[styles.backdrop, { transform: [{ translateX: backdropParallax }] }]}
            resizeMode="cover"
          />
        ) : null}
        <View style={styles.backdropShade} />
        <View style={styles.backdropGlowTop} />
        <View style={styles.backdropGlowBottom} />
      </View>

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerKicker}>What&apos;s Next?</Text>
          <Text style={styles.headerTitle}>Pick something for tonight.</Text>
        </View>
        <Text style={styles.progressCount}>{progress}/{SESSION_LENGTH}</Text>
      </View>
      <View style={styles.progressBarTrack}>
        <Animated.View
          style={[
            styles.progressBarFill,
            { width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) },
          ]}
        />
      </View>

      {loading ? <WhatNextSkeleton /> : null}

      {!loading && error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {!loading && revealVisible && revealCandidate ? (
        <Animated.View
          style={[
            styles.revealWrap,
            {
              opacity: revealEntry,
              transform: [
                { scale: revealEntry.interpolate({ inputRange: [0, 1], outputRange: [0.93, 1] }) },
              ],
            },
          ]}
        >
          <Text style={styles.revealEyebrow}>We think this is your move tonight.</Text>
          <Pressable style={styles.revealCard} onPress={() => void openDetails(revealCandidate)}>
            {resolveMediaUrl(revealDetail?.backdropUrl || revealCandidate.title.backdrop_url || revealCandidate.title.poster_url || null) ? (
              <Image
                source={{ uri: resolveMediaUrl(revealDetail?.backdropUrl || revealCandidate.title.backdrop_url || revealCandidate.title.poster_url || null)! }}
                style={styles.revealBackdrop}
                resizeMode="cover"
              />
            ) : null}
            <View style={styles.revealShade} />
            <View style={styles.revealContent}>
              <PosterStackPoster uri={revealDetail?.posterUrl || revealCandidate.title.poster_url || null} style={styles.revealPoster} />
              <Text style={styles.revealReason}>{finalReason(swipes, revealCandidate)}</Text>
              <Text style={styles.revealTitle}>{revealCandidate.title.title}</Text>
              <Text style={styles.revealMeta}>{buildRevealMeta(revealCandidate, revealDetail)}</Text>
              <Text style={styles.revealBody}>{revealDetail?.description || revealCandidate.title.overview || humanizeReason(revealCandidate.reason)}</Text>
              <View style={styles.revealActionRow}>
                <GoldButton
                  label="Stream Now"
                  icon="play"
                  size="md"
                  onPress={() => void streamReveal()}
                  style={{ flex: 1 }}
                />
                <Pressable
                  style={styles.secondaryAction}
                  onPress={() => {
                    setSaveTitleId(revealCandidate.title.id);
                    setShowSaveSheet(true);
                  }}
                >
                  <Ionicons name="bookmark-outline" size={16} color={colors.ink} />
                  <Text style={styles.secondaryActionText}>Save</Text>
                </Pressable>
              </View>
              <View style={styles.revealActionRow}>
                <Pressable
                  style={styles.tertiaryAction}
                  onPress={() => {
                    setAddToTeamTitle({ id: revealCandidate.title.id, title: revealCandidate.title.title });
                    setShowAddToTeam(true);
                  }}
                >
                  <Ionicons name="people-outline" size={16} color={colors.ink} />
                  <Text style={styles.tertiaryActionText}>Add to Watch Team</Text>
                </Pressable>
                <Pressable style={styles.tertiaryAction} onPress={() => void restartSession()}>
                  <Ionicons name="refresh" size={16} color={colors.ink} />
                  <Text style={styles.tertiaryActionText}>Restart</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}

      {!loading && !revealVisible ? (
        <View style={styles.deckArea}>
          {nextCards.slice(0, 2).reverse().map((item, index) => {
            const stackUri = resolveMediaUrl(item.title.backdrop_url || item.title.poster_url);
            return (
              <View
                key={item.title.id}
                pointerEvents="none"
                style={[
                  styles.stackCard,
                  index === 0 ? styles.stackCardBack : styles.stackCardFar,
                ]}
              >
                {stackUri ? (
                  <Image source={{ uri: stackUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : null}
                <View style={styles.stackCardShade} />
              </View>
            );
          })}

          {activeCard ? (
            <Animated.View
              style={[
                styles.card,
                {
                  transform: [...pan.getTranslateTransform(), { rotate: rotation }, { scale: nextCardEntry }],
                },
              ]}
              {...panResponder.panHandlers}
            >
              <View style={styles.cardPressable}>
                {activeBackdrop ? <Image source={{ uri: activeBackdrop }} style={styles.cardBackdrop} resizeMode="cover" /> : null}
                <View style={styles.cardShade} />
                <Animated.View
                  style={[
                    styles.choiceBadge,
                    styles.choiceBadgeLeft,
                    { opacity: choiceOpacity, transform: [{ scale: badgeScale }] },
                  ]}
                >
                  <Text style={styles.choiceText}>Not for me</Text>
                </Animated.View>
                <Animated.View
                  style={[
                    styles.choiceBadge,
                    styles.choiceBadgeRight,
                    { opacity: choiceOpacity, transform: [{ scale: badgeScale }] },
                  ]}
                >
                  <Text style={styles.choiceText}>Interested</Text>
                </Animated.View>
                <Animated.View
                  style={[
                    styles.choiceBadge,
                    styles.choiceBadgeUp,
                    { opacity: superlikeOpacity, transform: [{ scale: superlikeScale }] },
                  ]}
                >
                  <Text style={styles.choiceText}>Watch now</Text>
                </Animated.View>

                <View style={styles.cardContent}>
                  <View style={styles.posterWrap}>
                    <PosterStackPoster uri={activePoster} style={styles.cardPoster} />
                  </View>
                  <View style={styles.cardMetaBlock}>
                    <Text style={styles.cardTitle}>{activeCard.title.title}</Text>
                    <Text style={styles.cardMeta}>{buildCardMeta(activeCard, currentDetail)}</Text>
                    <Text style={styles.cardHook}>{humanizeReason(activeCard.reason)}</Text>
                    <View style={styles.tagRow}>
                      {activeTags.map((tag) => (
                        <View key={tag} style={styles.tagPill}>
                          <Text style={styles.tagText}>{tag}</Text>
                        </View>
                      ))}
                    </View>
                    {activeStreaming.length > 0 ? (
                      <View style={styles.streamingRow}>
                        {activeStreaming.map((entry) => {
                          const meta = getStreamingServiceMeta(entry.service);
                          return (
                            <View
                              key={`${activeCard.title.id}-${entry.service}`}
                              style={[
                                styles.streamingChip,
                                { backgroundColor: meta?.color ?? colors.surfaceSoft },
                              ]}
                            >
                              <Text style={[styles.streamingChipText, { color: meta?.textColor ?? colors.ink }]}>
                                {meta?.name ?? entry.serviceName}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    ) : null}
                    <Text style={styles.cardBody} numberOfLines={3}>
                      {currentDetail?.description || activeCard.title.overview || "A strong fit for your current watch mood."}
                    </Text>
                  </View>
                </View>
              </View>
            </Animated.View>
          ) : (
            <View style={styles.centerState}>
              <Text style={styles.stateTitle}>Your next obsession is loading…</Text>
              <Text style={styles.stateBody}>One more beat while we rebuild your queue.</Text>
            </View>
          )}
        </View>
      ) : null}

      {!loading && !revealVisible ? (
        <View style={styles.controls}>
          <AnimatedControl
            style={[styles.controlButton, styles.controlReject]}
            onPress={() => void animateSwipe("left")}
          >
            <Ionicons name="close" size={24} color={colors.ink} />
          </AnimatedControl>
          <AnimatedControl
            style={[styles.controlButton, styles.controlSave]}
            onPress={() => {
              if (!activeCard) {
                return;
              }
              setSaveTitleId(activeCard.title.id);
              setShowSaveSheet(true);
            }}
          >
            <Ionicons name="bookmark-outline" size={21} color={colors.ink} />
          </AnimatedControl>
          <AnimatedControl
            style={[styles.controlButton, styles.controlLike]}
            onPress={() => void animateSwipe("right")}
          >
            <Ionicons name="heart" size={22} color={colors.background} />
          </AnimatedControl>
          <AnimatedControl
            style={[styles.controlButton, styles.controlPlay]}
            onPress={() => void animateSwipe("up")}
          >
            <Ionicons name="play" size={20} color={colors.background} />
          </AnimatedControl>
        </View>
      ) : null}

      <UniversalTitleModal
        visible={showDetails}
        loading={detailLoading}
        title={detailTitle}
        onClose={() => setShowDetails(false)}
        onSaveTitle={(detail) => {
          setSaveTitleId(detail.id);
          setShowSaveSheet(true);
        }}
      />
      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="what_next"
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onError={(message) => setError(message)}
      />
      <AddToTeamSheet
        visible={showAddToTeam}
        token={sessionToken}
        title={addToTeamTitle}
        onClose={() => {
          setShowAddToTeam(false);
          setAddToTeamTitle(null);
        }}
        onError={(message) => setError(message)}
      />

      {toastVisible ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.toast,
            { opacity: toastOpacity, transform: [{ translateY: toastTranslateY }] },
          ]}
        >
          <Ionicons name="heart" size={14} color={colors.accent} />
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      ) : null}
    </SafeAreaView>
  );
}

function AnimatedControl({
  style,
  children,
  onPress,
}: {
  style: object;
  children: React.ReactNode;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.87, bounciness: 0, useNativeDriver: true }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, bounciness: 14, useNativeDriver: true }).start()}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

function dedupeRecommendations(items: RecommendationItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.title.id)) {
      return false;
    }
    seen.add(item.title.id);
    return true;
  });
}

function buildTasteTags(item: RecommendationItem | null, detail: UniversalTitle | null) {
  if (!item) {
    return [];
  }
  const tags = [...(detail?.genres ?? item.title.genres ?? [])].slice(0, 3);
  const reason = item.reason.toLowerCase();
  if (reason.includes("prestige") && !tags.includes("Prestige Drama")) {
    tags.push("Prestige Drama");
  }
  if (reason.includes("thriller") && !tags.includes("Slow Burn")) {
    tags.push("Slow Burn");
  }
  if (reason.includes("team") && !tags.includes("Watch Team Pick")) {
    tags.push("Watch Team Pick");
  }
  return tags.slice(0, 4);
}

function buildCardMeta(item: RecommendationItem, detail: UniversalTitle | null) {
  const year = detail?.year ?? (item.title.release_date ? Number(String(item.title.release_date).slice(0, 4)) : null);
  const mediaLabel = item.title.content_type === "movie" ? "Movie" : "TV Series";
  const rating = detail?.ratingTmdb ?? item.title.tmdb_rating ?? null;
  const left = [year, mediaLabel].filter(Boolean).join(" • ");
  return rating ? `${left} • ${rating.toFixed(1)} TMDB` : left;
}

function chooseReveal(swipes: SwipeEvent[], deck: RecommendationItem[]) {
  const positive = swipes.filter((item) => item.direction !== "left");
  if (positive.length > 0) {
    return [...positive]
      .sort((a, b) => scoreSwipe(b) - scoreSwipe(a))[0]
      .item;
  }
  return deck[0] ?? null;
}

function scoreSwipe(item: SwipeEvent) {
  const directionScore = item.direction === "up" ? 14 : item.direction === "right" ? 9 : 0;
  return directionScore + Math.min(item.pauseMs / 1200, 4);
}

function finalReason(swipes: SwipeEvent[], item: RecommendationItem) {
  const rightCount = swipes.filter((entry) => entry.direction === "right").length;
  const upCount = swipes.filter((entry) => entry.direction === "up").length;
  if (upCount > 1) {
    return `You kept swiping toward darker, more immediate picks, and this one rose to the top.`;
  }
  if (rightCount > 3) {
    return `Based on what you kept leaning into, this feels like the cleanest hit.`;
  }
  return humanizeReason(item.reason);
}

function buildRevealMeta(item: RecommendationItem, detail: UniversalTitle | null) {
  const tags = buildTasteTags(item, detail);
  if (tags.length > 0) {
    return tags.join(" • ");
  }
  return buildCardMeta(item, detail);
}

function rankStreamingOptions(entries: StreamingAvailability[], preferredServices: string[]) {
  const preferred = new Set(preferredServices);
  return [...entries].sort((a, b) => {
    const aPreferred = preferred.has(a.service) ? 1 : 0;
    const bPreferred = preferred.has(b.service) ? 1 : 0;
    return bPreferred - aPreferred;
  });
}

function humanizeReason(reason: string) {
  const normalized = reason.replace(/^because\s+/i, "").trim();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function PosterStackPoster({ uri, style }: { uri?: string | null; style: any }) {
  const resolved = resolveMediaUrl(uri);
  if (resolved) {
    return <Image source={{ uri: resolved }} style={style} resizeMode="cover" />;
  }
  return (
    <View style={[style, styles.posterFallback]}>
      <Ionicons name="film-outline" size={24} color={colors.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  background: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  backdropShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(5, 8, 14, 0.68)",
  },
  backdropGlowTop: {
    position: "absolute",
    top: -90,
    right: -30,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "rgba(244, 196, 48, 0.14)",
  },
  backdropGlowBottom: {
    position: "absolute",
    bottom: -100,
    left: -50,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: "rgba(46, 196, 182, 0.11)",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(11, 20, 36, 0.7)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  headerKicker: {
    color: colors.accent,
    fontSize: 12,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    fontWeight: "800",
  },
  headerTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "800",
  },
  progressCount: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "800",
  },
  progressBarTrack: {
    height: 3,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 2,
    marginHorizontal: spacing.lg,
    marginTop: 10,
    overflow: "hidden",
  },
  progressBarFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  stateTitle: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
  },
  stateBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  errorBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 18,
    backgroundColor: "rgba(255, 77, 77, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(255, 77, 77, 0.25)",
  },
  errorText: {
    color: "#ffd0d0",
    fontSize: 13,
    lineHeight: 18,
  },
  deckArea: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stackCard: {
    position: "absolute",
    left: spacing.lg + 10,
    right: spacing.lg + 10,
    height: "73%",
    borderRadius: 34,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    overflow: "hidden",
  },
  stackCardShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7, 11, 19, 0.55)",
  },
  stackCardBack: {
    transform: [{ scale: 0.96 }, { translateY: 14 }],
    opacity: 0.55,
  },
  stackCardFar: {
    transform: [{ scale: 0.92 }, { translateY: 28 }],
    opacity: 0.32,
  },
  card: {
    height: "78%",
    borderRadius: 36,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.11)",
    shadowColor: colors.shadow,
    shadowOpacity: 0.55,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 20 },
  },
  cardPressable: {
    flex: 1,
  },
  cardBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  cardShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7, 11, 19, 0.52)",
  },
  choiceBadge: {
    position: "absolute",
    top: 28,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: 2,
  },
  choiceBadgeLeft: {
    left: 24,
    borderColor: "#ff7b7b",
    backgroundColor: "rgba(255, 77, 77, 0.2)",
  },
  choiceBadgeRight: {
    right: 24,
    borderColor: "#7ef0ba",
    backgroundColor: "rgba(46, 196, 182, 0.2)",
  },
  choiceBadgeUp: {
    alignSelf: "center",
    top: 28,
    borderColor: "#f4c430",
    backgroundColor: "rgba(244, 196, 48, 0.18)",
  },
  choiceText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  cardContent: {
    flex: 1,
    justifyContent: "flex-end",
    padding: spacing.lg,
    gap: spacing.lg,
  },
  posterWrap: {
    alignItems: "center",
  },
  cardPoster: {
    width: 156,
    height: 224,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: colors.surfaceSoft,
  },
  cardMetaBlock: {
    gap: 10,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 31,
    lineHeight: 35,
    fontWeight: "900",
  },
  cardMeta: {
    color: "rgba(242,244,248,0.82)",
    fontSize: 14,
    fontWeight: "700",
  },
  cardHook: {
    color: colors.accent,
    fontSize: 17,
    lineHeight: 23,
    fontWeight: "800",
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tagPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.pill,
    backgroundColor: "rgba(11, 20, 36, 0.7)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  tagText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "700",
  },
  streamingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  streamingChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.pill,
  },
  streamingChipText: {
    fontSize: 12,
    fontWeight: "800",
  },
  cardBody: {
    color: "rgba(242,244,248,0.82)",
    fontSize: 14,
    lineHeight: 21,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  controlButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    shadowColor: colors.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  controlReject: {
    width: 62,
    height: 62,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  controlSave: {
    width: 56,
    height: 56,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  controlLike: {
    width: 72,
    height: 72,
    backgroundColor: colors.accent,
  },
  controlPlay: {
    width: 62,
    height: 62,
    backgroundColor: colors.success,
  },
  revealWrap: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    gap: spacing.md,
  },
  revealEyebrow: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  revealCard: {
    flex: 1,
    borderRadius: 34,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  revealBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  revealShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7, 11, 19, 0.74)",
  },
  revealContent: {
    flex: 1,
    justifyContent: "flex-end",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  revealPoster: {
    width: 128,
    height: 186,
    borderRadius: 22,
    backgroundColor: colors.surfaceSoft,
    marginBottom: spacing.sm,
  },
  revealReason: {
    color: colors.accent,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
  },
  revealTitle: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "900",
  },
  revealMeta: {
    color: "rgba(242,244,248,0.82)",
    fontSize: 14,
    fontWeight: "700",
  },
  revealBody: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: "94%",
  },
  revealActionRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  secondaryAction: {
    flex: 1,
    borderRadius: radii.pill,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  secondaryActionText: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 14,
  },
  tertiaryAction: {
    flex: 1,
    borderRadius: radii.pill,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingVertical: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  tertiaryActionText: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 13,
  },
  posterFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  toast: {
    position: "absolute",
    bottom: 110,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(11, 20, 36, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.3)",
  },
  toastText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "700",
  },
});
