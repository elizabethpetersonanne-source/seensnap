import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { GoldButton } from "@/components/gold-button";
import { PosterMosaic } from "@/components/poster-mosaic";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, radii, spacing } from "@/constants/theme";

type TrendingTitle = {
  id: string;
  title: string;
  content_type: string;
  poster_url?: string | null;
  backdrop_url?: string | null;
  genres: string[];
  tmdb_rating?: number | null;
};

type Team = {
  id: string;
  name: string;
  member_count?: number;
};

type EmotionType = "Devastation" | "Shock" | "Obsession" | "Chaos" | "Fear" | "Comfort";

const EMOTION_META: Record<EmotionType, { emoji: string; color: string }> = {
  Devastation: { emoji: "😭", color: "#B06FFF" },
  Shock:       { emoji: "🤯", color: "#FF8C00" },
  Obsession:   { emoji: "🔁", color: "#FFD21F" },
  Chaos:       { emoji: "🔥", color: "#FF4040" },
  Fear:        { emoji: "😨", color: "#40C8A0" },
  Comfort:     { emoji: "☁️",  color: "#70AAFF" },
};

const TICKER_ITEMS = [
  "Severance discourse spikes 312% after finale",
  "People are emotionally destroyed by Aftersun",
  "Psychological thrillers surge across SeenSnap",
  "Industry becomes a prestige obsession",
  "Twin Peaks rewatch culture intensifies",
  "Succession finale still dominating the discourse",
  "A24 horror is winning every Watch Team tonight",
  "The Bear kitchen scene is going viral again",
  "Poor Things becomes the most-saved film this month",
  "Saltburn divides the internet for the third time",
  "The Leftovers is the most underrated show ever made",
  "Past Lives is making everyone cry on public transit",
] as const;

const TREND_CLUSTERS = [
  {
    id: "tc_prestige",
    genre: "Drama",
    label: "Prestige TV Surge",
    description: "HBO-coded drama at cultural peak",
    activityLabel: "Exploding",
    activityCount: "247 active",
  },
  {
    id: "tc_psych",
    genre: "Thriller",
    label: "Psychological Thriller Wave",
    description: "Paranoia is the aesthetic of the moment",
    activityLabel: "Rising Fast",
    activityCount: "183 active",
  },
  {
    id: "tc_horror",
    genre: "Horror",
    label: "Horror Renaissance",
    description: "Elevated horror is dominating everything",
    activityLabel: "Trending",
    activityCount: "312 active",
  },
  {
    id: "tc_damage",
    genre: "Drama",
    label: "Emotional Damage Cinema",
    description: "Films designed to leave a lasting mark",
    activityLabel: "Spiking",
    activityCount: "156 active",
  },
  {
    id: "tc_rich",
    genre: "Crime",
    label: "Rich People Behaving Horribly",
    description: "Prestige dysfunction as its own genre",
    activityLabel: "Rising",
    activityCount: "201 active",
  },
  {
    id: "tc_scifi",
    genre: "Science Fiction",
    label: "Existential Sci-Fi",
    description: "The kind that makes you question everything",
    activityLabel: "Building",
    activityCount: "128 active",
  },
  {
    id: "tc_tiktok",
    genre: "Romance",
    label: "TikTok Rediscoveries",
    description: "Films going viral for the second time",
    activityLabel: "Viral",
    activityCount: "389 active",
  },
  {
    id: "tc_a24",
    genre: "Horror",
    label: "A24 Emotional Warfare",
    description: "Beautiful and devastating, simultaneously",
    activityLabel: "Exploding",
    activityCount: "276 active",
  },
];

type SocialSignal = {
  id: string;
  label: string;
  titleName: string;
  posterUrl: string;
  reaction: string;
  emotion: EmotionType;
  divisive?: boolean;
  trendSource?: string;
};

