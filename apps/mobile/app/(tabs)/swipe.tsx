import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Image,
  Linking,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
// Use safe-area-context (which honors `edges` prop) — the RN built-in SafeAreaView
// always adds top padding regardless of edges, which pushed the logo down on this tab.
import { SafeAreaView } from "react-native-safe-area-context";

import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { AddToTeamSheet } from "@/components/add-to-team-sheet";
import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { selectSafeBackdrop } from "@/lib/backdrop";
import { formatGenres } from "@/lib/format";
import { colors, fonts, rules, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";
import { apiRequest, resolveMediaUrl, resolvedApiBaseUrl } from "@/lib/api";
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

const SWIPE_X_THRESHOLD = 75;
const SWIPE_UP_THRESHOLD = 80;
const SESSION_LENGTH = 20;
const SUPPRESSION_SWIPES = 50;

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

export default function SwipeTab() {
  const { sessionToken } = useAuth();
  const [deck, setDeck] = useState<RecommendationItem[]>([]);
  const [detailCache, setDetailCache] = useState<Record<string, UniversalTitle>>({});
  const [preferredServices, setPreferredServices] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [swipes, setSwipes] = useState<SwipeEvent[]>([]);
  // Start loading=false — only flip to true when a fetch actually begins.
  // Prevents "infinite spinner" when the initial load path early-returns
  // (no session token yet, no auth, etc.) without ever calling setLoading(false).
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [addToTeamTitle, setAddToTeamTitle] = useState<{ id: string; title: string } | null>(null);
  const [showAddToTeam, setShowAddToTeam] = useState(false);
  const [sessionId, setSessionId] = useState(() => `swipe-tab-${Date.now()}`);
  const pan = useRef(new Animated.ValueXY()).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const nextCardEntry = useRef(new Animated.Value(1)).current;
  const revealEntry = useRef(new Animated.Value(0)).current;
  const cardStartRef = useRef(Date.now());
  const currentIndexRef = useRef(0);
  const nextWatchListIdRef = useRef<string | null>(null);
  const animateSwipeRef = useRef<(direction: SwipeDirection) => Promise<void>>(async () => {});
  const openDetailsForActiveRef = useRef<() => void>(() => {});
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTranslateY = useRef(new Animated.Value(12)).current;
  const hasLoadedRef = useRef(false);
  const [dnaFeedback, setDnaFeedback] = useState<{
    headline: string;
    body: string;
    signalLabels: string[];
    evidenceTitles: string[];
  } | null>(null);
  const dnaOpacity = useRef(new Animated.Value(0)).current;
  const dnaTranslateY = useRef(new Animated.Value(-12)).current;
  const dnaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showDnaFeedback(feedback: {
    headline: string;
    body: string;
    signal_labels?: string[];
    evidence_titles?: { title_name: string }[];
  } | null | undefined) {
    if (!feedback) return;
    const payload = {
      headline: feedback.headline,
      body: feedback.body,
      // Taste labels first (e.g. "Prestige Drama"), then evidence titles as chips.
      signalLabels: (feedback.signal_labels ?? []).slice(0, 2),
      evidenceTitles: (feedback.evidence_titles ?? []).map((e) => e.title_name).slice(0, 2),
    };
    setDnaFeedback(payload);
    if (dnaTimerRef.current) clearTimeout(dnaTimerRef.current);
    Animated.parallel([
      Animated.timing(dnaOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(dnaTranslateY, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]).start();
    dnaTimerRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(dnaOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(dnaTranslateY, { toValue: -12, duration: 220, useNativeDriver: true }),
      ]).start(() => setDnaFeedback(null));
    }, 4200);
  }

  useEffect(() => {
    return () => {
      if (dnaTimerRef.current) clearTimeout(dnaTimerRef.current);
    };
  }, []);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
    cardStartRef.current = Date.now();
    pan.setValue({ x: 0, y: 0 });
    nextCardEntry.setValue(0.96);
    Animated.timing(nextCardEntry, { toValue: 1, duration: 200, useNativeDriver: false }).start();
  }, [currentIndex, pan, nextCardEntry]);

  // Rewrite: simplest possible deck lifecycle. One useEffect on mount tied to
  // sessionToken. No useFocusEffect. No ref-based guards. If the swipe tab was
  // stuck in "infinite load", it was almost certainly a lifecycle-re-entry
  // issue in the previous complex setup. This version fires loadDeck exactly
  // once per session-token change.
  //
  // The API endpoint is verified fast (0.27s) — so if this simple version
  // still stalls, we know it's a rendering issue below, not a fetch issue.
  useEffect(() => {
    let cancelled = false;
    const t0 = Date.now();
    if (__DEV__) console.log("[swipe] effect fired; sessionToken?", !!sessionToken);

    // Absolute worst-case fallback: if load() hasn't resolved in 10s, clear
    // the loading state so the user always sees SOMETHING (empty state or error).
    // Never leaves the UI stranded on the loading spinner forever.
    const hardTimeout = setTimeout(() => {
      if (cancelled) return;
      if (__DEV__) console.log("[swipe] hard 10s timeout hit — forcing loading=false");
      setLoading(false);
      setError((prev) => prev ?? "Request took too long. Pull to retry.");
    }, 10_000);

    async function load() {
      if (!sessionToken) {
        if (__DEV__) console.log("[swipe] no sessionToken — clearing loading, returning");
        setLoading(false);
        clearTimeout(hardTimeout);
        return;
      }
      if (__DEV__) console.log("[swipe] setLoading(true), starting fetch");
      setLoading(true);
      setError(null);
      try {
        const recsUrl = `/titles/recommendations/for-me?limit=40&session_id=${encodeURIComponent(sessionId)}`;
        if (__DEV__) console.log("[swipe] fetching", recsUrl);
        const [items, preferences] = await Promise.all([
          apiRequest<RecommendationItem[]>(recsUrl, { token: sessionToken }),
          apiRequest<PreferencesResponse>("/me/preferences", { token: sessionToken })
            .catch(() => ({ connected_streaming_services: [] })),
        ]);
        if (__DEV__) console.log(`[swipe] fetch ok in ${Date.now() - t0}ms; items=${items?.length}, cancelled=${cancelled}`);
        if (cancelled) return;
        const deduped = dedupeRecommendations(items);
        const suppressed = applySuppression(deduped);
        const shuffled = lightShuffle(suppressed.length >= 8 ? suppressed : deduped);
        setDeck(shuffled);
        setPreferredServices(preferences.connected_streaming_services ?? []);
        setCurrentIndex(0);
        setSwipes([]);
        setDetailCache({});
        pan.setValue({ x: 0, y: 0 });
      } catch (loadError) {
        if (__DEV__) console.log("[swipe] fetch FAILED", loadError);
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load your swipe deck");
      } finally {
        clearTimeout(hardTimeout);
        if (__DEV__) console.log(`[swipe] finally in ${Date.now() - t0}ms; cancelled=${cancelled}`);
        if (!cancelled) {
          setLoading(false);
          hasLoadedRef.current = true;
        }
      }
    }

    void load();
    return () => {
      if (__DEV__) console.log("[swipe] effect cleanup — cancelled=true");
      cancelled = true;
      clearTimeout(hardTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  // Explicit reloader used by the "restart" flow and the reveal screen.
  const loadDeck = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      const recsUrl = `/titles/recommendations/for-me?limit=40&session_id=${encodeURIComponent(sessionId)}`;
      const [items, preferences] = await Promise.all([
        apiRequest<RecommendationItem[]>(recsUrl, { token: sessionToken }),
        apiRequest<PreferencesResponse>("/me/preferences", { token: sessionToken })
          .catch(() => ({ connected_streaming_services: [] })),
      ]);
      const deduped = dedupeRecommendations(items);
      const suppressed = applySuppression(deduped);
      const shuffled = lightShuffle(suppressed.length >= 8 ? suppressed : deduped);
      setDeck(shuffled);
      setPreferredServices(preferences.connected_streaming_services ?? []);
      setCurrentIndex(0);
      setSwipes([]);
      setDetailCache({});
      pan.setValue({ x: 0, y: 0 });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load your swipe deck");
    } finally {
      setLoading(false);
      hasLoadedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  const activeCard = deck[currentIndex] ?? null;
  const nextCards = deck.slice(currentIndex + 1, currentIndex + 3);
  const currentDetail = activeCard ? detailCache[activeCard.title.id] ?? null : null;
  const revealCandidate = useMemo(() => chooseReveal(swipes, deck), [swipes, deck]);
  // "Top Pick" celebration should only trigger when the user actually finished
  // a session — either 20 swipes completed, OR the deck ran dry after a
  // meaningful stretch (>=10). The previous `!activeCard && swipes.length > 0`
  // clause fired whenever the deck momentarily had no active card, which now
  // happens on short decks (recycle exclusion in taste.py) and produced the
  // reveal after 3–5 swipes.
  const deckExhausted = !activeCard && deck.length > 0;
  // Strict: "TOP PICK" celebration ONLY after the full 20-swipe session
  // completes. Prior version also triggered at deckExhausted + 10 swipes,
  // which meant heavy users with recycle-limited decks kept seeing the
  // celebration mid-session. Deck-exhausted-early now falls through to the
  // empty-state block below ("That's the fresh set for now") — no fake
  // celebration for a truncated session.
  const revealVisible = swipes.length >= SESSION_LENGTH;
  const revealDetail = revealCandidate ? detailCache[revealCandidate.title.id] ?? null : null;
  const progress = Math.min(swipes.length, SESSION_LENGTH);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress / SESSION_LENGTH,
      duration: 250,
      useNativeDriver: false,
    }).start();
  }, [progress, progressAnim]);

  useEffect(() => {
    if (revealVisible) {
      revealEntry.setValue(0);
      Animated.timing(revealEntry, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    }
  }, [revealVisible, revealEntry]);

  useEffect(() => {
    async function hydrateCard() {
      if (!sessionToken || !activeCard || detailCache[activeCard.title.id]) return;
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
    outputRange: ["-8deg", "0deg", "8deg"],
  });
  const leftLabelOpacity = pan.x.interpolate({
    inputRange: [-80, -20, 0],
    outputRange: [1, 0.3, 0],
    extrapolate: "clamp",
  });
  const rightLabelOpacity = pan.x.interpolate({
    inputRange: [0, 20, 80],
    outputRange: [0, 0.3, 1],
    extrapolate: "clamp",
  });
  const upLabelOpacity = pan.y.interpolate({
    inputRange: [-80, -30, 0],
    outputRange: [1, 0.3, 0],
    extrapolate: "clamp",
  });
  const backdropParallax = pan.x.interpolate({
    inputRange: [-250, 0, 250],
    outputRange: [10, 0, -10],
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
          friction: 8,
          tension: 100,
          useNativeDriver: false,
        }).start();
      },
    })
  ).current;

  async function animateSwipe(direction: SwipeDirection) {
    const toValue =
      direction === "left"
        ? { x: -420, y: 30 }
        : direction === "right"
          ? { x: 420, y: 30 }
          : { x: 0, y: -420 };

    await new Promise<void>((resolve) => {
      Animated.timing(pan, {
        toValue,
        duration: 200,
        useNativeDriver: false,
      }).start(() => resolve());
    });

    commitSwipe(direction);
    pan.setValue({ x: 0, y: 0 });
  }

  function commitSwipe(direction: SwipeDirection) {
    if (!sessionToken) return;
    const item = deck[currentIndexRef.current];
    if (!item) return;
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

    apiRequest<{
      scene_dna_feedback?: {
        headline: string;
        body: string;
        signal_labels?: string[];
        evidence_titles?: { title_name: string }[];
      } | null;
    }>("/titles/swipes", {
      method: "POST",
      token: sessionToken,
      body: JSON.stringify({
        title_id: item.title.id,
        direction,
        pause_ms: pauseMs,
        session_id: sessionId,
        reason: item.reason,
      }),
    })
      .then((res) => {
        if ((direction === "right" || direction === "up") && res?.scene_dna_feedback) {
          showDnaFeedback(res.scene_dna_feedback);
        }
      })
      .catch(() => {});
  }

  async function openDetails(item: RecommendationItem | null) {
    if (!sessionToken || !item) return;
    setShowDetails(true);
    setDetailLoading(true);
    try {
      const detail =
        detailCache[item.title.id] ??
        (await fetchUniversalTitle(sessionToken, item.title.id, {
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
    trackEvent("recommendation_accept", { title_id: revealDetail.id, session_id: sessionId, source: "swipe_tab" });
    await Linking.openURL(target);
  }

  function showToast(message: string) {
    setToastMessage(message);
    setToastVisible(true);
    toastOpacity.setValue(0);
    toastTranslateY.setValue(8);
    Animated.parallel([
      Animated.timing(toastOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.timing(toastTranslateY, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start(() => {
      setTimeout(() => {
        Animated.parallel([
          Animated.timing(toastOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
          Animated.timing(toastTranslateY, { toValue: 8, duration: 200, useNativeDriver: true }),
        ]).start(() => setToastVisible(false));
      }, 2200);
    });
  }

  async function saveToNextWatch(titleId: string, titleName: string) {
    if (!sessionToken) return;
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
            body: JSON.stringify({ name: "My Next Watch", description: "Titles from Swipe you want to watch" }),
          });
          nextWatchListIdRef.current = created.id;
        }
      }
      await apiRequest("/me/watchlist/items", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ content_title_id: titleId, list_id: nextWatchListIdRef.current, added_via: "swipe_heart" }),
      });
      showToast(`"${titleName}" added to My Next Watch`);
    } catch {
      // silent — don't interrupt the swipe flow
    }
  }

  async function restartSession() {
    if (!sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      // Fresh restart → new session id so the session-boost layer starts clean.
      const freshSession = `swipe-tab-${Date.now()}`;
      setSessionId(freshSession);
      const recsUrl = `/titles/recommendations/for-me?limit=40&session_id=${encodeURIComponent(freshSession)}`;
      const items = await apiRequest<RecommendationItem[]>(recsUrl, { token: sessionToken });
      const deduped = dedupeRecommendations(items);
      const suppressed = applySuppression(deduped);
      setDeck(lightShuffle(suppressed.length >= 8 ? suppressed : deduped));
      setCurrentIndex(0);
      setSwipes([]);
      setSessionId(`swipe-tab-${Date.now()}`);
      pan.setValue({ x: 0, y: 0 });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to rebuild your swipe deck");
    } finally {
      setLoading(false);
    }
  }

  const hasBackdrop = Boolean(currentDetail?.backdropUrl || activeCard?.title.backdrop_url);
  const activeBackdrop = resolveMediaUrl(
    currentDetail?.backdropUrl || activeCard?.title.backdrop_url || null
  );
  const activePoster = resolveMediaUrl(currentDetail?.posterUrl || activeCard?.title.poster_url || null);
  const activeGenres = buildGenreString(activeCard, currentDetail);
  const activeStreaming = rankStreamingOptions(currentDetail?.streamingAvailability ?? [], preferredServices).slice(0, 3);

  animateSwipeRef.current = animateSwipe;
  openDetailsForActiveRef.current = () => {
    void openDetails(activeCard);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      {/* Cinematic header — the CURRENT card's backdrop lives behind "What's next?"
          so the opening feels continuous with the deck (audit remediation: "let
          the first title's cinematic backdrop begin behind the headline and flow
          into the swipe surface"). Backdrop swaps as the user swipes. Tighter
          maxHeight so the card below still has generous room. */}
      {/* Unified Header §12 — variant="immersive" (Swipe is the one place a
          taller cinematic treatment is allowed). Progress counter MOVED OUT
          of the global rail into the deck surface below, so global controls
          (logo · search · bell) stay stationary across all tabs. */}
      <SeenSnapHeader
        variant="immersive"
        title="What's Next?"
        subtitle="Swipe to shape your SceneDNA."
        artworkSource={selectSafeBackdrop([
          activeCard?.title.backdrop_url,
          deck[currentIndex + 1]?.title.backdrop_url,
          deck[0]?.title.backdrop_url,
        ])}
        fallbackSeed={3}
      />

      {/* Session progress row — Unified Header brief §12. Counter was in the
          global header rail; moved here so it lives next to the swipe
          interaction it describes, and the global rail stays stationary
          across all tabs. */}
      <View style={styles.progressRow}>
        <Text style={styles.progressLabel}>TODAY&apos;S PICKS</Text>
        <Text style={styles.progressCountInline}>
          {progress}/{SESSION_LENGTH}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressFill,
            { width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) },
          ]}
        />
      </View>

      {loading ? (
        <View style={styles.loadingState}>
          <Text style={styles.loadingIndex}>01 / {SESSION_LENGTH.toString().padStart(2, "0")}</Text>
          <View style={styles.loadingRule} />
          <Text style={styles.loadingTitle}>Building your queue…</Text>
          <Text style={styles.loadingBody}>Matching to your Scene DNA</Text>
          {__DEV__ ? (
            <Text style={[styles.loadingBody, { marginTop: 12, opacity: 0.6, fontSize: 10 }]}>
              {resolvedApiBaseUrl}
              {"\n"}session: {sessionToken ? "yes" : "NO"}
            </Text>
          ) : null}
        </View>
      ) : null}

      {!loading && error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {!loading && !error && !revealVisible && (deck.length === 0 || deckExhausted) ? (
        <View style={styles.deckEmptyState}>
          <Text style={styles.deckEmptyTitle}>
            {deckExhausted && swipes.length > 0
              ? "That's the fresh set for now."
              : "You've seen everything for now."}
          </Text>
          <Text style={styles.deckEmptyBody}>
            {deckExhausted && swipes.length > 0
              ? `You swiped ${swipes.length} — pull for a fresh deck, or save a few titles to sharpen your SceneDNA.`
              : "Come back later for fresh recommendations, or save a few titles to sharpen your SceneDNA."}
          </Text>
          <Pressable
            onPress={() => void loadDeck()}
            style={({ pressed }) => [styles.deckEmptyCta, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="refresh" size={14} color={colors.accent} />
            <Text style={styles.deckEmptyCtaText}>Pull a fresh deck</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Session reveal */}
      {!loading && revealVisible && revealCandidate ? (
        <Animated.View
          style={[
            styles.revealWrap,
            {
              opacity: revealEntry,
              transform: [{ translateY: revealEntry.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
            },
          ]}
        >
          <Text style={styles.revealEyebrow}>TOP PICK / THIS SESSION</Text>
          <View style={styles.revealRule} />
          <Pressable style={styles.revealCard} onPress={() => void openDetails(revealCandidate)}>
            {resolveMediaUrl(
              revealDetail?.backdropUrl ||
                revealCandidate.title.backdrop_url ||
                revealCandidate.title.poster_url ||
                null
            ) ? (
              <Image
                source={{
                  uri: resolveMediaUrl(
                    revealDetail?.backdropUrl ||
                      revealCandidate.title.backdrop_url ||
                      revealCandidate.title.poster_url ||
                      null
                  )!,
                }}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
              />
            ) : null}
            <View style={styles.revealShade} />
            {/* Frame marks */}
            <View style={[styles.markTL, styles.markH]} /><View style={[styles.markTL, styles.markV]} />
            <View style={[styles.markTR, styles.markH]} /><View style={[styles.markTR, styles.markV]} />
            <View style={[styles.markBL, styles.markH]} /><View style={[styles.markBL, styles.markV]} />
            <View style={[styles.markBR, styles.markH]} /><View style={[styles.markBR, styles.markV]} />
            <View style={styles.revealContent}>
              {activePoster ? (
                <Image
                  source={{ uri: resolveMediaUrl(revealDetail?.posterUrl || revealCandidate.title.poster_url) ?? "" }}
                  style={styles.revealPoster}
                  resizeMode="cover"
                />
              ) : null}
              <Text style={styles.revealReason}>{finalReason(swipes, revealCandidate)}</Text>
              <Text style={styles.revealTitle}>{revealCandidate.title.title}</Text>
              <Text style={styles.revealMeta}>{buildCardMeta(revealCandidate, revealDetail)}</Text>
              <Text style={styles.revealBody} numberOfLines={3}>
                {revealDetail?.description || revealCandidate.title.overview || humanizeReason(revealCandidate.reason)}
              </Text>
              <View style={styles.revealActions}>
                <Pressable
                  style={styles.revealPrimaryAction}
                  onPress={() => void streamReveal()}
                >
                  <Text style={styles.revealPrimaryText}>WATCH NOW</Text>
                </Pressable>
                <Pressable
                  style={styles.revealSecondaryAction}
                  onPress={() => {
                    setSaveTitleId(revealCandidate.title.id);
                    setShowSaveSheet(true);
                  }}
                >
                  <Text style={styles.revealSecondaryText}>SAVE</Text>
                </Pressable>
              </View>
              <View style={styles.revealActions}>
                <Pressable
                  style={styles.revealSecondaryAction}
                  onPress={() => {
                    setAddToTeamTitle({ id: revealCandidate.title.id, title: revealCandidate.title.title });
                    setShowAddToTeam(true);
                  }}
                >
                  <Text style={styles.revealSecondaryText}>ADD TO TEAM</Text>
                </Pressable>
                <Pressable style={styles.revealSecondaryAction} onPress={() => void restartSession()}>
                  <Text style={styles.revealSecondaryText}>NEW SESSION</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* Swipe deck */}
      {!loading && !revealVisible ? (
        <View style={styles.deckArea}>
          {/* Stack cards behind */}
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
                  transform: [
                    ...pan.getTranslateTransform(),
                    { rotate: rotation },
                    { scale: nextCardEntry },
                  ],
                },
              ]}
              {...panResponder.panHandlers}
            >
              {/* Backdrop fills the card — poster-only titles get a centered poster on dark bg */}
              {hasBackdrop && activeBackdrop ? (
                <Animated.Image
                  source={{ uri: activeBackdrop }}
                  style={[styles.cardBackdrop, { transform: [{ translateX: backdropParallax }] }]}
                  resizeMode="cover"
                />
              ) : activePoster ? (
                <View style={[styles.cardBackdrop, { backgroundColor: "#090e18" }]}>
                  <Image source={{ uri: activePoster }} style={styles.cardPosterBg} resizeMode="cover" />
                  <View style={styles.cardPosterBgFade} />
                </View>
              ) : (
                <View style={[styles.cardBackdrop, { backgroundColor: colors.surface }]} />
              )}
              <View style={styles.cardShade} />

              {/* Frame marks */}
              <View style={[styles.markTL, styles.markH]} /><View style={[styles.markTL, styles.markV]} />
              <View style={[styles.markTR, styles.markH]} /><View style={[styles.markTR, styles.markV]} />

              {/* Directional edge labels */}
              <Animated.View style={[styles.edgeLeft, { opacity: leftLabelOpacity }]}>
                <Text style={styles.edgeLabelLeft}>← NOT FOR ME</Text>
              </Animated.View>
              <Animated.View style={[styles.edgeRight, { opacity: rightLabelOpacity }]}>
                <Text style={styles.edgeLabelRight}>MORE LIKE THIS →</Text>
              </Animated.View>
              <Animated.View style={[styles.edgeTop, { opacity: upLabelOpacity }]}>
                <Text style={styles.edgeLabelUp}>↑ WATCH NOW</Text>
              </Animated.View>

              {/* Card content — bottom of frame */}
              <View style={styles.cardContent}>
                {activePoster ? (
                  <Image source={{ uri: activePoster }} style={styles.cardPoster} resizeMode="cover" />
                ) : null}
                <View style={styles.cardMetaWrap}>
                  <Text style={styles.cardTitle} numberOfLines={2}>{activeCard.title.title}</Text>
                  <Text style={styles.cardMeta}>{buildCardMeta(activeCard, currentDetail)}</Text>
                  {activeGenres ? (
                    <Text style={styles.cardGenres}>{activeGenres}</Text>
                  ) : null}
                  {activeStreaming.length > 0 ? (
                    <Text style={styles.cardStreaming}>
                      {activeStreaming.map((s) => getStreamingServiceMeta(s.service)?.name ?? s.serviceName).join("  ·  ")}
                    </Text>
                  ) : null}
                  <Text style={styles.cardReason} numberOfLines={2}>
                    {humanizeReason(activeCard.reason)}
                  </Text>
                </View>
              </View>
            </Animated.View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIndex}>00 / {SESSION_LENGTH.toString().padStart(2, "0")}</Text>
              <View style={styles.emptyRule} />
              <Text style={styles.emptyTitle}>Your next obsession is loading…</Text>
              <Text style={styles.emptyBody}>One more beat while we rebuild your queue.</Text>
            </View>
          )}
        </View>
      ) : null}

      {/* Bottom action bar — editorial text actions, not circles */}
      {!loading && !revealVisible ? (
        <View style={styles.actionBar}>
          <Pressable style={styles.actionPass} onPress={() => void animateSwipe("left")}>
            <Text style={styles.actionPassText}>← PASS</Text>
          </Pressable>
          <Pressable
            style={styles.actionSave}
            onPress={() => {
              if (!activeCard) return;
              setSaveTitleId(activeCard.title.id);
              setShowSaveSheet(true);
            }}
          >
            <Ionicons name="bookmark-outline" size={16} color={colors.muted} />
          </Pressable>
          <Pressable style={styles.actionMore} onPress={() => void animateSwipe("right")}>
            <Text style={styles.actionMoreText}>MORE LIKE THIS →</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Watch Now — secondary full-width text action */}
      {!loading && !revealVisible && activeCard ? (
        <Pressable style={styles.watchNowBar} onPress={() => void animateSwipe("up")}>
          <Text style={styles.watchNowText}>↑  WATCH NOW</Text>
        </Pressable>
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
        source="swipe_tab"
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
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      ) : null}

      {dnaFeedback ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.dnaBanner,
            { opacity: dnaOpacity, transform: [{ translateY: dnaTranslateY }] },
          ]}
        >
          <View style={styles.dnaEyebrowRow}>
            <View style={styles.dnaGoldDot} />
            <Text style={styles.dnaEyebrow}>SCENEDNA</Text>
          </View>
          <Text style={styles.dnaHeadline} numberOfLines={2}>{dnaFeedback.headline}</Text>
          {/* Body clamped to 4 lines with a natural tail truncation so long copy
              can't overflow the card area beneath the banner. */}
          <Text style={styles.dnaBody} numberOfLines={4} ellipsizeMode="tail">
            {dnaFeedback.body}
          </Text>
          {(dnaFeedback.signalLabels.length > 0 || dnaFeedback.evidenceTitles.length > 0) ? (
            <View style={styles.dnaEvidenceRow}>
              {/* Signal labels (taste categories) get a gold accent — spec §12 example
                  chips like `SLOW BURN` `PSYCHOLOGICAL` `CHARACTER-DRIVEN`. */}
              {dnaFeedback.signalLabels.map((label) => (
                <Text key={`label-${label}`} style={styles.dnaLabelChip}>
                  {label.toUpperCase()}
                </Text>
              ))}
              {/* Evidence titles get a muted treatment so the label chips lead visually. */}
              {dnaFeedback.evidenceTitles.map((name) => (
                <Text key={`title-${name}`} style={styles.dnaEvidenceChip}>{name}</Text>
              ))}
            </View>
          ) : null}
        </Animated.View>
      ) : null}
    </SafeAreaView>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function dedupeRecommendations(items: RecommendationItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.title.id)) return false;
    seen.add(item.title.id);
    return true;
  });
}

