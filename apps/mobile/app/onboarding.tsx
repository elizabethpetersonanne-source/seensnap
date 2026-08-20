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
  View,
} from "react-native";

import { GoldButton } from "@/components/gold-button";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { ONBOARDING_COMPLETED_KEY } from "@/lib/onboarding";

const COUNTRIES = [
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "CA", label: "Canada" },
  { code: "AU", label: "Australia" },
  { code: "SE", label: "Sweden" },
  { code: "NO", label: "Norway" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "NL", label: "Netherlands" },
  { code: "BR", label: "Brazil" },
  { code: "IN", label: "India" },
  { code: "JP", label: "Japan" },
];

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

type Step = "welcome" | "basics" | "region" | "services" | "calibrate" | "dna" | "first-list" | "complete";

const LIST_PROMPTS = ["Weekend Watch", "Hidden Gems", "Classics to Catch Up On"];

type Title = {
  id: string;
  title: string;
  poster_url: string | null;
  media_type: string;
  release_year: number | null;
  genres: string[];
};

export default function OnboardingScreen() {
  const { sessionToken, user, updateSessionUser } = useAuth();
  const [step, setStep] = useState<Step>("welcome");
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [selectedCountry, setSelectedCountry] = useState("US");
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [listName, setListName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Calibration state
  const [candidates, setCandidates] = useState<Title[]>([]);
  const [calibrateIndex, setCalibrateIndex] = useState(0);
  const [swipeCount, setSwipeCount] = useState(0);
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  // Step animation
  const stepAnim = useRef(new Animated.Value(1)).current;

  function animateIn() {
    stepAnim.setValue(0);
    Animated.timing(stepAnim, { toValue: 1, duration: 240, useNativeDriver: true }).start();
  }

  const slideStyle = {
    opacity: stepAnim,
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

  const recordSwipe = useCallback(
    async (direction: "left" | "right", titleId: string) => {
      if (!sessionToken) return;
      try {
        await apiRequest("/titles/swipes", {
          method: "POST",
          token: sessionToken,
          body: JSON.stringify({
            title_id: titleId,
            direction,
            source_surface: "onboarding_calibration",
          }),
        });
        trackEvent("onboarding_swipe_action", { direction, swipe_number: swipeCount + 1 });
      } catch {
        // Non-blocking — swipe is best-effort during calibration
      }
    },
    [sessionToken, swipeCount]
  );

  const swipeCard = useCallback(
    (direction: "left" | "right") => {
      const card = candidates[calibrateIndex];
      if (!card) return;

      const toX = direction === "right" ? 400 : -400;
      Animated.timing(pan, {
        toValue: { x: toX, y: 0 },
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        pan.setValue({ x: 0, y: 0 });
        void recordSwipe(direction, card.id);
        const next = calibrateIndex + 1;
        const nextCount = swipeCount + 1;
        setCalibrateIndex(next);
        setSwipeCount(nextCount);
        if (nextCount >= CALIBRATION_TARGET) {
          trackEvent("taste_calibration_completed", { signals: nextCount });
          advance("dna");
        }
      });
    },
    [calibrateIndex, candidates, pan, recordSwipe, swipeCount]
  );

  // Per spec ONB-01: skip / "don't know" is neutral. Advance past the card without
  // recording a swipe and without incrementing swipeCount toward the 20-signal target.
  const skipCard = useCallback(() => {
    const card = candidates[calibrateIndex];
    if (!card) return;
    trackEvent("onboarding_swipe_skip", { position: calibrateIndex + 1 });
    setCalibrateIndex((i) => i + 1);
    // If we're about to run out of cards, gracefully advance to the DNA reveal
    // even without hitting 20 — the reveal already handles low-signal state.
    if (calibrateIndex + 1 >= candidates.length) {
      advance("dna");
    }
  }, [calibrateIndex, candidates]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > SWIPE_THRESHOLD) {
          swipeCard("right");
        } else if (gesture.dx < -SWIPE_THRESHOLD) {
          swipeCard("left");
        } else {
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  async function saveBasicsAndContinue() {
    if (!sessionToken) {
      advance("region");
      return;
    }
    const name = displayName.trim();
    if (!name) {
      advance("region");
      return;
    }
    setIsSaving(true);
    try {
      await apiRequest("/me", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ display_name: name }),
      });
      await updateSessionUser({ display_name: name });
    } catch {
      // Don't block onboarding on name-save failure — the user can edit later
    } finally {
      setIsSaving(false);
      advance("region");
    }
  }

  async function saveAndContinue() {
    if (!sessionToken) return;
    setIsSaving(true);
    try {
      await apiRequest("/me", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ country_code: selectedCountry }),
      });
      await apiRequest("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({
          connected_streaming_services: Array.from(selectedServices),
        }),
      });
      trackEvent("onboarding_started", { country: selectedCountry });
      advance("calibrate");
    } catch {
      advance("calibrate");
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
      trackEvent("onboarding_completed", {
        country: selectedCountry,
        services_count: selectedServices.size,
        swipes: swipeCount,
      });
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
      trackEvent("onboarding_skipped", { step, swipes: swipeCount });
    } catch {
      await SessionStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
    }
    router.replace("/(tabs)");
  }

  // Progress bar — show during calibration
  const MAIN_STEPS: Step[] = ["welcome", "basics", "region", "services", "calibrate"];
  const stepIndex = MAIN_STEPS.indexOf(step);
  const showDots = stepIndex !== -1 && step !== "welcome";

  const currentCard = candidates[calibrateIndex] ?? null;
  const cardRotate = pan.x.interpolate({
    inputRange: [-200, 0, 200],
    outputRange: ["-8deg", "0deg", "8deg"],
    extrapolate: "clamp",
  });

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

      {/* WELCOME */}
      {step === "welcome" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>SEENSNAP</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>Taste is{"\n"}personal.</Text>
          </View>
          <Text style={styles.body}>
            Swipe through titles to teach SeenSnap your taste. Two minutes of calibration unlocks
            your Scene DNA — a living taste profile that makes every recommendation sharper.
          </Text>
          <View style={styles.propList}>
            <View style={styles.propRow}>
              <Text style={styles.propIndex}>01</Text>
              <Text style={styles.propText}>Pick your region and streaming subscriptions.</Text>
            </View>
            <View style={styles.propRow}>
              <Text style={styles.propIndex}>02</Text>
              <Text style={styles.propText}>Swipe 20 titles to calibrate your taste.</Text>
            </View>
            <View style={styles.propRow}>
              <Text style={styles.propIndex}>03</Text>
              <Text style={styles.propText}>Unlock your Scene DNA and start discovering.</Text>
            </View>
          </View>
          <GoldButton
            label="Get started"
            icon="arrow-forward"
            size="lg"
            onPress={() => {
              trackEvent("onboarding_started", {});
              advance("basics");
            }}
            style={styles.cta}
          />
        </Animated.View>
      ) : null}

      {/* BASICS — display name */}
      {step === "basics" ? (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Animated.View style={[styles.stepWrap, slideStyle]}>
            <View style={styles.headerBlock}>
              <Text style={styles.eyebrow}>STEP 1 / 4</Text>
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
              returnKeyType="done"
              onSubmitEditing={() => void saveBasicsAndContinue()}
            />
            <GoldButton
              label={isSaving ? "Saving..." : "Continue"}
              icon="arrow-forward"
              size="lg"
              onPress={() => void saveBasicsAndContinue()}
              style={styles.cta}
            />
          </Animated.View>
        </KeyboardAvoidingView>
      ) : null}

      {/* REGION */}
      {step === "region" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>STEP 2 / 4</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>Where are{"\n"}you watching?</Text>
          </View>
          <Text style={styles.bodySmall}>We'll surface providers available in your region.</Text>
          <ScrollView style={styles.listWrap} showsVerticalScrollIndicator={false}>
            {COUNTRIES.map((c) => (
              <Pressable
                key={c.code}
                style={[styles.listItem, selectedCountry === c.code && styles.listItemSelected]}
                onPress={() => setSelectedCountry(c.code)}
              >
                <Text style={[styles.listItemText, selectedCountry === c.code && styles.listItemTextSelected]}>
                  {c.label}
                </Text>
                {selectedCountry === c.code ? (
                  <Text style={styles.listCheckmark}>✓</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
          <GoldButton
            label="Continue"
            icon="arrow-forward"
            size="lg"
            onPress={() => advance("services")}
            style={styles.cta}
          />
        </Animated.View>
      ) : null}

      {/* STREAMING SERVICES */}
      {step === "services" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>STEP 3 / 4</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>What are{"\n"}you subscribed to?</Text>
          </View>
          <Text style={styles.bodySmall}>
            Pick as many as you want. We'll show the right streaming options first.
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
            label={isSaving ? "Saving..." : "Start calibrating"}
            icon="arrow-forward"
            size="lg"
            onPress={() => void saveAndContinue()}
            style={styles.cta}
          />
          <Pressable style={styles.skipLink} onPress={() => void saveAndContinue()}>
            <Text style={styles.skipLinkText}>Skip — I'll set this up later</Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* CALIBRATION SWIPE */}
      {step === "calibrate" ? (
        <View style={styles.calibrateWrap}>
          {/* Counter */}
          <View style={styles.calibrateHeader}>
            <Text style={styles.calibrateCount}>
              {String(Math.min(swipeCount, CALIBRATION_TARGET)).padStart(2, "0")} / {CALIBRATION_TARGET}
            </Text>
            <Text style={styles.calibrateLabel}>TASTE CALIBRATION</Text>
          </View>
          <View style={styles.calibrateRule} />

          {loadingCandidates || !currentCard ? (
            <View style={styles.calibrateLoading}>
              <Text style={styles.calibrateLoadingTitle}>Building your candidate pool</Text>
              <View style={styles.calibrateLoadingRule} />
              <Text style={styles.calibrateLoadingBody}>Fetching titles from TMDB…</Text>
            </View>
          ) : (
            <>
              {/* Next card ghost */}
              {candidates[calibrateIndex + 1] ? (
                <View style={styles.cardGhost}>
                  {candidates[calibrateIndex + 1].poster_url ? (
                    <Image
                      source={{ uri: candidates[calibrateIndex + 1].poster_url! }}
                      style={StyleSheet.absoluteFill}
                      resizeMode="cover"
                    />
                  ) : null}
                </View>
              ) : null}

              {/* Active swipe card */}
              <Animated.View
                style={[
                  styles.card,
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
                    style={StyleSheet.absoluteFill}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.cardFallback} />
                )}

                {/* Corner frame marks */}
                <View style={[styles.frameMark, styles.frameMarkTL]} />
                <View style={[styles.frameMark, styles.frameMarkTR]} />
                <View style={[styles.frameMark, styles.frameMarkBL]} />
                <View style={[styles.frameMark, styles.frameMarkBR]} />

                {/* Direction overlays */}
                <Animated.View
                  style={[
                    styles.directionLabel,
                    styles.directionLabelLeft,
                    {
                      opacity: pan.x.interpolate({
                        inputRange: [-SWIPE_THRESHOLD, 0],
                        outputRange: [1, 0],
                        extrapolate: "clamp",
                      }),
                    },
                  ]}
                >
                  <Text style={styles.directionTextLeft}>← NOT FOR ME</Text>
                </Animated.View>
                <Animated.View
                  style={[
                    styles.directionLabel,
                    styles.directionLabelRight,
                    {
                      opacity: pan.x.interpolate({
                        inputRange: [0, SWIPE_THRESHOLD],
                        outputRange: [0, 1],
                        extrapolate: "clamp",
                      }),
                    },
                  ]}
                >
                  <Text style={styles.directionTextRight}>MORE LIKE THIS →</Text>
                </Animated.View>

                {/* Card info panel */}
                <View style={styles.cardPanel}>
                  <Text style={styles.cardTitle} numberOfLines={2}>{currentCard.title}</Text>
                  <Text style={styles.cardMeta}>
                    {[
                      currentCard.media_type === "movie" ? "FILM" : "SERIES",
                      currentCard.release_year,
                      currentCard.genres[0]?.toUpperCase(),
                    ]
                      .filter(Boolean)
                      .join("  ·  ")}
                  </Text>
                </View>
              </Animated.View>

              {/* Action bar */}
              <View style={styles.actionBar}>
                <Pressable style={styles.actionBtn} onPress={() => swipeCard("left")}>
                  <Text style={styles.actionBtnTextPass}>← PASS</Text>
                </Pressable>
                <Pressable style={styles.actionBtn} onPress={skipCard} hitSlop={6}>
                  <Text style={styles.actionBtnTextSkip}>SKIP</Text>
                </Pressable>
                <Pressable style={styles.actionBtn} onPress={() => swipeCard("right")}>
                  <Text style={styles.actionBtnTextLike}>MORE LIKE THIS →</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      ) : null}

      {/* SCENE DNA REVEAL */}
      {step === "dna" ? (
        <Animated.View style={[styles.stepWrap, slideStyle]}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>YOUR SCENE DNA</Text>
            <View style={styles.goldRule} />
            <Text style={styles.serif}>Taste profile{"\n"}unlocked.</Text>
          </View>
          <Text style={styles.body}>
            Based on {swipeCount} calibration signals, SeenSnap has built your initial taste
            profile. It gets sharper every time you swipe, save, or rate.
          </Text>
          <View style={styles.dnaStats}>
            <View style={styles.dnaStat}>
              <Text style={styles.dnaStatValue}>{swipeCount}</Text>
              <Text style={styles.dnaStatLabel}>Signals collected</Text>
            </View>
            <View style={styles.dnaStatDivider} />
            <View style={styles.dnaStat}>
              <Text style={styles.dnaStatValue}>∞</Text>
              <Text style={styles.dnaStatLabel}>Recs to unlock</Text>
            </View>
          </View>
          <GoldButton
            label="Continue"
            icon="arrow-forward"
            size="lg"
            onPress={() => {
              trackEvent("scene_dna_first_view", { swipes: swipeCount });
              advance("first-list");
            }}
            style={styles.cta}
          />
        </Animated.View>
      ) : null}

      {/* FIRST LIST — spec §07: optional custom list creation from onboarding */}
      {step === "first-list" ? (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Animated.View style={[styles.stepWrap, slideStyle]}>
            <View style={styles.headerBlock}>
              <Text style={styles.eyebrow}>OPTIONAL</Text>
              <View style={styles.goldRule} />
              <Text style={styles.serif}>Start your{"\n"}first list.</Text>
            </View>
            <Text style={styles.bodySmall}>
              Make discovery yours. Name a list, or use a prompt — you can always change it later.
              My Picks already exists as your default archive.
            </Text>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              placeholder="e.g. Weekend Watch"
              placeholderTextColor={colors.muted2}
              value={listName}
              onChangeText={setListName}
              style={styles.nameInput}
              maxLength={60}
              returnKeyType="done"
            />
            <View style={styles.serviceGrid}>
              {LIST_PROMPTS.map((prompt) => {
                const selected = listName === prompt;
                return (
                  <Pressable
                    key={prompt}
                    style={[styles.serviceChip, selected && styles.serviceChipSelected]}
                    onPress={() => setListName(prompt)}
                  >
                    {selected ? <Text style={styles.serviceCheck}>✓ </Text> : null}
                    <Text style={[styles.serviceChipText, selected && styles.serviceChipTextSelected]}>
                      {prompt}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <GoldButton
              label={isSaving ? "Saving..." : listName.trim() ? "Create list" : "Enter SeenSnap"}
              icon="arrow-forward"
              size="lg"
              onPress={async () => {
                setIsSaving(true);
                if (listName.trim() && sessionToken) {
                  try {
                    await apiRequest("/me/watchlist/lists", {
                      method: "POST",
                      token: sessionToken,
                      body: JSON.stringify({ name: listName.trim() }),
                    });
                    trackEvent("first_custom_list_created", { source: "onboarding" });
                  } catch {
                    // Non-blocking — user can create later.
                  }
                }
                await completeOnboarding();
                advance("complete");
              }}
              style={styles.cta}
            />
            <Pressable
              style={styles.skipLink}
              onPress={async () => {
                setIsSaving(true);
                await completeOnboarding();
                advance("complete");
              }}
            >
              <Text style={styles.skipLinkText}>Skip — I'll set this up later</Text>
            </Pressable>
          </Animated.View>
        </KeyboardAvoidingView>
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

  // Calibration
  calibrateWrap: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  calibrateHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 4,
    marginBottom: spacing.xs,
  },
  calibrateCount: {
    fontFamily: fonts.serifBold,
    fontSize: 28,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  calibrateLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    color: colors.accent,
    letterSpacing: 1.5,
  },
  calibrateRule: {
    height: 1,
    backgroundColor: rules.default,
    marginBottom: spacing.md,
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
  cardGhost: {
    position: "absolute",
    top: 100,
    left: spacing.lg + 8,
    right: spacing.lg + 8,
    bottom: 80,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
    overflow: "hidden",
    opacity: 0.35,
    transform: [{ scaleX: 0.94 }, { translateY: 10 }],
  },
  card: {
    position: "absolute",
    top: 90,
    left: 4,
    right: 4,
    bottom: 72,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
    overflow: "hidden",
  },
  cardFallback: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.backgroundElevated,
  },
  frameMark: {
    position: "absolute",
    backgroundColor: "rgba(244,196,48,0.50)",
  },
  frameMarkTL: { top: 14, left: 14, width: 14, height: 1 },
  frameMarkTR: { top: 14, right: 14, width: 14, height: 1 },
  frameMarkBL: { bottom: 96, left: 14, width: 14, height: 1 },
  frameMarkBR: { bottom: 96, right: 14, width: 14, height: 1 },
  directionLabel: {
    position: "absolute",
    top: 24,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  directionLabelLeft: { left: spacing.md },
  directionLabelRight: { right: spacing.md },
  directionTextLeft: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.1,
    color: colors.muted,
  },
  directionTextRight: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.1,
    color: colors.accent,
  },
  cardPanel: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(7,11,18,0.88)",
    borderTopWidth: 1,
    borderTopColor: rules.default,
    padding: spacing.md,
    gap: 4,
  },
  cardTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    lineHeight: 24,
    color: colors.ink,
  },
  cardMeta: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted2,
    letterSpacing: 0.5,
  },
  actionBar: {
    position: "absolute",
    bottom: 0,
    left: 4,
    right: 4,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: 12,
    paddingTop: 8,
  },
  actionBtn: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  actionBtnTextPass: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.muted2,
  },
  actionBtnTextSkip: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.muted2,
  },
  actionBtnTextLike: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.accent,
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
