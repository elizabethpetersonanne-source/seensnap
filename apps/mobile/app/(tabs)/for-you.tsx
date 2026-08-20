import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
// safe-area-context version — the RN built-in SafeAreaView ignores `edges` and adds
// an extra top inset that pushed the logo lower here than on other tabs.
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { GoldButton } from "@/components/gold-button";
import { SSAnimatedRule } from "@/components/ss-animated-rule";
import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { PosterStack } from "@/components/poster-stack";
import { TasteSignal } from "@/components/taste-signal";
import { useCyclingBackdrop, useFallbackBackdrop } from "@/lib/backdrop-pool";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { pressIn, pressOut } from "@/lib/motion";
import { trackEvent } from "@/lib/analytics";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

// ─── Types ────────────────────────────────────────────────────────────────────

type MeProfile = {
  user_id: string;
  email: string;
  username: string;
  display_name: string;
  favorite_genres: string[];
  country_code: string;
  avatar_url?: string | null;
  bio?: string | null;
};

type TasteGenreScore = { genre: string; score: number };
type TasteLabel = { label: string; confidence: number };
type TasteTitle = { title_id?: string | null; title_name: string; poster_url?: string | null };

type TasteProfile = {
  user_id: string;
  top_genres: TasteGenreScore[];
  top_themes: string[];
  top_platforms: string[];
  favorite_eras: string[];
  taste_labels: TasteLabel[];
  profile_summary?: string | null;
  current_obsessions: TasteTitle[];
  top_posters: string[];
  most_saved_genre?: string | null;
  updated_at?: string | null;
};

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
  };
  reason: string;
  seed_title_id?: string | null;
  // Backend Swipe Intelligence signal ref — powers Because You... rail headers
  // (SceneDNA UX Overhaul brief §5). Enum from taste.py REASON_TYPE_* constants.
  reason_type?: string;
  evidence?: {
    contributing_titles?: string[];
    contributing_traits?: string[];
    confidence?: number;
  };
};

type TeamSummary = {
  id: string;
  name: string;
  description?: string | null;
  member_count: number;
};

type TeamAnalytics = {
  team_id: string;
  average_compatibility: number;
  most_aligned_members: {
    compatibility: number;
    summary?: string | null;
    members: Array<{ user_id: string; display_name?: string | null; avatar_url?: string | null; score?: number | null; detail?: string | null }>;
  };
  most_divisive_member?: { user_id: string; display_name?: string | null; avatar_url?: string | null; score?: number | null; detail?: string | null } | null;
  taste_mvp?: { user_id: string; display_name?: string | null; avatar_url?: string | null; score?: number | null; detail?: string | null } | null;
  most_loved_title?: TasteTitle | null;
  most_divisive_title?: TasteTitle | null;
  genre_breakdown: Array<{ genre: string; percent: number }>;
};

// SceneDNA unified schema from /me/scene-dna (backend build_scene_dna_response).
// Mirrors app/schemas/taste.py SceneDnaResponse. Compact hero + evidence-first
// signal cards read directly from this object — no ad-hoc client stitching.
type SceneDnaIdentity = {
  archetype: string;
  one_line: string;
  confidence_tier: "strong" | "emerging" | "early";
  updated_at?: string | null;
  based_on_summary: string;
  hero_backdrops: string[];
};
type SceneDnaSignal = {
  label: string;
  confidence_tier: "strong" | "emerging" | "early";
  evidence_count: number;
  contributing_titles: { title_id?: string | null; title_name: string; poster_url?: string | null }[];
};
type SceneDnaMovement = {
  direction: "rising" | "entering_top5" | "fading";
  label: string;
  sample_size: number;
  detail: string;
};
type SceneDnaColdStart = {
  saves_current: number;
  saves_target: number;
  ratings_current: number;
  ratings_target: number;
  swipes_current: number;
  swipes_target: number;
  next_action_hint: string;
};
type SceneDna = {
  identity: SceneDnaIdentity | null;
  signals: SceneDnaSignal[];
  movement: SceneDnaMovement[];
  has_signal: boolean;
  cold_start: SceneDnaColdStart | null;
};

type PersonalityArchetype = { name: string; description: string; icon: string };
type Achievement = { id: string; name: string; description: string; icon: string; color: string; unlocked: boolean };
type EraEntry = { era: string; period: string; isCurrent: boolean };

type HotTake = { statement: string; type: string; strength: number };
type GenreShift = { genre: string; delta: number; direction: "rising" | "falling"; current_share: number; previous_share: number };
type TasteEvolution = { period_label: string; comparison_label: string; shifts: GenreShift[]; summary: string; has_data: boolean };
type TasteAlignmentEntry = { user_id: string; display_name: string; avatar_url?: string | null; alignment_score: number; top_shared_genres: string[]; shared_label?: string | null };
type TasteAlignment = { entries: TasteAlignmentEntry[]; has_data: boolean };

// ─── Constants ────────────────────────────────────────────────────────────────

// Scene Picks mood taxonomy. Each entry maps to a backend RecommendationService
// mode key (SceneDNA brief §12) so the query is REAL — filter by semantic
// attributes + personal re-rank — not a client-side keyword grep. Modes that
// don't yet exist on the backend fall back to "perfect" (personalized rank
// across the whole pool).
const MOODS = [
  { id: "all", label: "All Picks", mode: "perfect" as const },
  { id: "dark", label: "Dark & Cinematic", mode: "dark-cinematic" as const },
  { id: "comfort", label: "Something Comforting", mode: "comfort" as const },
  { id: "hidden", label: "Hidden Gem For You", mode: "hidden-gems" as const },
  { id: "movie-night", label: "Movie Night", mode: "movie-night" as const },
  { id: "late-night", label: "Late Night", mode: "late-night" as const },
  { id: "afternoon", label: "Afternoon Pick", mode: "afternoon" as const },
] as const;

type MoodId = (typeof MOODS)[number]["id"];

