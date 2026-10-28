import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
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
import { apiRequest, resolveMediaUrl, resolvedApiBaseUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { type StreamingAvailability, getStreamingServiceMeta } from "@/lib/streaming";
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
//   left  — Pass (not interested)
//   right — Save to My Next Watch
//   up    — Already watched + liked → force a rating
//   down  — Already watched + didn't like → mark watched, score 2/10
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
  const [categoryFilter, setCategoryFilter] = useDiscoveryFilter();
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
        const p = new URLSearchParams({ limit: "40", session_id: sessionId });
        if (categoryFilter.media_type) p.set("preferred_type", categoryFilter.media_type);
        if (categoryFilter.genre) p.set("genre", categoryFilter.genre);
        const recsUrl = `/titles/recommendations/for-me?${p.toString()}`;
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
  }, [sessionToken, categoryFilter.media_type, categoryFilter.genre]);

  // Explicit reloader used by the "restart" flow and the reveal screen.
  const loadDeck = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: "40",
        session_id: sessionId,
      });
      if (categoryFilter.media_type) params.set("preferred_type", categoryFilter.media_type);
      if (categoryFilter.genre) params.set("genre", categoryFilter.genre);
      const recsUrl = `/titles/recommendations/for-me?${params.toString()}`;
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

    let cancelled = false;
    async function hydrateOne(item: RecommendationItem) {
      try {
        const detail = await fetchUniversalTitle(token, item.title.id, {
          id: item.title.id,
          title: item.title.title,
          content_type: item.title.content_type,
          poster_url: item.title.poster_url,
          backdrop_url: item.title.backdrop_url,
          overview: item.title.overview,
        });
        if (cancelled) return;
        setDetailCache((current) =>
          current[item.title.id] ? current : { ...current, [item.title.id]: detail }
        );
      } catch {
        // keep the swipe session moving even if enrichment fails
      }
    }
    for (const item of toHydrate) void hydrateOne(item);
    return () => {
      cancelled = true;
    };
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
      onStartShouldSetPanResponder: () => true,
      // Claim the touch aggressively so the parent ScrollView doesn't
      // steal horizontal drags. The old `() => true` returned true only
      // on the FIRST move sample; some browsers / RN-Web then handed the
      // gesture to the scroll container. Capture-phase variants and the
      // termination guard below keep the card in charge for the whole
      // gesture. Fixes "can't swipe easily with your finger" on mobile.
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: (_, gesture) => {
        // Only "capture" (steal from scroll) when the movement is
        // clearly horizontal-ish — a modest 4px threshold. Pure
        // vertical scrolls still work if the user isn't touching the
        // card intending to swipe.
        return Math.abs(gesture.dx) > 4 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
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
        if (gesture.dy > SWIPE_UP_THRESHOLD) {
          void animateSwipeRef.current("down");
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
    // Direction-specific flick sound. Left = descending thud (Pass),
    // right = rising two-tone pluck (More Like This), up = rising
    // major-third chord (Watch Now). Fires at the start of the exit
    // animation so audio and motion feel simultaneous.
    playSwipeSound(direction);

    const toValue =
      direction === "left"
        ? { x: -420, y: 30 }
        : direction === "right"
          ? { x: 420, y: 30 }
          : direction === "up"
            ? { x: 0, y: -420 }
            : { x: 0, y: 420 };

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
    if (direction === "up") {
      // Oct-27 Swipe semantics: UP means "already watched + liked".
      // Open the rating editor so the user commits a specific score.
      // Submitting any rating implicitly marks the title watched
      // server-side; this surface never writes a watched event without
      // a user action.
      setRatingTarget({ titleId: item.title.id, titleName: item.title.title });
    }
    // W03: if the user down-swipes a title they've already rated
    // positively (score >= 7), ask them to resolve the conflict
    // before we record the dislike. "An existing numeric score must
    // never be overwritten or cleared silently."  — spec.
    //
    // The server-side swipe path WON'T touch the rating anyway, but
    // leaving both signals in place is contradictory. Prompt for
    // Change rating / Cancel. Watched state stays either way.
    if (direction === "down") {
      void (async () => {
        try {
          type RatingResp = { score: number | null };
          const current = await apiRequest<RatingResp>(`/me/ratings/${item.title.id}`, { token: sessionToken });
          const score = typeof current?.score === "number" ? current.score : null;
          if (score !== null && score >= 7) {
            // Reverse the local progress so the card can be
            // restored or the user can re-rate.
            setSwipes((prev) => prev.slice(0, -1));
            setCurrentIndex((prev) => Math.max(0, prev - 1));
            Alert.alert(
              "You rated this " + score + "/10",
              "A thumbs-down swipe conflicts with your existing positive rating. Change the rating, or cancel this swipe?",
              [
                {
                  text: "Cancel swipe",
                  style: "cancel",
                  // Nothing further — local state is already restored.
                },
                {
                  text: "Change rating",
                  onPress: () => {
                    setRatingTarget({ titleId: item.title.id, titleName: item.title.title });
                  },
                },
              ],
            );
          }
        } catch {
          // Non-fatal — if we can't check, don't block the swipe.
        }
      })();
    }
    // DOWN handled by the backend swipe-record path alone: it writes
    // the SwipeRecord with direction=down and calls mark_watched. No
    // automatic numeric rating is fabricated per Oct-27 follow-up
    // ("do not assign an automatic 2/10 or other numeric score"). The
    // qualitative dislike is carried by the swipe direction itself.
    trackEvent(`swipe_${direction}`, {
      title_id: item.title.id,
      session_id: sessionId,
      pause_ms: pauseMs,
    });

    apiRequest<{
      swipe_id?: string;
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
        // Per-decision idempotency key (spec §12). A retried POST
        // with the same key returns the existing record instead of
        // creating a second signal for the same swipe.
        idempotency_key: `${sessionId}:${item.title.id}:${direction}:${cardStartRef.current}`,
      }),
    })
      .then((res) => {
        if (res?.swipe_id) {
          // W06: remember the last swipe so Undo can reverse it.
          setLastSwipe({
            swipeId: res.swipe_id,
            item,
            direction,
            at: Date.now(),
          });
        }
        if ((direction === "right" || direction === "up") && res?.scene_dna_feedback) {
          showDnaFeedback(res.scene_dna_feedback);
        }
      })
      .catch(() => {});
  }

  // Oct-27 W06: Undo the most recent eligible swipe. Reverses the
  // server-side effect (watched/saved), restores the card to the
  // deck, and clears the last-swipe memo.
  async function undoLastSwipe() {
    if (!sessionToken || !lastSwipe) return;
    const prev = lastSwipe;
    setLastSwipe(null);
    // Optimistic card restore: insert the item ahead of the current
    // index so the next render shows it again.
    setDeck((d) => {
      const next = [...d];
      next.splice(currentIndexRef.current, 0, prev.item);
      return next;
    });
    setSwipes((s) => {
      // Drop the matching trailing entry so progress and SceneDNA
      // snapshots don't double-count.
      for (let i = s.length - 1; i >= 0; i -= 1) {
        if (s[i].item.title.id === prev.item.title.id && s[i].direction === prev.direction) {
          return [...s.slice(0, i), ...s.slice(i + 1)];
        }
      }
      return s;
    });
    try {
      type UndoResp = { ok: boolean; reversed: string[]; partial_reason: string | null };
      const res = await apiRequest<UndoResp>(`/titles/swipes/${prev.swipeId}`, {
        method: "DELETE",
        token: sessionToken,
      });
      trackEvent("swipe_undo", {
        direction: prev.direction,
        reversed: res.reversed.join(","),
        partial_reason: res.partial_reason ?? "",
      });
      if (res.partial_reason) {
        // Honest partial-success toast — the card is restored but
        // the server-side state couldn't be fully reverted.
        showUndoToast(
          res.partial_reason === "rating_exists_newer"
            ? "Watched state was kept — you already rated this title."
            : "Some state couldn't be reversed.",
        );
      }
    } catch {
      // On failure, re-apply the swipe locally so state matches
      // what the server still has recorded.
      setDeck((d) => d.filter((it) => it.title.id !== prev.item.title.id || d.indexOf(it) !== currentIndexRef.current));
    }
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
    if (sessionToken) {
      void recordWatchHandoff(sessionToken, {
        titleId: revealDetail.id,
        providerCode: primary?.service ?? "unknown",
        outboundUrl: target,
        originSurface: "swipe_tab_reveal",
      });
    }
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
      const p = new URLSearchParams({ limit: "40", session_id: freshSession });
      if (categoryFilter.media_type) p.set("preferred_type", categoryFilter.media_type);
      if (categoryFilter.genre) p.set("genre", categoryFilter.genre);
      const recsUrl = `/titles/recommendations/for-me?${p.toString()}`;
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
  openDetailsForActiveRef.current = () => {
    void openDetails(activeCard);
  };

  // Presentational block for the current title's identity, metadata, reason,
  // decision controls, and Watch Now. Same JSX under both compositions so
  // narrow (below the deck) and wide (in the right rail) stay visually
  // identical. Handlers are the SAME references used by the gesture layer —
  // no domain behavior lives in this block per spec §9 action mapping contract.
  const detailsAndControls = activeCard ? (
    <View style={styles.detailsBlock}>
      <Text style={styles.detailsTitle} numberOfLines={isWide ? 3 : 2}>
        {activeCard.title.title}
      </Text>
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
                <View key={s.service} style={styles.providerLogoBox}>
                  <Image source={{ uri: s.logoUrl }} style={styles.providerLogoImg} resizeMode="contain" />
                </View>
              );
            }
            return (
              <View
                key={s.service}
                style={[styles.providerPill, meta ? { backgroundColor: meta.color } : null]}
              >
                <Text style={[styles.providerPillLabel, meta ? { color: meta.textColor } : null]} numberOfLines={1}>
                  {(meta?.shortName || s.serviceName || "").toUpperCase()}
                </Text>
              </View>
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

      {Platform.OS !== "web" ? (
        <Text style={styles.swipeHint}>
          Swipe up to Watch Now · tap PREVIEWS for trailers
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
          <CategoryChips
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
          />
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
              disabled={!activeCard}
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
              disabled={!activeCard}
              hitSlop={4}
              style={({ pressed }) => [styles.swipeLegendPill, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Save to My Next Watch"
            >
              <Ionicons name="arrow-forward" size={11} color={colors.muted} />
              <Text style={styles.swipeLegendLabel}>Save</Text>
            </Pressable>
            <Pressable
              onPress={() => activeCard && void animateSwipeRef.current("up")}
              disabled={!activeCard}
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
              disabled={!activeCard}
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
              {/* Primary CTAs: Watch Now + Keep Swiping. "Keep Swiping"
                  used to be a small secondary chip labeled "NEW SESSION"
                  — user feedback: that label wasn't intuitive and the
                  button was buried. It's now a first-class primary
                  action alongside Watch Now, because "give me more"
                  is the modal outcome most reveal viewers want next. */}
              <View style={styles.revealActions}>
                <Pressable
                  style={styles.revealPrimaryAction}
                  onPress={() => void streamReveal()}
                >
                  <Text style={styles.revealPrimaryText}>WATCH NOW</Text>
                </Pressable>
                <Pressable
                  style={styles.revealPrimaryAction}
                  onPress={() => void restartSession()}
                  accessibilityLabel="Keep swiping — start a new set"
                >
                  <Text style={styles.revealPrimaryText}>KEEP SWIPING</Text>
                </Pressable>
              </View>
              <View style={styles.revealActions}>
                <Pressable
                  style={styles.revealSecondaryAction}
                  onPress={() => {
                    setSaveTitleId(revealCandidate.title.id);
                    setShowSaveSheet(true);
                  }}
                >
                  <Text style={styles.revealSecondaryText}>SAVE</Text>
                </Pressable>
                <Pressable
                  style={styles.revealSecondaryAction}
                  onPress={() => {
                    setAddToTeamTitle({ id: revealCandidate.title.id, title: revealCandidate.title.title });
                    setShowAddToTeam(true);
                  }}
                >
                  <Text style={styles.revealSecondaryText}>ADD TO TEAM</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* Narrow mode (mobile): one unified bordered card containing
          hero backdrop + title identity + metadata + Why It's Here +
          provider strip. Pan responder wraps the hero area so swipes
          still work. Decision circles sit below the card. */}
      {!loading && !revealVisible && isNarrow && activeCard ? (
        <View style={styles.narrowStack}>
          <Animated.View
            style={[
              styles.unifiedCard,
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
            {/* Hero area with backdrop + title artwork + Play Trailer */}
            <View style={styles.unifiedHero}>
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
                onPress={() => void openDetails(activeCard)}
                hitSlop={8}
                style={styles.unifiedPlayTrailer}
                accessibilityLabel="Play trailer"
              >
                <View style={styles.unifiedPlayCircle}>
                  <Ionicons name="play" size={16} color={colors.ink} />
                </View>
                <Text style={styles.unifiedPlayLabel}>Play{"\n"}Trailer</Text>
              </Pressable>
            </View>

            {/* Content body */}
            <View style={styles.unifiedBody}>
              <Text style={styles.unifiedTitle} numberOfLines={2}>{activeCard.title.title}</Text>
              <Text style={styles.unifiedMeta}>{buildCardMeta(activeCard, currentDetail)}</Text>

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
                      <View key={s.service} style={styles.unifiedProviderLogoWrap}>
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
                      </View>
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

            {/* Directional feedback edges — same as before. */}
            <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipLeft, { opacity: leftLabelOpacity }]}>
              <Text style={styles.deckEdgeChipTextLeft}>PASS</Text>
            </Animated.View>
            <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipRight, { opacity: rightLabelOpacity }]}>
              <Text style={styles.deckEdgeChipTextRight}>SAVE</Text>
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
        </View>
      ) : null}

      {/* Wide mode (desktop/tablet): existing two-column layout.
          Narrow mode is handled by the unified card above. */}
      {!loading && !revealVisible && !isNarrow ? (
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

                  {/* Directional feedback — W02 commit labels. */}
                  <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipLeft, { opacity: leftLabelOpacity }]}>
                    <Text style={styles.deckEdgeChipTextLeft}>PASS</Text>
                  </Animated.View>
                  <Animated.View style={[styles.deckEdgeChip, styles.deckEdgeChipRight, { opacity: rightLabelOpacity }]}>
                    <Text style={styles.deckEdgeChipTextRight}>SAVE</Text>
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
