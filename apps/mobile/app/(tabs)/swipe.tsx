import { swipeDirection } from "@/lib/swipe-gesture";
import { discoveryFilterKey } from "@/lib/discovery-recovery";
import { restoreDiscovery, saveDiscoverySnapshot } from "@/lib/discovery-storage";
import { SceneDnaBadge } from "@/components/scene-dna-badge";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  ActivityIndicator,
  Animated,
  Image,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
// Use safe-area-context (which honors `edges` prop) — the RN built-in SafeAreaView
// always adds top padding regardless of edges, which pushed the logo down on this tab.
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { TitleActionSheets, type TitleActionTarget } from "@/components/title-action-sheets";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { AddToTeamSheet } from "@/components/add-to-team-sheet";
import { AppHeader } from "@/components/headers/app-header";
import { RatingEditor, type RatingSnapshot } from "@/components/rating-editor";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { selectSafeBackdrop } from "@/lib/backdrop";
import { useFallbackBackdrop } from "@/lib/backdrop-pool";
import { formatGenres } from "@/lib/format";
import { colors, fonts, rules, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";
import { apiRequest, ApiError, resolveMediaUrl, resolvedApiBaseUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { type StreamingAvailability, getStreamingServiceMeta } from "@/lib/streaming";
import { patchTitleState, subscribeTitleState } from "@/lib/title-state";
import { subscribeRatingChanges } from "@/components/rating-editor";
import { playSwipeSound } from "@/lib/swipe-sfx";
import { CategoryChips } from "@/components/category-chips";
import { useDiscoveryFilter } from "@/lib/discovery-filter";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";
import { recordWatchHandoff } from "@/lib/watch-handoff";

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

// Oct-27 Swipe semantics:
//   left  — Pass for now (temporary cooldown)
//   right — Interested; does not save to a list
//   up    — Watched; offer an optional rating
//   down  — Watched and disliked; never invent a numeric rating
type SwipeDirection = "left" | "right" | "up" | "down";

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

export default function SwipeTab() {
  const { sessionToken, user } = useAuth();
  const [deck, setDeck] = useState<RecommendationItem[]>([]);
  const deckRef = useRef(deck); deckRef.current = deck;
  const [detailCache, setDetailCache] = useState<Record<string, UniversalTitle>>({});
  const detailFlights = useRef(new Map<string, number>());
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
  // Oct-27 Swipe semantics: up-swipe opens the rating editor.
  const [ratingTarget, setRatingTarget] = useState<{ titleId: string; titleName: string } | null>(null);
  // W06: last successful swipe memo so the Undo button can reverse
  // it. Cleared on a new swipe or on manual undo.
  const [lastSwipe, setLastSwipe] = useState<{
    swipeId: string;
    item: RecommendationItem;
    direction: SwipeDirection;
    at: number;
  } | null>(null);
  const [undoToast, setUndoToast] = useState<string | null>(null);
  function showUndoToast(message: string) {
    setUndoToast(message);
    setTimeout(() => setUndoToast(null), 3000);
  }
  const [flipped, setFlipped] = useState(false);
  const flippedRef = useRef(flipped); flippedRef.current = flipped;
  const detailRequestRef = useRef(0);
  const [showDetails, setShowDetails] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [addToTeamTitle, setAddToTeamTitle] = useState<{ id: string; title: string } | null>(null);
  const [showAddToTeam, setShowAddToTeam] = useState(false);
  const [sessionId, setSessionId] = useState(() => `swipe-tab-${Date.now()}`);
  // Sep-22 brief §2 category chips — media type + genre filters that
  // W09: filter is a SHARED session across Swipe + Preview. Picking
  // Comedy here propagates to the Preview tab (and vice versa) via
  // the discovery-filter store.
  const [actionTarget, setActionTarget] = useState<TitleActionTarget | null>(null);
  const [categoryFilter, setCategoryFilter, filterReady] = useDiscoveryFilter();
  const mode = categoryFilter.availability_mode ?? "streaming";
  const filterKey = discoveryFilterKey(categoryFilter.media_type, categoryFilter.genre, mode);
  const queueScope = `${user?.user_id}|${filterKey}`;
  const [queueOwner, setQueueOwner] = useState<string | null>(null);
  const [resumeCursor, setResumeCursor] = useState<string | null>(null);
  const [feedCursor, setFeedCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const [showHelp, setShowHelp] = useState(true);
  const generationRef = useRef(0);
  const pageRequestRef = useRef<number | null>(null);
  const swipingRef = useRef(false);
  const [swipeBusy, setSwipeBusy] = useState(false);
  const [swipeError, setSwipeError] = useState<string | null>(null);
  const swipeOperationRef = useRef<AbortController | null>(null);
  const swipeAttemptRef = useRef<{
    item: RecommendationItem; direction: SwipeDirection; pauseMs: number;
    decisionKey: string; sessionId: string;
  } | null>(null);
  const canSwipeRef = useRef(false);
  const emptyPagesRef = useRef(0);
  const pan = useRef(new Animated.ValueXY()).current;

  const nextCardEntry = useRef(new Animated.Value(1)).current;

  const cardStartRef = useRef(Date.now());
  const currentIndexRef = useRef(0);
  const nextWatchListIdRef = useRef<string | null>(null);
  const animateSwipeRef = useRef<(direction: SwipeDirection) => Promise<void>>(async () => {});
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
    // Sep-22 brief §6: no blocking dialog. This overlay was already
    // pointerEvents="none" so it never captured input — but 4.2s was
    // long enough to feel like an interruption. Shortened to 1600ms
    // so it registers as a brief acknowledgement without stopping the
    // rhythm of swipes. The next swipe cancels it via the clearTimeout
    // above so consecutive right-swipes never stack banners.
    dnaTimerRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(dnaOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(dnaTranslateY, { toValue: -12, duration: 180, useNativeDriver: true }),
      ]).start(() => setDnaFeedback(null));
    }, 1600);
  }

  useEffect(() => {
    return () => {
      if (dnaTimerRef.current) clearTimeout(dnaTimerRef.current);
    };
  }, []);

  // Static-per-focus fallback backdrop for the shared header. Uses the
  // same pool other primary tabs draw from; `useFallbackBackdrop`
  // advances on tab focus, not on swipe, so the header artwork does
  // NOT change with every card commit.
  const headerArtwork = useFallbackBackdrop(3);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
    cardStartRef.current = Date.now();
    pan.setValue({ x: 0, y: 0 });
    nextCardEntry.setValue(0.96);
    Animated.timing(nextCardEntry, { toValue: 1, duration: 200, useNativeDriver: false }).start();
  }, [currentIndex, pan, nextCardEntry]);

  type FeedPage = { session_id: string; resume_cursor?: string; items: RecommendationItem[]; next_cursor: string | null; has_more: boolean };
  const loadDeck = useCallback(async (resume = false) => {
    if (!sessionToken || !filterReady) return;
    const generation = ++generationRef.current;
    swipeOperationRef.current?.abort(); swipeOperationRef.current = null;
    swipingRef.current = false; swipeAttemptRef.current = null;
    setSwipeBusy(false); setSwipeError(null);
    pan.stopAnimation(); pan.setValue({ x: 0, y: 0 });
    currentIndexRef.current = 0;
    pageRequestRef.current = null;
    setQueueOwner(null); setResumeCursor(null);
    setDeck([]); setCurrentIndex(0); setSwipes([]); setLastSwipe(null);
    setLoading(true); setLoadingMore(false); setError(null); setFeedCursor(null);
    emptyPagesRef.current = 0;
    const params = new URLSearchParams({ limit: "20", mode });
    if (categoryFilter.media_type) params.set("preferred_type", categoryFilter.media_type);
    if (categoryFilter.genre) params.set("genre", categoryFilter.genre);
    try {
      const restored = resume && user?.user_id ? await restoreDiscovery<FeedPage>(user.user_id, sessionToken, "swipe", filterKey,
        { preferred_type: categoryFilter.media_type, genre: categoryFilter.genre, mode }) : null;
      if (generation !== generationRef.current) return;
      const [page, preferences] = await Promise.all([
        restored ? Promise.resolve(restored.response) : apiRequest<FeedPage>(`/titles/recommendations/feed?${params}`, { token: sessionToken, timeoutMs: 90000 }),
        apiRequest<PreferencesResponse>("/me/preferences", { token: sessionToken }).catch(() => ({ connected_streaming_services: [] })),
      ]);
      if (generation !== generationRef.current) return;
      setDeck(dedupeRecommendations(page.items));
      setResumeCursor(page.resume_cursor ?? null); setQueueOwner(queueScope);
      setShowFilters(!restored?.filtersHidden);
      setFeedCursor(page.next_cursor); setHasMore(page.has_more); setResumeCursor(page.resume_cursor ?? null);
      setPreferredServices(preferences.connected_streaming_services ?? []);
      setSessionId(page.session_id ?? `swipe-${Date.now()}`);
      setDetailCache({}); pan.setValue({ x: 0, y: 0 });
    } catch (e) {
      if (generation === generationRef.current) setError(e instanceof Error ? e.message : "Couldn't load picks. Try again.");
    } finally {
      if (generation === generationRef.current) { setLoading(false); hasLoadedRef.current = true; }
    }
  }, [sessionToken, filterReady, categoryFilter.media_type, categoryFilter.genre, mode, user?.user_id, filterKey, queueScope, pan]);

  useEffect(() => {
    void loadDeck(true);
    return () => {
      generationRef.current++;
      swipeOperationRef.current?.abort(); swipeOperationRef.current = null;
      swipingRef.current = false;
      pan.stopAnimation();
    };
  }, [loadDeck]);

  const loadMore = useCallback(async () => {
    if (!sessionToken || !feedCursor || !hasMore || pageRequestRef.current !== null) return;
    const generation = generationRef.current;
    pageRequestRef.current = generation; setLoadingMore(true); setError(null);
    const params = new URLSearchParams({ limit: "20", cursor: feedCursor, mode });
    if (categoryFilter.media_type) params.set("preferred_type", categoryFilter.media_type);
    if (categoryFilter.genre) params.set("genre", categoryFilter.genre);
    try {
      const page = await apiRequest<FeedPage>(`/titles/recommendations/feed?${params}`, { token: sessionToken, timeoutMs: 90000 });
      if (generation !== generationRef.current) return;
      const known = new Set(deckRef.current.map(item => item.title.id));
      const added = page.items.some(item => !known.has(item.title.id));
      setDeck((previous) => dedupeRecommendations([...previous, ...page.items]));
      setFeedCursor(page.next_cursor); setHasMore(page.has_more); setResumeCursor(page.resume_cursor ?? null);
      emptyPagesRef.current = added ? 0 : emptyPagesRef.current + 1;
      if (!added && page.next_cursor === feedCursor && page.has_more) setError("The queue couldn't advance. Tap Continue to retry with your current filters.");
      else if (emptyPagesRef.current >= 3 && page.has_more) setError("Still looking for eligible picks in this category. Tap Continue to search further.");
    } catch (e) {
      if (generation === generationRef.current) {
        if (e instanceof ApiError && e.status === 409) { setFeedCursor(null); setHasMore(false); }
        setError(e instanceof Error ? e.message : "Couldn't load more picks. Retry keeps your filters.");
      }
    } finally {
      if (pageRequestRef.current === generation) { pageRequestRef.current = null; setLoadingMore(false); }
    }
  }, [sessionToken, feedCursor, hasMore, categoryFilter.media_type, categoryFilter.genre, mode]);

  useEffect(() => {
    if (!loading && !loadingMore && !error && hasMore && deck.length - currentIndex <= 8) void loadMore();
  }, [loading, loadingMore, error, hasMore, deck.length, currentIndex, loadMore]);

  useEffect(() => {
    function removeQueued(titleId: string) {
      setDeck((previous) => previous.filter((item, index) => index <= currentIndexRef.current || item.title.id !== titleId));
      if (!swipingRef.current) setCurrentIndex((index) => deck[index]?.title.id === titleId ? index + 1 : index);
    }
    const stopState = subscribeTitleState((state) => { if (state.saved || state.watched) removeQueued(state.title_id); });
    const stopRating = subscribeRatingChanges((titleId) => removeQueued(titleId));
    return () => { stopState(); stopRating(); };
  }, [deck]);

  useEffect(() => {
    const ids = deck.slice(currentIndex).map(item => item.title.id);
    if (!user?.user_id || loading || queueOwner !== queueScope || !resumeCursor || ids.length > 100) return;
    saveDiscoverySnapshot(user.user_id, "swipe", { version: 1, filter: filterKey, cursor: resumeCursor, title_ids: ids, saved_at: Date.now(), filters_hidden: !showFilters });
  }, [deck, currentIndex, loading, queueOwner, queueScope, resumeCursor, filterKey, user?.user_id, showFilters]);

  const activeCard = queueOwner === queueScope ? deck[currentIndex] ?? null : null;
  canSwipeRef.current = !!activeCard && !loading && !swipeBusy && !swipeError;
  useEffect(() => {
    setFlipped(false);
    if (!swipingRef.current && swipeAttemptRef.current?.item.title.id !== activeCard?.title.id) {
      swipeAttemptRef.current = null; setSwipeError(null);
    }
  }, [activeCard?.title.id]);
  const deckExhausted = !activeCard;
  const nextCards = useMemo(() => deck.slice(currentIndex + 1, currentIndex + 3), [deck, currentIndex]);
  const currentDetail = activeCard ? detailCache[activeCard.title.id] ?? null : null;
  useEffect(() => {
    // Hydrate the active card AND the next two in parallel. The user
    // reported that synopsis / streaming / "why it's here" popped in a
    // second or two after each swipe — the previous version only
    // hydrated the active card, which meant every new active card
    // started a fresh network round trip. Prefetching the upcoming
    // cards' details means by the time a swipe commits, the next
    // card's UniversalTitle is already in cache, so the details block
    // renders complete on first paint.
    if (!sessionToken) return;
    const token = sessionToken;
    const toHydrate: RecommendationItem[] = [];
    if (activeCard && !detailCache[activeCard.title.id]) toHydrate.push(activeCard);
    for (const upcoming of nextCards) {
      if (!detailCache[upcoming.title.id]) toHydrate.push(upcoming);
    }
    if (toHydrate.length === 0) return;

    const generation = generationRef.current;
    async function hydrateOne(item: RecommendationItem) {
      const id = item.title.id;
      if (detailFlights.current.get(id) === generation) return;
      detailFlights.current.set(id, generation);
      try {
        const detail = await fetchUniversalTitle(token, item.title.id, {
          id: item.title.id,
          title: item.title.title,
          content_type: item.title.content_type,
          poster_url: item.title.poster_url,
          backdrop_url: item.title.backdrop_url,
          overview: item.title.overview,
        }, { lightweight: true });
        if (generation !== generationRef.current) return;
        setDetailCache((current) =>
          current[item.title.id] ? current : { ...current, [item.title.id]: detail }
        );
      } catch {
        // keep the swipe session moving even if enrichment fails
      } finally {
        if (detailFlights.current.get(id) === generation) detailFlights.current.delete(id);
      }
    }
    for (const item of toHydrate) void hydrateOne(item);
  }, [activeCard, nextCards, detailCache, sessionToken]);

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
  // W02: direction label as gesture approaches commitment. Opacity
  // ramps from 0 → full as the pan reaches the commit threshold so
  // the user sees what they're about to do before letting go.
  const downLabelOpacity = pan.y.interpolate({
    inputRange: [0, 30, 80],
    outputRange: [0, 0.3, 1],
    extrapolate: "clamp",
  });
  const backdropParallax = pan.x.interpolate({
    inputRange: [-250, 0, 250],
    outputRange: [10, 0, -10],
    extrapolate: "clamp",
  });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Let taps and child controls respond. Claim deliberate drags only.
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_, gesture) => canSwipeRef.current && !swipingRef.current && !flippedRef.current && Math.max(Math.abs(gesture.dx), Math.abs(gesture.dy)) > 8,
      onMoveShouldSetPanResponderCapture: (_, gesture) => {
        // The detail face can scroll without triggering a Watched gesture.
        return canSwipeRef.current && !swipingRef.current && !flippedRef.current && Math.max(Math.abs(gesture.dx), Math.abs(gesture.dy)) > 8;
      },
      onPanResponderGrant: () => { if (!swipingRef.current) pan.stopAnimation(); },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderMove: (_, gesture) => {
        if (!swipingRef.current && canSwipeRef.current) pan.setValue({ x: gesture.dx, y: gesture.dy });
      },
      onPanResponderTerminate: () => {
        // Safari/OS interruptions do not always deliver a release event.
        if (!swipingRef.current) { pan.stopAnimation(); pan.setValue({ x: 0, y: 0 }); }
      },
      onPanResponderRelease: (_, gesture) => {
        if (swipingRef.current) return;
        const direction = swipeDirection(gesture.dx, gesture.dy, SWIPE_X_THRESHOLD, SWIPE_UP_THRESHOLD);
        if (direction) { void animateSwipeRef.current(direction); return; }
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
    if (swipingRef.current || !sessionToken || queueOwner !== queueScope || !deck[currentIndexRef.current]) return;
    const item = deck[currentIndexRef.current];
    const pending = swipeAttemptRef.current;
    // An uncertain response must be retried with the same decision and key.
    if (pending && pending.item.title.id === item.title.id && pending.direction !== direction) return;
    const attempt = pending?.item.title.id === item.title.id ? pending : {
      item, direction,
      pauseMs: Math.min(120000, Math.max(Date.now() - cardStartRef.current, 0)),
      // The existing API and database cap idempotency keys at 80 characters.
      decisionKey: `${sessionId.slice(0, 8)}:${item.title.id}:${direction}:${cardStartRef.current}`,
      sessionId,
    };
    swipeAttemptRef.current = attempt;
    const operation = new AbortController();
    swipeOperationRef.current = operation;
    swipingRef.current = true;
    setSwipeBusy(true); setSwipeError(null);
    // Return the dragged poster to its slot while confirmation is in flight.
    // The visible saving state replaces an apparently frozen, half-dragged card.
    pan.stopAnimation(); pan.setValue({ x: 0, y: 0 });
    playSwipeSound(direction);
    const generation = generationRef.current;
    const { pauseMs, decisionKey } = attempt;
    try {
      const res = await apiRequest<{ swipe_id: string }>("/titles/swipes", {
        method: "POST", token: sessionToken, signal: operation.signal,
        body: JSON.stringify({ title_id: item.title.id, direction, pause_ms: pauseMs,
          session_id: attempt.sessionId, reason: item.reason, source_surface: "swipe", idempotency_key: decisionKey }),
      });
      if (generation !== generationRef.current) return;
      await new Promise<void>((resolve) => {
        const animation = Animated.timing(pan, {
          toValue: direction === "left" ? { x: -420, y: 30 } : direction === "right" ? { x: 420, y: 30 } : { x: 0, y: direction === "up" ? -420 : 420 },
          duration: 180, useNativeDriver: false,
        });
        // A backgrounded/interrupted animation must not retain the input lock.
        const timer = setTimeout(() => { if (generation === generationRef.current) animation.stop(); resolve(); }, 500);
        animation.start(() => { clearTimeout(timer); resolve(); });
      });
      if (generation !== generationRef.current) return;
      swipeAttemptRef.current = null;
      setSwipes((previous) => [...previous, { item, direction, pauseMs }]);
      currentIndexRef.current += 1;
      setCurrentIndex(currentIndexRef.current); setShowFilters(false);
      setLastSwipe({ swipeId: res.swipe_id, item, direction, at: Date.now() });
      if (direction === "up" || direction === "down") patchTitleState(item.title.id, { watched: true });
      if (direction === "up") setRatingTarget({ titleId: item.title.id, titleName: item.title.title });
      trackEvent(`swipe_${direction}`, { title_id: item.title.id, session_id: sessionId });
    } catch (e) {
      if (generation !== generationRef.current) return;
      if (e instanceof ApiError && e.status === 409) {
        swipeAttemptRef.current = null;
        setRatingTarget({ titleId: item.title.id, titleName: item.title.title });
        showUndoToast("This title has a positive rating. Change it or keep your current rating.");
      } else setSwipeError("Your swipe could not be confirmed. Retry this swipe to continue; your place is saved.");
    } finally {
      // An old response must never unlock or recenter a new filter's gesture.
      if (swipeOperationRef.current === operation) {
        pan.setValue({ x: 0, y: 0 }); swipingRef.current = false;
        swipeOperationRef.current = null; setSwipeBusy(false);
      }
    }
  }

  // Oct-27 W06: Undo the most recent eligible swipe. Reverses the
  // server-side effect (watched/saved), restores the card to the
  // deck, and clears the last-swipe memo.
  async function undoLastSwipe() {
    if (!sessionToken || !lastSwipe || swipingRef.current || swipeAttemptRef.current) return;
    const operation = new AbortController();
    swipeOperationRef.current = operation;
    swipingRef.current = true;
    setSwipeBusy(true);
    const previous = lastSwipe;
    const generation = generationRef.current;
    try {
      const result = await apiRequest<{ reversed: string[]; partial_reason: string | null; watched: boolean | null }>(
        `/titles/swipes/${previous.swipeId}`, { method: "DELETE", token: sessionToken, signal: operation.signal },
      );
      if (generation !== generationRef.current) return;
      setLastSwipe(null);
      setDeck((deck) => {
        const next = [...deck];
        next.splice(currentIndexRef.current, 0, previous.item);
        return next;
      });
      setSwipes((swipes) => swipes.slice(0, -1));
      cardStartRef.current = Date.now();
      if (result.watched != null) patchTitleState(previous.item.title.id, { watched: result.watched });
      if (result.partial_reason) showUndoToast("Swipe undone. Your newer rating or watched status was kept.");
      trackEvent("swipe_undo", { direction: previous.direction, reversed: result.reversed.join(",") });
    } catch {
      if (generation === generationRef.current) showUndoToast("Couldn't undo. Tap Undo to retry.");
    } finally {
      if (swipeOperationRef.current === operation) {
        swipeOperationRef.current = null; swipingRef.current = false; setSwipeBusy(false);
      }
    }
  }

  async function openDetails(item: RecommendationItem | null) {
    if (!sessionToken || !item) return;
    const request = ++detailRequestRef.current, generation = generationRef.current;
    setShowDetails(true); setDetailTitle(null);
    setDetailLoading(true);
    try {
      const detail =
        (await fetchUniversalTitle(sessionToken, item.title.id, {
          id: item.title.id,
          title: item.title.title,
          content_type: item.title.content_type,
          poster_url: item.title.poster_url,
          backdrop_url: item.title.backdrop_url,
          overview: item.title.overview,
        }));
      if (request !== detailRequestRef.current || generation !== generationRef.current) return;
      setDetailCache((current) => ({ ...current, [item.title.id]: detail }));
      setDetailTitle(detail);
    } catch (detailError) {
      if (request !== detailRequestRef.current || generation !== generationRef.current) return;
      setError(detailError instanceof Error ? detailError.message : "Could not load title details");
      setDetailTitle(null);
    } finally {
      if (request === detailRequestRef.current && generation === generationRef.current) setDetailLoading(false);
    }
  }

  async function openProvider(option: StreamingAvailability) {
    const target = Platform.OS === "web" ? option.webUrl : option.appUrl || option.webUrl;
    if (!target || !activeCard) return;
    try {
      if (sessionToken) void recordWatchHandoff(sessionToken, {
        titleId: activeCard.title.id, providerCode: option.service, outboundUrl: target, originSurface: "swipe",
      }).catch(() => {});
      await Linking.openURL(target);
    } catch { showUndoToast("Couldn't open this service. Try its website from title details."); }
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



  const hasBackdrop = Boolean(currentDetail?.backdropUrl || activeCard?.title.backdrop_url);
  const activeBackdrop = resolveMediaUrl(
    currentDetail?.backdropUrl || activeCard?.title.backdrop_url || null
  );
  // Poster stability per Swipe v1.1 spec §10 "authoritative poster resolution
  // and no-refresh contract". Pin to the recommendation-response poster
  // (TMDB source of truth from /titles/recommendations/for-me) FIRST — never
  // let the async hydrateCard() replace it 1-2s later. currentDetail is only
  // consulted when the primary is genuinely absent.
  //
  // Root cause of the visible swap: the previous order preferred
  // currentDetail?.posterUrl, which arrives from fetchUniversalTitle() after
  // the card is already visible. If universal-title returned a different-
  // sized/different-source poster (even a legitimate TMDB variant) it
  // triggered a visible flicker/replacement. Freezing to the recs-response
  // URL means the poster picked at render time is the one seen for the
  // entire visible lifetime of the card.
  const activePoster = resolveMediaUrl(activeCard?.title.poster_url || currentDetail?.posterUrl || null);
  const activeSynopsis = currentDetail?.description ?? null;
  const activeGenres = buildGenreString(activeCard, currentDetail);
  const activeStreaming = rankStreamingOptions(currentDetail?.streamingAvailability ?? [], preferredServices).slice(0, 3);

  // Responsive poster/workspace sizing per redesign spec §6.4 + §7. Poster
  // is a contained 2:3 portrait object at every viewport; on wide screens
  // (>=900) the workspace becomes a two-column deck + details rail; on
  // narrow it's a vertical stack. Never let the card become a landscape
  // banner and never let it grow beyond ~420px on huge displays.
  // Responsive layout mode per Mobile Responsive Remediation spec §6.
  // Modes are computed from BOTH width and height because a
  // 1200×580 desktop window needs the compact treatment even though
  // width alone would say "roomy". Bottom nav + safe areas are
  // reserved before deriving the poster's height budget.
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const safeInsets = useSafeAreaInsets();
  type LayoutMode = "roomy_wide" | "compact_wide" | "narrow_tall" | "narrow_short" | "failsafe";
  const layoutMode: LayoutMode = (() => {
    if (viewportHeight < 560 || viewportWidth < 320) return "failsafe";
    if (viewportWidth >= 900 && viewportHeight >= 760) return "roomy_wide";
    if (viewportWidth >= 720 || viewportHeight >= 560) {
      if (viewportWidth >= 720) return "compact_wide";
    }
    if (viewportHeight >= 700) return "narrow_tall";
    return "narrow_short";
  })();
  const isNarrow = layoutMode === "narrow_tall" || layoutMode === "narrow_short" || layoutMode === "failsafe";
  const isWide = !isNarrow;

  const workspacePadding = viewportWidth < 480 ? 12 : 20;
  const workspaceMaxWidth = 980;
  const availableWorkspaceWidth = Math.min(viewportWidth, workspaceMaxWidth);
  const workspaceGap = isNarrow ? 12 : (layoutMode === "compact_wide" ? 20 : 32);

  // Height-budgeted poster sizing per spec §9. Reserve persistent UI
  // (safe areas, shared header, feature header, decision dock, bottom
  // nav) then derive the poster from the SMALLER of width- and
  // height-constrained bounds so a squat viewport shrinks the card
  // rather than clipping the actions below it.
  // Shared header is not rendered on narrow modes (see JSX below) so
  // its height reservation drops to 0 there, freeing that space for
  // the poster.
  const RESERVED_SHARED_HEADER = isNarrow ? 0 : 64;
  const RESERVED_FEATURE_HEADER =
    layoutMode === "narrow_short" ? 48 :
    layoutMode === "narrow_tall" ? 64 : 92;
  const RESERVED_DECISION_DOCK =
    layoutMode === "narrow_short" ? 132 :
    isNarrow ? 156 : 160;                 // control row + Watch Now + gap
  const RESERVED_BOTTOM_NAV = 66;         // approx tab bar height incl padding
  const reservedInterfaceHeight =
    safeInsets.top + safeInsets.bottom +
    RESERVED_SHARED_HEADER + RESERVED_FEATURE_HEADER +
    RESERVED_DECISION_DOCK + RESERVED_BOTTOM_NAV +
    // Extra breathing room for gaps / synopsis / genre chips in the
    // details column; only applied when they SHARE vertical space with
    // the poster (single-column narrow modes).
    (isNarrow ? 220 : 32);

  const availablePosterHeight = Math.max(240, viewportHeight - reservedInterfaceHeight);
  const heightLimitedWidth = availablePosterHeight * (2 / 3);
  const modeMaxWidth =
    layoutMode === "roomy_wide" ? 400 :
    layoutMode === "compact_wide" ? 340 :
    layoutMode === "narrow_tall" ? 220 :
    layoutMode === "narrow_short" ? 185 :
    260;
  const widthAvailableForPoster = isNarrow
    ? availableWorkspaceWidth - workspacePadding * 2
    : (availableWorkspaceWidth - workspacePadding * 2 - workspaceGap) * 0.48;
  const posterMaxWidth = Math.min(modeMaxWidth, widthAvailableForPoster, heightLimitedWidth);
  const posterColumnWidth = isNarrow ? posterMaxWidth : posterMaxWidth;

  animateSwipeRef.current = animateSwipe;

  // Presentational block for the current title's identity, metadata, reason,
  // decision controls, and Watch Now. Same JSX under both compositions so
  // narrow (below the deck) and wide (in the right rail) stay visually
  // identical. Handlers are the SAME references used by the gesture layer —
  // no domain behavior lives in this block per spec §9 action mapping contract.
  const flippedCard = activeCard ? <View style={{ width: "100%", height: isNarrow ? Math.min(600, Math.max(280, viewportHeight * .6)) : posterColumnWidth * 1.5, backgroundColor: colors.surface }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Back to poster" onPress={() => setFlipped(false)} style={{ minHeight: 44, padding: 12, alignItems: "center" }}><Text style={{ color: colors.accent }}>Back to poster</Text></Pressable>
    <ScrollView nestedScrollEnabled contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Text style={{ color: colors.ink, fontFamily: fonts.serifBold, fontSize: 24 }}>{activeCard.title.title}</Text>
      <Text style={{ color: colors.muted, fontSize: 14 }}>{buildCardMeta(activeCard, currentDetail)}</Text>
      <SceneDnaBadge titleId={activeCard.title.id} />
      <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 24 }}>{activeSynopsis || "Synopsis unavailable right now."}</Text>
      {currentDetail?.credits.cast.length ? <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21 }}>Cast: {currentDetail.credits.cast.slice(0, 8).join(", ")}</Text> : null}
      <Text style={{ color: colors.ink, fontFamily: fonts.sansSemiBold }}>Where to watch</Text>
      {activeStreaming.length ? activeStreaming.map(option => <Pressable key={option.service} disabled={!option.appUrl && !option.webUrl} onPress={() => void openProvider(option)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.accent }}>{option.serviceName || option.service}</Text></Pressable>) : <Text style={{ color: colors.muted }}>Availability isn't confirmed. Open full details to check.</Text>}
      <Pressable accessibilityRole="button" onPress={(event) => { event.stopPropagation(); void openDetails(activeCard); }} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.accent }}>Full title details and trailers</Text></Pressable>
    </ScrollView>
  </View> : null;

  const directActions = activeCard ? (
<View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12 }}>
        <Pressable disabled={swipeBusy || !!swipeError}
            onPress={() => void animateSwipe("up")} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.ink }}>Watched + Rate</Text></Pressable>
        <Pressable disabled={swipeBusy || !!swipeError}
            onPress={() => void animateSwipe("down")} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.ink }}>Didn't like it</Text></Pressable>
        <Pressable onPress={() => setActionTarget({ action: "send", id: activeCard.title.id, title: activeCard.title.title, poster: activeCard.title.poster_url })} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.ink }}>Send</Text></Pressable>
        <Pressable onPress={() => setActionTarget({ action: "team", id: activeCard.title.id, title: activeCard.title.title })} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.ink }}>Watch Team</Text></Pressable>
      </View>
  ) : null;

  const detailsAndControls = activeCard ? (
    <View style={styles.detailsBlock}>
      <Text style={styles.detailsTitle} numberOfLines={isWide ? 3 : 2}>
        {activeCard.title.title}
      </Text>
      <SceneDnaBadge titleId={activeCard.title.id} />
      <Text style={styles.detailsMeta}>{buildCardMeta(activeCard, currentDetail)}</Text>
      {activeGenres ? (
        <View style={styles.detailsGenreRow}>
          {activeGenres.split(",").map((g) => g.trim()).filter(Boolean).slice(0, 3).map((g) => (
            <View key={g} style={styles.detailsGenreChip}>
              <Text style={styles.detailsGenreChipText}>{g}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {/* Synopsis — canonical TMDB overview per Swipe v1.1 spec §6.5.
          Placed between metadata and WHY IT'S HERE so users understand
          what the title IS before we tell them why it's for them.
          Clamped to ~3-4 lines; the full overview lives in title detail.
          No Wikipedia/Wikimedia fallback per §10 no-refresh contract. */}
      {activeSynopsis ? (
        <Text
          style={styles.detailsSynopsis}
          numberOfLines={layoutMode === "narrow_short" ? 2 : isWide ? 3 : 3}
        >
          {activeSynopsis}
        </Text>
      ) : null}
      {activeCard.reason ? (
        <View style={styles.detailsReasonBlock}>
          <View style={styles.detailsReasonRule} />
          <View style={{ flex: 1 }}>
            <View style={styles.detailsReasonLabelRow}>
              <Ionicons name="albums" size={11} color={colors.accent} />
              <Text style={styles.detailsReasonLabel}>WHY IT'S HERE</Text>
            </View>
            <Text
              style={styles.detailsReasonText}
              numberOfLines={layoutMode === "narrow_short" ? 2 : 3}
            >
              {humanizeReason(activeCard.reason)}
            </Text>
          </View>
        </View>
      ) : null}
      {activeStreaming.length > 0 ? (
        <View style={styles.providerStrip}>
          {activeStreaming.slice(0, 4).map((s) => {
            const meta = getStreamingServiceMeta(s.service);
            // Real TMDB logo first; brand short-name pill fallback.
            if (s.logoUrl) {
              return (
                <Pressable key={s.service} accessibilityLabel={`Watch on ${s.serviceName || s.service}`} disabled={!s.appUrl && !s.webUrl}
                  onPress={() => void openProvider(s)} style={[styles.providerLogoBox, { minWidth: 44, minHeight: 44 }]}>
                  <Image source={{ uri: s.logoUrl }} style={styles.providerLogoImg} resizeMode="contain" />
                </Pressable>
              );
            }
            return (
              <Pressable
                key={s.service} accessibilityLabel={`Watch on ${s.serviceName || s.service}`} disabled={!s.appUrl && !s.webUrl}
                onPress={() => void openProvider(s)}
                style={[styles.providerPill, { minHeight: 44 }, meta ? { backgroundColor: meta.color } : null]}
              >
                <Text style={[styles.providerPillLabel, meta ? { color: meta.textColor } : null]} numberOfLines={1}>
                  {(meta?.shortName || s.serviceName || "").toUpperCase()}
                </Text>
              </Pressable>
            );
          })}
          {activeStreaming.length > 4 ? (
            <View style={styles.providerMore}>
              <Text style={styles.providerMoreLabel}>+{activeStreaming.length - 4} more</Text>
              <Ionicons name="chevron-forward" size={11} color={colors.muted} />
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Vision-mock decision dock: three big circular controls below
          the card. PASS and SAVE are outlined; MORE LIKE THIS is the
          filled yellow primary. Labels sit underneath in uppercase
          mono — matches the vision mock exactly. */}
      <View style={styles.decisionDock}>
        <View style={styles.decisionCell}>
          <Pressable
            disabled={swipeBusy || !!swipeError}
            onPress={() => void animateSwipe("left")}
            accessibilityRole="button"
            accessibilityLabel={`Pass on ${activeCard.title.title}`}
            style={({ pressed }) => [styles.decisionCircle, styles.decisionCircleNeutral, pressed && { opacity: 0.72 }]}
          >
            <Ionicons name="close" size={28} color={colors.ink} />
          </Pressable>
          <Text style={styles.decisionLabel}>PASS</Text>
        </View>
        <View style={styles.decisionCell}>
          <Pressable
            disabled={swipeBusy || !!swipeError}
            onPress={() => void animateSwipe("right")}
            accessibilityRole="button"
            accessibilityLabel={`More like ${activeCard.title.title}`}
            style={({ pressed }) => [styles.decisionCircle, styles.decisionCirclePrimary, pressed && { opacity: 0.88 }]}
          >
            <Ionicons name="heart" size={28} color={colors.background} />
          </Pressable>
          <Text style={[styles.decisionLabel, styles.decisionLabelPrimary]}>MORE LIKE THIS</Text>
        </View>
        <View style={styles.decisionCell}>
          <Pressable
            onPress={() => {
              if (!activeCard) return;
              setSaveTitleId(activeCard.title.id);
              setShowSaveSheet(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Save ${activeCard.title.title}`}
            style={({ pressed }) => [styles.decisionCircle, styles.decisionCircleNeutral, pressed && { opacity: 0.72 }]}
          >
            <Ionicons name="bookmark-outline" size={26} color={colors.ink} />
          </Pressable>
          <Text style={styles.decisionLabel}>SAVE</Text>
        </View>
      </View>

      {directActions}
      {Platform.OS !== "web" ? (
        <Text style={styles.swipeHint}>
          Up: Watched + optional rating · Down: Watched, didn’t like it
        </Text>
      ) : null}
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      {/* Restore the shared global app header per Swipe v1.1 spec §6.1 —
          same component used on every other primary tab, so navigation
          (logo · search · messages · notifications) stays consistent. Use
          variant="standard" and pass NO artworkSource so it collapses to
          the minimum shell height without a photographic banner —
          poster is the workspace's focal element, not the header. */}
      {/* Oct-19 Header Standardization — shared immersive AppHeader
          on every width. Mark + SWIPE/PREVIEW selector + empty right.
          Switching between Swipe and Preview uses the same selector
          instance, so metrics and alignment stay consistent. */}
      <AppHeader
        variant="immersive"
        mode="swipe"
        onModeChange={(next) => {
          if (next === "preview") router.push("/previews");
        }}
      />
      <ScrollView
        contentContainerStyle={[
          styles.workspaceScroll,
          {
            paddingHorizontal: workspacePadding,
            // Reserve enough bottom room so the decision controls +
            // Watch Now never scroll beneath the fixed tab bar +
            // safe-area inset. Spec §11: "Provide page/scroller
            // bottom padding equal to the decision-dock height +
            // bottom-navigation height + safe-area inset."
            paddingBottom: 40 + RESERVED_BOTTOM_NAV + safeInsets.bottom,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Compact feature header per spec §6.2 — replaces the full-viewport
            backdrop hero. Sits inside the max-width workspace container. */}
        <View style={[styles.workspaceContainer, { maxWidth: workspaceMaxWidth }]}>
          {/* Sep-22 brief §1: shared Swipe|Previews mode toggle at the
              top of the discovery experience. Tapping Previews pushes
              the router to /previews; that screen has the mirror-image
              toggle back. Independent queues + positions per mode are
              preserved by leaving each screen mounted through the tabs
              layout — switching modes never resets the other's queue. */}
          {/* SWIPE | PREVIEWS selector now lives in the shared
              AppHeader above — don't duplicate it here. */}
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable onPress={() => setShowFilters((v) => !v)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.accent }}>Filters{categoryFilter.genre ? ` · ${categoryFilter.genre}` : ""}</Text></Pressable>
            <Pressable onPress={() => setShowHelp((v) => !v)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.ink }}>How to swipe</Text></Pressable>
          </View>
          {showHelp ? <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 12 }}>Right — More like this. Left — Pass for now. Up — Watched; add a rating. Down — Watched and didn't like it. Tap the poster to flip to details; tap Back to poster to return. Save adds a title to your lists.</Text> : null}
          {showFilters ? <CategoryChips
            value={categoryFilter}
            onChange={(next) => {
              setCategoryFilter(next);
              // Reset queue on filter change so the visible deck stops
              // being from the previous filter — the useEffect above
              // fires a fresh load with the new URL params.
              setCurrentIndex(0);
              setSwipes([]);
              setDetailCache({});
            }}
          /> : null}
          <View style={styles.featureHeader}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.featureTitle}>What&apos;s Next?</Text>
              {/* Hide the secondary line on the shortest narrow mode
                  to reclaim vertical space. */}
              {layoutMode !== "narrow_short" ? (
                <Text style={styles.featureSubtitle}>Discover picks tailored to your taste.</Text>
              ) : null}
            </View>
            <Text style={styles.featureProgress}>
              {swipes.length} explored
            </Text>
          </View>
          {/* Oct-27 follow-up: swipe cheat sheet lives on the actual
              Swipe tab (not just What's Next). Compact four-pill legend
              so the directions are discoverable without a tutorial. */}
          {/* W04: four tappable direction buttons mirror the
              gestures so there's an equivalent, screen-reader-friendly
              way to commit every direction. W06: Undo chip appears
              on the right after a swipe lands. */}
          <View style={styles.swipeLegendRow}>
            <Pressable
              onPress={() => activeCard && void animateSwipeRef.current("left")}
              disabled={!activeCard || swipeBusy || !!swipeError}
              hitSlop={4}
              style={({ pressed }) => [styles.swipeLegendPill, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Pass this title"
            >
              <Ionicons name="arrow-back" size={11} color={colors.muted} />
              <Text style={styles.swipeLegendLabel}>Pass</Text>
            </Pressable>
            <Pressable
              onPress={() => activeCard && void animateSwipeRef.current("right")}
              disabled={!activeCard || swipeBusy || !!swipeError}
              hitSlop={4}
              style={({ pressed }) => [styles.swipeLegendPill, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="More like this"
            >
              <Ionicons name="arrow-forward" size={11} color={colors.muted} />
              <Text style={styles.swipeLegendLabel}>More like this</Text>
            </Pressable>
            <Pressable
              onPress={() => activeCard && void animateSwipeRef.current("up")}
              disabled={!activeCard || swipeBusy || !!swipeError}
              hitSlop={4}
              style={({ pressed }) => [styles.swipeLegendPill, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Mark watched and rate"
            >
              <Ionicons name="arrow-up" size={11} color={colors.accent} />
              <Text style={[styles.swipeLegendLabel, { color: colors.accent }]}>Watched + rate</Text>
            </Pressable>
            <Pressable
              onPress={() => activeCard && void animateSwipeRef.current("down")}
              disabled={!activeCard || swipeBusy || !!swipeError}
              hitSlop={4}
              style={({ pressed }) => [styles.swipeLegendPill, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Mark watched, didn't like"
            >
              <Ionicons name="arrow-down" size={11} color={colors.muted} />
              <Text style={styles.swipeLegendLabel}>Watched · didn't like</Text>
            </Pressable>
            {lastSwipe ? (
              <Pressable
                disabled={swipeBusy || !!swipeError}
                onPress={() => void undoLastSwipe()}
                hitSlop={4}
                style={({ pressed }) => [styles.swipeUndoPill, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel={`Undo last swipe: ${lastSwipe.direction}`}
              >
                <Ionicons name="arrow-undo-outline" size={11} color={colors.background} />
                <Text style={styles.swipeUndoLabel}>Undo</Text>
              </Pressable>
            ) : null}
          </View>

          {undoToast ? (
            <View style={styles.undoToast}>
              <Text style={styles.undoToastLabel}>{undoToast}</Text>
            </View>
          ) : null}

      {loading ? (
        <View style={styles.loadingState}>

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

      {swipeBusy ? (
        <View accessibilityRole="progressbar" accessibilityLabel="Saving swipe" style={{ flexDirection: "row", gap: 10, alignItems: "center", justifyContent: "center", padding: 12 }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={{ color: colors.ink }}>Saving your choice…</Text>
        </View>
      ) : null}
      {swipeError ? (
        <View accessibilityRole="alert" style={styles.errorBanner}>
          <Text style={styles.errorText}>{swipeError}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry this swipe" disabled={swipeBusy}
            onPress={() => { const attempt = swipeAttemptRef.current; if (attempt) void animateSwipe(attempt.direction); }}
            style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: colors.accent }}>Retry swipe</Text>
          </Pressable>
        </View>
      ) : null}

      {!loading && error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => void (feedCursor ? loadMore() : loadDeck(true))} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.accent }}>Continue</Text></Pressable>
        </View>
      ) : null}

      {!loading && !error && !loadingMore && !hasMore && (deck.length === 0 || deckExhausted) ? (
        <View style={styles.deckEmptyState}>
          <Text style={styles.deckEmptyTitle}>You've reached the available {categoryFilter.genre ?? "streaming"} picks for now.</Text>
          <Text style={styles.deckEmptyBody}>Try another genre, or check again for new picks. Your current filters are kept.</Text>
          <Pressable
            onPress={() => void loadDeck()}
            style={({ pressed }) => [styles.deckEmptyCta, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="refresh" size={14} color={colors.accent} />
            <Text style={styles.deckEmptyCtaText}>Retry these filters</Text>
          </Pressable>
        </View>
      ) : null}

      {loadingMore ? <Text style={{ color: colors.muted, textAlign: "center", padding: 16 }}>Finding more picks…</Text> : null}
      {/* Narrow mode (mobile): one unified bordered card containing
          hero backdrop + title identity + metadata + Why It's Here +
          provider strip. Pan responder wraps the hero area so swipes
          still work. Decision circles sit below the card. */}
      {!loading && isNarrow && activeCard ? (
        <View style={styles.narrowStack}>
          <Animated.View
            style={[
              styles.unifiedCard,
              Platform.OS === "web" && { touchAction: flipped ? "pan-y" : "none" },
              { opacity: swipeBusy ? 0.65 : 1 },
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
            {flipped ? flippedCard : <>
            {/* Poster tap reveals details without leaving this queue. */}
            <Pressable accessibilityRole="button" accessibilityLabel={`Flip ${activeCard.title.title} to details`} disabled={swipeBusy || !!swipeError} onPress={() => setFlipped(true)} style={styles.unifiedHero}>
              {(() => {
                const heroSource = resolveMediaUrl(
                  activeCard.title.backdrop_url || activeCard.title.poster_url || null,
                );
                return heroSource ? (
                  <Image source={{ uri: heroSource }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                ) : (
                  <View style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.surfaceMuted }]} />
                );
              })()}
              <View style={styles.unifiedHeroShade} />
              <View style={styles.unifiedBadge}>
                <Text style={styles.unifiedBadgeLabel}>
                  {activeCard.title.content_type === "movie" ? "MOVIE" : "SERIES"}
                </Text>
              </View>
              <Pressable
                onPress={(event) => { event.stopPropagation(); void openDetails(activeCard); }}
                hitSlop={8}
                style={styles.unifiedPlayTrailer}
                accessibilityLabel="Open full title details"
              >
                <View style={styles.unifiedPlayCircle}>
                  <Ionicons name="play" size={16} color={colors.ink} />
                </View>
                <Text style={styles.unifiedPlayLabel}>Full{"\n"}Details</Text>
              </Pressable>
            </Pressable>

            {/* Content body */}
            <View style={styles.unifiedBody}>
              <Text style={styles.unifiedTitle} numberOfLines={2}>{activeCard.title.title}</Text>
              <Text style={styles.unifiedMeta}>{buildCardMeta(activeCard, currentDetail)}</Text>
              <SceneDnaBadge titleId={activeCard.title.id} />

              {activeGenres ? (
                <View style={styles.unifiedGenreRow}>
                  {activeGenres.split(",").map((g) => g.trim()).filter(Boolean).slice(0, 4).map((g) => (
                    <View key={g} style={styles.unifiedGenreChip}>
                      <Text style={styles.unifiedGenreChipText}>{g}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {activeSynopsis ? (
                <Text style={styles.unifiedSynopsis} numberOfLines={2}>{activeSynopsis}</Text>
              ) : null}

              <View style={styles.unifiedDivider} />

              {activeCard.reason ? (
                <View style={styles.unifiedWhyBlock}>
                  <View style={styles.unifiedWhyRule} />
                  <View style={{ flex: 1 }}>
                    <View style={styles.unifiedWhyLabelRow}>
                      <Ionicons name="albums" size={11} color={colors.accent} />
                      <Text style={styles.unifiedWhyLabel}>WHY IT'S HERE</Text>
                    </View>
                    <Text style={styles.unifiedWhyText} numberOfLines={2}>{humanizeReason(activeCard.reason)}</Text>
                  </View>
                </View>
              ) : null}

              {activeStreaming.length > 0 ? (
                <View style={styles.unifiedProviderStrip}>
                  {activeStreaming.slice(0, 4).map((s) => {
                    const meta = getStreamingServiceMeta(s.service);
                    const label = (meta?.shortName || s.serviceName || "").toUpperCase();
                    // Real TMDB-provided logo takes precedence; brand
                    // short-name text is the fallback when logo_url
                    // isn't available for a provider.
                    return (
                      <Pressable key={s.service} onPress={() => void openProvider(s)} accessibilityLabel={`Watch on ${s.serviceName || s.service}`} disabled={!s.appUrl && !s.webUrl} style={[styles.unifiedProviderLogoWrap, { minHeight: 44, minWidth: 44 }]}>
                        {s.logoUrl ? (
                          <Image source={{ uri: s.logoUrl }} style={styles.unifiedProviderLogo} resizeMode="contain" />
                        ) : (
                          <View
                            style={[styles.unifiedProviderPill, meta ? { backgroundColor: meta.color } : null]}
                          >
                            <Text
                              style={[styles.unifiedProviderPillLabel, meta ? { color: meta.textColor } : null]}
                              numberOfLines={1}
                            >
                              {label}
                            </Text>
                          </View>
                        )}
                      </Pressable>
                    );
                  })}
                  {activeStreaming.length > 4 ? (
                    <View style={styles.unifiedProviderMore}>
                      <Text style={styles.unifiedProviderMoreLabel}>+{activeStreaming.length - 4} more</Text>
                      <Ionicons name="chevron-forward" size={11} color={colors.muted} />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>

            </>}
            {/* Directional feedback edges — same as before. */}
            <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipLeft, { opacity: leftLabelOpacity }]}>
              <Text style={styles.deckEdgeChipTextLeft}>PASS</Text>
            </Animated.View>
            <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipRight, { opacity: rightLabelOpacity }]}>
              <Text style={styles.deckEdgeChipTextRight}>MORE LIKE THIS</Text>
            </Animated.View>
            <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipTop, { opacity: upLabelOpacity }]}>
              <Text style={styles.deckEdgeChipTextTop}>WATCHED + RATE</Text>
            </Animated.View>
            <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipBottom, { opacity: downLabelOpacity }]}>
              <Text style={styles.deckEdgeChipTextBottom}>DIDN'T LIKE</Text>
            </Animated.View>
          </Animated.View>

          {/* Decision circles (same primitives, outside the card) */}
          <View style={styles.decisionDock}>
            <View style={styles.decisionCell}>
              <Pressable
                disabled={swipeBusy || !!swipeError}
            onPress={() => void animateSwipe("left")}
                accessibilityRole="button"
                accessibilityLabel={`Pass on ${activeCard.title.title}`}
                style={({ pressed }) => [styles.decisionCircle, styles.decisionCircleNeutral, pressed && { opacity: 0.72 }]}
              >
                <Ionicons name="close" size={28} color={colors.ink} />
              </Pressable>
              <Text style={styles.decisionLabel}>PASS</Text>
            </View>
            <View style={styles.decisionCell}>
              <Pressable
                disabled={swipeBusy || !!swipeError}
            onPress={() => void animateSwipe("right")}
                accessibilityRole="button"
                accessibilityLabel={`More like ${activeCard.title.title}`}
                style={({ pressed }) => [styles.decisionCircle, styles.decisionCirclePrimary, pressed && { opacity: 0.88 }]}
              >
                <Ionicons name="heart" size={28} color={colors.background} />
              </Pressable>
              <Text style={[styles.decisionLabel, styles.decisionLabelPrimary]}>MORE LIKE THIS</Text>
            </View>
            <View style={styles.decisionCell}>
              <Pressable
                onPress={() => {
                  if (!activeCard) return;
                  setSaveTitleId(activeCard.title.id);
                  setShowSaveSheet(true);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Save ${activeCard.title.title}`}
                style={({ pressed }) => [styles.decisionCircle, styles.decisionCircleNeutral, pressed && { opacity: 0.72 }]}
              >
                <Ionicons name="bookmark-outline" size={26} color={colors.ink} />
              </Pressable>
              <Text style={styles.decisionLabel}>SAVE</Text>
            </View>
          </View>
          {directActions}
        </View>
      ) : null}

      {/* Wide mode (desktop/tablet): existing two-column layout.
          Narrow mode is handled by the unified card above. */}
      {!loading && !isNarrow ? (
        <View
          style={[
            styles.workspace,
            {
              gap: workspaceGap,
              flexDirection: "row",
              alignItems: "flex-start",
            },
          ]}
        >
          {/* Poster deck column */}
          <View
            style={[
              styles.deckColumn,
              { width: posterColumnWidth },
            ]}
          >
            <View
              style={[
                styles.posterDeck,
                { width: posterMaxWidth, height: posterMaxWidth * 1.5 },
              ]}
            >
              {/* Queued layers — up to 2, offset behind the active card. */}
              {nextCards.slice(0, 2).reverse().map((item, index) => {
                const stackUri = resolveMediaUrl(item.title.poster_url || item.title.backdrop_url);
                const depth = index; // 0 = closest, 1 = furthest
                return (
                  <View
                    key={item.title.id}
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[
                      styles.deckLayer,
                      {
                        transform: [
                          { translateX: (depth + 1) * (viewportWidth < 400 ? 6 : 10) },
                          { translateY: (depth + 1) * 8 },
                          { scale: 1 - (depth + 1) * 0.03 },
                        ],
                        opacity: 0.35 - depth * 0.15,
                      },
                    ]}
                  >
                    {stackUri ? (
                      <Image
                        source={{ uri: stackUri }}
                        style={styles.deckLayerImage}
                        resizeMode="contain"
                      />
                    ) : null}
                  </View>
                );
              })}

              {/* Active card — draggable. */}
              {activeCard ? (
                <Animated.View
                  style={[
                    styles.deckActiveCard,
                    Platform.OS === "web" && { touchAction: flipped ? "pan-y" : "none" },
                    { opacity: swipeBusy ? 0.65 : 1 },
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
                  {flipped ? flippedCard : <Pressable accessibilityRole="button" accessibilityLabel={`Flip ${activeCard.title.title} to details`} disabled={swipeBusy || !!swipeError} onPress={() => setFlipped(true)} style={{ flex: 1, width: "100%" }}>
                  {activePoster ? (
                    <Image
                      source={{ uri: activePoster }}
                      style={styles.deckActivePoster}
                      resizeMode="contain"
                      accessibilityLabel={`${activeCard.title.title} poster`}
                    />
                  ) : (
                    <View style={styles.deckPosterFallback}>
                      <Text style={styles.deckPosterFallbackTitle} numberOfLines={4}>
                        {activeCard.title.title}
                      </Text>
                      <Text style={styles.deckPosterFallbackMeta}>
                        {activeCard.title.content_type === "movie" ? "FILM" : "SERIES"}
                      </Text>
                    </View>
                  )}

                  </Pressable>}

                  {/* Directional feedback — W02 commit labels. */}
                  <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipLeft, { opacity: leftLabelOpacity }]}>
                    <Text style={styles.deckEdgeChipTextLeft}>PASS</Text>
                  </Animated.View>
                  <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipRight, { opacity: rightLabelOpacity }]}>
                    <Text style={styles.deckEdgeChipTextRight}>MORE LIKE THIS</Text>
                  </Animated.View>
                  <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipTop, { opacity: upLabelOpacity }]}>
                    <Text style={styles.deckEdgeChipTextTop}>WATCHED + RATE</Text>
                  </Animated.View>
                  <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipBottom, { opacity: downLabelOpacity }]}>
                    <Text style={styles.deckEdgeChipTextBottom}>DIDN'T LIKE</Text>
                  </Animated.View>
                </Animated.View>
              ) : (
                <View style={styles.deckPosterFallback}>
                  <Text style={styles.deckPosterFallbackTitle}>Your next obsession is loading…</Text>
                  <Text style={styles.deckPosterFallbackMeta}>One more beat while we rebuild your queue.</Text>
                </View>
              )}
            </View>
          </View>

          {/* Details + controls column — flex:1 on wide so it takes
              the remaining row space. Narrow mode uses the unified
              card rendered above instead. */}
          <View style={[styles.railColumn, { flex: 1 }]}>
            {detailsAndControls}
          </View>
        </View>
      ) : null}

      <UniversalTitleModal
        visible={showDetails}
        loading={detailLoading}
        title={detailTitle}
        onClose={() => { detailRequestRef.current++; setShowDetails(false); }}
        onSaveTitle={(detail) => {
          setSaveTitleId(detail.id);
          setShowSaveSheet(true);
        }}
      />
      <TitleActionSheets target={actionTarget} token={sessionToken} source="swipe" onClose={() => setActionTarget(null)} />
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
      {/* Oct-27 Swipe semantics: UP = already watched + liked → the
          user must commit a specific 1–10 score before the deck
          advances past this prompt. Dismissing is also allowed; the
          swipe still counts as the watched signal. */}
      <RatingEditor
        visible={ratingTarget !== null}
        token={sessionToken}
        titleId={ratingTarget?.titleId ?? null}
        titleName={ratingTarget?.titleName ?? null}
        initial={null}
        onClose={() => setRatingTarget(null)}
        onChanged={(_: RatingSnapshot) => setRatingTarget(null)}
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
        </View>
      </ScrollView>
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
const MARK_COLOR = "rgba(255,230,0,0.50)";
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
    fontFamily: fonts.sans,
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

  swipeLegendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
    paddingBottom: 4,
  },
  swipeLegendPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.1)",
  },
  swipeLegendLabel: {
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.muted,
  },
  swipeUndoPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.accent,
    marginLeft: "auto",
  },
  swipeUndoLabel: {
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.background,
    fontFamily: fonts.sansSemiBold,
  },
  undoToast: {
    marginHorizontal: spacing.lg,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.78)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
  },
  undoToastLabel: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 11,
    lineHeight: 15,
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
    fontFamily: fonts.sans,
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
    fontFamily: fonts.sansBold,
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
    backgroundColor: "rgba(255,230,0,0.06)",
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
    fontFamily: fonts.sansBold,
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
    backgroundColor: "rgba(255,230,0,0.06)",
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
    fontFamily: fonts.sans,
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
    fontFamily: fonts.sansBold,
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
    fontFamily: fonts.sansBold,
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

  // ─── Redesigned Swipe (poster-first responsive) ─────────────────────
  workspaceScroll: {
    paddingBottom: 40,
  },
  workspaceContainer: {
    width: "100%",
    alignSelf: "center",
    gap: spacing.md,
  },
  // Legacy chip-style mode toggle — kept so other callers referencing
  // these style keys don't break during the staged rebuild.
  modeToggleRow: {
    flexDirection: "row",
    gap: 8,
    paddingTop: spacing.md,
  },
  modeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: "transparent",
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

  // Vision-mock centered SWIPE | PREVIEWS selector per Visual Design
  // brief §8. Uppercase mono labels, gold underline on active, no
  // background chip.
  modeSelectorRow: {
    paddingTop: spacing.md,
    alignItems: "center",
  },
  modeSelector: {
    flexDirection: "row",
    gap: 28,
    alignItems: "center",
  },
  modeOption: {
    alignItems: "center",
    paddingVertical: 6,
  },
  modeOptionLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 13,
    letterSpacing: 1.6,
    color: colors.muted,
    textTransform: "uppercase",
  },
  modeOptionLabelActive: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 13,
    letterSpacing: 1.6,
    color: colors.accent,
    textTransform: "uppercase",
  },
  modeOptionUnderline: {
    marginTop: 4,
    height: 2,
    width: 36,
    backgroundColor: colors.accent,
    borderRadius: 1,
  },
  featureHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  featureEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.8,
    color: colors.accent,
    textTransform: "uppercase",
  },
  featureTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  featureSubtitle: {
    fontFamily: fonts.sans,
    fontStyle: "italic",
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  featureProgress: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 1.2,
    paddingTop: 4,
  },

  workspace: {
    // Always row per user feedback — poster left, details right at
    // every viewport. Gap and column widths come from the caller
    // (workspaceGap + posterColumnWidth) since they depend on the
    // measured viewport.
    flexDirection: "row",
    alignItems: "flex-start",
  },
  workspaceWide: {
    // No-op retained for API compat with older commits that referenced
    // it. New code should not add narrow-vs-wide direction switches.
    flexDirection: "row",
    alignItems: "flex-start",
  },
  deckColumn: {
    alignItems: "center",
  },
  railColumn: {
    minWidth: 0,
  },

  // Deck — 2:3 portrait container that holds the active card + queued
  // layers. Fixed aspect ratio so the poster is never distorted, and
  // width driven by useWindowDimensions per spec §6.4.
  posterDeck: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  deckLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#0a0f18",
    borderWidth: 1,
    borderColor: rules.default,
  },
  deckLayerImage: {
    ...StyleSheet.absoluteFillObject,
  },
  deckActiveCard: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "#0a0f18",
    borderWidth: 1,
    borderColor: rules.default,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
    elevation: 12,
    // Web-only: block the browser's default touch-scroll while
    // dragging so the PanResponder receives every move event without
    // the parent ScrollView stealing the gesture. RN Native ignores
    // this CSS property; RN-Web forwards it to the div. `none` means
    // no browser-managed scrolling starts on this element — the card
    // owns the gesture end-to-end.
    touchAction: "none",
  },
  deckActivePoster: {
    ...StyleSheet.absoluteFillObject,
  },
  deckPosterFallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.sm,
  },
  deckPosterFallbackTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 20,
    textAlign: "center",
  },
  deckPosterFallbackMeta: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },

  // Directional feedback chips — restrained per spec §9, small and
  // pinned to the card corners rather than blanket overlays.
  deckEdgeChip: {
    position: "absolute",
    top: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 3,
    borderWidth: 1,
  },
  deckEdgeChipLeft: {
    left: 16,
    borderColor: colors.muted,
    backgroundColor: "rgba(7,11,18,0.72)",
  },
  deckEdgeChipRight: {
    right: 16,
    borderColor: colors.accent,
    backgroundColor: "rgba(255,230,0,0.14)",
  },
  deckEdgeChipTop: {
    top: 16,
    left: "50%",
    marginLeft: -70,
    width: 140,
    alignItems: "center",
    borderColor: colors.accent,
    backgroundColor: "rgba(255,230,0,0.14)",
  },
  deckEdgeChipBottom: {
    bottom: 16,
    left: "50%",
    marginLeft: -70,
    width: 140,
    alignItems: "center",
    borderColor: colors.danger,
    backgroundColor: "rgba(224,42,70,0.14)",
  },
  deckEdgeChipTextLeft: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.ink,
  },
  deckEdgeChipTextRight: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.accent,
  },
  deckEdgeChipTextTop: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.accent,
  },
  deckEdgeChipTextBottom: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.danger,
  },

  // Details + controls block — used in both narrow (below deck) and
  // wide (right rail) compositions, no forking.
  detailsBlock: {
    gap: spacing.sm,
    paddingTop: spacing.md,
  },
  detailsTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.3,
  },
  detailsMeta: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  detailsGenreRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 2,
  },
  detailsGenreChip: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  detailsGenreChipText: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  detailsSynopsis: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    opacity: 0.9,
  },
  detailsReasonBlock: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  detailsReasonRule: {
    width: 2,
    backgroundColor: rules.gold,
  },
  detailsReasonLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  detailsReasonLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  providerStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    padding: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  providerLogoBox: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  providerLogoImg: {
    width: 42,
    height: 24,
    borderRadius: 4,
  },
  providerPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  providerPillLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.8,
    color: colors.ink,
  },
  providerMore: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginLeft: "auto",
    paddingRight: 6,
  },
  providerMoreLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.6,
    color: colors.muted,
  },
  detailsReasonText: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
  },
  detailsStreaming: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.5,
    marginTop: 4,
  },

  controlRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.md,
  },
  controlBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  controlBtnNeutral: {
    borderWidth: 1,
    borderColor: rules.default,
    flexGrow: 1,
    flexBasis: 0,
  },
  controlBtnNeutralText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.0,
    color: colors.ink,
    textTransform: "uppercase",
  },
  controlBtnPrimary: {
    backgroundColor: colors.accent,
    flexGrow: 1.4,
    flexBasis: 0,
  },
  controlBtnPrimaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.0,
    color: colors.background,
    textTransform: "uppercase",
  },

  watchNowCta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: spacing.sm,
    minHeight: 44,
    borderRadius: 6,
    backgroundColor: colors.ink,
  },
  watchNowCtaText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 12,
    letterSpacing: 1.2,
    color: colors.background,
    textTransform: "uppercase",
  },

  swipeHint: {
    marginTop: 10,
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    textAlign: "center",
  },

  // Vision-mock decision dock. Three circular controls, centered,
  // with uppercase mono labels under each.
  decisionDock: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: 32,
    marginTop: spacing.lg,
  },
  decisionCell: {
    alignItems: "center",
    gap: 8,
    width: 92,
  },
  decisionCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  decisionCircleNeutral: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  decisionCirclePrimary: {
    backgroundColor: colors.accent,
  },
  decisionLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.muted,
    textAlign: "center",
    textTransform: "uppercase",
  },
  decisionLabelPrimary: {
    color: colors.ink,
  },

  // Narrow-mode unified card. Hero backdrop + content body + provider
  // strip in one bordered rounded container. Pan responder wraps it
  // so a drag anywhere on the card registers as a swipe.
  narrowStack: {
    width: "100%",
    alignItems: "stretch",
    gap: spacing.lg,
    paddingTop: spacing.sm,
  },
  unifiedCard: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "#0a0f18",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
    touchAction: "none",
  },
  unifiedHero: {
    width: "100%",
    aspectRatio: 16 / 11,
    position: "relative",
  },
  unifiedHeroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  unifiedBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  unifiedBadgeLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.ink,
  },
  unifiedPlayTrailer: {
    position: "absolute",
    right: 14,
    bottom: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  unifiedPlayCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  unifiedPlayLabel: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 11,
    lineHeight: 13,
    color: colors.ink,
    letterSpacing: 0.3,
  },
  unifiedBody: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: 10,
  },
  unifiedTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  unifiedMeta: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    marginTop: -4,
  },
  unifiedGenreRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  unifiedGenreChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.22)",
  },
  unifiedGenreChipText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.ink,
    letterSpacing: 0.2,
  },
  unifiedSynopsis: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 13,
    lineHeight: 18,
  },
  unifiedDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginVertical: 2,
  },
  unifiedWhyBlock: {
    flexDirection: "row",
    gap: 10,
  },
  unifiedWhyRule: {
    width: 2,
    backgroundColor: colors.accent,
    opacity: 0.75,
  },
  unifiedWhyLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  unifiedWhyLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.accent,
  },
  unifiedWhyText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.ink,
  },
  unifiedProviderStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    padding: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  unifiedProviderLogoWrap: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  unifiedProviderLogo: {
    width: 42,
    height: 24,
    borderRadius: 4,
  },
  unifiedProviderPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  unifiedProviderPillLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.8,
    color: colors.ink,
  },
  unifiedProviderMore: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginLeft: "auto",
    paddingRight: 6,
  },
  unifiedProviderMoreLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.6,
    color: colors.muted,
  },
});