const HERO_FALLBACK = ["This is your scene.", "Your taste is getting sharper, moodier, and more specific."];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ForYouScreen() {
  const router = useRouter();
  const { sessionToken } = useAuth();
  const [profile, setProfile] = useState<MeProfile | null>(null);
  const [taste, setTaste] = useState<TasteProfile | null>(null);
  // Unified SceneDNA snapshot — powers the compact identity hero + signal
  // cards + Taste Shift module. Assembled server-side (brief §3 IA).
  const [sceneDna, setSceneDna] = useState<SceneDna | null>(null);
  // Deep Dive collapsible per brief §3 layer 5 — detailed analytics are one
  // tap deeper, not expanded by default.
  const [showDeepDive, setShowDeepDive] = useState(false);
  // Signal evidence drawer state (brief §7 + §11 correction UI).
  const [signalDrawer, setSignalDrawer] = useState<SceneDnaSignal | null>(null);
  // Detail payload fetched from /me/scene-dna/signals/{name} when the drawer
  // opens — real per-signal evidence + trend + explore rail per §18.
  const [signalDetail, setSignalDetail] = useState<{
    score: number;
    confidence_tier: string;
    sample_size: number;
    trend: string;
    positive_evidence: { title_id?: string; title_name: string; poster_url?: string | null }[];
    negative_evidence: { title_id?: string; title_name: string; poster_url?: string | null }[];
    explore: { impression_id: string; title_id: string; title_name: string; poster_url?: string | null; score: number; confidence: string }[];
  } | null>(null);
  const [signalDetailLoading, setSignalDetailLoading] = useState(false);
  const [recommendations, setRecommendations] = useState<RecommendationItem[]>([]);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [teamAnalytics, setTeamAnalytics] = useState<TeamAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [savedTitleIds, setSavedTitleIds] = useState<Set<string>>(new Set());
  const [selectedMood, setSelectedMood] = useState<MoodId>("all");
  // Mood recs come from /recommendations?mode={mood.mode} — real server-side
  // semantic queries with personal re-ranking (SceneDNA brief §12 + §29).
  // Prior implementation was a client-side keyword filter over the "All Picks"
  // pool, which meant every user got the same "Dark & Cinematic" list.
  const [moodRecs, setMoodRecs] = useState<Record<MoodId, RecommendationItem[]>>({} as Record<MoodId, RecommendationItem[]>);
  const [moodFallbackLoading, setMoodFallbackLoading] = useState(false);
  const [hotTakes, setHotTakes] = useState<HotTake[]>([]);
  const [tasteEvolution, setTasteEvolution] = useState<TasteEvolution | null>(null);
  const [tasteAlignment, setTasteAlignment] = useState<TasteAlignment | null>(null);
  const motion = useRef(new Animated.Value(0)).current;
  const pulseDot = useRef(new Animated.Value(0.4)).current;
  const [isFocused, setIsFocused] = useState(true);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );

  useEffect(() => {
    async function load() {
      if (!sessionToken) return;
      setIsLoading(true);
      setError(null);
      try {
        const me = await apiRequest<MeProfile>("/me", { token: sessionToken });
        setProfile(me);
        const [tasteProfile, recs, teamList, dna] = await Promise.all([
          apiRequest<TasteProfile>(`/profiles/${me.user_id}/taste`, { token: sessionToken }),
          apiRequest<RecommendationItem[]>("/titles/recommendations/for-me?limit=18", { token: sessionToken }),
          apiRequest<TeamSummary[]>("/teams", { token: sessionToken }),
          apiRequest<SceneDna>("/me/scene-dna", { token: sessionToken }).catch(() => null),
        ]);
        setTaste(tasteProfile);
        setRecommendations(recs);
        setSceneDna(dna);
        try {
          const savedIds = await apiRequest<string[]>("/me/watchlist/title-ids", { token: sessionToken });
          setSavedTitleIds(new Set(savedIds));
        } catch {
          // non-critical; filtering will gracefully skip if unavailable
        }
        setTeams(teamList);
        if (teamList.length > 0) {
          try {
            const analytics = await apiRequest<TeamAnalytics>(`/teams/${teamList[0].id}/analytics`, { token: sessionToken });
            setTeamAnalytics(analytics);
          } catch {
            setTeamAnalytics(null);
          }
        } else {
          setTeamAnalytics(null);
        }
        const [takesResult, evolutionResult, alignmentResult] = await Promise.allSettled([
          apiRequest<HotTake[]>("/me/hot-takes", { token: sessionToken }),
          apiRequest<TasteEvolution>("/me/taste-evolution", { token: sessionToken }),
          apiRequest<TasteAlignment>("/me/taste-alignment", { token: sessionToken }),
        ]);
        if (takesResult.status === "fulfilled") setHotTakes(takesResult.value);
        if (evolutionResult.status === "fulfilled") setTasteEvolution(evolutionResult.value);
        if (alignmentResult.status === "fulfilled") setTasteAlignment(alignmentResult.value);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load Your Scene");
      } finally {
        setIsLoading(false);
      }
    }
    void load();
  }, [sessionToken]);

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseDot, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulseDot, { toValue: 0.4, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseDot]);

  useEffect(() => {
    motion.setValue(0);
    Animated.timing(motion, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [motion, taste, recommendations.length, teamAnalytics?.team_id]);

  // Mood rails call the unified RecommendationService (SceneDNA brief §12 +
  // §29). Each mood is a REAL server-side query against semantic attributes
  // (tone, visual_style, comfort_level, viewing_context) with personal
  // re-ranking — not a client-side keyword filter over the "All Picks" pool.
  useEffect(() => {
    if (selectedMood === "all" || !sessionToken) return;
    if (moodRecs[selectedMood]) return; // already fetched this session
    const mood = MOODS.find((m) => m.id === selectedMood);
    if (!mood) return;
    setMoodFallbackLoading(true);
    apiRequest<{
      mode: string;
      mode_label: string;
      items: Array<{
        impression_id: string;
        title: { id: string; title: string; content_type: string; poster_url?: string | null; backdrop_url?: string | null; overview?: string | null; release_date?: string | null; genres?: string[] };
        score: number;
        confidence: string;
        reasons: { type: string; signal_type?: string; signal_name?: string; hits?: number; score?: number }[];
        mode_label: string;
        reason_template: string;
      }>;
    }>(`/recommendations?mode=${encodeURIComponent(mood.mode)}&limit=20&surface=scenedna_scene_picks`, { token: sessionToken })
      .then((data) => {
        const asRecs: RecommendationItem[] = data.items.map((it) => ({
          title: it.title,
          reason: it.reason_template,
          reason_type: it.reasons[0]?.signal_name ?? mood.mode,
        }));
        setMoodRecs((prev) => ({ ...prev, [selectedMood]: asRecs }));
      })
      .catch(() => setMoodRecs((prev) => ({ ...prev, [selectedMood]: [] })))
      .finally(() => setMoodFallbackLoading(false));
  }, [selectedMood, sessionToken, moodRecs]);

  async function openDetails(item: RecommendationItem | TasteTitle) {
    if (!sessionToken) return;
    const titleId = "title" in item ? item.title.id : item.title_id;
    if (!titleId) return;
    setShowDetails(true);
    setDetailLoading(true);
    try {
      const seed =
        "title" in item
          ? { id: item.title.id, title: item.title.title, content_type: item.title.content_type, poster_url: item.title.poster_url, backdrop_url: item.title.backdrop_url, overview: item.title.overview }
          : { id: titleId, title: item.title_name, content_type: "movie", poster_url: item.poster_url };
      const full = await fetchUniversalTitle(sessionToken, titleId, seed);
      setDetailTitle(full);
    } catch (detailError) {
      setDetailTitle(null);
      setError(detailError instanceof Error ? detailError.message : "Could not load title details");
    } finally {
      setDetailLoading(false);
    }
  }

  // Posters for the PosterStack visual (portraits are correct there).
  const heroBackdrop = useMemo(() => {
    const candidates = [
      ...(taste?.top_posters ?? []),
      ...(taste?.current_obsessions.map((o) => o.poster_url ?? "") ?? []),
      ...recommendations.flatMap((r) => [r.title.backdrop_url ?? "", r.title.poster_url ?? ""]),
    ]
      .map((u) => resolveMediaUrl(u))
      .filter((u): u is string => Boolean(u));
    return candidates.slice(0, 3);
  }, [recommendations, taste]);

  // Landscape backdrop specifically for SSCinematicHeader — pulled ONLY from real
  // TMDB backdrops of the user's taste-driving titles. Never stretch a poster.
  const headerBackdropCandidates = useMemo(() => {
    return recommendations
      .flatMap((r) => [r.title.backdrop_url])
      .map((u) => resolveMediaUrl(u ?? null))
      .filter((u): u is string => Boolean(u));
  }, [recommendations]);
  const headerBackdrop = useCyclingBackdrop(headerBackdropCandidates);

  // Cycle through the personalized SceneDNA hero backdrops (from titles that
  // actually drove the DNA) so the header rotates instead of always locking
  // to the top obsession's backdrop.
  const sceneDnaHeaderBackdrop = useCyclingBackdrop(
    (sceneDna?.identity?.hero_backdrops ?? []).map((u) => resolveMediaUrl(u ?? null)),
  );

  const heroIntro = useMemo(() => buildHeroIntro(profile?.display_name, taste), [profile?.display_name, taste]);
  const heroSummary = useMemo(() => buildHeroSummary(taste), [taste]);
  const eraCopy = useMemo(() => buildEraCopy(taste), [taste]);
  const sceneStats = useMemo(() => buildSceneStats(taste), [taste]);
  const personality = useMemo(() => buildPersonalityArchetype(taste), [taste]);
  const achievements = useMemo(() => computeAchievements(taste), [taste]);
  const eraTimeline = useMemo(() => buildEraTimeline(taste), [taste]);
  const pulseHeadline = useMemo(() => buildPulseHeadline(teams[0], teamAnalytics), [teamAnalytics, teams]);

  // "All Picks" uses the personalized deck; other moods use the mode-scoped
  // rec fetch. Filter out titles the user has already saved regardless of mode.
  const activeRecList = useMemo(() => {
    const base = selectedMood === "all" ? recommendations.slice(1) : (moodRecs[selectedMood] ?? []);
    return base.filter((item) => !savedTitleIds.has(item.title.id));
  }, [recommendations, moodRecs, selectedMood, savedTitleIds]);

  const tonightsPick = useMemo(() => {
    if (selectedMood === "all") return recommendations[0] ?? null;
    return (moodRecs[selectedMood] ?? [])[0] ?? recommendations[0] ?? null;
  }, [recommendations, moodRecs, selectedMood]);

  const groupedRecommendations = useMemo(
    () => groupRecommendations(activeRecList, []),
    [activeRecList]
  );

  const stagger = (index: number) => ({
    opacity: motion,
    transform: [{ translateY: motion.interpolate({ inputRange: [0, 1], outputRange: [18 + index * 4, 0] }) }],
  });

  const tasteKey = taste?.user_id ?? "";

  const hasMinimalTaste = !taste || (taste.taste_labels.length === 0 && taste.top_genres.length === 0);

  // Cold-start fallback — if the user has no recommendations yet, fall back to a
  // trending backdrop at offset 4 so this tab doesn't look identical to Discover.
  const fallbackBackdrop = useFallbackBackdrop(4);

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      {/* Unified Header §6 + §7. SceneDNA is the DESTINATION; the
          personalized archetype lives in the identity card BELOW.
          Artwork cycles through the user's DNA-contributing titles so
          revisiting the tab doesn't always show the exact same backdrop
          (it was reading `[0]` before, which felt hardcoded to whichever
          title happened to sit at the top of current_obsessions). */}
      <SeenSnapHeader
        title="SceneDNA"
        subtitle="Your taste, decoded."
        artworkSource={sceneDnaHeaderBackdrop ?? headerBackdrop ?? fallbackBackdrop}
        fallbackSeed={4}
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Compact Identity Hero — SceneDNA UX Overhaul brief §4. Single
            headline archetype + one-sentence explanation + credibility line
            grounded in real behavior counts. Backdrop collage in the header
            already pulls from the same DNA-contributing titles, so the
            imagery is evidence, not decoration. Falls back to the legacy
            personalization strip when /me/scene-dna hasn't loaded yet. */}
        {sceneDna?.identity ? (
          <Animated.View style={[styles.identityCard, stagger(0)]}>
            <View style={styles.identityMetaRow}>
              <Text style={styles.identityKicker}>Your SceneDNA</Text>
              <View
                style={[
                  styles.identityConfidencePill,
                  sceneDna.identity.confidence_tier === "strong" && styles.identityConfidencePillStrong,
                  sceneDna.identity.confidence_tier === "emerging" && styles.identityConfidencePillEmerging,
                  sceneDna.identity.confidence_tier === "early" && styles.identityConfidencePillEarly,
                ]}
              >
                <Animated.View style={[styles.identityConfidenceDot, { opacity: pulseDot }]} />
                <Text style={styles.identityConfidenceText}>
                  {sceneDna.identity.confidence_tier === "strong"
                    ? "Strong signal"
                    : sceneDna.identity.confidence_tier === "emerging"
                      ? "Emerging pattern"
                      : "Early signal"}
                </Text>
              </View>
            </View>
            <Text style={styles.identityArchetype} numberOfLines={2}>
              {sceneDna.identity.archetype}
            </Text>
            <Text style={styles.identityOneLine} numberOfLines={3}>
              {sceneDna.identity.one_line}
            </Text>
            <Text style={styles.identityBasedOn}>{sceneDna.identity.based_on_summary}</Text>
            <GoldButton
              label="Find What's Next"
              size="lg"
              onPress={() => router.navigate("/(tabs)/swipe")}
              style={{ alignSelf: "flex-start", marginTop: spacing.sm }}
            />
          </Animated.View>
        ) : sceneDna?.cold_start ? (
          // Cold-start meter — SceneDNA UX Overhaul brief §8. Progress tied to
          // MEANINGFUL behaviors (saves / ratings / swipes), not arbitrary
          // app usage. Never present a fabricated identity until the user has
          // enough signal — better to look deliberately incomplete than fake.
          <Animated.View style={[styles.identityCard, stagger(0)]}>
            <View style={styles.identityMetaRow}>
              <Text style={styles.identityKicker}>Your SceneDNA</Text>
              <View style={[styles.identityConfidencePill, styles.identityConfidencePillEarly]}>
                <Text style={styles.identityConfidenceText}>Forming</Text>
              </View>
            </View>
            <Text style={styles.identityArchetype} numberOfLines={2}>
              Your SceneDNA is forming.
            </Text>
            <Text style={styles.identityOneLine} numberOfLines={3}>
              {sceneDna.cold_start.next_action_hint}
            </Text>
            <View style={styles.coldStartMeters}>
              <ColdStartMeter
                label="Save"
                current={sceneDna.cold_start.saves_current}
                target={sceneDna.cold_start.saves_target}
              />
              <ColdStartMeter
                label="Rate"
                current={sceneDna.cold_start.ratings_current}
                target={sceneDna.cold_start.ratings_target}
              />
              <ColdStartMeter
                label="Swipe"
                current={sceneDna.cold_start.swipes_current}
                target={sceneDna.cold_start.swipes_target}
              />
            </View>
            <GoldButton
              label="Start Swiping"
              size="lg"
              onPress={() => router.navigate("/(tabs)/swipe")}
              style={{ alignSelf: "flex-start", marginTop: spacing.sm }}
            />
          </Animated.View>
        ) : (
          // Loading fallback — /me/scene-dna hasn't resolved yet. Kept as a
          // lightweight strip so the layout doesn't jump when data lands.
          <Animated.View style={[styles.dnaSection, stagger(0)]}>
            <View style={styles.heroLiveTag}>
              <Animated.View style={[styles.heroLiveDot, { opacity: pulseDot }]} />
              <Text style={styles.heroLiveText}>Reading your signals…</Text>
            </View>
          </Animated.View>
        )}

        {/* Editorial loading state */}
        {isLoading ? (
          <View style={styles.loadingState}>
            <Text style={styles.loadingIndex}>§ 00</Text>
            <View style={styles.loadingRule} />
            <Text style={styles.loadingHeading}>Building your taste profile…</Text>
            <Text style={styles.loadingBody}>Reading the signals from your saves, ratings, and watch history.</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Low-signal editorial state */}
        {!isLoading && hasMinimalTaste ? (
          <Animated.View style={[styles.lowSignalState, stagger(1)]}>
            <Text style={styles.lowSignalIndex}>§ 01</Text>
            <View style={styles.lowSignalRule} />
            <Text style={styles.lowSignalHeading}>We have the outline.</Text>
            <Text style={styles.lowSignalBody}>Give us a few more choices and this page starts to feel personal. Save what you've seen. Rate what moved you.</Text>
            <Pressable onPress={() => router.navigate("/(tabs)/swipe")} style={styles.lowSignalCta}>
              <Text style={styles.lowSignalCtaText}>Swipe to build your taste →</Text>
            </Pressable>
          </Animated.View>
        ) : null}

        {/* Your Scene Picks — moved to top for immediate value */}
        <Animated.View style={stagger(1)}>
          <ChapterSection index="§ 01" title="Your Scene Picks" subtitle="Matched to your taste identity. Intentional, not random.">
            <TonightsMoodPicker selected={selectedMood} onSelect={setSelectedMood} />
            <View style={styles.recommendationSectionList}>
              {groupedRecommendations.length > 0 ? (
                groupedRecommendations.map((group) => (
                  <View key={group.title} style={styles.recommendationGroup}>
                    <View style={styles.recommendationGroupHeader}>
                      <Text style={styles.recommendationGroupTitle}>{group.title}</Text>
                      <Text style={styles.recommendationGroupSubtitle}>{group.subtitle}</Text>
                    </View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recommendationRow}>
                      {group.items.map((item) => (
                        <AnimatedCard key={item.title.id} style={styles.recommendationCard} onPress={() => void openDetails(item)}>
                          <Poster uri={item.title.poster_url} style={styles.recommendationPoster} iconSize={20} />
                          <MatchBadge score={computeMatchScore(item, taste)} />
                          <View style={styles.recommendationOverlay}>
                            <Text style={styles.recommendationReason}>{humanizeReason(item.reason)}</Text>
                            <Text style={styles.recommendationTitle} numberOfLines={2}>{item.title.title}</Text>
                            <Text style={styles.recommendationMeta} numberOfLines={1}>
                              {buildRecommendationMeta(item)}
                            </Text>
                          </View>
                          <Pressable
                            onPress={() => { setSaveTitleId(item.title.id); setShowSaveSheet(true); }}
                            style={styles.saveButton}
                          >
                            <Ionicons name="bookmark-outline" size={18} color={colors.ink} />
                          </Pressable>
                        </AnimatedCard>
                      ))}
                    </ScrollView>
                  </View>
                ))
              ) : selectedMood !== "all" ? (
                // SceneDNA brief §34 — honest empty state. Mood rails need
                // semantic tone/pacing attributes to work well; until Phase 3
                // lands those (task #55 TitleFeatures), tell the user why
                // rather than filling with popularity dressed as personal.
                <View style={styles.moodEmptyState}>
                  <Text style={styles.emptyText}>
                    Not enough {MOODS.find((m) => m.id === selectedMood)?.label.toLowerCase()} picks match your taste yet.
                  </Text>
                  <Text style={styles.emptySubText}>
                    Save or swipe more titles in this vein and this rail sharpens up. Meanwhile, try Discover for what's trending in this category.
                  </Text>
                  <Pressable onPress={() => setSelectedMood("all")} style={styles.emptyCta}>
                    <Text style={styles.emptyCtaText}>Back to all picks</Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.emptyText}>
                  {isLoading ? "Building your queue…" : "Save or swipe a few titles — your picks will appear here."}
                </Text>
              )}
            </View>
          </ChapterSection>
        </Animated.View>

        {taste ? (
          <>
            {/* Signals — SceneDNA UX Overhaul brief §3 layer 2. Replaces the
                old typographic stat list. 3-5 compact signal cards, each
                grounded in real contributing titles. Confidence tier decides
                how firmly we phrase the label (strong/emerging/early). */}
            {sceneDna?.signals && sceneDna.signals.length > 0 ? (
              <Animated.View style={stagger(2)}>
                <ChapterSection
                  index="§ 02"
                  title="Strongest Signals"
                  subtitle="What your saves and swipes keep pointing to."
                >
                  <View style={styles.signalGrid}>
                    {sceneDna.signals.map((signal) => (
                      <Pressable
                        key={signal.label}
                        style={styles.signalCard}
                        onPress={() => {
                          trackEvent("scene_dna_signal_opened", {
                            label: signal.label,
                            confidence_tier: signal.confidence_tier,
                          });
                          setSignalDrawer(signal);
                          setSignalDetail(null);
                          setSignalDetailLoading(true);
                          if (sessionToken) {
                            apiRequest<typeof signalDetail>(
                              `/me/scene-dna/signals/${encodeURIComponent(signal.label)}`,
                              { token: sessionToken },
                            )
                              .then((data) => setSignalDetail(data))
                              .catch(() => setSignalDetail(null))
                              .finally(() => setSignalDetailLoading(false));
                          } else {
                            setSignalDetailLoading(false);
                          }
                        }}
                      >
                        <View style={styles.signalHeader}>
                          <Text style={styles.signalLabel} numberOfLines={1}>{signal.label}</Text>
                          <Text
                            style={[
                              styles.signalTier,
                              signal.confidence_tier === "strong" && styles.signalTierStrong,
                              signal.confidence_tier === "emerging" && styles.signalTierEmerging,
                              signal.confidence_tier === "early" && styles.signalTierEarly,
                            ]}
                          >
                            {signal.confidence_tier}
                          </Text>
                        </View>
                        <Text style={styles.signalEvidence}>
                          Shows up across {signal.evidence_count} recent {signal.evidence_count === 1 ? "save" : "saves"}
                        </Text>
                        {signal.contributing_titles.length > 0 ? (
                          <View style={styles.signalPosterRow}>
                            {signal.contributing_titles.slice(0, 3).map((t) => (
                              <View key={`${signal.label}-${t.title_id ?? t.title_name}`} style={styles.signalPoster}>
                                {t.poster_url ? (
                                  <Image source={{ uri: t.poster_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                                ) : null}
                              </View>
                            ))}
                          </View>
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                </ChapterSection>
              </Animated.View>
            ) : null}

            {/* Taste Shift — brief §3 layer 3, §5. Only material movement, not
                a full leaderboard. Empty when there's nothing meaningful to
                report — that's the point (no fake movement). */}
            {sceneDna?.movement && sceneDna.movement.length > 0 ? (
              <Animated.View style={stagger(3)}>
                <ChapterSection
                  index="§ 03"
                  title="Taste Shift"
                  subtitle="What's changed since last month."
                >
                  <View style={styles.movementList}>
                    {sceneDna.movement.map((m) => (
                      <View key={`${m.direction}-${m.label}`} style={styles.movementRow}>
                        <Text
                          style={[
                            styles.movementArrow,
                            m.direction === "rising" && styles.movementArrowUp,
                            m.direction === "fading" && styles.movementArrowDown,
                          ]}
                        >
                          {m.direction === "rising" ? "↑" : m.direction === "fading" ? "↓" : "★"}
                        </Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.movementLabel}>{m.label}</Text>
                          <Text style={styles.movementDetail}>{m.detail}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </ChapterSection>
              </Animated.View>
            ) : null}

            {/* Deep Dive toggle — brief §3 layer 5, §9 P2. Detailed analytics
                belong ONE TAP DEEPER, not expanded by default. Everything from
                Genre Breakdown through Alignment lives behind this. */}
            <Pressable
              onPress={() => setShowDeepDive((v) => !v)}
              style={styles.deepDiveToggle}
            >
              <Text style={styles.deepDiveKicker}>§ Deep Dive</Text>
              <Text style={styles.deepDiveLabel}>
                {showDeepDive ? "Hide detailed analytics ↑" : "Show detailed analytics ↓"}
              </Text>
            </Pressable>

            {showDeepDive && taste.top_genres.length > 0 ? (
              <Animated.View style={stagger(2)}>
                <ChapterSection index="§ 04" title="Genre Breakdown" subtitle="Your distribution, by signal strength.">
                  <View style={styles.genreList}>
                    {taste.top_genres.slice(0, 6).map((g) => {
                      const pct = Math.round(Math.min(99, (g.score / (taste.top_genres[0]?.score || 1)) * 100));
                      return (
                        <View key={g.genre} style={styles.genreRow}>
                          <Text style={styles.genreName}>{g.genre}</Text>
                          <View style={styles.genreBarTrack}>
                            <View style={[styles.genreBarFill, { width: `${pct}%` }]} />
                          </View>
                          <Text style={styles.genrePct}>{pct}%</Text>
                        </View>
                      );
                    })}
                  </View>
                </ChapterSection>
              </Animated.View>
            ) : null}
            {!showDeepDive ? null : (
              <></>
            )}

            {/* Deep Dive contents — analytics/achievements/history behind the
                collapsible toggle per brief §3 layer 5 + §9 P2. Kept as-is so
                power users can still access them, but no longer expanded by
                default (was flooding the primary intelligence journey). */}
            {showDeepDive ? (
              <>
                {/* Your Current Era */}
                <Animated.View style={stagger(3)}>
                  <View style={styles.eraCard}>
                    <Text style={styles.eraIndex}>§ 05</Text>
                    <View style={styles.eraRule} />
                    <Text style={styles.eraEyebrow}>Current era</Text>
                    <Text style={styles.eraTitle}>{eraCopy.title}</Text>
                    <Text style={styles.eraBody}>{eraCopy.body}</Text>
                  </View>
                </Animated.View>

                {/* Era Timeline */}
                {eraTimeline.length > 1 ? (
                  <Animated.View style={stagger(4)}>
                    <EraTimelineSection entries={eraTimeline} />
                  </Animated.View>
                ) : null}

                {/* Taste Identity — legacy labels list, still useful for the
                    "receipts" view even though Signals cards now render up top. */}
                <Animated.View style={stagger(5)}>
                  <ChapterSection index="§ 06" title="Taste Identity" subtitle="The labels your viewing history has earned you.">
                    {taste.taste_labels.length > 0 ? (
                      <View style={styles.identityList}>
                        {taste.taste_labels.map((l, i) => (
                          <IdentityChapterRow key={l.label} label={l} index={i} />
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>Keep saving and rating. Your identity labels are coming into focus.</Text>
                    )}
                  </ChapterSection>
                </Animated.View>

                {/* Your Viewing Personality */}
                <Animated.View style={stagger(6)}>
                  <ViewingPersonalityCard personality={personality} />
                </Animated.View>

                {/* Taste Achievements — brief §5 explicitly moves this out of
                    the core intelligence journey; deep dive is the right home. */}
                <Animated.View style={stagger(7)}>
                  <TasteAchievementsSection achievements={achievements} />
                </Animated.View>

                {/* Hot Takes */}
                {hotTakes.length > 0 ? (
                  <Animated.View style={stagger(8)}>
                    <HotTakesSection takes={hotTakes} />
                  </Animated.View>
                ) : null}

                {/* Taste Evolution */}
                {tasteEvolution?.has_data ? (
                  <Animated.View style={stagger(9)}>
                    <TasteEvolutionSection evolution={tasteEvolution} />
                  </Animated.View>
                ) : null}

                {/* People With Your Taste */}
                {tasteAlignment?.has_data ? (
                  <Animated.View style={stagger(10)}>
                    <TasteAlignmentSection alignment={tasteAlignment} onNavigate={(userId) => router.push(`/profile/${userId}`)} />
                  </Animated.View>
                ) : null}
              </>
            ) : null}

            {/* Tonight's Pick */}
            {tonightsPick ? (
              <Animated.View style={stagger(11)}>
                <TonightsPickCard
                  item={tonightsPick}
                  taste={taste}
                  onOpen={() => void openDetails(tonightsPick)}
                  onSave={() => { setSaveTitleId(tonightsPick.title.id); setShowSaveSheet(true); }}
                />
              </Animated.View>
            ) : null}

            {/* Currently Obsessing Over */}
            <Animated.View style={stagger(12)}>
              <ChapterSection index="§ 07" title="Currently Obsessing Over" subtitle="The titles and moods living rent-free in your head.">
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalRow}>
                  {taste.current_obsessions.length > 0 ? (
                    taste.current_obsessions.map((item, i) => (
                      <AnimatedCard
                        key={`${item.title_id}-${item.title_name}`}
                        style={styles.obsessionCard}
                        onPress={() => void openDetails(item)}
                      >
                        <Poster uri={item.poster_url} style={styles.obsessionPoster} iconSize={22} />
                        <View style={styles.obsessionCopy}>
                          <Text style={styles.obsessionTag}>{i === 0 ? "Top obsession" : "In rotation"}</Text>
                          <Text style={styles.obsessionTitle} numberOfLines={2}>{item.title_name}</Text>
                        </View>
                      </AnimatedCard>
                    ))
                  ) : (
                    <Text style={styles.emptyText}>Nothing is taking over your watchlist just yet.</Text>
                  )}
                </ScrollView>
              </ChapterSection>
            </Animated.View>
          </>
        ) : null}

        {/* Your Teams Are Into */}
        {teams.length > 0 ? (
          <Animated.View style={stagger(14)}>
            <ChapterSection index="§ 09" title="Your Teams Are Into…" subtitle="What your watch circle can't stop talking about.">
              <View style={styles.teamCard}>
                <View style={styles.teamTopRow}>
                  <View style={styles.teamHeading}>
                    <Text style={styles.teamName}>{teams[0].name}</Text>
                    <Text style={styles.teamMeta}>{teams[0].member_count} members</Text>
                  </View>
                  <View style={styles.compatibilityBlock}>
                    <Text style={styles.compatibilityValue}>{teamAnalytics?.average_compatibility ?? 0}%</Text>
                    <Text style={styles.compatibilityLabel}>in sync</Text>
                  </View>
                </View>
                <View style={styles.teamRule} />
                <Text style={styles.teamHeadline}>{pulseHeadline}</Text>
                <View style={styles.teamInsightGrid}>
                  <MiniInsight label="Taste MVP" value={teamAnalytics?.taste_mvp?.display_name ?? "Still shaking out"} />
                  <MiniInsight label="Most loved" value={teamAnalytics?.most_loved_title?.title_name ?? "Still shaking out"} />
                  <MiniInsight label="Most divisive" value={teamAnalytics?.most_divisive_title?.title_name ?? "Still shaking out"} />
                  <MiniInsight label="Biggest vibe" value={teamAnalytics?.genre_breakdown?.[0]?.genre ?? "Still shaking out"} />
                </View>
              </View>
            </ChapterSection>
          </Animated.View>
        ) : null}

      </ScrollView>

      <UniversalTitleModal
        visible={showDetails}
        loading={detailLoading}
        title={detailTitle}
        onClose={() => setShowDetails(false)}
        onSaveTitle={(detail) => { setSaveTitleId(detail.id); setShowSaveSheet(true); }}
      />
      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="your_scene"
        onClose={() => { setShowSaveSheet(false); setSaveTitleId(null); }}
        onError={(message) => setError(message)}
      />

      {/* Signal evidence drawer — SceneDNA brief §18 + §20. Renders the
          REAL per-signal detail from /me/scene-dna/signals/{name}: sample
          size, trend, positive evidence, negative evidence, and an
          "Explore this signal" personalized rec rail. "Less like this" /
          "Not quite me" POST /correction so the signal actually gets
          suppressed on the next SceneDNA refresh — not just an analytics
          event. */}
      <Modal visible={signalDrawer !== null} transparent animationType="fade" onRequestClose={() => setSignalDrawer(null)}>
        <Pressable style={styles.signalDrawerBackdrop} onPress={() => setSignalDrawer(null)}>
          <Pressable style={styles.signalDrawerSheet} onPress={(e) => e.stopPropagation()}>
            {signalDrawer ? (
              <ScrollView contentContainerStyle={{ paddingBottom: spacing.md }}>
                <View style={styles.signalDrawerHeader}>
                  <Text style={styles.signalDrawerKicker}>
                    Signal · {signalDetail?.confidence_tier ?? signalDrawer.confidence_tier}
                    {signalDetail?.trend === "rising" ? "  ·  ↑ rising" : null}
                    {signalDetail?.trend === "fading" ? "  ·  ↓ fading" : null}
                  </Text>
                  <Text style={styles.signalDrawerLabel}>{signalDrawer.label}</Text>
                  <Text style={styles.signalDrawerBody}>
                    {signalDetailLoading
                      ? "Loading evidence…"
                      : signalDetail
                        ? `${signalDetail.sample_size} interactions in your history. ${signalDetail.positive_evidence.length > 0 ? "Titles that shaped this:" : "Still gathering evidence."}`
                        : `${signalDrawer.evidence_count} recent ${signalDrawer.evidence_count === 1 ? "interaction" : "interactions"}.`}
                  </Text>
                </View>
                {(signalDetail?.positive_evidence ?? signalDrawer.contributing_titles).length > 0 ? (
                  <View style={styles.signalDrawerEvidenceRow}>
                    {(signalDetail?.positive_evidence ?? signalDrawer.contributing_titles).slice(0, 3).map((t) => (
                      <View key={t.title_id ?? t.title_name} style={styles.signalDrawerEvidenceItem}>
                        <View style={styles.signalDrawerEvidencePoster}>
                          {t.poster_url ? (
                            <Image source={{ uri: t.poster_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                          ) : null}
                        </View>
                        <Text style={styles.signalDrawerEvidenceTitle} numberOfLines={2}>{t.title_name}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                {signalDetail && signalDetail.negative_evidence.length > 0 ? (
                  <View style={{ marginTop: spacing.md }}>
                    <Text style={styles.signalDrawerSectionLabel}>Titles you pushed back on</Text>
                    <View style={styles.signalDrawerNegativeRow}>
                      {signalDetail.negative_evidence.slice(0, 3).map((t) => (
                        <Text key={t.title_id ?? t.title_name} style={styles.signalDrawerNegativeChip} numberOfLines={1}>
                          {t.title_name}
                        </Text>
                      ))}
                    </View>
                  </View>
                ) : null}

                {signalDetail && signalDetail.explore.length > 0 ? (
                  <View style={{ marginTop: spacing.md }}>
                    <Text style={styles.signalDrawerSectionLabel}>Explore this signal</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.signalDrawerExploreRow}>
                      {signalDetail.explore.map((rec) => (
                        <View key={rec.impression_id} style={styles.signalDrawerExploreCard}>
                          <View style={styles.signalDrawerExplorePoster}>
                            {rec.poster_url ? (
                              <Image source={{ uri: rec.poster_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                            ) : null}
                          </View>
                          <Text style={styles.signalDrawerExploreTitle} numberOfLines={2}>{rec.title_name}</Text>
                        </View>
                      ))}
                    </ScrollView>
                  </View>
                ) : null}

                <View style={styles.signalDrawerActions}>
                  <Pressable
                    style={[styles.signalDrawerAction, styles.signalDrawerActionSecondary]}
                    onPress={() => {
                      const label = signalDrawer.label;
                      trackEvent("scene_dna_signal_less_like", { label });
                      if (sessionToken) {
                        apiRequest(`/me/scene-dna/signals/${encodeURIComponent(label)}/correction`, {
                          method: "POST",
                          token: sessionToken,
                          body: JSON.stringify({ action: "signal_less_like" }),
                        }).catch(() => {});
                      }
                      setSignalDrawer(null);
                    }}
                  >
                    <Ionicons name="thumbs-down-outline" size={16} color={colors.muted} />
                    <Text style={styles.signalDrawerActionText}>Less like this</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.signalDrawerAction, styles.signalDrawerActionSecondary]}
                    onPress={() => {
                      const label = signalDrawer.label;
                      trackEvent("scene_dna_signal_not_me", { label });
                      if (sessionToken) {
                        apiRequest(`/me/scene-dna/signals/${encodeURIComponent(label)}/correction`, {
                          method: "POST",
                          token: sessionToken,
                          body: JSON.stringify({ action: "signal_not_me" }),
                        }).catch(() => {});
                      }
                      setSignalDrawer(null);
                    }}
                  >
                    <Ionicons name="close-outline" size={16} color={colors.muted} />
                    <Text style={styles.signalDrawerActionText}>Not quite me</Text>
                  </Pressable>
                </View>
                <Pressable style={styles.signalDrawerClose} onPress={() => setSignalDrawer(null)}>
                  <Text style={styles.signalDrawerCloseText}>Close</Text>
                </Pressable>
              </ScrollView>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ColdStartMeter({ label, current, target }: { label: string; current: number; target: number }) {
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  const done = current >= target;
  return (
    <View style={styles.coldStartMeter}>
      <View style={styles.coldStartMeterRow}>
        <Text style={styles.coldStartMeterLabel}>{label}</Text>
        <Text style={[styles.coldStartMeterCount, done && styles.coldStartMeterCountDone]}>
          {Math.min(current, target)}/{target}
        </Text>
      </View>
      <View style={styles.coldStartMeterTrack}>
        <View style={[styles.coldStartMeterFill, { width: `${pct}%` }, done && styles.coldStartMeterFillDone]} />
      </View>
    </View>
  );
}

function ChapterSection({ index, title, subtitle, children }: { index: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.chapterHeader}>
        <Text style={styles.chapterIndex}>{index}</Text>
        <View style={styles.chapterRule} />
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      </View>
      {children}
    </View>
  );
}

function StatRow({
  stat,
  index,
  tasteKey,
}: {
  stat: { label: string; value: string; body: string };
  index: number;
  tasteKey: string;
}) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    opacity.setValue(0);
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 1, duration: 320, useNativeDriver: true }).start();
    }, index * 75);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasteKey]);

  return (
    <Animated.View style={[styles.statRow, { opacity }]}>
      <View style={styles.statRuleBar} />
      <View style={styles.statInner}>
        <Text style={styles.statLabel}>{stat.label}</Text>
        <Text style={styles.statValue}>{stat.value}</Text>
        <Text style={styles.statBody}>{stat.body}</Text>
      </View>
    </Animated.View>
  );
}

function EraTimelineSection({ entries }: { entries: EraEntry[] }) {
  return (
    <View style={styles.section}>
      <View style={styles.chapterHeader}>
        <Text style={styles.chapterIndex}>§ 05</Text>
        <View style={styles.chapterRule} />
        <Text style={styles.sectionTitle}>Your Era Timeline</Text>
        <Text style={styles.sectionSubtitle}>How your taste has shifted over time.</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.eraTimelineRow}>
        {entries.map((entry, i) => (
          <View key={entry.period} style={styles.eraTimelineEntryWrap}>
            {i > 0 ? (
              <View style={styles.eraTimelineConnector}>
                <View style={styles.eraTimelineConnectorLine} />
              </View>
            ) : null}
            <View style={[styles.eraTimelineCard, entry.isCurrent && styles.eraTimelineCardCurrent]}>
              <Text style={[styles.eraTimelinePeriod, entry.isCurrent && styles.eraTimelinePeriodCurrent]}>
                {entry.period}
              </Text>
              {entry.isCurrent ? (
                <View style={styles.eraTimelineGoldTick} />
              ) : null}
              <Text style={[styles.eraTimelineName, entry.isCurrent && styles.eraTimelineNameCurrent]} numberOfLines={3}>
                {entry.era}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function IdentityChapterRow({ label, index }: { label: TasteLabel; index: number }) {
  const isShifting = label.confidence >= 80;
  return (
    <View style={styles.identityRow}>
      <View style={styles.identityRowTop}>
        <Text style={styles.identityRowIndex}>{String(index + 1).padStart(2, "0")}</Text>
        <View style={styles.identityRowRule} />
        <Text style={styles.identityRowConf}>{label.confidence}%</Text>
        {isShifting ? <Text style={styles.identityGoldTick}>▲</Text> : null}
      </View>
      <Text style={styles.identityRowLabel}>{label.label}</Text>
      <Text style={styles.identityRowCaption}>{buildLabelCaption(label.label)}</Text>
    </View>
  );
}

function HotTakesSection({ takes }: { takes: HotTake[] }) {
  const typeLabel: Record<string, string> = {
    contrarian: "Contrarian",
    hidden_gem: "Hidden gem",
    genre_devotee: "Genre devotee",
    crowd_pleaser: "Crowd pleaser",
  };
  return (
    <ChapterSection index="§ 06" title="Your Hot Takes" subtitle="What your viewing history reveals about you when you're not looking.">
      <View style={styles.hotTakesList}>
        {takes.map((take, i) => {
          const label = typeLabel[take.type] ?? take.type;
          return (
            <View key={i} style={styles.hotTakeRow}>
              <View style={styles.hotTakeRowTop}>
                <Text style={styles.hotTakeType}>{label}</Text>
                <View style={styles.hotTakeRuleInline} />
                <Text style={styles.hotTakeStrength}>{take.strength}%</Text>
              </View>
              <Text style={styles.hotTakeStatement}>{take.statement}</Text>
            </View>
          );
        })}
      </View>
    </ChapterSection>
  );
}

function TasteEvolutionSection({ evolution }: { evolution: TasteEvolution }) {
  return (
    <ChapterSection index="§ 06b" title="Taste in Motion" subtitle={evolution.summary}>
      <View style={styles.evolutionList}>
        {evolution.shifts.map((shift) => {
          const isRising = shift.direction === "rising";
          const color = isRising ? colors.accent : colors.danger;
          const pct = Math.round(Math.min(Math.abs(shift.delta) * 2.5, 100));
          return (
            <View key={shift.genre} style={styles.evolutionRow}>
              <View style={styles.evolutionLabelRow}>
                <Text style={styles.evolutionGenre}>{shift.genre}</Text>
                <View style={styles.evolutionDeltaWrap}>
                  {/* Gold tick/annotation for rising dimensions */}
                  {isRising ? (
                    <Text style={[styles.evolutionTick, { color }]}>▲</Text>
                  ) : (
                    <Text style={[styles.evolutionTick, { color }]}>▼</Text>
                  )}
                  <Text style={[styles.evolutionDelta, { color }]}>{Math.abs(shift.delta)}%</Text>
                </View>
              </View>
              <View style={styles.evolutionBarTrack}>
                <View style={[styles.evolutionBarFill, { width: `${pct}%`, backgroundColor: color }]} />
              </View>
            </View>
          );
        })}
      </View>
      <Text style={styles.evolutionFootnote}>{evolution.period_label} {evolution.comparison_label}</Text>
    </ChapterSection>
  );
}

function TasteAlignmentSection({ alignment, onNavigate }: { alignment: TasteAlignment; onNavigate: (userId: string) => void }) {
  return (
    <ChapterSection index="§ 06c" title="People With Your Taste" subtitle="The accounts in your circle who get it. Same chaos, same obsessions.">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.alignmentRow}>
        {alignment.entries.map((entry) => {
          const scoreColor = entry.alignment_score >= 70 ? colors.accent : colors.muted;
          return (
            <Pressable key={entry.user_id} style={styles.alignmentCard} onPress={() => onNavigate(entry.user_id)}>
              <Avatar uri={entry.avatar_url} label={entry.display_name} size={48} />
              <Text style={[styles.alignmentScore, { color: scoreColor }]}>{entry.alignment_score}%</Text>
              <Text style={styles.alignmentName} numberOfLines={1}>{entry.display_name}</Text>
              {entry.shared_label ? (
                <Text style={styles.alignmentSharedLabel} numberOfLines={1}>{entry.shared_label}</Text>
              ) : entry.top_shared_genres.length > 0 ? (
                <Text style={styles.alignmentSharedLabel} numberOfLines={1}>{entry.top_shared_genres[0]}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </ChapterSection>
  );
}

function ViewingPersonalityCard({ personality }: { personality: PersonalityArchetype }) {
  return (
    <ChapterSection index="§ 05b" title="Your Viewing Personality" subtitle="The archetype your taste history has shaped.">
      <View style={styles.personalityCard}>
        <Text style={styles.personalityIcon}>{personality.icon}</Text>
        <View style={styles.personalityMeta}>
          <Text style={styles.personalityEyebrow}>You are</Text>
          <Text style={styles.personalityName}>{personality.name}</Text>
          <Text style={styles.personalityDescription}>{personality.description}</Text>
        </View>
      </View>
    </ChapterSection>
  );
}

function TasteAchievementsSection({ achievements }: { achievements: Achievement[] }) {
  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  const sorted = [...achievements].sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0));
  return (
    <ChapterSection
      index="§ 05c"
      title="Taste Achievements"
      subtitle={
        unlockedCount > 0
          ? `${unlockedCount} of ${achievements.length} unlocked. Your viewing record speaks for itself.`
          : "Save and rate titles to start unlocking these."
      }
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.achievementRow}>
        {sorted.map((achievement) => (
          <AchievementCard key={achievement.id} achievement={achievement} />
        ))}
      </ScrollView>
    </ChapterSection>
  );
}

function AchievementCard({ achievement }: { achievement: Achievement }) {
  return (
    <View style={[styles.achievementCard, !achievement.unlocked && styles.achievementCardLocked]}>
      <Text style={styles.achievementIcon}>{achievement.icon}</Text>
      <View style={styles.achievementRuleBar} />
      <Text style={styles.achievementName}>{achievement.name}</Text>
      <Text style={styles.achievementDesc} numberOfLines={3}>{achievement.description}</Text>
      <Text style={[styles.achievementStatus, achievement.unlocked && styles.achievementStatusUnlocked]}>
        {achievement.unlocked ? "Unlocked" : "Locked"}
      </Text>
    </View>
  );
}

function TonightsMoodPicker({ selected, onSelect }: { selected: MoodId; onSelect: (id: MoodId) => void }) {
  return (
    <View style={styles.moodSection}>
      <Text style={styles.moodLabel}>Tonight's mood</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.moodRow}>
        {MOODS.map((mood) => (
          <Pressable
            key={mood.id}
            style={[styles.moodChip, selected === mood.id && styles.moodChipActive]}
            onPress={() => onSelect(mood.id)}
          >
            <Text style={[styles.moodChipText, selected === mood.id && styles.moodChipTextActive]}>
              {mood.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function MatchBadge({ score }: { score: number }) {
  const tierColor = score >= 85 ? colors.accent : score >= 70 ? colors.muted : colors.muted2;
  return (
    <View style={styles.matchBadge}>
      <Text style={[styles.matchScore, { color: tierColor }]}>{score}%</Text>
      <Text style={[styles.matchLabel, { color: tierColor }]}> match</Text>
    </View>
  );
}

function TonightsPickCard({ item, taste, onOpen, onSave }: { item: RecommendationItem; taste: TasteProfile; onOpen: () => void; onSave: () => void }) {
  const backdropUri = resolveMediaUrl(item.title.backdrop_url || item.title.poster_url);
  const posterUri = resolveMediaUrl(item.title.poster_url);
  const genres = item.title.genres?.slice(0, 3) ?? [];
  return (
    <ChapterSection index="§ 06" title="Tonight's Pick" subtitle="Our best read on your vibe right now.">
      <Pressable style={styles.tonightCard} onPress={onOpen}>
        {backdropUri ? (
          <Image source={{ uri: backdropUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />
        )}
        <View style={styles.tonightShade} />
        <View style={styles.tonightContent}>
          <Text style={styles.tonightHook}>{buildTonightHook(item, taste)}</Text>
          <View style={styles.tonightRow}>
            {posterUri ? (
              <Image source={{ uri: posterUri }} style={styles.tonightPoster} resizeMode="cover" />
            ) : (
              <View style={[styles.tonightPoster, styles.tonightPosterFallback]}>
                <Ionicons name="film-outline" size={20} color={colors.muted} />
              </View>
            )}
            <View style={styles.tonightMeta}>
              <Text style={styles.tonightTitle} numberOfLines={2}>{item.title.title}</Text>
              {genres.length > 0 ? (
                <Text style={styles.tonightGenres}>{genres.join(" / ")}</Text>
              ) : null}
              <Text style={styles.tonightReason} numberOfLines={2}>{item.title.overview || humanizeReason(item.reason)}</Text>
            </View>
          </View>
          <View style={styles.tonightActions}>
            <Pressable style={styles.tonightPrimary} onPress={onOpen}>
              <Ionicons name="play" size={14} color={colors.background} />
              <Text style={styles.tonightPrimaryText}>See Details</Text>
            </Pressable>
            <Pressable style={styles.tonightSave} onPress={onSave}>
              <Ionicons name="bookmark-outline" size={18} color={colors.ink} />
            </Pressable>
          </View>
        </View>
      </Pressable>
    </ChapterSection>
  );
}

function MiniInsight({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.miniInsight}>
      <Text style={styles.miniInsightLabel}>{label}</Text>
      <View style={styles.miniInsightRule} />
      <Text style={styles.miniInsightValue}>{value}</Text>
    </View>
  );
}

function AnimatedCard({ style, onPress, children }: { style: any; onPress: () => void; children: ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <Pressable onPress={onPress} onPressIn={() => pressIn(scale)} onPressOut={() => pressOut(scale)}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

function Poster({ uri, style, iconSize }: { uri?: string | null; style: any; iconSize: number }) {
  const resolved = resolveMediaUrl(uri);
  if (resolved) return <Image source={{ uri: resolved }} style={style} resizeMode="cover" />;
  return (
    <View style={[style, styles.posterFallback]}>
      <Ionicons name="film-outline" size={iconSize} color={colors.muted} />
    </View>
  );
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function buildPersonalityArchetype(taste: TasteProfile | null): PersonalityArchetype {
  if (!taste || (!taste.taste_labels.length && !taste.top_genres.length)) {
    return { name: "The Taste Architect", description: "Your entertainment identity is still forming. Every save and rating shapes the scene you're building.", icon: "🎬" };
  }
  const all = [...taste.taste_labels.map((l) => l.label.toLowerCase()), ...taste.top_genres.map((g) => g.genre.toLowerCase())].join(" ");
  if ((all.includes("drama") || all.includes("prestige")) && (all.includes("hbo") || all.includes("slow burn") || all.includes("psychological"))) {
    return { name: "The Emotional Masochist", description: "You consistently gravitate toward emotionally devastating prestige dramas, slow-burn thrillers, and character studies that leave psychic damage.", icon: "🎭" };
  }
  if (all.includes("horror")) return { name: "The Darkness Enjoyer", description: "You voluntarily put yourself through the worst possible scenarios, then immediately look for the next one. No notes.", icon: "🌑" };
  if (all.includes("crime") || all.includes("thriller")) return { name: "The Chaos Watcher", description: "Tension, moral ambiguity, and deeply questionable life decisions. You are clearly not here to relax — and you're better for it.", icon: "🔥" };
  if (all.includes("sci-fi") || all.includes("science fiction") || all.includes("fantasy")) return { name: "The Midnight Sci-Fi Brain", description: "Big ideas, broken timelines, and worlds that bend physics. You are in it for the existential unease.", icon: "🌌" };
  if (all.includes("comedy") || all.includes("sitcom")) return { name: "The Comfort Rewatcher", description: "Sharp writing, familiar worlds, and knowing exactly how it ends. This isn't laziness. This is a deeply refined viewing philosophy.", icon: "☕" };
  if (all.includes("documentary") || all.includes("true crime")) return { name: "The Reality Auditor", description: "You'd rather watch something that actually happened — ideally something that should not have happened — than any amount of fiction.", icon: "🔍" };
  return { name: "The Prestige Purist", description: "You have taste and you know it. Cinematography matters. Character development matters. Awards-bait is still bait, but you can tell the difference.", icon: "🏆" };
}

function computeAchievements(taste: TasteProfile | null): Achievement[] {
  if (!taste) return [];
  const genres = taste.top_genres.map((g) => g.genre.toLowerCase());
  const labels = taste.taste_labels.map((l) => l.label.toLowerCase());
  const platforms = taste.top_platforms.map((p) => p.toLowerCase());
  const all = [...genres, ...labels, ...taste.top_themes.map((t) => t.toLowerCase())].join(" ");

  return [
    {
      id: "prestige_elite",
      name: "Prestige Drama Elite",
      description: "Your taste gravitates toward the prestigious, the awarded, and the emotionally annihilating.",
      icon: "🏆",
      color: "#f4c430",
      unlocked: all.includes("drama") && (all.includes("prestige") || (taste.taste_labels[0]?.confidence ?? 0) >= 70),
    },
    {
      id: "chaos_agent",
      name: "Chaos Agent",
      description: "You actively seek out morally complex situations and protagonists making the worst possible decisions.",
      icon: "🔥",
      color: "#ff6b35",
      unlocked: all.includes("crime") || all.includes("thriller"),
    },
    {
      id: "hbo_loyalist",
      name: "HBO Loyalist",
      description: "Max, HBO, and the prestige pipeline have your full attention and presumably your bank account.",
      icon: "📺",
      color: "#5fa8ff",
      unlocked: platforms.some((p) => p.includes("hbo") || p.includes("max")),
    },
    {
      id: "night_owl",
      name: "The Night Owl",
      description: "Horror, psychological tension, and things that go catastrophically wrong after dark. You live here.",
      icon: "🦉",
      color: "#9456ff",
      unlocked: all.includes("horror") || all.includes("psychological"),
    },
    {
      id: "sci_oracle",
      name: "Sci-Fi Oracle",
      description: "You see the dystopia coming before everyone else. Big ideas and broken timelines live rent-free in your head.",
      icon: "🌌",
      color: colors.accent,
      unlocked: all.includes("sci-fi") || all.includes("science fiction") || all.includes("sci fi"),
    },
    {
      id: "comfort_king",
      name: "Comfort Rewatcher",
      description: "Some people watch for discovery. You watch for the return trip to places that feel like home.",
      icon: "☕",
      color: "#f4a430",
      unlocked: all.includes("comedy") || all.includes("sitcom") || all.includes("comfort"),
    },
    {
      id: "criterion_core",
      name: "Criterion-Core",
      description: "You have opinions about aspect ratios, theatrical releases, and restorations. You are correct.",
      icon: "🎞️",
      color: "#d0d0d0",
      unlocked: all.includes("foreign") || all.includes("independent") || all.includes("arthouse") || all.includes("classic"),
    },
    {
      id: "era_traveler",
      name: "Era Traveler",
      description: "Your taste doesn't care about release year. Classics and current releases share equal real estate.",
      icon: "⏳",
      color: "#86a8d0",
      unlocked: (taste.favorite_eras?.length ?? 0) >= 2,
    },
    {
      id: "depth_charge",
      name: "Taste Depth Charge",
      description: "Your profile has enough signal to generate recommendations that actually feel personal.",
      icon: "🧠",
      color: colors.accent,
      unlocked: taste.taste_labels.length >= 3 || taste.top_genres.length >= 4,
    },
    {
      id: "true_crime",
      name: "True Crime Archivist",
      description: "You have done extensive research into events you definitely should not know this much about.",
      icon: "🔍",
      color: "#ff4d4d",
      unlocked: all.includes("true crime") || (all.includes("documentary") && all.includes("crime")),
    },
  ];
}

function buildEraTimeline(taste: TasteProfile | null): EraEntry[] {
  // We only surface the CURRENT era — the historical entries were
  // fabricated with hardcoded "2 months ago" / "Last month" strings from
  // the user's top labels/genres, regardless of when those signals
  // actually formed. That violated the no-fake-data rule and caused
  // brand-new accounts to see an invented backstory ("2 months ago:
  // Crime Era"). Real historical eras will land once we start recording
  // taste-profile snapshots per week/month — until then, "right now" is
  // the honest answer.
  if (!taste) return [];
  const labels = taste.taste_labels;
  const genres = taste.top_genres;
  const currentEra = labels[0]?.label ?? (genres[0]?.genre ? `${genres[0].genre} Phase` : null);
  if (!currentEra) return [];
  return [{ era: currentEra, period: "Right now", isCurrent: true }];
}

function computeMatchScore(item: RecommendationItem, taste: TasteProfile | null): number {
  const topGenres = new Set((taste?.top_genres ?? []).slice(0, 4).map((g) => g.genre.toLowerCase()));
  const topThemes = new Set((taste?.top_themes ?? []).slice(0, 4).map((t) => t.toLowerCase()));
  const titleGenres = (item.title.genres ?? []).map((g) => g.toLowerCase());
  const genreHits = titleGenres.filter((g) => topGenres.has(g)).length;
  const themeHits = titleGenres.filter((g) => [...topThemes].some((t) => g.includes(t) || t.includes(g))).length;
  const idHash = item.title.id.split("").reduce((acc, c, i) => acc + c.charCodeAt(0) * (i + 1), 0);
  return Math.min(99, 72 + (idHash % 14) + Math.min(14, genreHits * 7 + themeHits * 4));
}

function buildHeroIntro(name?: string | null, taste?: TasteProfile | null) {
  if (taste?.taste_labels?.length) {
    if (name) return `${name}, this is your scene.`;
    const top = taste.taste_labels.slice(0, 2).map((l) => l.label.toLowerCase());
    return `This is your ${top.join(" and ")} era.`;
  }
  return name ? `${name}, this is your scene.` : HERO_FALLBACK[0];
}

function buildHeroSummary(taste?: TasteProfile | null) {
  if (taste?.profile_summary) {
    const platform = taste.top_platforms[0];
    return platform ? `${taste.profile_summary} Lately, ${platform} has clearly been part of the plan.` : taste.profile_summary;
  }
  const genres = taste?.top_genres.slice(0, 3).map((g) => g.genre) ?? [];
  const label = taste?.taste_labels[0]?.label;
  const theme = taste?.top_themes[0];
  if (label && genres.length > 0) {
    return `${label} with a ${genres[0].toLowerCase()} obsession and${theme ? ` a taste for ${theme.toLowerCase()} and` : ""} stories that know how to leave a mark.`;
  }
  if (genres.length > 0) return `Your scene is leaning into ${joinHumanList(genres.map((g) => g.toLowerCase()))}, with a soft spot for stories that know how to leave a mark.`;
  return HERO_FALLBACK[1];
}

function buildEraCopy(taste?: TasteProfile | null) {
  const leadLabel = taste?.taste_labels[0]?.label;
  const leadGenre = taste?.top_genres[0]?.genre;
  const leadPlatform = taste?.top_platforms[0];
  const theme = taste?.top_themes[0];
  if (leadLabel && leadPlatform) return { title: `${leadLabel} with a ${leadPlatform} habit`, body: `Right now you are leaning into ${leadLabel.toLowerCase()} picks, especially the kind with ${theme?.toLowerCase() ?? "real emotional tension"}.` };
  if (leadGenre) return { title: `Deep in your ${leadGenre.toLowerCase()} phase`, body: `The titles you save and revisit keep circling back to ${leadGenre.toLowerCase()} stories that feel a little richer, darker, or more obsessive than average.` };
  return { title: "Your taste is still taking shape", body: "A few more saves, rankings, and reactions will make this page feel even more personal." };
}

function buildSceneStats(taste: TasteProfile | null) {
  const genre = taste?.most_saved_genre ?? taste?.top_genres[0]?.genre ?? "—";
  const platform = taste?.top_platforms[0] ?? "—";
  const theme = taste?.top_themes[0] ?? taste?.top_genres[1]?.genre ?? "—";
  const topLabel = taste?.taste_labels[0];
  const tier = !topLabel ? "Building" : topLabel.confidence >= 80 ? "Elite" : topLabel.confidence >= 60 ? "Core" : "Deep Cut";
  return [
    { label: "Most saved genre", value: genre, body: "Your most consistently saved content category." },
    { label: "Home platform", value: platform, body: "Where most of your current taste lives." },
    { label: "Dominant theme", value: theme, body: "The recurring vibe in what you watch." },
    { label: "Taste tier", value: tier, body: "Based on depth and diversity of saves." },
  ];
}

function buildTonightHook(item: RecommendationItem, taste: TasteProfile) {
  const label = taste.taste_labels[0]?.label;
  const reason = item.reason.toLowerCase();
  if (label && reason.includes("thriller")) return `Your ${label.toLowerCase()} streak keeps pulling toward picks like this.`;
  if (label) return `Deep in your ${label.toLowerCase()} phase, this one keeps surfacing.`;
  return humanizeReason(item.reason);
}

function buildLabelCaption(label: string) {
  const lower = label.toLowerCase();
  if (lower.includes("drama")) return "You like your stories emotionally loaded and impossible to casually watch.";
  if (lower.includes("crime") || lower.includes("thriller")) return "You reliably fall for tension, danger, and deeply questionable decisions.";
  if (lower.includes("comedy")) return "You go back to sharp writing, comfort rewatches, and chaotic charm.";
  if (lower.includes("sci")) return "You like big ideas, eerie worlds, and stories that bend reality a little.";
  if (lower.includes("horror")) return "You are clearly not here for calm, emotionally regulated entertainment.";
  return "One of the strongest patterns shaping your taste right now.";
}

// Bucket rank + copy for each reason_type. Order controls rail order; picks-
// derived rails float to the top because brief §2 makes My Picks the primary
// signal. Copy shape follows brief §5 examples ("Because you keep saving…").
const REC_RAIL_ORDER: Record<string, { rank: number; title: (evidence?: string[], traits?: string[]) => string; subtitle: string }> = {
  PICKS_SCENEDNA_OVERLAP: {
    rank: 0,
    title: (ev) => (ev && ev.length ? `Because ${ev.slice(0, 2).join(" + ")} agree with your SceneDNA` : "Because your saves + SceneDNA agree"),
    subtitle: "Both signals line up here — highest confidence.",
  },
  PICKS_CLUSTER: {
    rank: 1,
    title: (ev, traits) => {
      const trait = traits?.[0]?.toLowerCase();
      return trait ? `Because you keep saving ${trait}` : "Because your saves have a pattern";
    },
    subtitle: "A trait shared across multiple things you've saved.",
  },
  PICKS_SIMILARITY: {
    rank: 2,
    title: (ev) => (ev && ev.length ? `Because you saved ${ev[0]}` : "Because you saved something like this"),
    subtitle: "Direct match to a title on your shelf.",
  },
  SCENEDNA_MATCH: {
    rank: 3,
    title: (_ev, traits) => (traits && traits.length ? `Because your SceneDNA leans ${traits[0].toLowerCase()}` : "Because your SceneDNA points here"),
    subtitle: "Grounded in your taste profile.",
  },
  WATCH_TEAM: {
    rank: 4,
    title: (ev) => (ev && ev.length ? `Because your Watch Team saved ${ev[0]}` : "Because your Watch Team is here"),
    subtitle: "Shared taste with people you watch with.",
  },
  CREATOR_AFFINITY: {
    rank: 5,
    title: (ev) => (ev && ev.length ? `Because you follow the ${ev[0]} team` : "Because you follow this creative team"),
    subtitle: "Same eye, different worlds.",
  },
  HIDDEN_GEM: {
    rank: 6,
    title: () => "Hidden gems in your lane",
    subtitle: "Under-the-radar picks that shouldn't be.",
  },
  TASTE_NEIGHBORS: {
    rank: 7,
    title: () => "People with your taste are here",
    subtitle: "Collaborative discovery, not similarity math.",
  },
  TRENDING_PERSONALIZED: {
    rank: 8,
    title: () => "Trending — but for you",
    subtitle: "What the crowd is watching, filtered by your DNA.",
  },
  SERENDIPITY: {
    rank: 9,
    title: () => "A little outside your usual lane",
    subtitle: "Hear us out — worth the detour.",
  },
  NEW_RELEASE_MATCH: {
    rank: 10,
    title: () => "New releases in your taste",
    subtitle: "Just landed and match your signals.",
  },
};

function groupRecommendations(items: RecommendationItem[], fallbackItems: RecommendationItem[] = []) {
  // Dedupe across primary + fallback, preserving first-seen order.
  const seen = new Set<string>();
  const merged: RecommendationItem[] = [];
  for (const item of [...items, ...fallbackItems]) {
    if (!seen.has(item.title.id)) {
      seen.add(item.title.id);
      merged.push(item);
    }
  }
  if (!merged.length) return [];

  // Brief §5 — group by reason_type so each rail carries a "because…" header
  // mapped back to the specific DNA signal that generated it. If the backend
  // hasn't tagged a reason_type (older seed data), fall back to a single
  // generic rail so the surface never breaks.
  const buckets = new Map<string, RecommendationItem[]>();
  for (const item of merged) {
    const key = item.reason_type ?? "GENERIC";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(item);
  }

  const rails: { title: string; subtitle: string; items: RecommendationItem[] }[] = [];
  for (const [reasonType, bucketItems] of buckets) {
    const config = REC_RAIL_ORDER[reasonType];
    if (config) {
      // Use the first item's evidence to fill the {title} slot in the header
      // template — keeps the reason concrete, not templated jargon.
      const firstEvidence = bucketItems[0]?.evidence?.contributing_titles ?? [];
      const firstTraits = bucketItems[0]?.evidence?.contributing_traits ?? [];
      rails.push({
        title: config.title(firstEvidence, firstTraits),
        subtitle: config.subtitle,
        items: bucketItems.slice(0, 8),
      });
    } else {
      rails.push({
        title: reasonType === "GENERIC" ? "Your Scene Picks" : reasonType,
        subtitle: "Matched to your taste identity.",
        items: bucketItems.slice(0, 8),
      });
    }
  }

  // Order rails by rank; unknown types fall to the bottom.
  return rails.sort((a, b) => {
    const aType = merged.find((m) => m.title.title === a.items[0]?.title.title)?.reason_type ?? "GENERIC";
    const bType = merged.find((m) => m.title.title === b.items[0]?.title.title)?.reason_type ?? "GENERIC";
    return (REC_RAIL_ORDER[aType]?.rank ?? 99) - (REC_RAIL_ORDER[bType]?.rank ?? 99);
  });
}

function humanizeReason(reason: string) {
  const normalized = reason.replace(/^because\s+/i, "");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildRecommendationMeta(item: RecommendationItem) {
  const genres = item.title.genres?.slice(0, 3) ?? [];
  return genres.length > 0 ? genres.join(" / ") : item.title.content_type;
}

function buildPulseHeadline(team?: TeamSummary | null, analytics?: TeamAnalytics | null) {
  if (!team) return "Your circle has not started making noise yet.";
  const aligned = analytics?.most_aligned_members?.summary;
  if (aligned) return aligned;
  const loved = analytics?.most_loved_title?.title_name;
  const divisive = analytics?.most_divisive_title?.title_name;
  if (loved && divisive) return `${team.name} is rallying around ${loved}, while ${divisive} is doing its best to start arguments.`;
  return `${team.name} is still warming up, but the group taste is starting to come into focus.`;
}

function joinHumanList(items: string[]) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },

  // Hero — editorial masthead
  hero: {
    minHeight: 380,
    borderRadius: radii.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.backgroundElevated,
  },
  heroPosterColumn: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 96,
    gap: 2,
    overflow: "hidden",
  },
  heroPosterThumb: {
    width: 96,
    height: 192,
    opacity: 0.28,
  },
  heroPosterThumbOffset: {
    marginTop: 2,
  },
  heroPosterFade: {
    position: "absolute",
    inset: 0,
    // Fade from left (opaque background) to transparent on the right
    // React Native doesn't support CSS gradients directly, use a simple semi-transparent overlay
    backgroundColor: colors.backgroundElevated,
    opacity: 0.72,
  },
  heroCopy: { padding: spacing.xl, gap: spacing.md, justifyContent: "flex-end", minHeight: 380, zIndex: 1 },
  logo: { width: 110, height: 30, marginBottom: 4 },
  heroTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroKicker: {
    color: colors.accent,
    textTransform: "uppercase",
    letterSpacing: 2,
    fontSize: 11,
    fontFamily: fonts.monoMedium,
  },
  heroLiveTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroLiveDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  heroLiveText: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 0.4,
  },
  heroRule: {
    height: 1,
    backgroundColor: rules.default,
    marginVertical: 4,
  },
  heroTitle: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 38,
    fontFamily: fonts.serifBold,
    maxWidth: "86%",
  },
  // SceneDNA compact identity hero — brief §4. Replaces the giant persistent
  // artwork + poster stack that used to swallow the top of the screen.
  identityCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  identityMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  identityKicker: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  identityConfidencePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "transparent",
  },
  identityConfidencePillStrong: {
    borderColor: "rgba(74,222,128,0.45)",
    backgroundColor: "rgba(74,222,128,0.10)",
  },
  identityConfidencePillEmerging: {
    borderColor: "rgba(244,196,48,0.45)",
    backgroundColor: "rgba(244,196,48,0.10)",
  },
  identityConfidencePillEarly: {
    borderColor: colors.border,
    backgroundColor: "transparent",
  },
  identityConfidenceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  identityConfidenceText: {
    color: colors.ink,
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  identityArchetype: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.5,
    marginTop: 4,
  },
  identityOneLine: {
    color: colors.muted,
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 15,
    lineHeight: 22,
  },
  identityBasedOn: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.4,
    marginTop: 4,
  },
  // Signals grid — brief §3 layer 2 compact evidence-first cards.
  signalGrid: { gap: 10 },
  signalCard: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 8,
  },
  signalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  signalLabel: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 15,
    letterSpacing: -0.2,
    flex: 1,
  },
  signalTier: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  signalTierStrong: {
    color: "#7dd3a3",
    borderColor: "rgba(74,222,128,0.45)",
    backgroundColor: "rgba(74,222,128,0.10)",
  },
  signalTierEmerging: {
    color: colors.accent,
    borderColor: "rgba(244,196,48,0.45)",
    backgroundColor: "rgba(244,196,48,0.10)",
  },
  signalTierEarly: {
    color: colors.muted,
  },
  signalEvidence: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
  },
  signalPosterRow: { flexDirection: "row", gap: 6, marginTop: 4 },
  signalPoster: {
    width: 40,
    height: 56,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: colors.background,
  },
  // Taste Shift — brief §3 layer 3.
  movementList: { gap: 12 },
  movementRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  movementArrow: {
    fontSize: 20,
    fontFamily: fonts.serifBold,
    color: colors.muted,
    lineHeight: 22,
    minWidth: 22,
  },
  movementArrowUp: { color: "#7dd3a3" },
  movementArrowDown: { color: colors.muted },
  movementLabel: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 17,
    letterSpacing: -0.2,
  },
  movementDetail: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2,
  },
  // Deep Dive collapsible toggle.
  deepDiveToggle: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted ?? colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  deepDiveKicker: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  deepDiveLabel: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
  },
  // Cold-start meter — brief §8. Meaningful behaviors only.
  coldStartMeters: { gap: 10, marginTop: spacing.sm },
  coldStartMeter: { gap: 6 },
  coldStartMeterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  coldStartMeterLabel: {
    color: colors.ink,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  coldStartMeterCount: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  coldStartMeterCountDone: {
    color: "#7dd3a3",
  },
  coldStartMeterTrack: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  coldStartMeterFill: {
    height: 6,
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  coldStartMeterFillDone: {
    backgroundColor: "#7dd3a3",
  },
  // Signal evidence drawer — brief §7.
  signalDrawerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(4,8,14,0.72)",
    justifyContent: "flex-end",
  },
  signalDrawerSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  signalDrawerHeader: { gap: 4 },
  signalDrawerKicker: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  signalDrawerLabel: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 26,
    letterSpacing: -0.4,
  },
  signalDrawerBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  signalDrawerEvidenceRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  signalDrawerEvidenceItem: { flex: 1, gap: 6 },
  signalDrawerEvidencePoster: {
    aspectRatio: 2 / 3,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  signalDrawerEvidenceTitle: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 11,
    lineHeight: 15,
  },
  signalDrawerActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: spacing.sm,
  },
  signalDrawerAction: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 999,
  },
  signalDrawerActionSecondary: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  signalDrawerActionText: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
  },
  signalDrawerClose: {
    alignItems: "center",
    paddingVertical: 10,
  },
  signalDrawerCloseText: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  signalDrawerSectionLabel: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  signalDrawerNegativeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  signalDrawerNegativeChip: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    maxWidth: 220,
  },
  signalDrawerExploreRow: { gap: 10, paddingRight: spacing.md },
  signalDrawerExploreCard: {
    width: 90,
    gap: 6,
  },
  signalDrawerExplorePoster: {
    width: 90,
    aspectRatio: 2 / 3,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  signalDrawerExploreTitle: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 11,
    lineHeight: 15,
  },
  // Container for the Scene DNA personalization strip that sits directly under
  // the SSCinematicHeader. Provides the vertical rhythm for poster row + live tag
  // + signal chips + CTA.
  dnaSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  dnaPosterRow: {
    alignItems: "flex-start",
    marginBottom: spacing.sm,
  },
  heroSignalRow: { gap: 10, marginTop: 4 },
  heroSignalItem: { flexDirection: "row", alignItems: "center", gap: 10 },
  heroSignalIndex: {
    color: colors.accent,
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 0.8,
    minWidth: 22,
  },
  heroSignalText: {
    color: colors.ink,
    fontSize: 13,
    fontFamily: fonts.sansSemiBold,
  },

  // Editorial loading state
  loadingState: {
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  loadingIndex: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
  loadingRule: { height: 1, backgroundColor: rules.default },
  loadingHeading: {
    color: colors.ink,
    fontSize: 26,
    lineHeight: 32,
    fontFamily: fonts.serif,
  },
  loadingBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.sans,
  },

  // Low-signal editorial state
  lowSignalState: {
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: rules.default,
  },
  lowSignalIndex: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
  lowSignalRule: { height: 1, backgroundColor: rules.default },
  lowSignalHeading: {
    color: colors.ink,
    fontSize: 30,
    lineHeight: 36,
    fontFamily: fonts.serifBold,
  },
  lowSignalBody: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
    maxWidth: "88%",
  },
  lowSignalCta: {
    marginTop: spacing.xs,
    alignSelf: "flex-start",
  },
  lowSignalCtaText: {
    color: colors.accent,
    fontSize: 14,
    fontFamily: fonts.sansSemiBold,
    letterSpacing: 0.3,
  },

  error: { color: colors.danger, fontSize: 13, lineHeight: 18, fontFamily: fonts.sans },

  // Chapter sections
  section: { gap: spacing.md },
  chapterHeader: { gap: 6 },
  chapterIndex: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
  chapterRule: {
    height: 1,
    backgroundColor: rules.default,
    marginBottom: 4,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 22,
    lineHeight: 28,
    fontFamily: fonts.serifBold,
  },
  sectionSubtitle: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.sans,
    maxWidth: "92%",
  },

  // Stat list — editorial rows
  statList: { gap: 0 },
  statRow: { gap: 0 },
  statRuleBar: { height: 1, backgroundColor: rules.default },
  statInner: { paddingVertical: spacing.md, gap: 4 },
  statLabel: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  statValue: {
    color: colors.ink,
    fontSize: 28,
    lineHeight: 32,
    fontFamily: fonts.serifBold,
  },
  statBody: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: fonts.sans,
  },

  // Genre breakdown — mono text with hairline bars
  genreList: { gap: spacing.sm },
  genreRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  genreName: {
    color: colors.ink,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    width: 110,
  },
  genreBarTrack: {
    flex: 1,
    height: 1,
    backgroundColor: rules.default,
  },
  genreBarFill: {
    height: 1,
    backgroundColor: colors.accent,
  },
  genrePct: {
    color: colors.muted2,
    fontSize: 11,
    fontFamily: fonts.mono,
    width: 34,
    textAlign: "right",
  },

  // Era card — flat surface, no glass
  eraCard: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: rules.default,
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  eraIndex: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
  eraRule: { height: 1, backgroundColor: rules.gold, marginBottom: 4 },
  eraEyebrow: {
    color: colors.accent,
    fontSize: 11,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1.4,
  },
  eraTitle: {
    color: colors.ink,
    fontSize: 26,
    lineHeight: 31,
    fontFamily: fonts.serifBold,
  },
  eraBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.sans,
  },

  // Era Timeline — flat cards, gold tick for current
  eraTimelineRow: { gap: 0, paddingRight: spacing.sm, alignItems: "stretch" },
  eraTimelineEntryWrap: { flexDirection: "row", alignItems: "center" },
  eraTimelineConnector: { paddingHorizontal: 4 },
  eraTimelineConnectorLine: { width: 16, height: 1, backgroundColor: rules.default },
  eraTimelineCard: {
    width: 140,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    gap: 8,
    minHeight: 96,
    justifyContent: "flex-end",
    borderRadius: radii.sm,
  },
  eraTimelineCardCurrent: {
    width: 172,
    backgroundColor: colors.backgroundElevated,
    borderColor: rules.gold,
  },
  eraTimelinePeriod: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1.1,
  },
  eraTimelinePeriodCurrent: { color: colors.accent },
  eraTimelineGoldTick: {
    width: 20,
    height: 2,
    backgroundColor: colors.accent,
    borderRadius: 1,
  },
  eraTimelineName: {
    color: colors.muted,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    lineHeight: 18,
  },
  eraTimelineNameCurrent: {
    color: colors.ink,
    fontSize: 15,
    fontFamily: fonts.sansSemiBold,
    lineHeight: 20,
  },

  // Taste Identity — chapter row list
  identityList: { gap: 0 },
  identityRow: { paddingVertical: spacing.md, gap: 6 },
  identityRowTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  identityRowIndex: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    minWidth: 22,
  },
  identityRowRule: { flex: 1, height: 1, backgroundColor: rules.default },
  identityRowConf: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.mono,
  },
  identityGoldTick: {
    color: colors.accent,
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  identityRowLabel: {
    color: colors.ink,
    fontSize: 24,
    lineHeight: 29,
    fontFamily: fonts.serifBold,
  },
  identityRowCaption: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.sans,
  },

  // Viewing Personality
  personalityCard: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: rules.default,
    paddingVertical: spacing.xl,
    flexDirection: "row",
    gap: spacing.lg,
    alignItems: "flex-start",
  },
  personalityIcon: { fontSize: 28, marginTop: 4 },
  personalityMeta: { flex: 1, gap: 6 },
  personalityEyebrow: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  personalityName: {
    color: colors.ink,
    fontSize: 22,
    lineHeight: 27,
    fontFamily: fonts.serifBold,
  },
  personalityDescription: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.sans,
  },

  // Taste Achievements
  achievementRow: { gap: spacing.md, paddingRight: spacing.sm },
  achievementCard: {
    width: 148,
    padding: spacing.md,
    borderTopWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    gap: 8,
    borderRadius: radii.sm,
  },
  achievementCardLocked: { opacity: 0.38 },
  achievementIcon: { fontSize: 20 },
  achievementRuleBar: { height: 1, backgroundColor: rules.default },
  achievementName: {
    color: colors.ink,
    fontSize: 13,
    fontFamily: fonts.sansSemiBold,
    lineHeight: 17,
  },
  achievementDesc: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: fonts.sans,
  },
  achievementStatus: {
    color: colors.muted2,
    fontSize: 9,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 2,
  },
  achievementStatusUnlocked: { color: colors.accent },

  // Tonight's Mood Picker
  moodSection: { gap: spacing.sm },
  moodLabel: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  moodRow: { gap: spacing.sm, paddingRight: spacing.sm },
  moodChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  moodChipActive: {
    borderBottomColor: colors.accent,
  },
  moodChipText: {
    color: colors.muted,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
  },
  moodChipTextActive: {
    color: colors.accent,
    fontFamily: fonts.sansSemiBold,
  },

  // Tonight's Pick
  tonightCard: {
    height: 320,
    borderRadius: radii.lg,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  tonightShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(5,8,14,0.76)" },
  tonightContent: { position: "absolute", left: 0, right: 0, bottom: 0, padding: spacing.lg, gap: spacing.sm },
  tonightHook: {
    color: colors.accent,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  tonightRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.md },
  tonightPoster: {
    width: 80,
    height: 116,
    borderRadius: radii.sm,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
  },
  tonightPosterFallback: { alignItems: "center", justifyContent: "center" },
  tonightMeta: { flex: 1, gap: 6 },
  tonightTitle: {
    color: colors.ink,
    fontSize: 24,
    lineHeight: 29,
    fontFamily: fonts.serifBold,
  },
  tonightGenres: {
    color: colors.muted2,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 0.3,
  },
  tonightReason: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: fonts.sans,
  },
  tonightActions: { flexDirection: "row", gap: spacing.sm, marginTop: 4 },
  tonightPrimary: {
    flex: 1,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  tonightPrimaryText: {
    color: colors.background,
    fontSize: 13,
    fontFamily: fonts.sansBold,
  },
  tonightSave: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: rules.default,
  },

  // Obsessions
  horizontalRow: { gap: spacing.md, paddingRight: spacing.sm },
  obsessionCard: {
    width: 144,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: rules.default,
  },
  obsessionPoster: { width: "100%", height: 210, backgroundColor: colors.backgroundElevated },
  obsessionCopy: { padding: spacing.md, gap: 6 },
  obsessionTag: {
    color: colors.accent,
    fontSize: 9,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  obsessionTitle: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 19,
    fontFamily: fonts.sansSemiBold,
  },

  // Match Badge — flat mono text, no pill
  matchBadge: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: "row",
    alignItems: "baseline",
    backgroundColor: "rgba(7,11,18,0.82)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
  },
  matchScore: { fontSize: 12, fontFamily: fonts.monoMedium },
  matchLabel: { fontSize: 10, fontFamily: fonts.mono },

  // Recommendations
  recommendationSectionList: { gap: spacing.lg },
  recommendationGroup: { gap: spacing.sm },
  recommendationGroupHeader: { gap: 4 },
  recommendationGroupTitle: {
    color: colors.ink,
    fontSize: 16,
    fontFamily: fonts.sansSemiBold,
  },
  recommendationGroupSubtitle: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: fonts.sans,
  },
  recommendationRow: { gap: spacing.md, paddingRight: spacing.sm },
  recommendationCard: {
    width: 220,
    borderRadius: radii.sm,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  recommendationPoster: { width: "100%", height: 300, backgroundColor: colors.backgroundElevated },
  recommendationOverlay: { padding: spacing.md, gap: 5 },
  recommendationReason: {
    color: colors.accent,
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 0.4,
  },
  recommendationTitle: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 20,
    fontFamily: fonts.sansSemiBold,
  },
  recommendationMeta: {
    color: colors.muted2,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 0.2,
  },
  saveButton: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    padding: 9,
    borderRadius: radii.sm,
    backgroundColor: "rgba(7,11,18,0.72)",
    borderWidth: 1,
    borderColor: rules.default,
  },

  // Teams
  teamCard: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: rules.default,
    paddingVertical: spacing.xl,
    gap: spacing.md,
  },
  teamTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md },
  teamHeading: { flex: 1, gap: 4 },
  teamName: {
    color: colors.ink,
    fontSize: 20,
    fontFamily: fonts.serifBold,
  },
  teamMeta: {
    color: colors.muted2,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  compatibilityBlock: { alignItems: "flex-end", gap: 2 },
  compatibilityValue: {
    color: colors.accent,
    fontSize: 28,
    fontFamily: fonts.serifBold,
    lineHeight: 32,
  },
  compatibilityLabel: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  teamRule: { height: 1, backgroundColor: rules.default },
  teamHeadline: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.sans,
  },
  teamInsightGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  miniInsight: {
    width: "48%",
    borderTopWidth: 1,
    borderTopColor: rules.default,
    paddingTop: spacing.sm,
    gap: 4,
  },
  miniInsightLabel: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  miniInsightRule: { height: 1, backgroundColor: rules.default, marginVertical: 2 },
  miniInsightValue: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 19,
    fontFamily: fonts.sansMedium,
  },

  posterFallback: { alignItems: "center", justifyContent: "center" },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.sans,
  },
  emptySubText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: fonts.sans,
    marginTop: 6,
  },
  moodEmptyState: {
    paddingVertical: spacing.md,
    gap: 4,
  },
  emptyCta: {
    alignSelf: "flex-start",
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyCtaText: {
    color: colors.ink,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },

  // Hot Takes
  hotTakesList: { gap: 0 },
  hotTakeRow: { paddingVertical: spacing.md, gap: 6 },
  hotTakeRowTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  hotTakeType: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  hotTakeRuleInline: { flex: 1, height: 1, backgroundColor: rules.default },
  hotTakeStrength: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  hotTakeStatement: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },

  // Taste Evolution
  evolutionList: { gap: spacing.md },
  evolutionRow: { gap: 8 },
  evolutionLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  evolutionGenre: {
    color: colors.ink,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
  },
  evolutionDeltaWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
  evolutionTick: { fontSize: 9, fontFamily: fonts.mono },
  evolutionDelta: { fontSize: 12, fontFamily: fonts.monoMedium },
  evolutionBarTrack: { height: 1, backgroundColor: rules.default },
  evolutionBarFill: { height: 1 },
  evolutionFootnote: {
    color: colors.muted2,
    fontSize: 10,
    marginTop: spacing.sm,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },

  // Taste Alignment
  alignmentRow: { gap: spacing.md, paddingBottom: 4 },
  alignmentCard: {
    width: 100,
    alignItems: "center",
    gap: 6,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: rules.default,
  },
  alignmentScore: {
    fontSize: 12,
    fontFamily: fonts.monoMedium,
  },
  alignmentName: {
    color: colors.ink,
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    textAlign: "center",
  },
  alignmentSharedLabel: {
    color: colors.muted2,
    fontSize: 10,
    fontFamily: fonts.mono,
    textAlign: "center",
    lineHeight: 14,
  },
});
