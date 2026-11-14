import { swipeDirection } from "@/lib/swipe-gesture";
import * as SessionStorage from "@/lib/session-storage";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  ActivityIndicator,
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

import { safeReturnPath } from "@/lib/return-path";
import { Ionicons } from "@expo/vector-icons";
import { useOnboardingDraft } from "@/lib/onboarding-draft";
import { CountrySelector } from "@/components/country-selector";
import { OnboardingTitleSearch } from "@/components/onboarding-title-search";
import { RatingEditor } from "@/components/rating-editor";
import { GoldButton } from "@/components/gold-button";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { markOnboardingCompleted, onboardingDraftKey } from "@/lib/onboarding";
import { playSwipeSound } from "@/lib/swipe-sfx";

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

const CALIBRATION_TARGET = 5;
type Direction = "left" | "right" | "up" | "down";
const SWIPE_THRESHOLD = 80;

type Step =
  | "welcome"
  | "basics"
  | "services"
  | "calibrate-intro"
  | "calibrate"
  | "dna"
  | "complete";

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
  slideStyle: {
    transform: {
      translateX: Animated.AnimatedInterpolation<string | number>;
    }[];
  };
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
        accessibilityLabel="Your display name"
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
        Pick a handle — this is your public @-name. Letters, numbers, dots and
        underscores.
      </Text>
      <TextInput
        autoCapitalize="none"
        accessibilityLabel="Your public username"
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
        <Text
          style={[
            styles.bodySmall,
            { color: colors.muted2, marginTop: -spacing.lg },
          ]}
        >
          Checking…
        </Text>
      ) : handleStatus.state === "available" ? (
        <Text
          style={[
            styles.bodySmall,
            { color: colors.accent, marginTop: -spacing.lg },
          ]}
        >
          ✓ @{handleStatus.normalized} is available
        </Text>
      ) : handleStatus.state === "unavailable" ? (
        <Text
          style={[
            styles.bodySmall,
            { color: colors.danger ?? "#E74C3C", marginTop: -spacing.lg },
          ]}
        >
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
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const destination = (safeReturnPath(returnTo) ?? "/(tabs)") as Parameters<
    typeof router.replace
  >[0];
  const [step, setStep] = useState<Step>("welcome");
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set(),
  );
  const [handle, setHandle] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [country, setCountry] = useState("US");
  const [ratingTitle, setRatingTitle] = useState<Title | null>(null);
  const [ratedCount, setRatedCount] = useState(0);
  const actionBusy = useRef(false);
  const completionBusy = useRef(false);
  const draft = useOnboardingDraft(
    user?.user_id,
    sessionToken,
    {
      step,
      display_name: displayName,
      username: handle,
      country_code: country,
      streaming_services: [...selectedServices],
    },
    (saved) => {
      if (
        [
          "welcome",
          "basics",
          "services",
          "calibrate-intro",
          "calibrate",
          "dna",
        ].includes(saved.step)
      )
        setStep(saved.step as Step);
      setDisplayName(saved.display_name);
      setHandle(saved.username);
      setCountry(saved.country_code);
      setSelectedServices(new Set(saved.streaming_services));
    },
  );
  // Handle (unique username). Live-checked against
  // GET /me/username-check as the user types (small debounce).
  const [handleStatus, setHandleStatus] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "available"; normalized: string }
    | { state: "unavailable"; reason: string }
  >({ state: "idle" });
  const handleCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCheckGeneration = useRef(0);
  const profileBusy = useRef(false);

  const checkHandleAvailability = useCallback(
    (value: string) => {
      const check = ++handleCheckGeneration.current;
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
          if (check !== handleCheckGeneration.current) return;
          if (resp.available) {
            setHandleStatus({
              state: "available",
              normalized: resp.normalized ?? trimmed,
            });
          } else {
            setHandleStatus({
              state: "unavailable",
              reason: resp.reason ?? "unavailable",
            });
          }
        } catch {
          if (check !== handleCheckGeneration.current) return;
          setHandleStatus({ state: "idle" });
        }
      }, 320);
    },
    [sessionToken],
  );

  useEffect(() => {
    checkHandleAvailability(handle);
    return () => {
      handleCheckGeneration.current++;
      if (handleCheckTimer.current) clearTimeout(handleCheckTimer.current);
    };
  }, [handle, checkHandleAvailability]);

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
    Animated.timing(stepAnim, {
      toValue: 1,
      duration: 240,
      useNativeDriver: false,
    }).start();
  }

  const slideStyle = {
    transform: [
      {
        translateX: stepAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [20, 0],
        }),
      },
    ],
  };

  function advance(next: Step) {
    setError(null);
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
        const progress = await apiRequest<{
          signal_count: number;
          rated_count: number;
          target: number;
          completed: boolean;
        }>("/me/onboarding-progress", { token: sessionToken });
        setRatedCount(progress.rated_count ?? 0);
        if (progress.signal_count > 0) {
          setSwipeCount(progress.signal_count);
        }
      } catch {
        // Best-effort — if the endpoint fails, start from zero (no regression).
      }

      const results = await apiRequest<Title[]>(
        "/titles/calibration-candidates",
        {
          token: sessionToken,
        },
      );
      setCandidates(results);
      trackEvent("taste_calibration_started", {});
    } catch {
      // Fallback to trending if calibration endpoint fails
      try {
        const trending = await apiRequest<Title[]>(
          "/titles/trending?limit=25",
          {
            token: sessionToken,
          },
        );
        setCandidates(trending);
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

  // ─── Gesture wiring — mirrors main Swipe tab EXACTLY ──────────────
  // Refs (not state) for the index/count the release callback reads,
  // so the once-created PanResponder always sees fresh values without
  // needing to be recreated. State updates go through functional
  // setState so React batching doesn't cause race conditions.

  const pan = useRef(new Animated.ValueXY()).current;
  const calibrateIndexRef = useRef(0);
  const swipeCountRef = useRef(0);
  const candidatesRef = useRef<Title[]>([]);
  const sessionTokenRef = useRef<string | null>(null);

  useEffect(() => {
    calibrateIndexRef.current = calibrateIndex;
  }, [calibrateIndex]);
  useEffect(() => {
    swipeCountRef.current = swipeCount;
  }, [swipeCount]);
  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);
  useEffect(() => {
    sessionTokenRef.current = sessionToken ?? null;
  }, [sessionToken]);

  async function recordSwipe(
    direction: Direction,
    titleId: string,
    inputMethod: "gesture" | "button",
    position: number,
  ) {
    const tok = sessionTokenRef.current;
    if (!tok) throw new Error("Sign in again to save your progress.");
    try {
      await apiRequest("/titles/swipes", {
        method: "POST",
        token: tok,
        body: JSON.stringify({
          title_id: titleId,
          direction,
          source_surface: "onboarding_calibration",
          action_version: 3,
          idempotency_key: `onboarding:${titleId}:${direction}:${position}`,
        }),
      });
      trackEvent("onboarding_calibration_action", {
        action: direction,
        title_id: titleId,
        position,
        input_method: inputMethod,
      });
    } catch {
      trackEvent("onboarding_error", {
        step: "calibrate",
        code: "swipe_record_failed",
      });
      throw new Error("Your action was not saved. Please try again.");
    }
  }

  async function animateSwipe(
    direction: Direction,
    inputMethod: "gesture" | "button" = "gesture",
  ) {
    const idx = calibrateIndexRef.current;
    const card = candidatesRef.current[idx];
    if (!card || actionBusy.current || ratingTitle) return;
    actionBusy.current = true;
    setError(null);
    playSwipeSound(direction);
    try {
      await recordSwipe(
        direction,
        card.id,
        inputMethod,
        swipeCountRef.current + 1,
      );
      const toValue =
        direction === "up"
          ? { x: 0, y: -420 }
          : direction === "down"
            ? { x: 0, y: 420 }
            : { x: direction === "right" ? 420 : -420, y: 30 };
      await new Promise<void>((resolve) => {
        const watchdog = setTimeout(resolve, 450);
        Animated.timing(pan, {
          toValue,
          duration: 180,
          useNativeDriver: false,
        }).start(() => { clearTimeout(watchdog); resolve(); });
      });
      calibrateIndexRef.current = idx + 1;
      swipeCountRef.current += 1;
      setCalibrateIndex(idx + 1);
      setSwipeCount(swipeCountRef.current);
      if (direction === "up") setRatingTitle(card);
      else if (idx + 1 >= candidatesRef.current.length) advance("dna");
    } catch {
      setError(
        "Your action was not saved. Try again. If you already rated this title positively, edit its rating before marking it disliked.",
      );
    } finally {
      pan.setValue({ x: 0, y: 0 });
      actionBusy.current = false;
    }
  }

  // Ref that always points at the LATEST animateSwipe closure — same
  // pattern the main Swipe tab uses (animateSwipeRef). Assigned on
  // every render, read from PanResponder's release callback.
  const noopSwipe = useRef<
    (dir: Direction, input?: "gesture" | "button") => Promise<void>
  >(async () => {}).current;
  const animateSwipeRef =
    useRef<(dir: Direction, input?: "gesture" | "button") => Promise<void>>(
      noopSwipe,
    );
  animateSwipeRef.current = animateSwipe;

  function skipCard() {
    const idx = calibrateIndexRef.current;
    const card = candidatesRef.current[idx];
    if (!card || actionBusy.current || ratingTitle) return;
    trackEvent("onboarding_calibration_exited", {
      position: idx + 1,
      reason: "card_skip",
    });
    calibrateIndexRef.current = idx + 1;
    setCalibrateIndex(idx + 1);
    if (idx + 1 >= candidatesRef.current.length) {
      advance("dna");
    }
  }

  // PanResponder created ONCE — same as main Swipe. The release
  // callback dispatches through animateSwipeRef so the always-current
  // animateSwipe closure runs. No useMemo recreation, no state deps.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_, gesture) => !actionBusy.current && Math.max(Math.abs(gesture.dx), Math.abs(gesture.dy)) > 8,
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        !actionBusy.current && Math.max(Math.abs(gesture.dx), Math.abs(gesture.dy)) > 8,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderMove: (_, gesture) => {
        if (!actionBusy.current) pan.setValue({ x: gesture.dx, y: gesture.dy });
      },
      onPanResponderRelease: (_, gesture) => {
        if (actionBusy.current) return;
        const direction = swipeDirection(gesture.dx, gesture.dy, SWIPE_THRESHOLD, SWIPE_THRESHOLD);
        if (direction) { void animateSwipeRef.current(direction, "gesture"); return; }
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          friction: 8,
          tension: 100,
          useNativeDriver: false,
        }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          friction: 8,
          tension: 100,
          useNativeDriver: false,
        }).start();
      },
    }),
  ).current;

  async function saveBasicsAndContinue() {
    if (!sessionToken || profileBusy.current) return;
    const name = displayName.trim();
    if (!name && !handle.trim()) {
      advance("services");
      return;
    }
    profileBusy.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = name ? { display_name: name } : {};
      // The server is authoritative. Do not silently discard a typed or restored
      // handle just because a delayed availability preview has not finished.
      if (handle.trim())
        body.username = handle.trim().toLowerCase().replace(/^@/, "");
      await apiRequest("/me", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify(body),
      });
      if (name) await updateSessionUser({ display_name: name });
      advance("services");
      trackEvent("onboarding_profile_completed", {
        set_handle: !!handle.trim(),
      });
    } catch {
      trackEvent("onboarding_error", {
        step: "basics",
        code: "profile_save_failed",
      });
      setError(
        "Your profile could not be saved. Check that your handle is available and uses 3–40 letters, numbers, dots or underscores, then try again.",
      );
    } finally {
      profileBusy.current = false;
      setIsSaving(false);
    }
  }

  async function saveAndContinue(skipped = false) {
    if (!sessionToken) return;
    if (!/^[A-Z]{2}$/.test(country)) {
      setError("Enter a two-letter country code, such as US or GB.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({
          connected_streaming_services: Array.from(selectedServices),
          preferred_regions: [country],
        }),
      });
      trackEvent(
        skipped
          ? "onboarding_providers_skipped"
          : "onboarding_providers_completed",
        { services_count: selectedServices.size },
      );
      advance("calibrate-intro");
    } catch {
      trackEvent("onboarding_error", {
        step: "services",
        code: "prefs_save_failed",
      });
      setError(
        "Your viewing preferences could not be saved. Please try again.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function completeOnboarding(): Promise<boolean> {
    if (!sessionToken || !user?.user_id || completionBusy.current) return false;
    completionBusy.current = true;
    setIsSaving(true);
    setError(null);
    try {
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ onboarding_completed: true }),
      });
      draft.stop();
      await markOnboardingCompleted(user.user_id);
      void apiRequest("/me/onboarding-draft", {
        method: "DELETE",
        token: sessionToken,
      }).catch(() => {});
      await SessionStorage.deleteItem(onboardingDraftKey(user.user_id)).catch(
        () => {},
      );
      return true;
    } catch {
      setError(
        "Your progress could not be saved. Please try again when you are connected.",
      );
      return false;
    } finally {
      completionBusy.current = false;
      setIsSaving(false);
    }
  }

  async function skip() {
    if (await completeOnboarding()) {
      trackEvent("onboarding_completed", {
        swipes: swipeCount,
        skipped_at: step,
      });
      router.replace(destination);
    }
  }

  // Progress bar — show as small dots between Basics and Calibration.
  // Country is selected within Services; progress remains three short steps.
  const MAIN_STEPS: Step[] = [
    "welcome",
    "basics",
    "services",
    "calibrate-intro",
    "calibrate",
  ];
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
  const { width: calibrateViewport, height: viewportHeight } =
    useWindowDimensions();
  const calibratePadding = calibrateViewport < 480 ? 16 : 20;
  const posterMaxWidth = Math.min(
    360,
    calibrateViewport - calibratePadding * 2,
    Math.max(140, (viewportHeight - 390) / 1.5),
  );
  const posterHeight = posterMaxWidth * 1.5;
  if (!draft.ready)
    return (
      <SafeAreaView
        style={[
          styles.safeArea,
          { justifyContent: "center", alignItems: "center", gap: 16 },
        ]}
      >
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.ink, fontSize: 16 }}>
          Restoring your progress…
        </Text>
      </SafeAreaView>
    );

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header bar */}
      <View style={styles.headerBar}>
        {stepIndex > 0 && stepIndex < 4 ? <Pressable accessibilityRole="button" accessibilityLabel="Back to previous onboarding step" disabled={isSaving} onPress={() => { setError(null); setStep(MAIN_STEPS[stepIndex - 1]); }} style={{ minWidth: 44, minHeight: 44, justifyContent: "center" }}><Ionicons name="arrow-back" size={22} color={colors.ink} /></Pressable> : null}
        {showDots ? (
          <View style={styles.dots}>
            {MAIN_STEPS.slice(1).map((s) => (
              <View
                key={s}
                style={[styles.dot, step === s && styles.dotActive]}
              />
            ))}
          </View>
        ) : (
          <View />
        )}
        {step !== "complete" && step !== "dna" ? (
          <Pressable
            disabled={isSaving}
            onPress={() => void skip()}
            style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
          >
            <Text style={styles.skipText}>Skip</Text>
          </Pressable>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{
            flexGrow: 1,
            width: "100%",
            maxWidth: 760,
            alignSelf: "center",
          }}
        >
          {error ? (
            <Text
              accessibilityRole="alert"
              style={{ color: colors.accent, padding: 16 }}
            >
              {error}
            </Text>
          ) : null}

          {/* WELCOME — spec §8.1 canonical hero copy. */}
          {draft.error ? (
            <View style={{ padding: 16, gap: 8 }}>
              <Text style={{ color: colors.accent, fontSize: 15 }}>
                {draft.error}
              </Text>
              {draft.conflict ? (
                <View style={{ gap: 8 }}>
                  <Pressable
                    style={{ minHeight: 44, justifyContent: "center" }}
                    onPress={draft.useThisDevice}
                  >
                    <Text style={{ color: colors.ink }}>
                      Keep this device's draft
                    </Text>
                  </Pressable>
                  <Pressable
                    style={{ minHeight: 44, justifyContent: "center" }}
                    onPress={draft.useOtherDevice}
                  >
                    <Text style={{ color: colors.ink }}>
                      Use the other device's progress
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  style={{ minHeight: 44, justifyContent: "center" }}
                  onPress={draft.retry}
                >
                  <Text style={{ color: colors.ink }}>Retry sync</Text>
                </Pressable>
              )}
            </View>
          ) : null}
          {step === "welcome" ? (
            <Animated.View style={[styles.stepWrap, slideStyle]}>
              <View style={styles.headerBlock}>
                <Text style={styles.eyebrow}>SEENSNAP</Text>
                <View style={styles.goldRule} />
                <Text style={styles.serif}>Find what{"\n"}to watch next.</Text>
              </View>
              <Text style={styles.body}>
                Build your SceneDNA from what you love, save picks, and discover
                titles worth your time.
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
                Select the services you subscribe to. This does not connect or
                log in to your streaming accounts.
              </Text>
              <CountrySelector
                value={country}
                onChange={setCountry}
                disabled={isSaving}
              />
              <View style={styles.serviceGrid}>
                {STREAMING_SERVICES.map((s) => {
                  const selected = selectedServices.has(s.id);
                  return (
                    <Pressable
                      key={s.id}
                      style={[
                        styles.serviceChip,
                        selected && styles.serviceChipSelected,
                      ]}
                      onPress={() => toggleService(s.id)}
                    >
                      {selected ? (
                        <Text style={styles.serviceCheck}>✓ </Text>
                      ) : null}
                      <Text
                        style={[
                          styles.serviceChipText,
                          selected && styles.serviceChipTextSelected,
                        ]}
                      >
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
              <Pressable
                style={styles.skipLink}
                onPress={() => void saveAndContinue(true)}
              >
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
                Rate five titles you have watched to help SeenSnap learn your
                taste. You can leave anytime.
              </Text>
              <View style={styles.propList}>
                <View style={styles.propRow}>
                  <Text style={styles.propIndex}>←</Text>
                  <Text style={styles.propText}>Swipe left: Pass</Text>
                </View>
                <View style={styles.propRow}>
                  <Text style={styles.propIndex}>→</Text>
                  <Text style={styles.propText}>Swipe right: Save to My Next Watch</Text>
                </View>
                <View style={styles.propRow}>
                  <Text style={styles.propIndex}>↑</Text>
                  <Text style={styles.propText}>
                    Swipe up: Watched — add an optional rating
                  </Text>
                </View>
                <View style={styles.propRow}>
                  <Text style={styles.propIndex}>↓</Text>
                  <Text style={styles.propText}>
                    Swipe down: Watched and didn’t like it
                  </Text>
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
                  <Text style={styles.featureSubtitle}>
                    Swipe to shape your SceneDNA.
                  </Text>
                </View>
                <Text style={styles.featureProgress}>
                  {Math.min(ratedCount, CALIBRATION_TARGET)}/
                  {CALIBRATION_TARGET} rated
                </Text>
              </View>

              <OnboardingTitleSearch
                onRate={(t) =>
                  setRatingTitle({
                    ...t,
                    media_type: t.content_type,
                    release_year: null,
                    genres: [],
                  })
                }
              />
              {loadingCandidates || !currentCard ? (
                <View style={styles.calibrateLoading}>
                  <Text style={styles.calibrateLoadingTitle}>
                    {loadingCandidates ? "Finding titles" : "No titles loaded"}
                  </Text>
                  <View style={styles.calibrateLoadingRule} />
                  <Text style={styles.calibrateLoadingBody}>
                    {loadingCandidates
                      ? "Just a moment…"
                      : "Search for a title you know, or retry the suggestions."}
                  </Text>
                  {!loadingCandidates ? (
                    <Pressable
                      style={{ minHeight: 44 }}
                      onPress={() => void fetchCandidates()}
                    >
                      <Text style={{ color: colors.accent }}>
                        Retry suggestions
                      </Text>
                    </Pressable>
                  ) : null}
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
                            transform: [
                              { translateX: 8 },
                              { translateY: 8 },
                              { scale: 0.97 },
                            ],
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
                        // Wrap in a View with pointerEvents="none" so
                        // touches pass through to the parent Animated.View
                        // — on RN-Web the <img> element otherwise absorbs
                        // touches and PanResponder misses gesture starts.
                        <View
                          style={StyleSheet.absoluteFillObject}
                          pointerEvents="none"
                        >
                          <Image
                            source={{ uri: currentCard.poster_url }}
                            style={StyleSheet.absoluteFillObject}
                            resizeMode="contain"
                            accessibilityLabel={`${currentCard.title} poster`}
                          />
                        </View>
                      ) : (
                        <View style={styles.deckPosterFallback}>
                          <Text
                            style={styles.deckPosterFallbackTitle}
                            numberOfLines={4}
                          >
                            {currentCard.title}
                          </Text>
                          <Text style={styles.deckPosterFallbackMeta}>
                            {currentCard.media_type === "movie"
                              ? "FILM"
                              : "SERIES"}
                          </Text>
                        </View>
                      )}

                      <Animated.View
                        style={[
                          styles.deckEdgeChip,
                          styles.deckEdgeChipLeft,
                          { opacity: leftLabelOpacity },
                        ]}
                      >
                        <Text style={styles.deckEdgeChipTextLeft}>PASS</Text>
                      </Animated.View>
                      <Animated.View
                        style={[
                          styles.deckEdgeChip,
                          styles.deckEdgeChipRight,
                          { opacity: rightLabelOpacity },
                        ]}
                      >
                        <Text style={styles.deckEdgeChipTextRight}>
                          NEXT WATCH
                        </Text>
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
                        onPress={() => void animateSwipe("left", "button")}
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
                        onPress={() => void animateSwipe("right", "button")}
                        accessibilityRole="button"
                        accessibilityLabel={`Save ${currentCard.title} to My Next Watch`}
                      >
                        <Ionicons
                          name="heart"
                          size={16}
                          color={colors.background}
                        />
                        <Text style={styles.controlBtnPrimaryText}>
                          Next Watch
                        </Text>
                      </Pressable>
                    </View>
                    <View style={styles.controlRow}>
                      <Pressable
                        style={[styles.controlBtn, styles.controlBtnNeutral]}
                        onPress={() => void animateSwipe("down", "button")}
                        accessibilityRole="button"
                      >
                        <Text style={styles.controlBtnNeutralText}>
                          ↓ Watched · Disliked
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.controlBtn, styles.controlBtnPrimary]}
                        onPress={() => void animateSwipe("up", "button")}
                        accessibilityRole="button"
                      >
                        <Text style={styles.controlBtnPrimaryText}>
                          ↑ Watched · Rate
                        </Text>
                      </Pressable>
                    </View>
                    <Pressable
                      style={styles.skipCardLink}
                      onPress={skipCard}
                      hitSlop={8}
                    >
                      <Text style={styles.skipCardLinkText}>
                        Don’t know this title
                      </Text>
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
                <Text style={styles.serif}>
                  Your SceneDNA{"\n"}is taking shape.
                </Text>
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
                  trackEvent("onboarding_scenedna_reveal_viewed", {
                    swipes: swipeCount,
                  });
                  if (!(await completeOnboarding())) return;
                  trackEvent("onboarding_completed", {
                    services_count: selectedServices.size,
                    swipes: swipeCount,
                  });
                  router.replace(destination);
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
              <Text
                style={[
                  styles.serif,
                  { marginTop: spacing.md, textAlign: "center" },
                ]}
              >
                Start discovering.
              </Text>
              <Text
                style={[
                  styles.bodySmall,
                  { textAlign: "center", marginTop: spacing.md },
                ]}
              >
                Your Scene DNA is live. The more you interact, the sharper it
                gets.
              </Text>
              <GoldButton
                label="Start swiping"
                icon="layers"
                size="lg"
                onPress={() => router.replace("/(tabs)/swipe")}
                style={[styles.cta, { marginTop: spacing.xl }]}
              />
              <Pressable
                style={styles.skipLink}
                onPress={() => router.replace(destination)}
              >
                <Text style={styles.skipLinkText}>Browse Discover first</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <RatingEditor
        visible={!!ratingTitle}
        token={sessionToken}
        titleId={ratingTitle?.id ?? null}
        titleName={ratingTitle?.title}
        initial={null}
        onClose={() => setRatingTitle(null)}
        onChanged={() => {
          if (sessionToken)
            void apiRequest<{ rated_count: number }>(
              "/me/onboarding-progress",
              { token: sessionToken },
            )
              .then((progress) => {
                setRatedCount(progress.rated_count);
                if (progress.rated_count >= CALIBRATION_TARGET) advance("dna");
              })
              .catch(() =>
                setError(
                  "Your rating is saved. Reconnect to refresh your progress.",
                ),
              );
        }}
      />
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
    backgroundColor: "rgba(255,230,0,0.04)",
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
    backgroundColor: "rgba(255,230,0,0.06)",
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