const SOCIAL_SIGNALS: SocialSignal[] = [
  {
    id: "ss_bear",
    label: "Most Emotionally Devastating",
    titleName: "The Bear",
    posterUrl: "https://image.tmdb.org/t/p/w500/eKfVzzEazSIjJMrw9ADa2x8ksLz.jpg",
    reaction: "That kitchen scene destroyed everyone in the room.",
    emotion: "Devastation",
    trendSource: "SeenSnap",
  },
  {
    id: "ss_succession",
    label: "Everyone's Posting About This",
    titleName: "Succession",
    posterUrl: "https://image.tmdb.org/t/p/w500/z0XiwdrCQ9yVIr4O0pxzaAYRxdW.jpg",
    reaction: "The discourse hasn't stopped since the finale aired.",
    emotion: "Obsession",
    trendSource: "Film Twitter",
  },
  {
    id: "ss_saltburn",
    label: "Most Divisive Movie This Week",
    titleName: "Saltburn",
    posterUrl: "https://image.tmdb.org/t/p/w500/qjhahNLSZ705B5JP92YMEYPocPz.jpg",
    reaction: "Half the internet loved it. Half walked out.",
    emotion: "Chaos",
    divisive: true,
    trendSource: "Watch Teams",
  },
  {
    id: "ss_aftersun",
    label: "TikTok Rediscovery",
    titleName: "Aftersun",
    posterUrl: "https://image.tmdb.org/t/p/w500/3o9IVM4aDaCX4PcPbfIRbfQGqGG.jpg",
    reaction: "A new wave of people discovering this and immediately crying.",
    emotion: "Devastation",
    trendSource: "TikTok",
  },
  {
    id: "ss_leftovers",
    label: "Prestige Drama Fans Are Obsessed",
    titleName: "The Leftovers",
    posterUrl: "https://image.tmdb.org/t/p/w500/rJ59VxEYqFWCjqHpRxrGNQRsqRm.jpg",
    reaction: "Every week more people find this show and lose it.",
    emotion: "Obsession",
    trendSource: "SeenSnap",
  },
  {
    id: "ss_midsommar",
    label: "Watch Teams Cannot Agree",
    titleName: "Midsommar",
    posterUrl: "https://image.tmdb.org/t/p/w500/7LEI8ulZzO5gy9Ww2NVCrKmHeDZ.jpg",
    reaction: "Is it a horror film or a breakup film? Watch Teams are split.",
    emotion: "Fear",
    divisive: true,
    trendSource: "Watch Teams",
  },
  {
    id: "ss_past_lives",
    label: "Film Twitter Rediscovered This",
    titleName: "Past Lives",
    posterUrl: "https://image.tmdb.org/t/p/w500/k3waqVXSnvCZWfJYNtdamTgTtTA.jpg",
    reaction: "The ending is living rent-free in everyone's head.",
    emotion: "Devastation",
    trendSource: "Film Twitter",
  },
];

type CulturalMoment = {
  id: string;
  label: string;
  sublabel: string;
  titleName: string;
  posterUrl: string;
};

const CULTURAL_MOMENTS: CulturalMoment[] = [
  { id: "cm_oscar",     label: "Oscar Momentum",       sublabel: "Awards Circuit",   titleName: "Past Lives",           posterUrl: "https://image.tmdb.org/t/p/w500/k3waqVXSnvCZWfJYNtdamTgTtTA.jpg" },
  { id: "cm_sundance",  label: "Sundance Buzz",         sublabel: "Festival Circuit", titleName: "Aftersun",             posterUrl: "https://image.tmdb.org/t/p/w500/3o9IVM4aDaCX4PcPbfIRbfQGqGG.jpg" },
  { id: "cm_hbo",       label: "HBO Sunday Energy",     sublabel: "Right Now",        titleName: "The Leftovers",        posterUrl: "https://image.tmdb.org/t/p/w500/rJ59VxEYqFWCjqHpRxrGNQRsqRm.jpg" },
  { id: "cm_tiktok",    label: "TikTok Rediscovery",    sublabel: "Going Viral",      titleName: "Saltburn",             posterUrl: "https://image.tmdb.org/t/p/w500/qjhahNLSZ705B5JP92YMEYPocPz.jpg" },
  { id: "cm_critics",   label: "Critics' Darling",      sublabel: "Awards Season",    titleName: "Poor Things",          posterUrl: "https://image.tmdb.org/t/p/w500/kCGlIMHnOm8JPXq3rXM6c5wMxcT.jpg" },
  { id: "cm_netflix",   label: "Netflix Spike",         sublabel: "Surging Now",      titleName: "Mindhunter",           posterUrl: "https://image.tmdb.org/t/p/w500/ah19M0nQJ6fdrH3oQjAriRbBCvN.jpg" },
  { id: "cm_horror",    label: "Horror Season Wave",    sublabel: "Seasonal",         titleName: "Midsommar",            posterUrl: "https://image.tmdb.org/t/p/w500/7LEI8ulZzO5gy9Ww2NVCrKmHeDZ.jpg" },
  { id: "cm_rewatch",   label: "Rewatch Culture",       sublabel: "Internet Obsession", titleName: "Severance",          posterUrl: "https://image.tmdb.org/t/p/w500/H1VjAFzGPaUbcSQXSZVWLEFvCL.jpg" },
];