function buildGenreString(item: RecommendationItem | null, detail: UniversalTitle | null) {
  if (!item) return null;
  // Cap at 2 genres and use the shared separator — audit called out that dumping
  // 3+ genres into a narrow layout wraps into noise. Streaming service is
  // rendered separately by the caller, never mixed into this string.
  return formatGenres(detail?.genres ?? item.title.genres ?? [], 2) || null;
}

function buildCardMeta(item: RecommendationItem, detail: UniversalTitle | null) {
  const year =
    detail?.year ?? (item.title.release_date ? Number(String(item.title.release_date).slice(0, 4)) : null);
  const mediaLabel = item.title.content_type === "movie" ? "FILM" : "SERIES";
  return [year, mediaLabel].filter(Boolean).join("  ·  ");
}

function chooseReveal(swipes: SwipeEvent[], deck: RecommendationItem[]) {
  const positive = swipes.filter((item) => item.direction !== "left");
  if (positive.length > 0) {
    return [...positive].sort((a, b) => scoreSwipe(b) - scoreSwipe(a))[0].item;
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
  if (upCount > 1) return `You kept swiping toward darker, more immediate picks, and this one rose to the top.`;
  if (rightCount > 3) return `Based on what you kept leaning into, this feels like the cleanest hit.`;
  return humanizeReason(item.reason);
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

// ─── Frame marks ────────────────────────────────────────────────────────────
const MARK_COLOR = "rgba(244,196,48,0.50)";
const MARK_SIZE = 14;

// ─── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerCopy: { flex: 1, gap: 3 },
  headerEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.6,
    color: colors.accent,
  },
  headerTitle: {
    fontFamily: fonts.serif,
    fontSize: 20,
    lineHeight: 24,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  progressCount: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted2,
    paddingTop: 4,
  },

  // Session progress — moved out of the global rail per Unified Header §12.
  progressRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: 6,
  },
  progressLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    color: colors.muted2,
    letterSpacing: 1.4,
  },
  progressCountInline: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted2,
    letterSpacing: 0.6,
  },
  // Progress hairline
  progressTrack: {
    height: 1,
    backgroundColor: rules.default,
    marginHorizontal: spacing.xl,
  },
  progressFill: {
    height: 1,
    backgroundColor: colors.accent,
  },

  // Loading state
  loadingState: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
    gap: spacing.md,
  },
  loadingIndex: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    color: colors.muted2,
  },
  loadingRule: { height: 1, width: 32, backgroundColor: rules.gold },
  loadingTitle: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 34,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  loadingBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.muted,
    lineHeight: 20,
  },

  // Error
  errorBanner: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(224,112,112,0.25)",
  },
  errorText: { fontFamily: fonts.sans, color: colors.danger, fontSize: 13, lineHeight: 18 },
  deckEmptyState: {
    padding: spacing.xl,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 4,
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  deckEmptyTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 26,
    color: colors.ink,
    letterSpacing: -0.2,
  },
  deckEmptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
  },
  deckEmptyCta: {
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.06)",
  },
  deckEmptyCtaText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: colors.accent,
  },

  // Deck area
  deckArea: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },

  // Stack (behind) cards
  stackCard: {
    position: "absolute",
    left: spacing.lg + 6,
    right: spacing.lg + 6,
    bottom: spacing.sm,
    top: spacing.sm,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  stackCardShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(7,11,18,0.62)" },
  stackCardBack: { transform: [{ scale: 0.96 }, { translateY: 10 }], opacity: 0.55 },
  stackCardFar: { transform: [{ scale: 0.92 }, { translateY: 20 }], opacity: 0.30 },

  // Active card — edge-to-edge, restrained radius
  card: {
    flex: 1,
    borderWidth: 1,
    borderColor: rules.default,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderRadius: 4,
    shadowColor: colors.shadow,
    shadowOpacity: 0.45,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  cardBackdrop: { ...StyleSheet.absoluteFillObject, overflow: "hidden" },
  cardPosterBg: {
    position: "absolute",
    top: "5%",
    left: "15%",
    right: "15%",
    bottom: "15%",
    borderRadius: 6,
  },
  cardPosterBgFade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(9,14,24,0.45)",
  },
  cardShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7,11,18,0)",
  },

  // Directional edge labels
  edgeLeft: {
    position: "absolute",
    top: "42%",
    left: 16,
  },
  edgeLabelLeft: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.1,
    color: colors.muted,
  },
  edgeRight: {
    position: "absolute",
    top: "42%",
    right: 16,
  },
  edgeLabelRight: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.1,
    color: colors.accent,
  },
  edgeTop: {
    position: "absolute",
    top: 20,
    alignSelf: "center",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  edgeLabelUp: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.1,
    color: colors.accent,
  },

  // Card content (bottom panel)
  cardContent: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    backgroundColor: "rgba(7,11,18,0.84)",
    borderTopWidth: 1,
    borderTopColor: rules.default,
  },
  cardPoster: {
    width: 72,
    height: 108,
    borderRadius: 2,
    backgroundColor: colors.surfaceMuted,
  },
  cardMetaWrap: {
    flex: 1,
    gap: 5,
    justifyContent: "flex-end",
  },
  cardTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 26,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  cardMeta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.8,
    color: colors.muted2,
  },
  cardGenres: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.muted2,
  },
  cardStreaming: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.6,
    color: colors.accent,
  },
  cardReason: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.muted,
    marginTop: 2,
  },

  // Frame marks (corners)
  markTL: { position: "absolute", top: 14, left: 14 },
  markTR: { position: "absolute", top: 14, right: 14 },
  markBL: { position: "absolute", bottom: 14, left: 14 },
  markBR: { position: "absolute", bottom: 14, right: 14 },
  markH: { width: MARK_SIZE, height: 1, backgroundColor: MARK_COLOR },
  markV: { width: 1, height: MARK_SIZE, backgroundColor: MARK_COLOR, position: "absolute" },

  // Bottom action bar
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: rules.default,
  },
  actionPass: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  actionPassText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.0,
    color: colors.muted,
  },
  actionSave: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
  },
  actionMore: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  actionMoreText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.0,
    color: colors.accent,
  },

  // Watch now bar
  watchNowBar: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.md,
    paddingVertical: 13,
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.06)",
  },
  watchNowText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.accent,
  },

  // Empty state
  emptyState: {
    flex: 1,
    paddingTop: spacing.xxl,
    gap: spacing.md,
  },
  emptyIndex: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    color: colors.muted2,
  },
  emptyRule: { height: 1, width: 32, backgroundColor: rules.default },
  emptyTitle: {
    fontFamily: fonts.serif,
    fontSize: 26,
    lineHeight: 32,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.muted,
    lineHeight: 20,
  },

  // Reveal (session end)
  revealWrap: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    gap: spacing.md,
  },
  revealEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.4,
    color: colors.accent,
  },
  revealRule: { height: 1, backgroundColor: rules.gold },
  revealCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: rules.default,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderRadius: 2,
  },
  revealShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(7,11,18,0.70)" },
  revealContent: {
    flex: 1,
    justifyContent: "flex-end",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  revealPoster: {
    width: 84,
    height: 124,
    borderRadius: 2,
    backgroundColor: colors.surfaceSoft,
    marginBottom: spacing.sm,
  },
  revealReason: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
  },
  revealTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 30,
    lineHeight: 34,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  revealMeta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.8,
    color: colors.muted2,
  },
  revealBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
    maxWidth: "90%",
  },
  revealActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  revealPrimaryAction: {
    flex: 1,
    paddingVertical: 13,
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  revealPrimaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.paperInk,
  },
  revealSecondaryAction: {
    flex: 1,
    paddingVertical: 13,
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
  },
  revealSecondaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.muted,
  },

  // Toast
  toast: {
    position: "absolute",
    bottom: 120,
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.gold,
  },
  toastText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.ink,
  },
  dnaBanner: {
    position: "absolute",
    top: 72,
    left: spacing.md,
    right: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.backgroundElevated,
    borderWidth: 1,
    borderColor: rules.gold,
    gap: 6,
  },
  dnaEyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dnaGoldDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  dnaEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.6,
    color: colors.accent,
  },
  dnaHeadline: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    lineHeight: 24,
    color: colors.ink,
    marginTop: 2,
    letterSpacing: -0.2,
  },
  dnaBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
  },
  dnaEvidenceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  dnaEvidenceChip: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.4,
    color: colors.muted2,
    borderWidth: 1,
    borderColor: rules.default,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  dnaLabelChip: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.2,
    color: colors.paperInk,
    backgroundColor: colors.accent,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
});
