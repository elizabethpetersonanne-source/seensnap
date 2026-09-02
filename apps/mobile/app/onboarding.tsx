import * as SessionStorage from "@/lib/session-storage";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Image,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { Ionicons } from "@expo/vector-icons";
import { GoldButton } from "@/components/gold-button";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { ONBOARDING_COMPLETED_KEY } from "@/lib/onboarding";
import { playSwipeSound } from "@/lib/swipe-sfx";

// COUNTRIES list removed — region picker no longer in the onboarding
// flow per spec §7 (country_code defaults to "US" at account creation
// and can be adjusted in Settings later).

const STREAMING_SERVICES = [
  { id: "netflix", label: "Netflix" },
  { id: "prime_video", label: "Prime Video" },
  { id: "apple_tv_plus", label: "Apple TV+" },
  { id: "hbo_max", label: "Max" },
  { id: "disney_plus", label: "Disney+" },
  { id: "hulu", label: "Hulu" },
  { id: "paramount_plus", label: "Paramount+" },
  { id: "peacock", label: "Peacock" },
];

const CALIBRATION_TARGET = 20;
const SWIPE_THRESHOLD = 80;

// Spec §7 flow: Welcome → Auth → Basics → Streaming Services →
// Calibration Intro → Calibration → SceneDNA Reveal → Discover.
// Region step is intentionally dropped per spec (country defaults to
// "US" at account creation and can be adjusted in Settings). First-list
// creation is EXPLICITLY a Non-Goal per spec §4.
type Step = "welcome" | "basics" | "services" | "calibrate-intro" | "calibrate" | "dna" | "complete";

type Title = {
  id: string;
  title: string;
  poster_url: string | null;
  media_type: string;
  release_year: number | null;
  genres: string[];
};

// Extracted body of the Basics step so the same JSX can render inside
// a KeyboardAvoidingView on native and a plain ScrollView on web
// without duplicating the form markup.
type HandleStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; normalized: string }
  | { state: "unavailable"; reason: string };

function BasicsBody({
  slideStyle,
  displayName,
  setDisplayName,
  handle,
  setHandle,
  checkHandleAvailability,
  handleStatus,
  isSaving,
  onContinue,
}: {
  slideStyle: { transform: { translateX: Animated.AnimatedInterpolation<string | number> }[] };
  displayName: string;
  setDisplayName: (v: string) => void;
  handle: string;
  setHandle: (v: string) => void;
  checkHandleAvailability: (v: string) => void;
  handleStatus: HandleStatus;
  isSaving: boolean;
  onContinue: () => void;
}) {
  return (
    <Animated.View style={[styles.stepWrap, slideStyle]}>
      <View style={styles.headerBlock}>
        <Text style={styles.eyebrow}>STEP 1 / 3</Text>
        <View style={styles.goldRule} />
        <Text style={styles.serif}>What should{"\n"}we call you?</Text>
      </View>
      <Text style={styles.bodySmall}>
        This is the name shown on your Picks, Teams and profile.
      </Text>
      <TextInput
        autoCapitalize="words"
        autoComplete="name"
        autoCorrect={false}
        placeholder="Your name"
        placeholderTextColor={colors.muted2}
        value={displayName}
        onChangeText={setDisplayName}
        style={styles.nameInput}
        maxLength={60}
        returnKeyType="next"
      />
      <Text style={styles.bodySmall}>
        Pick a handle — this is your public @-name. Letters, numbers, dots and underscores.
      </Text>
      <TextInput
        autoCapitalize="none"
        autoComplete="username"
        autoCorrect={false}
        placeholder="@yourhandle"
        placeholderTextColor={colors.muted2}
        value={handle}
        onChangeText={(v) => {
          setHandle(v);
          checkHandleAvailability(v);
        }}
        style={styles.nameInput}
        maxLength={40}
        returnKeyType="done"
        onSubmitEditing={onContinue}
      />
      {handleStatus.state === "checking" ? (
        <Text style={[styles.bodySmall, { color: colors.muted2, marginTop: -spacing.lg }]}>
          Checking…
        </Text>
      ) : handleStatus.state === "available" ? (
        <Text style={[styles.bodySmall, { color: colors.accent, marginTop: -spacing.lg }]}>
          ✓ @{handleStatus.normalized} is available
        </Text>
      ) : handleStatus.state === "unavailable" ? (
        <Text style={[styles.bodySmall, { color: colors.danger ?? "#E74C3C", marginTop: -spacing.lg }]}>
          {handleStatus.reason === "taken"
            ? "Already taken — try another."
            : handleStatus.reason === "too_short"
              ? "At least 3 characters."
              : handleStatus.reason === "too_long"
                ? "Under 40 characters."
                : handleStatus.reason === "invalid_chars"
                  ? "Letters, numbers, dots and underscores only."
                  : "Not available."}
        </Text>
      ) : null}
      <GoldButton
        label={isSaving ? "Saving..." : "Continue"}
        icon="arrow-forward"
        size="lg"
        onPress={onContinue}
        style={styles.cta}
      />
    </Animated.View>
  );
}