function FallbackImage({
  uri,
  style,
  resizeMode = "cover",
}: {
  uri: string;
  style: any;
  resizeMode?: "cover" | "contain" | "stretch" | "center";
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <View style={[style, { backgroundColor: colors.backgroundElevated }]} />;
  return (
    <Image source={{ uri }} style={style} resizeMode={resizeMode} onError={() => setFailed(true)} />
  );
}

function EmotionPill({ emotion }: { emotion: EmotionType }) {
  const meta = EMOTION_META[emotion];
  return (
    <View style={[styles.emotionPill, { borderColor: meta.color + "55" }]}>
      <Text style={[styles.emotionText, { color: meta.color }]}>
        {meta.emoji} {emotion}
      </Text>
    </View>
  );
}

type TrendCluster = (typeof TREND_CLUSTERS)[number];

export default function SignalScreen() {
  const router = useRouter();
  const { sessionToken } = useAuth();
  const [trending, setTrending] = useState<TrendingTitle[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedCluster, setSelectedCluster] = useState<TrendCluster | null>(null);

  const [tickerIdx, setTickerIdx] = useState(0);
  const tickerFade = useRef(new Animated.Value(1)).current;
  const tickerSlide = useRef(new Animated.Value(0)).current;
  const pulseDot = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const dot = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseDot, { toValue: 1.7, duration: 650, useNativeDriver: true }),
        Animated.timing(pulseDot, { toValue: 1, duration: 650, useNativeDriver: true }),
      ])
    );
    dot.start();
    return () => dot.stop();
  }, [pulseDot]);

  useEffect(() => {
    const timer = setInterval(() => {
      Animated.parallel([
        Animated.timing(tickerFade, { toValue: 0, duration: 260, useNativeDriver: true }),
        Animated.timing(tickerSlide, { toValue: -8, duration: 260, useNativeDriver: true }),
      ]).start(() => {
        setTickerIdx((prev) => (prev + 1) % TICKER_ITEMS.length);
        tickerSlide.setValue(10);
        Animated.parallel([
          Animated.timing(tickerFade, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(tickerSlide, { toValue: 0, duration: 320, useNativeDriver: true }),
        ]).start();
      });
    }, 3800);
    return () => clearInterval(timer);
  }, [tickerFade, tickerSlide]);

  const fetchData = useCallback(async () => {
    if (!sessionToken) return;
    try {
      const titles = await apiRequest<TrendingTitle[]>("/titles/trending?limit=24", { token: sessionToken });
      setTrending(titles);
    } catch {
      // keep empty on error
    }
    try {
      const teamList = await apiRequest<Team[]>("/teams", { token: sessionToken });
      setTeams(teamList.slice(0, 4));
    } catch {
      // keep empty on error
    }
  }, [sessionToken]);

  useFocusEffect(
    useCallback(() => {
      void fetchData();
    }, [fetchData])
  );

  const heroPosters = useMemo(
    () =>
      trending
        .slice(0, 4)
        .map((t) => resolveMediaUrl(t.backdrop_url ?? t.poster_url ?? null) ?? "")
        .filter(Boolean),
    [trending]
  );

  const clusterPosters = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const cluster of TREND_CLUSTERS) {
      const matched = trending
        .filter((t) => t.genres.some((g) => g.toLowerCase().includes(cluster.genre.toLowerCase())))
        .slice(0, 3)
        .map((t) => resolveMediaUrl(t.poster_url ?? null) ?? "")
        .filter(Boolean);
      result[cluster.id] = matched;
    }
    return result;
  }, [trending]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.pageGlow} />
      <View style={styles.pageGlowLeft} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* ── Cinematic Hero with Ticker ── */}
        <View style={styles.hero}>
          <PosterMosaic uris={heroPosters} />
          <View style={styles.heroShade} />
          <View style={styles.heroContent}>
            <Text style={styles.heroKicker}>SIGNAL</Text>
            <Text style={styles.heroTagline}>The living pulse of entertainment culture.</Text>
            {/* Ticker */}
            <View style={styles.tickerWrap}>
              <View style={styles.tickerLivePill}>
                <Animated.View style={[styles.tickerDot, { transform: [{ scale: pulseDot }] }]} />
                <Text style={styles.tickerLiveLabel}>LIVE</Text>
              </View>
              <View style={styles.tickerTrack}>
                <Animated.Text
                  numberOfLines={1}
                  style={[
                    styles.tickerText,
                    { opacity: tickerFade, transform: [{ translateY: tickerSlide }] },
                  ]}
                >
                  {TICKER_ITEMS[tickerIdx]}
                </Animated.Text>
              </View>
            </View>
          </View>
        </View>

        {/* ── Right Now Live ── */}
        {trending.length > 0 ? (
          <>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionKickerRow}>
                <Animated.View style={[styles.liveIndicator, { transform: [{ scale: pulseDot }] }]} />
                <Text style={styles.sectionKicker}>Right Now</Text>
              </View>
              <Text style={styles.sectionTitle}>Fastest Rising</Text>
              <Text style={styles.sectionSub}>Top titles surging across SeenSnap this moment.</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rightNowRow}
            >
              {trending.slice(0, 8).map((title, i) => {
                const imgUri = resolveMediaUrl(title.backdrop_url ?? title.poster_url ?? null);
                return (
                  <View key={title.id} style={styles.rightNowCard}>
                    {imgUri ? (
                      <FallbackImage uri={imgUri} style={StyleSheet.absoluteFill} />
                    ) : (
                      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backgroundElevated }]} />
                    )}
                    <View style={styles.rightNowShade} />
                    <View style={styles.rightNowRankBadge}>
                      <Text style={styles.rightNowRank}>#{i + 1}</Text>
                    </View>
                    <Text numberOfLines={2} style={styles.rightNowTitle}>{title.title}</Text>
                    {title.tmdb_rating ? (
                      <Text style={styles.rightNowRating}>★ {title.tmdb_rating.toFixed(1)}</Text>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          </>
        ) : null}

        {/* ── Live Trend Clusters ── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionKicker}>Genre Waves</Text>
          <Text style={styles.sectionTitle}>Live Trend Clusters</Text>
          <Text style={styles.sectionSub}>Cinematic movements forming across the platform.</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.clusterRow}>
          {TREND_CLUSTERS.map((cluster) => (
            <Pressable
              key={cluster.id}
              style={({ pressed }) => [styles.clusterCard, pressed && styles.pressed]}
              onPress={() => setSelectedCluster(cluster)}
            >
              <PosterMosaic uris={clusterPosters[cluster.id] ?? []} />
              <View style={styles.clusterShade} />
              <View style={styles.clusterContent}>
                <View style={styles.clusterActivityPill}>
                  <View style={styles.clusterDot} />
                  <Text style={styles.clusterActivityLabel}>{cluster.activityLabel}</Text>
                </View>
                <View style={styles.clusterBottom}>
                  <Text style={styles.clusterGenre}>{cluster.genre.toUpperCase()}</Text>
                  <Text style={styles.clusterLabel}>{cluster.label}</Text>
                  <Text style={styles.clusterDescription}>{cluster.description}</Text>
                  <Text style={styles.clusterCount}>{cluster.activityCount}</Text>
                </View>
              </View>
            </Pressable>
          ))}
        </ScrollView>

        {/* ── Social Signals ── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionKicker}>Audience Energy</Text>
          <Text style={styles.sectionTitle}>Social Signals</Text>
          <Text style={styles.sectionSub}>What viewers are feeling most right now.</Text>
        </View>
        <View style={styles.signalList}>
          {SOCIAL_SIGNALS.map((signal) => (
            <View key={signal.id} style={styles.signalCard}>
              <FallbackImage uri={signal.posterUrl} style={styles.signalPoster} />
              <View style={styles.signalBody}>
                <View style={styles.signalTopRow}>
                  <Text style={styles.signalLabel}>{signal.label}</Text>
                  {signal.divisive ? (
                    <View style={styles.divisivePill}>
                      <Text style={styles.divisiveText}>DIVIDED</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.signalTitle}>{signal.titleName}</Text>
                <Text numberOfLines={2} style={styles.signalReaction}>{signal.reaction}</Text>
                <View style={styles.signalFooter}>
                  <EmotionPill emotion={signal.emotion} />
                  {signal.trendSource ? (
                    <Text style={styles.signalSource}>via {signal.trendSource}</Text>
                  ) : null}
                </View>
              </View>
            </View>
          ))}
        </View>

        {/* ── Cultural Moments ── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionKicker}>Cultural Calendar</Text>
          <Text style={styles.sectionTitle}>Cultural Moments</Text>
          <Text style={styles.sectionSub}>The films and shows defining this exact moment.</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.momentRow}>
          {CULTURAL_MOMENTS.map((moment) => (
            <View key={moment.id} style={styles.momentCard}>
              <FallbackImage uri={moment.posterUrl} style={StyleSheet.absoluteFill} />
              <View style={styles.momentShade} />
              <View style={styles.momentContent}>
                <View style={styles.momentLabelPill}>
                  <Text style={styles.momentLabelText}>{moment.label}</Text>
                </View>
                <View style={styles.momentBottom}>
                  <Text style={styles.momentSublabel}>{moment.sublabel}</Text>
                  <Text numberOfLines={2} style={styles.momentTitle}>{moment.titleName}</Text>
                </View>
              </View>
            </View>
          ))}
        </ScrollView>

        {/* ── Watch Team Pulse ── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionKicker}>Your Network</Text>
          <Text style={styles.sectionTitle}>Watch Team Pulse</Text>
          <Text style={styles.sectionSub}>See what your teams are watching right now.</Text>
        </View>
        {teams.length > 0 ? (
          <View style={styles.teamList}>
            {teams.map((team) => (
              <Pressable
                key={team.id}
                style={({ pressed }) => [styles.teamCard, pressed && styles.pressed]}
                onPress={() => router.push("/(tabs)/teams")}
              >
                <View style={styles.teamIconWrap}>
                  <Ionicons name="people" size={18} color={colors.accent} />
                </View>
                <View style={styles.teamMeta}>
                  <Text style={styles.teamName}>{team.name}</Text>
                  {team.member_count != null ? (
                    <Text style={styles.teamCount}>{team.member_count} member{team.member_count !== 1 ? "s" : ""}</Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.muted} />
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={styles.teamEmpty}>
            <Text style={styles.teamEmptyText}>Watch Teams let you track what your friends are watching in real time.</Text>
            <GoldButton
              label="Find a Team"
              icon="people"
              size="sm"
              onPress={() => router.push("/(tabs)/teams")}
              style={{ alignSelf: "flex-start" }}
            />
          </View>
        )}

      </ScrollView>

      {/* ── Cluster Detail Modal ── */}
      <Modal
        transparent
        visible={selectedCluster !== null}
        animationType="slide"
        onRequestClose={() => setSelectedCluster(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSelectedCluster(null)} />
        {selectedCluster ? (
          <View style={styles.clusterModal}>
            <View style={styles.clusterModalHeader}>
              <View style={styles.clusterModalLeft}>
                <View style={styles.clusterActivityPill}>
                  <View style={styles.clusterDot} />
                  <Text style={styles.clusterActivityLabel}>{selectedCluster.activityLabel}</Text>
                </View>
                <Text style={styles.clusterModalTitle}>{selectedCluster.label}</Text>
                <Text style={styles.clusterModalMeta}>{selectedCluster.activityCount} · {selectedCluster.genre}</Text>
                <Text style={styles.clusterModalDesc}>{selectedCluster.description}</Text>
              </View>
              <Pressable onPress={() => setSelectedCluster(null)} style={styles.clusterModalClose}>
                <Ionicons name="close" size={16} color={colors.ink} />
              </Pressable>
            </View>

            {(() => {
              const genreTitles = trending.filter((t) =>
                t.genres.some((g) => g.toLowerCase().includes(selectedCluster.genre.toLowerCase()))
              );
              if (genreTitles.length === 0) {
                return (
                  <Text style={styles.clusterModalEmpty}>
                    No live trending titles in this cluster right now.
                  </Text>
                );
              }
              return (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.clusterModalTitleRow}
                >
                  {genreTitles.slice(0, 10).map((title) => {
                    const posterUri = resolveMediaUrl(title.poster_url ?? null) ?? null;
                    return (
                      <Pressable
                        key={title.id}
                        style={({ pressed }) => [styles.clusterModalTitleCard, pressed && { opacity: 0.85 }]}
                        onPress={() => setSelectedCluster(null)}
                      >
                        {posterUri ? (
                          <FallbackImage uri={posterUri} style={StyleSheet.absoluteFill} />
                        ) : (
                          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backgroundElevated }]} />
                        )}
                        <View style={styles.clusterModalTitleShade} />
                        <Text numberOfLines={2} style={styles.clusterModalTitleName}>{title.title}</Text>
                        {title.tmdb_rating ? (
                          <Text style={styles.clusterModalTitleRating}>★ {title.tmdb_rating.toFixed(1)}</Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              );
            })()}

            <GoldButton
              label={`Discover ${selectedCluster.genre}`}
              icon="compass"
              size="md"
              onPress={() => {
                setSelectedCluster(null);
                router.push({ pathname: "/what-next", params: { genre: selectedCluster.genre } });
              }}
              style={{ marginTop: 4 }}
            />
          </View>
        ) : null}
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  pageGlow: {
    position: "absolute",
    top: -80,
    right: -60,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: "rgba(255,210,31,0.06)",
  },
  pageGlowLeft: {
    position: "absolute",
    top: 400,
    left: -80,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "rgba(176,111,255,0.05)",
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 120,
    gap: spacing.md,
  },

  // Hero
  hero: {
    borderRadius: 28,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.09)",
    height: 280,
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(3,5,10,0.72)",
  },
  heroContent: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.lg,
    gap: 10,
  },
  heroKicker: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 3,
  },
  heroTagline: {
    color: "rgba(242,244,248,0.72)",
    fontSize: 14,
    lineHeight: 20,
    fontStyle: "italic",
  },

  // Ticker
  tickerWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(3,5,10,0.72)",
    borderWidth: 1,
    borderColor: "rgba(255,210,31,0.18)",
    borderRadius: 10,
    overflow: "hidden",
    height: 36,
  },
  tickerLivePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,210,31,0.14)",
    borderRightWidth: 1,
    borderRightColor: "rgba(255,210,31,0.22)",
    paddingHorizontal: 10,
    height: "100%",
  },
  tickerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  tickerLiveLabel: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.6,
  },
  tickerTrack: {
    flex: 1,
    overflow: "hidden",
    justifyContent: "center",
    paddingLeft: 10,
  },
  tickerText: {
    color: "rgba(242,244,248,0.88)",
    fontSize: 12.5,
    fontWeight: "600",
    letterSpacing: 0.1,
  },

  // Section headers
  sectionHeader: { gap: 4 },
  sectionKickerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  sectionKicker: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.3,
  },
  sectionTitle: { color: colors.ink, fontSize: 24, fontWeight: "900" },
  sectionSub: { color: colors.muted, fontSize: 13, lineHeight: 19 },

  // Right Now Live
  rightNowRow: { gap: 12, paddingBottom: 4 },
  rightNowCard: {
    width: 160,
    height: 100,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    justifyContent: "flex-end",
    padding: 10,
    gap: 2,
  },
  rightNowShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(3,5,10,0.58)",
  },
  rightNowRankBadge: {
    position: "absolute",
    top: 8,
    left: 10,
    backgroundColor: "rgba(255,210,31,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,210,31,0.32)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rightNowRank: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  rightNowTitle: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 15,
  },
  rightNowRating: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "800",
  },

  // Trend Clusters
  clusterRow: { gap: 12, paddingBottom: 4 },
  clusterCard: {
    width: 190,
    height: 240,
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
  },
  clusterShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(3,5,10,0.62)",
  },
  clusterContent: {
    flex: 1,
    padding: 14,
    justifyContent: "space-between",
  },
  clusterActivityPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,210,31,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,210,31,0.30)",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  clusterDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.accent,
  },
  clusterActivityLabel: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  clusterBottom: { gap: 3 },
  clusterGenre: {
    color: "rgba(242,244,248,0.45)",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  clusterLabel: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "900",
    lineHeight: 19,
  },
  clusterDescription: {
    color: "rgba(242,244,248,0.55)",
    fontSize: 11,
    lineHeight: 15,
    fontStyle: "italic",
  },
  clusterCount: {
    color: "rgba(242,244,248,0.45)",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 2,
  },

  // Social Signals
  signalList: { gap: 10 },
  signalCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 20,
    padding: 14,
  },
  signalPoster: {
    width: 56,
    height: 82,
    borderRadius: 12,
    backgroundColor: colors.backgroundElevated,
    flexShrink: 0,
  },
  signalBody: { flex: 1, gap: 4 },
  signalTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  signalLabel: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    flex: 1,
  },
  divisivePill: {
    backgroundColor: "rgba(255,64,64,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,64,64,0.32)",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  divisiveText: {
    color: "#FF4040",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.8,
  },
  signalTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "900",
  },
  signalReaction: {
    color: "rgba(242,244,248,0.55)",
    fontSize: 12,
    lineHeight: 17,
  },
  signalFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 2,
  },
  emotionPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  emotionText: {
    fontSize: 11,
    fontWeight: "800",
  },
  signalSource: {
    color: "rgba(242,244,248,0.38)",
    fontSize: 11,
    fontStyle: "italic",
  },

  // Cultural Moments
  momentRow: { gap: 12, paddingBottom: 4 },
  momentCard: {
    width: 150,
    height: 240,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
  },
  momentShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(3,5,10,0.56)",
  },
  momentContent: {
    flex: 1,
    padding: 12,
    justifyContent: "space-between",
  },
  momentLabelPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    backgroundColor: "rgba(255,210,31,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,210,31,0.28)",
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  momentLabelText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  momentBottom: { gap: 2 },
  momentSublabel: {
    color: "rgba(242,244,248,0.45)",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  momentTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 17,
  },

  // Watch Team Pulse
  teamList: { gap: 10 },
  teamCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 20,
    padding: 14,
  },
  teamIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,210,31,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,210,31,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  teamMeta: { flex: 1, gap: 2 },
  teamName: { color: colors.ink, fontWeight: "900", fontSize: 14 },
  teamCount: { color: colors.muted, fontSize: 12 },
  teamEmpty: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 22,
    padding: spacing.lg,
    gap: 14,
  },
  teamEmptyText: {
    color: "rgba(242,244,248,0.62)",
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 280,
  },

  pressed: { opacity: 0.86, transform: [{ scale: 0.97 }] },

  // Cluster Detail Modal
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(3,5,10,0.76)" },
  clusterModal: {
    marginTop: "auto",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: 44,
  },
  clusterModalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  clusterModalLeft: { flex: 1, gap: 4 },
  clusterModalTitle: { color: colors.ink, fontSize: 22, fontWeight: "900", lineHeight: 27 },
  clusterModalMeta: { color: colors.muted, fontSize: 13 },
  clusterModalDesc: { color: "rgba(242,244,248,0.55)", fontSize: 13, lineHeight: 18, fontStyle: "italic" },
  clusterModalClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.backgroundElevated,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  clusterModalEmpty: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  clusterModalTitleRow: { gap: 12, paddingBottom: 4 },
  clusterModalTitleCard: {
    width: 120,
    height: 174,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: colors.backgroundElevated,
    justifyContent: "flex-end",
    padding: 8,
  },
  clusterModalTitleShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(3,5,10,0.55)",
  },
  clusterModalTitleName: { color: colors.ink, fontSize: 12, fontWeight: "900", lineHeight: 15 },
  clusterModalTitleRating: { color: colors.accent, fontSize: 11, fontWeight: "800", marginTop: 2 },
});