export default function OnboardingScreen() {
  const { sessionToken, user, updateSessionUser } = useAuth();
  const [step, setStep] = useState<Step>("welcome");
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  // Handle (unique username). Live-checked against
  // GET /me/username-check as the user types (small debounce).
  const [handle, setHandle] = useState("");
  const [handleStatus, setHandleStatus] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "available"; normalized: string }
    | { state: "unavailable"; reason: string }
  >({ state: "idle" });
  const handleCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkHandleAvailability = useCallback(
    (value: string) => {
      if (handleCheckTimer.current) clearTimeout(handleCheckTimer.current);
      if (!sessionToken) return;
      const trimmed = value.trim().toLowerCase();
      if (!trimmed) {
        setHandleStatus({ state: "idle" });
        return;
      }
      setHandleStatus({ state: "checking" });
      handleCheckTimer.current = setTimeout(async () => {
        try {
          const resp = await apiRequest<{
            available: boolean;
            reason?: string | null;
            normalized?: string | null;
          }>(`/me/username-check?username=${encodeURIComponent(trimmed)}`, {
            token: sessionToken,
          });
          if (resp.available) {
            setHandleStatus({ state: "available", normalized: resp.normalized ?? trimmed });
          } else {
            setHandleStatus({ state: "unavailable", reason: resp.reason ?? "unavailable" });
          }
        } catch {
          setHandleStatus({ state: "idle" });
        }
      }, 320);
    },
    [sessionToken],
  );

  // Calibration state
  const [candidates, setCandidates] = useState<Title[]>([]);
  const [calibrateIndex, setCalibrateIndex] = useState(0);
  const [swipeCount, setSwipeCount] = useState(0);
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  // Step animation — translateX-only "slide in from the right" so
  // even if the animation callback silently no-ops on RN-Web (which
  // happens with useNativeDriver in some browser environments), the
  // step is always fully visible. Previously we animated opacity
  // 0 → 1, and if the timing callback dropped, the whole step
  // rendered invisible (user reported blank page after "Get Started").
  const stepAnim = useRef(new Animated.Value(1)).current;

  function animateIn() {
    stepAnim.setValue(0);
    // useNativeDriver=false because on RN-Web the native-driver
    // interpolation for a transform target can silently discard the
    // update; JS driver reliably ticks the interpolate. Also, we
    // deliberately do NOT bind opacity to stepAnim anymore — content
    // is visible from the first frame.
    Animated.timing(stepAnim, { toValue: 1, duration: 240, useNativeDriver: false }).start();
  }

  const slideStyle = {
    transform: [
      {
        translateX: stepAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }),
      },
    ],
  };

  function advance(next: Step) {
    setStep(next);
    animateIn();
  }

  function toggleService(id: string) {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Fetch calibration titles + resume from server-persisted swipe count.
  const fetchCandidates = useCallback(async () => {
    if (!sessionToken) return;
    setLoadingCandidates(true);
    try {
      // Resume from previously-recorded calibration swipes so kill/relaunch doesn't reset progress.
      try {
        const progress = await apiRequest<{ signal_count: number; target: number; completed: boolean }>(
          "/me/onboarding-progress",
          { token: sessionToken }
        );
        if (progress.signal_count > 0) {
          setSwipeCount(Math.min(progress.signal_count, CALIBRATION_TARGET));
          setCalibrateIndex(Math.min(progress.signal_count, CALIBRATION_TARGET));
        }
      } catch {
        // Best-effort — if the endpoint fails, start from zero (no regression).
      }

      const results = await apiRequest<Title[]>("/titles/calibration-candidates", {
        token: sessionToken,
      });
      setCandidates(results.slice(0, CALIBRATION_TARGET + 5));
      trackEvent("taste_calibration_started", {});
    } catch {
      // Fallback to trending if calibration endpoint fails
      try {
        const trending = await apiRequest<Title[]>("/titles/trending?limit=25", {
          token: sessionToken,
        });
        setCandidates(trending.slice(0, CALIBRATION_TARGET + 5));
      } catch {
        // Can't load calibration — skip step
      }
    } finally {
      setLoadingCandidates(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    if (step === "calibrate" && candidates.length === 0) {
      void fetchCandidates();
    }
  }, [step, candidates.length, fetchCandidates]);

  useEffect(() => {
    if (!displayName && user?.display_name) {
      setDisplayName(user.display_name);
    }
  }, [user?.display_name, displayName]);

  // Calibration swipe card
  const pan = useRef(new Animated.ValueXY()).current;
  // Ref that always points at the LATEST swipeCard closure. The
  // PanResponder is created once with useRef and its release callback
  // otherwise captures the first-render swipeCard — which sees
  // candidates=[] / calibrateIndex=0 and early-returns. Same pattern
  // as the main Swipe tab's animateSwipeRef.
  const swipeCardRef = useRef<(dir: "left" | "right", input?: "gesture" | "button") => void>(() => {});

  const recordSwipe = useCallback(
    async (
      direction: "left" | "right",
      titleId: string,
      inputMethod: "gesture" | "button",
      position: number,
    ) => {
      if (!sessionToken) return;
      try {
        await apiRequest("/titles/swipes", {
          method: "POST",
          token: sessionToken,
          body: JSON.stringify({
            title_id: titleId,
            direction,
            source_surface: "onboarding_calibration",
            // Spec §12: idempotent swipe writes. Per-decision key so
            // a retried POST doesn't count as a double signal.
            idempotency_key: `onboarding:${titleId}:${direction}:${position}`,
          }),
        });
        // Spec §14 canonical event with action/title_id/position/input_method.
        trackEvent("onboarding_calibration_action", {
          action: direction === "left" ? "pass" : "more_like_this",
          title_id: titleId,
          position,
          input_method: inputMethod,
        });
      } catch {
        trackEvent("onboarding_error", { step: "calibrate", code: "swipe_record_failed" });
        // Non-blocking — swipe is best-effort during calibration
      }
    },
    [sessionToken]
  );

  const swipeCard = useCallback(
    (direction: "left" | "right", inputMethod: "gesture" | "button" = "gesture") => {
      const card = candidates[calibrateIndex];
      if (!card) return;

      // Match main-tab swipe: direction-specific sound cue at exit start.
      playSwipeSound(direction);

      const toX = direction === "right" ? 400 : -400;
      const positionAtSwipe = swipeCount + 1;
      Animated.timing(pan, {
        toValue: { x: toX, y: 0 },
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        pan.setValue({ x: 0, y: 0 });
        void recordSwipe(direction, card.id, inputMethod, positionAtSwipe);
        const next = calibrateIndex + 1;
        const nextCount = swipeCount + 1;
        setCalibrateIndex(next);
        setSwipeCount(nextCount);
        if (nextCount >= CALIBRATION_TARGET) {
          trackEvent("onboarding_calibration_completed", { signals: nextCount });
          advance("dna");
        }
      });
    },
    [calibrateIndex, candidates, pan, recordSwipe, swipeCount]
  );

  // Keep the ref pointed at the latest swipeCard closure so the
  // memoized PanResponder release callback always sees fresh state.
  swipeCardRef.current = swipeCard;

  // Per spec ONB-01: skip / "don't know" is neutral. Advance past the card without
  // recording a swipe and without incrementing swipeCount toward the 20-signal target.
  const skipCard = useCallback(() => {
    const card = candidates[calibrateIndex];
    if (!card) return;
    // Non-decision — no swipe event recorded, no signal counted.
    // Spec §14 has no dedicated skip event; the funnel captures
    // "reached calibration but didn't complete" via _exited/_resumed.
    trackEvent("onboarding_calibration_exited", { position: calibrateIndex + 1, reason: "card_skip" });
    setCalibrateIndex((i) => i + 1);
    // If we're about to run out of cards, gracefully advance to the DNA reveal
    // even without hitting 20 — the reveal already handles low-signal state.
    if (calibrateIndex + 1 >= candidates.length) {
      advance("dna");
    }
  }, [calibrateIndex, candidates]);

  const panResponder = useRef(
    PanResponder.create({
      // Same capture-phase + termination guards as the main Swipe tab
      // so horizontal drags aren't stolen by the parent ScrollView on
      // RN-Web / mobile Safari (fixes stuck-finger swipe on mobile).
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        Math.abs(gesture.dx) > 4 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: (_, gesture) => {
        // Call through the ref so we always hit the LATEST swipeCard
        // closure (with current candidates + calibrateIndex + swipeCount).
        // Otherwise this fires the first-render swipeCard, which saw
        // candidates=[] and early-returned — the reported "swipe doesn't
        // actually work" symptom.
        if (gesture.dx > SWIPE_THRESHOLD) {
          swipeCardRef.current("right", "gesture");
        } else if (gesture.dx < -SWIPE_THRESHOLD) {
          swipeCardRef.current("left", "gesture");
        } else {
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  async function saveBasicsAndContinue() {
    if (!sessionToken) {
      advance("services");
      return;
    }
    const name = displayName.trim();
    if (!name) {
      advance("services");
      return;
    }
    setIsSaving(true);
    try {
      const body: Record<string, string> = { display_name: name };
      // Only include username in the PATCH when it passed the live
      // availability check — sending an unchecked or unavailable
      // handle would either 409 or silently apply. Handle is
      // optional in Basics: users who don't set one get whatever
      // default was assigned at signup (email-derived).
      if (handleStatus.state === "available") {
        body.username = handleStatus.normalized;
      }
      await apiRequest("/me", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify(body),
      });
      await updateSessionUser({ display_name: name });
      trackEvent("onboarding_profile_completed", {
        set_handle: handleStatus.state === "available",
      });
    } catch {
      trackEvent("onboarding_error", { step: "basics", code: "profile_save_failed" });
      // Don't block onboarding on name-save failure — the user can edit later
    } finally {
      setIsSaving(false);
      advance("services");
    }
  }

  async function saveAndContinue(skipped = false) {
    if (!sessionToken) return;
    setIsSaving(true);
    try {
      // Region is no longer part of the onboarding flow per spec §7 —
      // country_code stays at the account default (usually "US") and
      // can be adjusted in Settings later. Only streaming providers
      // are captured here; provider selection is availability data,
      // not taste evidence, per spec §8.4 data rule.
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({
          connected_streaming_services: Array.from(selectedServices),
        }),
      });
      trackEvent(
        skipped ? "onboarding_providers_skipped" : "onboarding_providers_completed",
        { services_count: selectedServices.size },
      );
      advance("calibrate-intro");
    } catch {
      trackEvent("onboarding_error", { step: "services", code: "prefs_save_failed" });
      advance("calibrate-intro");
    } finally {
      setIsSaving(false);
    }
  }

  async function completeOnboarding() {
    if (!sessionToken) return;
    setIsSaving(true);
    try {
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ onboarding_completed: true }),
      });
      await SessionStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
    } catch {
      await SessionStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
    } finally {
      setIsSaving(false);
    }
  }

  async function skip() {
    if (!sessionToken) return;
    try {
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ onboarding_completed: true }),
      });
      await SessionStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
      // Per spec §5.5 Preserve Momentum: skip is neutral, never
      // recorded as dislike. Spec §14 event name: no dedicated "skip"
      // event required, just onboarding_completed with the state we
      // reached. This preserves funnel visibility without inventing
      // a signal.
      trackEvent("onboarding_completed", { swipes: swipeCount, skipped_at: step });
    } catch {
      await SessionStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
    }
    router.replace("/(tabs)");
  }

  // Progress bar — show as small dots between Basics and Calibration.
  // Removed the "region" step per spec §7 (country_code stays at
  // account default). Removed "first-list" step per spec §4 Non-Goals.
  const MAIN_STEPS: Step[] = ["welcome", "basics", "services", "calibrate-intro", "calibrate"];
  const stepIndex = MAIN_STEPS.indexOf(step);
  const showDots = stepIndex !== -1 && step !== "welcome";

  const currentCard = candidates[calibrateIndex] ?? null;
  const nextCard = candidates[calibrateIndex + 1] ?? null;
  const cardRotate = pan.x.interpolate({
    inputRange: [-200, 0, 200],
    outputRange: ["-8deg", "0deg", "8deg"],
    extrapolate: "clamp",
  });
  const leftLabelOpacity = pan.x.interpolate({
    inputRange: [-SWIPE_THRESHOLD, -20, 0],
    outputRange: [1, 0.3, 0],
    extrapolate: "clamp",
  });
  const rightLabelOpacity = pan.x.interpolate({
    inputRange: [0, 20, SWIPE_THRESHOLD],
    outputRange: [0, 0.3, 1],
    extrapolate: "clamp",
  });

  // Poster deck geometry — mirrors the main Swipe tab so calibration
  // teaches the exact interaction users see after onboarding.
  const { width: calibrateViewport } = useWindowDimensions();
  const calibratePadding = calibrateViewport < 480 ? 16 : 20;
  const posterMaxWidth = Math.min(
    360,
    Math.max(200, calibrateViewport - calibratePadding * 2),
  );
  const posterHeight = posterMaxWidth * 1.5;

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header bar */}
      <View style={styles.headerBar}>
        {showDots ? (
          <View style={styles.dots}>
            {MAIN_STEPS.slice(1).map((s) => (
              <View key={s} style={[styles.dot, step === s && styles.dotActive]} />
            ))}
          </View>
        ) : (
          <View />
        )}
        {step !== "complete" && step !== "dna" ? (
          <Pressable onPress={() => void skip()} hitSlop={12}>
            <Text style={styles.skipText}>Skip</Text>
          </Pressable>
        ) : null}
      </View>

      {/* WELCOME — spec §8.1 canonical hero copy. */}
      {step === "welcome" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>SEENSNAP</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>Find what{"\n"}to watch next.</Text>
          </View>
          <Text style={styles.body}>
            Build your SceneDNA from what you love, save picks, and discover titles worth
            your time.
          </Text>
          <GoldButton
            label="Get started"
            icon="arrow-forward"
            size="lg"
            onPress={() => {
              trackEvent("onboarding_welcome_viewed", {});
              advance("basics");
            }}
            style={styles.cta}
          />
        </Animated.View>
      ) : null}

      {/* BASICS — display name + unique handle.
           Prior version wrapped the step in KeyboardAvoidingView with
           behavior=undefined on web, and inside that a
           Animated.View style={[stepWrap:flex:1, slideStyle]}.
           On some RN-Web versions the KAV rendered a wrapping div
           without explicit sizing so the child flex:1 collapsed to
           zero height = blank page reported after "Get Started".
           Switched to a plain ScrollView on web — KAV is a no-op
           there anyway (no on-screen keyboard) and ScrollView guarantees
           a concrete render box + lets long content (name + handle +
           status + CTA) scroll on short viewports. */}
      {step === "basics" ? (
        Platform.OS === "web" ? (
          <ScrollView contentContainerStyle={styles.stepScroll}>
            <BasicsBody
              slideStyle={slideStyle}
              displayName={displayName}
              setDisplayName={setDisplayName}
              handle={handle}
              setHandle={setHandle}
              checkHandleAvailability={checkHandleAvailability}
              handleStatus={handleStatus}
              isSaving={isSaving}
              onContinue={() => void saveBasicsAndContinue()}
            />
          </ScrollView>
        ) : (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <BasicsBody
              slideStyle={slideStyle}
              displayName={displayName}
              setDisplayName={setDisplayName}
              handle={handle}
              setHandle={setHandle}
              checkHandleAvailability={checkHandleAvailability}
              handleStatus={handleStatus}
              isSaving={isSaving}
              onContinue={() => void saveBasicsAndContinue()}
            />
          </KeyboardAvoidingView>
        )
      ) : null}

      {/* STREAMING SERVICES — spec §8.4 canonical heading + copy +
           explicit "Skip for now" secondary action. */}
      {step === "services" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>STEP 2 / 3</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>Where do{"\n"}you watch?</Text>
          </View>
          <Text style={styles.bodySmall}>
            Choose any services you use. We'll prioritize titles you can stream — but this
            won't limit what you can discover.
          </Text>
          <View style={styles.serviceGrid}>
            {STREAMING_SERVICES.map((s) => {
              const selected = selectedServices.has(s.id);
              return (
                <Pressable
                  key={s.id}
                  style={[styles.serviceChip, selected && styles.serviceChipSelected]}
                  onPress={() => toggleService(s.id)}
                >
                  {selected ? <Text style={styles.serviceCheck}>✓ </Text> : null}
                  <Text style={[styles.serviceChipText, selected && styles.serviceChipTextSelected]}>
                    {s.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <GoldButton
            label={isSaving ? "Saving..." : "Continue"}
            icon="arrow-forward"
            size="lg"
            onPress={() => void saveAndContinue(false)}
            style={styles.cta}
          />
          <Pressable style={styles.skipLink} onPress={() => void saveAndContinue(true)}>
            <Text style={styles.skipLinkText}>Skip for now</Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* CALIBRATION INTRO — spec §8.5 sets expectations before the
           first swipe. Shown ONCE. No multi-screen tutorial. */}
      {step === "calibrate-intro" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>STEP 3 / 3</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>Let's tune{"\n"}your picks.</Text>
          </View>
          <Text style={styles.body}>
            React to a few titles so SeenSnap can start learning what fits you. Aim for 20 —
            you can leave anytime.
          </Text>
          <View style={styles.propList}>
            <View style={styles.propRow}>
              <Text style={styles.propIndex}>←</Text>
              <Text style={styles.propText}>Swipe left: Pass</Text>
            </View>
            <View style={styles.propRow}>
              <Text style={styles.propIndex}>→</Text>
              <Text style={styles.propText}>Swipe right: More Like This</Text>
            </View>
            <View style={styles.propRow}>
              <Text style={styles.propIndex}>↑</Text>
              <Text style={styles.propText}>Save it to My Picks — a strong positive signal</Text>
            </View>
          </View>
          <GoldButton
            label="Start swiping"
            icon="arrow-forward"
            size="lg"
            onPress={() => {
              trackEvent("onboarding_calibration_started", {});
              advance("calibrate");
            }}
            style={styles.cta}
          />
          <Pressable style={styles.skipLink} onPress={() => void skip()}>
            <Text style={styles.skipLinkText}>Do this later</Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* CALIBRATION SWIPE — visually + interactively matches the
           production Swipe tab so users learn the real gesture once.
           Poster-first (2:3 contain), stacked queue behind the active
           card, direction-chip edge overlays, and the same yellow
           "More Like This" primary / neutral "Pass" button pair. */}
      {step === "calibrate" ? (
        <View style={styles.calibrateWrap}>
          <View style={styles.calibrateHeader}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.featureEyebrow}>TASTE CALIBRATION</Text>
              <Text style={styles.featureTitle}>What&apos;s Next?</Text>
              <Text style={styles.featureSubtitle}>Swipe to shape your SceneDNA.</Text>
            </View>
            <Text style={styles.featureProgress}>
              {Math.min(swipeCount, CALIBRATION_TARGET)}/{CALIBRATION_TARGET}
            </Text>
          </View>

          {loadingCandidates || !currentCard ? (
            <View style={styles.calibrateLoading}>
              <Text style={styles.calibrateLoadingTitle}>Building your candidate pool</Text>
              <View style={styles.calibrateLoadingRule} />
              <Text style={styles.calibrateLoadingBody}>Just a moment…</Text>
            </View>
          ) : (
            <View style={styles.calibrateBody}>
              <View
                style={[
                  styles.posterDeck,
                  { width: posterMaxWidth, height: posterHeight },
                ]}
              >
                {/* Queued next card behind the active one. */}
                {nextCard ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.deckLayer,
                      {
                        transform: [{ translateX: 8 }, { translateY: 8 }, { scale: 0.97 }],
                        opacity: 0.35,
                      },
                    ]}
                  >
                    {nextCard.poster_url ? (
                      <Image
                        source={{ uri: nextCard.poster_url }}
                        style={styles.deckLayerImage}
                        resizeMode="contain"
                      />
                    ) : null}
                  </View>
                ) : null}

                {/* Active card — draggable. */}
                <Animated.View
                  style={[
                    styles.deckActiveCard,
                    {
                      transform: [
                        { translateX: pan.x },
                        { translateY: pan.y },
                        { rotate: cardRotate },
                      ],
                    },
                  ]}
                  {...panResponder.panHandlers}
                >
                  {currentCard.poster_url ? (
                    <Image
                      source={{ uri: currentCard.poster_url }}
                      style={StyleSheet.absoluteFillObject}
                      resizeMode="contain"
                      accessibilityLabel={`${currentCard.title} poster`}
                    />
                  ) : (
                    <View style={styles.deckPosterFallback}>
                      <Text style={styles.deckPosterFallbackTitle} numberOfLines={4}>
                        {currentCard.title}
                      </Text>
                      <Text style={styles.deckPosterFallbackMeta}>
                        {currentCard.media_type === "movie" ? "FILM" : "SERIES"}
                      </Text>
                    </View>
                  )}

                  <Animated.View
                    style={[styles.deckEdgeChip, styles.deckEdgeChipLeft, { opacity: leftLabelOpacity }]}
                  >
                    <Text style={styles.deckEdgeChipTextLeft}>PASS</Text>
                  </Animated.View>
                  <Animated.View
                    style={[styles.deckEdgeChip, styles.deckEdgeChipRight, { opacity: rightLabelOpacity }]}
                  >
                    <Text style={styles.deckEdgeChipTextRight}>MORE LIKE THIS</Text>
                  </Animated.View>
                </Animated.View>
              </View>

              {/* Details block — mirrors main Swipe tab: title + meta chip + genre chips. */}
              <View style={styles.detailsBlock}>
                <Text style={styles.detailsTitle} numberOfLines={2}>
                  {currentCard.title}
                </Text>
                <Text style={styles.detailsMeta}>
                  {[
                    currentCard.media_type === "movie" ? "FILM" : "SERIES",
                    currentCard.release_year,
                  ]
                    .filter(Boolean)
                    .join("  ·  ")}
                </Text>
                {currentCard.genres.length > 0 ? (
                  <View style={styles.detailsGenreRow}>
                    {currentCard.genres.slice(0, 2).map((g) => (
                      <View key={g} style={styles.detailsGenreChip}>
                        <Text style={styles.detailsGenreChipText}>{g}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                <View style={styles.controlRow}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.controlBtn,
                      styles.controlBtnNeutral,
                      pressed && { opacity: 0.7 },
                    ]}
                    onPress={() => swipeCard("left", "button")}
                    accessibilityRole="button"
                    accessibilityLabel={`Pass on ${currentCard.title}`}
                  >
                    <Ionicons name="close" size={18} color={colors.muted} />
                    <Text style={styles.controlBtnNeutralText}>Pass</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.controlBtn,
                      styles.controlBtnPrimary,
                      pressed && { opacity: 0.85 },
                    ]}
                    onPress={() => swipeCard("right", "button")}
                    accessibilityRole="button"
                    accessibilityLabel={`More like ${currentCard.title}`}
                  >
                    <Ionicons name="heart" size={16} color={colors.background} />
                    <Text style={styles.controlBtnPrimaryText}>More Like This</Text>
                  </Pressable>
                </View>
                <Pressable style={styles.skipCardLink} onPress={skipCard} hitSlop={8}>
                  <Text style={styles.skipCardLinkText}>Skip this card</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      ) : null}

      {/* SCENE DNA REVEAL — spec §8.7 canonical HONEST state.
           No invented "signals collected / recs to unlock ∞" stats
           (those were flagged in spec §8.7: "Do not render empty
           charts, invented percentages, personality labels, or
           unsupported strongest signals.")
           The reveal reflects reality: if the user reached the 20-swipe
           target, their profile is forming; if they skipped early,
           we say so — same honest headline either way.
           Primary CTA routes to Discover per spec §7 handoff. */}
      {step === "dna" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>YOUR SCENEDNA</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>Your SceneDNA{"\n"}is taking shape.</Text>
          </View>
          <Text style={styles.body}>
            {swipeCount >= 5
              ? `You made ${swipeCount} decisions — that's a real head start. The more you rate, save, and swipe, the more personal your recommendations become.`
              : "The more you rate, save, and swipe, the more personal your recommendations become."}
          </Text>
          <GoldButton
            label="Go to Discover"
            icon="arrow-forward"
            size="lg"
            onPress={async () => {
              trackEvent("onboarding_scenedna_reveal_viewed", { swipes: swipeCount });
              await completeOnboarding();
              trackEvent("onboarding_completed", {
                services_count: selectedServices.size,
                swipes: swipeCount,
              });
              router.replace("/(tabs)");
            }}
            style={styles.cta}
          />
          <Pressable
            style={styles.skipLink}
            onPress={() => {
              advance("calibrate");
            }}
          >
            <Text style={styles.skipLinkText}>Keep swiping</Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* COMPLETE */}
      {step === "complete" ? (
        <View style={[styles.stepWrap, styles.completeWrap]}>
          <Text style={styles.eyebrow}>ALL SET</Text>
          <View style={styles.goldRule} />
          <Text style={[styles.serif, { marginTop: spacing.md, textAlign: "center" }]}>
            Start discovering.
          </Text>
          <Text style={[styles.bodySmall, { textAlign: "center", marginTop: spacing.md }]}>
            Your Scene DNA is live. The more you interact, the sharper it gets.
          </Text>
          <GoldButton
            label="Start swiping"
            icon="layers"
            size="lg"
            onPress={() => router.replace("/(tabs)/swipe")}
            style={[styles.cta, { marginTop: spacing.xl }]}
          />
          <Pressable style={styles.skipLink} onPress={() => router.replace("/(tabs)")}>
            <Text style={styles.skipLinkText}>Browse Discover first</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  dots: {
    flexDirection: "row",
    gap: 6,
  },
  dot: {
    width: 24,
    height: 2,
    backgroundColor: rules.default,
  },
  dotActive: {
    backgroundColor: colors.accent,
  },
  skipText: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  stepWrap: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  stepScroll: {
    // ScrollView contentContainerStyle for the web variant of the
    // basics step. flexGrow ensures the child Animated.View's flex:1
    // has a concrete parent height even when the browser hasn't laid
    // out anything yet.
    flexGrow: 1,
  },
  completeWrap: {
    justifyContent: "center",
    alignItems: "center",
  },
  headerBlock: {
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  eyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.accent,
    textTransform: "uppercase",
  },
  goldRule: {
    height: 1,
    width: 40,
    backgroundColor: rules.gold,
    marginVertical: 2,
  },
  serif: {
    fontFamily: fonts.serifBold,
    fontSize: 38,
    lineHeight: 44,
    color: colors.ink,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 23,
    color: colors.muted,
    marginBottom: spacing.xl,
  },
  bodySmall: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    marginBottom: spacing.lg,
  },
  propList: {
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  propRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start",
  },
  propIndex: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    color: colors.accent,
    letterSpacing: 0.5,
    marginTop: 3,
    width: 20,
  },
  propText: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
  },
  cta: {
    marginTop: spacing.sm,
  },
  skipLink: {
    marginTop: spacing.md,
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  skipLinkText: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 11,
    letterSpacing: 0.5,
    textDecorationLine: "underline",
  },
  nameInput: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.background,
    marginBottom: spacing.xl,
  },
  listWrap: {
    flex: 1,
    marginBottom: spacing.md,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: rules.default,
  },
  listItemSelected: {
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.04)",
  },
  listItemText: {
    fontFamily: fonts.sansMedium,
    color: colors.muted,
    fontSize: 14,
  },
  listItemTextSelected: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
  },
  listCheckmark: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 14,
  },
  serviceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  serviceChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
  },
  serviceChipSelected: {
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.06)",
  },
  serviceCheck: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
  },
  serviceChipText: {
    fontFamily: fonts.sansMedium,
    color: colors.muted,
    fontSize: 13,
  },
  serviceChipTextSelected: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
  },

  // Calibration — mirrors the main Swipe tab visual language so
  // users learn the real interaction here rather than an onboarding-
  // specific fork (spec §5.1 "teach the real product").
  calibrateWrap: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  calibrateHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 4,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  featureEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.accent,
    textTransform: "uppercase",
  },
  featureTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
  },
  featureSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.muted,
  },
  featureProgress: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  calibrateBody: {
    flex: 1,
    alignItems: "center",
    gap: spacing.md,
  },
  calibrateLoading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.sm,
  },
  calibrateLoadingTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
    textAlign: "center",
  },
  calibrateLoadingRule: {
    width: 40,
    height: 1,
    backgroundColor: rules.gold,
  },
  calibrateLoadingBody: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.muted2,
    letterSpacing: 0.5,
  },
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
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "#0a0f18",
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
    touchAction: "none",
  },
  deckPosterFallback: {
    ...StyleSheet.absoluteFillObject,
    padding: spacing.lg,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.backgroundElevated,
  },
  deckPosterFallbackTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
    textAlign: "center",
  },
  deckPosterFallbackMeta: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted2,
    letterSpacing: 1,
  },
  deckEdgeChip: {
    position: "absolute",
    top: 18,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  deckEdgeChipLeft: { left: 12 },
  deckEdgeChipRight: { right: 12 },
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
  detailsBlock: {
    width: "100%",
    gap: 8,
    marginTop: spacing.md,
  },
  detailsTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    lineHeight: 24,
    color: colors.ink,
  },
  detailsMeta: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted2,
    letterSpacing: 0.5,
  },
  detailsGenreRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  detailsGenreChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: rules.default,
  },
  detailsGenreChipText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.ink,
  },
  controlRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.sm,
  },
  controlBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 6,
    flexGrow: 1,
    flexBasis: 0,
  },
  controlBtnNeutral: {
    borderWidth: 1,
    borderColor: rules.default,
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
  },
  controlBtnPrimaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.0,
    color: colors.background,
    textTransform: "uppercase",
  },
  skipCardLink: {
    alignItems: "center",
    marginTop: 4,
    paddingVertical: 6,
  },
  skipCardLinkText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted2,
    letterSpacing: 0.5,
    textDecorationLine: "underline",
  },

  // Scene DNA reveal
  dnaStats: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.sm,
    marginBottom: spacing.xl,
    overflow: "hidden",
  },
  dnaStat: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.lg,
    gap: 4,
  },
  dnaStatDivider: {
    width: 1,
    height: 40,
    backgroundColor: rules.default,
  },
  dnaStatValue: {
    fontFamily: fonts.serifBold,
    fontSize: 32,
    color: colors.accent,
  },
  dnaStatLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted2,
    letterSpacing: 0.5,
  },
});
