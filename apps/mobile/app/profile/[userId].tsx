import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Avatar } from "@/components/avatar";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

type Compatibility = {
  compatibility: number;
  top_shared_genres: string[];
  summary?: string | null;
};

type PublicProfile = {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  is_following: boolean;
  can_follow: boolean;
  taste_labels: Array<{ label: string; confidence: number }>;
  favorite_genres: Array<{ genre: string; score: number }>;
  profile_summary?: string | null;
  current_obsessions: Array<{ title_name: string; poster_url?: string | null }>;
  top_posters: string[];
  compatibility?: Compatibility | null;
};

type PublicPost = {
  id: string;
  title_id?: string | null;
  title_name?: string | null;
  title_poster_url?: string | null;
  caption?: string | null;
  rating?: number | null;
  created_at: string;
};

type PublicList = {
  list_id: string;
  name: string;
  description: string | null;
  item_count: number;
  share_token: string;
  preview_posters: string[];
};

type Personality = { archetype: string; tagline: string; accentColor: string };

function derivePersonality(bio: string | null | undefined): Personality {
  const b = (bio ?? "").toLowerCase();
  if (b.includes("slow cinema") || b.includes("long take") || b.includes("auteur"))
    return { archetype: "The Auteur", tagline: "Studying every frame.", accentColor: "#5c7cfa" };
  if (b.includes("award") || b.includes("prestige"))
    return { archetype: "The Prestige Purist", tagline: "Spiraling through awards bait.", accentColor: "#f4c430" };
  if (b.includes("horror") || b.includes("disturbing"))
    return { archetype: "The Horror Head", tagline: "Running through the disturbing stuff.", accentColor: "#e03131" };
  if (b.includes("cinematograph") || b.includes("director"))
    return { archetype: "The Visual Obsessive", tagline: "Watching everything twice.", accentColor: "#2ec4b6" };
  if (b.includes("comfort") || b.includes("rewatch"))
    return { archetype: "The Comfort Rewatcher", tagline: "Revisiting all-time favorites.", accentColor: "#74c0fc" };
  if (b.includes("letterboxd") || b.includes("logging"))
    return { archetype: "The Completionist", tagline: "Logging everything released.", accentColor: "#a9e34b" };
  if (b.includes("messy") || b.includes("moody") || b.includes("lighting"))
    return { archetype: "The Mood Watcher", tagline: "Only watching when the vibe is right.", accentColor: "#cc5de8" };
  if (b.includes("writing") || b.includes("plot"))
    return { archetype: "The Script Snob", tagline: "Won't settle for weak dialogue.", accentColor: "#ff922b" };
  if (b.includes("90s") || b.includes("rewind"))
    return { archetype: "The Retro Specialist", tagline: "Rewatching the classics.", accentColor: "#ffc078" };
  if (b.includes("big screen") || b.includes("blockbuster"))
    return { archetype: "The Spectacle Seeker", tagline: "Chasing the next big experience.", accentColor: "#63e6be" };
  return { archetype: "The Taste Maker", tagline: "Building a distinct point of view.", accentColor: "#f4c430" };
}

function relativeTime(dateString: string) {
  const now = Date.now();
  const ts = new Date(dateString).getTime();
  if (Number.isNaN(ts)) return "now";
  const diff = Math.max(now - ts, 0);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function PublicProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const { sessionToken } = useAuth();
  const router = useRouter();

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [publicLists, setPublicLists] = useState<PublicList[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  const [showDetails, setShowDetails] = useState(false);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);

  const floatAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, { toValue: -7, duration: 2600, useNativeDriver: true }),
        Animated.timing(floatAnim, { toValue: 0, duration: 2600, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [floatAnim]);

  useFocusEffect(
    useCallback(() => {
      async function load() {
        if (!sessionToken || !userId) return;
        setIsLoading(true);
        setError(null);
        try {
          const [p, feed, lists] = await Promise.all([
            apiRequest<PublicProfile>(`/profiles/${userId}`, { token: sessionToken }),
            apiRequest<PublicPost[]>(`/profiles/${userId}/posts`, { token: sessionToken }),
            apiRequest<PublicList[]>(`/profiles/${userId}/public-lists`, { token: sessionToken })
              .catch(() => [] as PublicList[]),
          ]);
          setProfile(p);
          setPosts(feed);
          setPublicLists(lists);
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load profile");
        } finally {
          setIsLoading(false);
        }
      }
      void load();
    }, [sessionToken, userId])
  );

  async function openDetails(post: PublicPost) {
    if (!sessionToken || !post.title_id) return;
    setShowDetails(true);
    setDetailLoading(true);
    try {
      const title = await fetchUniversalTitle(sessionToken, post.title_id, {
        id: post.title_id,
        title: post.title_name ?? "Untitled",
        content_type: "movie",
        poster_url: post.title_poster_url,
        overview: post.caption,
      });
      setDetailTitle(title);
    } catch {
      setDetailTitle(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function toggleFollow() {
    if (!sessionToken || !profile || !profile.can_follow || followBusy) return;
    const currentlyFollowing = profile.is_following;
    setFollowBusy(true);
    try {
      await apiRequest<void>(`/profiles/${profile.user_id}/follow`, {
        method: currentlyFollowing ? "DELETE" : "POST",
        token: sessionToken,
      });
      setProfile((cur) =>
        cur
          ? {
              ...cur,
              is_following: !currentlyFollowing,
              follower_count: Math.max(cur.follower_count + (currentlyFollowing ? -1 : 1), 0),
            }
          : cur
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update follow");
    } finally {
      setFollowBusy(false);
    }
  }

  const personality = useMemo(() => derivePersonality(profile?.bio), [profile?.bio]);

  const bannerPosters = useMemo(() => {
    const fromApi = profile?.top_posters ?? [];
    if (fromApi.length) return fromApi.slice(0, 4);
    return posts.filter((p) => p.title_poster_url).slice(0, 4).map((p) => p.title_poster_url!);
  }, [profile?.top_posters, posts]);

  const obsession = profile?.current_obsessions?.[0] ?? null;
  const compat = profile?.compatibility ?? null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Nav */}
        <View style={styles.nav}>
          <Pressable onPress={() => router.back()} style={styles.back}>
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {isLoading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: 60 }} size="large" />
        ) : null}

        {profile ? (
          <>
            {/* ── Cinematic Hero Banner ──
                Renders the full poster-mosaic hero only when we have real
                artwork to fill it. New / low-post profiles show a compact
                variant so the avatar isn't left floating in a dark void
                below a giant empty rectangle. */}
            {bannerPosters.length > 0 ? (
              <View style={styles.heroBanner}>
                <View style={StyleSheet.absoluteFill}>
                  {bannerPosters.map((uri, i) => (
                    <Image
                      key={uri + String(i)}
                      source={{ uri: resolveMediaUrl(uri) ?? uri }}
                      style={[
                        styles.bannerPoster,
                        i === 0 && { top: -10, right: -20, width: 160, height: 240, transform: [{ rotate: "7deg" }] },
                        i === 1 && { top: 20, right: 110, width: 120, height: 178, transform: [{ rotate: "-4deg" }] },
                        i === 2 && { top: -5, left: -10, width: 130, height: 194, transform: [{ rotate: "-6deg" }] },
                        i === 3 && { top: 40, left: 90, width: 100, height: 148, transform: [{ rotate: "5deg" }] },
                      ]}
                      resizeMode="cover"
                    />
                  ))}
                </View>
                <View style={[styles.bannerShade, { backgroundColor: `${colors.background}cc` }]} />

                {compat?.compatibility ? (
                  <View style={styles.compatBadge}>
                    <Text style={[styles.compatScore, { color: personality.accentColor }]}>
                      {compat.compatibility}%
                    </Text>
                    <Text style={styles.compatLabel}>match</Text>
                  </View>
                ) : null}

                <View style={styles.bannerAvatarWrap}>
                  {/* Flatten the float-animation transform onto the ring
                      itself — a nested Animated.View wrapper with its
                      own alignItems can compute a full-width box on
                      react-native-web and defeat the parent's
                      justifyContent centering. */}
                  <Animated.View
                    style={[
                      styles.bannerAvatarRing,
                      {
                        borderColor: personality.accentColor,
                        shadowColor: personality.accentColor,
                        transform: [{ translateY: floatAnim }],
                      },
                    ]}
                  >
                    <Avatar uri={profile.avatar_url} label={profile.display_name} size={96} />
                  </Animated.View>
                </View>
              </View>
            ) : (
              <View style={styles.heroCompact}>
                {compat?.compatibility ? (
                  <View style={styles.compatBadgeCompact}>
                    <Text style={[styles.compatScore, { color: personality.accentColor }]}>
                      {compat.compatibility}%
                    </Text>
                    <Text style={styles.compatLabel}>match</Text>
                  </View>
                ) : null}
                <View
                  style={[
                    styles.bannerAvatarRing,
                    {
                      borderColor: personality.accentColor,
                      shadowColor: personality.accentColor,
                    },
                  ]}
                >
                  <Avatar uri={profile.avatar_url} label={profile.display_name} size={96} />
                </View>
              </View>
            )}

            {/* ── Identity Block ── */}
            <View style={styles.identityBlock}>
              <Text style={styles.displayName}>{profile.display_name}</Text>
              <Text style={styles.username}>@{profile.username}</Text>

              <View
                style={[
                  styles.archetypePill,
                  { backgroundColor: `${personality.accentColor}22`, borderColor: `${personality.accentColor}55` },
                ]}
              >
                <Text style={[styles.archetypeText, { color: personality.accentColor }]}>
                  {personality.archetype}
                </Text>
              </View>

              {profile.bio?.trim() ? <Text style={styles.bio}>{profile.bio}</Text> : null}
              <Text style={[styles.tagline, { color: personality.accentColor }]}>{personality.tagline}</Text>

              {/* Favorite genres */}
              {profile.favorite_genres.length > 0 ? (
                <View style={styles.genreRow}>
                  {profile.favorite_genres.slice(0, 5).map(({ genre }) => (
                    <View key={genre} style={styles.genreChip}>
                      <Text style={styles.genreChipText}>{genre}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Shared taste callout */}
              {compat?.top_shared_genres?.length ? (
                <Text style={styles.compatShared}>
                  Shared taste · {compat.top_shared_genres.slice(0, 3).join(" · ")}
                </Text>
              ) : null}
            </View>

            {/* ── Stats Row ── */}
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>{profile.follower_count}</Text>
                <Text style={styles.statLabel}>Followers</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>{profile.following_count}</Text>
                <Text style={styles.statLabel}>Following</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>{profile.post_count}</Text>
                <Text style={styles.statLabel}>Posts</Text>
              </View>
            </View>

            {/* ── Follow Button ── */}
            {profile.can_follow ? (
              <Pressable
                style={[
                  styles.followButton,
                  profile.is_following && styles.followingButton,
                  followBusy && styles.followDisabled,
                ]}
                onPress={() => void toggleFollow()}
                disabled={followBusy}
              >
                {!profile.is_following ? (
                  <Ionicons name="person-add-outline" size={14} color={colors.background} />
                ) : null}
                <Text style={[styles.followButtonText, profile.is_following && styles.followingButtonText]}>
                  {followBusy ? "..." : profile.is_following ? "Following" : "Follow"}
                </Text>
              </Pressable>
            ) : null}

            {/* ── Current Obsession ── */}
            {obsession ? (
              <View style={styles.obsessionCard}>
                <Text style={[styles.sectionKicker, { color: personality.accentColor }]}>
                  Current Obsession
                </Text>
                <View style={styles.obsessionRow}>
                  {obsession.poster_url ? (
                    <Image
                      source={{ uri: resolveMediaUrl(obsession.poster_url) ?? obsession.poster_url }}
                      style={styles.obsessionPoster}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={[styles.obsessionPoster, styles.obsessionPosterFallback]}>
                      <Ionicons name="film" size={18} color={colors.muted} />
                    </View>
                  )}
                  <View style={styles.obsessionMeta}>
                    <Text style={styles.obsessionTitle} numberOfLines={2}>
                      {obsession.title_name}
                    </Text>
                    {profile.profile_summary ? (
                      <Text style={styles.obsessionCaption} numberOfLines={3}>
                        {profile.profile_summary}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
            ) : null}

            {/* ── Public Lists ── */}
            <View style={styles.listsSection}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionKicker}>Collections</Text>
                <Text style={styles.sectionTitle}>Public Lists</Text>
                {publicLists.length > 0 ? (
                  <Text style={styles.feedCount}>{publicLists.length}</Text>
                ) : null}
              </View>
              {publicLists.length === 0 ? (
                <View style={styles.listsEmpty}>
                  <Ionicons name="albums-outline" size={26} color={colors.muted} />
                  <Text style={styles.listsEmptyTitle}>No public lists yet</Text>
                  <Text style={styles.listsEmptyBody}>
                    Public collections will appear here when {profile.display_name} shares one.
                  </Text>
                </View>
              ) : (
                <View style={styles.publicListCol}>
                  {publicLists.map((list) => (
                    <Pressable
                      key={list.list_id}
                      style={styles.publicListRow}
                      onPress={() => router.push(`/lists/${list.share_token}`)}
                    >
                      <View style={styles.publicListPosters}>
                        {list.preview_posters.slice(0, 4).map((uri, i) => (
                          <Image
                            key={uri + String(i)}
                            source={{ uri: resolveMediaUrl(uri) ?? uri }}
                            style={styles.publicListPoster}
                            resizeMode="cover"
                          />
                        ))}
                        {list.preview_posters.length === 0 ? (
                          <View style={[styles.publicListPoster, styles.publicListPosterEmpty]}>
                            <Ionicons name="albums-outline" size={18} color={colors.muted} />
                          </View>
                        ) : null}
                      </View>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={styles.publicListName} numberOfLines={1}>{list.name}</Text>
                        <Text style={styles.publicListMeta}>
                          {list.item_count} {list.item_count === 1 ? "title" : "titles"}
                        </Text>
                        {list.description ? (
                          <Text style={styles.publicListDesc} numberOfLines={2}>{list.description}</Text>
                        ) : null}
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.muted} />
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {/* ── Activity Feed ── */}
            <View style={styles.feedSection}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionKicker}>Activity</Text>
                <Text style={styles.sectionTitle}>Posts</Text>
                {posts.length > 0 ? (
                  <Text style={styles.feedCount}>{posts.length}</Text>
                ) : null}
              </View>

              {posts.length === 0 ? (
                <View style={styles.empty}>
                  <Ionicons name="film-outline" size={28} color={colors.muted} />
                  <Text style={styles.emptyTitle}>No public posts yet</Text>
                  <Text style={styles.emptyBody}>
                    When {profile.display_name} posts, it'll show up here.
                  </Text>
                </View>
              ) : (
                <View style={styles.postList}>
                  {posts.map((post) => (
                    <Pressable
                      key={post.id}
                      style={styles.postCard}
                      onPress={() => void openDetails(post)}
                    >
                      {post.title_poster_url ? (
                        <Image
                          source={{ uri: resolveMediaUrl(post.title_poster_url) ?? post.title_poster_url }}
                          style={StyleSheet.absoluteFill}
                          resizeMode="cover"
                        />
                      ) : null}
                      <View style={styles.postCardShade} />
                      <View style={styles.postCardBody}>
                        {post.title_name ? (
                          <Text style={styles.postCardTitle} numberOfLines={1}>
                            {post.title_name}
                          </Text>
                        ) : null}
                        {post.caption ? (
                          <Text style={styles.postCardCaption} numberOfLines={2}>
                            {post.caption}
                          </Text>
                        ) : null}
                        <View style={styles.postCardMeta}>
                          {typeof post.rating === "number" ? (
                            <View style={styles.ratingPill}>
                              <Text style={styles.ratingText}>{post.rating}/10</Text>
                            </View>
                          ) : null}
                          <Text style={styles.postTime}>{relativeTime(post.created_at)} ago</Text>
                        </View>
                      </View>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          </>
        ) : null}
      </ScrollView>

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
        source="profile"
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onError={(message) => setError(message)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },

  nav: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 4,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  backText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  error: { color: colors.danger, fontSize: 13, paddingHorizontal: spacing.lg },

  // ── Hero banner ──────────────────────────────────────────────────────────
  heroBanner: {
    height: 268,
    marginHorizontal: spacing.lg,
    borderRadius: 32,
    overflow: "hidden",
    backgroundColor: "#080e1a",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.09)",
  },
  bannerPoster: {
    position: "absolute",
    borderRadius: 16,
    opacity: 0.48,
  },
  bannerShade: { ...StyleSheet.absoluteFillObject },
  bannerGlow: {
    position: "absolute",
    bottom: -80,
    left: "20%",
    width: 240,
    height: 240,
    borderRadius: 120,
    opacity: 0.14,
  },
  bannerAvatarWrap: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    // Centers the avatar inside the banner on both axes so it reads as
    // the focal point (previous version sat half-outside via bottom:-52
    // which felt disconnected — the small circle was floating between
    // the banner and the identity block below).
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  heroCompact: {
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  compatBadgeCompact: {
    position: "absolute",
    top: 0,
    right: 0,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.52)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 14,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  bannerAvatarRing: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 3,
    overflow: "hidden",
    backgroundColor: colors.backgroundElevated,
    shadowOpacity: 0.55,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
  },
  compatBadge: {
    position: "absolute",
    top: 16,
    right: 16,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.52)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 14,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  compatScore: { fontWeight: "900", fontSize: 20, lineHeight: 22 },
  compatLabel: {
    color: "rgba(255,255,255,0.65)",
    fontWeight: "700",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },

  // ── Identity ─────────────────────────────────────────────────────────────
  identityBlock: {
    alignItems: "center",
    // paddingTop 62 was compensating for an avatar that hung half-outside
    // the banner. Avatar now sits inside the banner center → no overlap,
    // just standard spacing.
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: 6,
  },
  displayName: { color: colors.ink, fontSize: 27, fontWeight: "900", letterSpacing: -0.4 },
  username: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  archetypePill: {
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  archetypeText: { fontSize: 12, fontWeight: "900", textTransform: "uppercase", letterSpacing: 1 },
  bio: {
    color: "rgba(242,244,248,0.82)",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginTop: 4,
    maxWidth: 290,
  },
  tagline: { fontSize: 12, fontWeight: "700", fontStyle: "italic", marginTop: 2 },
  genreRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "center", marginTop: 8 },
  genreChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  genreChipText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  compatShared: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
    textAlign: "center",
  },

  // ── Stats ─────────────────────────────────────────────────────────────────
  statsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.xl,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.lg,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statItem: { alignItems: "center", gap: 3 },
  statNumber: { color: colors.ink, fontSize: 22, fontWeight: "900" },
  statLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  statDivider: { width: 1, height: 36, backgroundColor: colors.border },

  // ── Follow ────────────────────────────────────────────────────────────────
  followButton: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingHorizontal: 28,
    paddingVertical: 13,
  },
  followingButton: {
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  followButtonText: { color: colors.background, fontWeight: "900", fontSize: 13 },
  followingButtonText: { color: colors.accent },
  followDisabled: { opacity: 0.55 },

  // ── Section chrome ────────────────────────────────────────────────────────
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  sectionKicker: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 1.3,
    flex: 1,
  },
  sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  feedCount: { color: colors.muted, fontSize: 14, fontWeight: "800" },

  // ── Obsession card ────────────────────────────────────────────────────────
  obsessionCard: {
    marginHorizontal: spacing.lg,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  obsessionRow: { flexDirection: "row", gap: spacing.md },
  obsessionPoster: { width: 72, height: 108, borderRadius: 12, backgroundColor: colors.surfaceSoft },
  obsessionPosterFallback: { alignItems: "center", justifyContent: "center" },
  obsessionMeta: { flex: 1, gap: 6, justifyContent: "center" },
  obsessionTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", lineHeight: 22 },
  obsessionCaption: { color: colors.muted, fontSize: 13, lineHeight: 18 },

  // ── Public lists ──────────────────────────────────────────────────────────
  listsSection: { gap: spacing.md },
  listsEmpty: {
    marginHorizontal: spacing.lg,
    borderRadius: 20,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    alignItems: "center",
    gap: 8,
  },
  listsEmptyTitle: { color: colors.ink, fontWeight: "800", fontSize: 14 },
  listsEmptyBody: { color: colors.muted, fontSize: 13, lineHeight: 18, textAlign: "center" },
  publicListCol: { marginHorizontal: spacing.lg, gap: spacing.sm },
  publicListRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 14,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  publicListPosters: {
    flexDirection: "row",
    gap: 3,
  },
  publicListPoster: {
    width: 28,
    height: 42,
    borderRadius: 3,
    backgroundColor: colors.surface,
  },
  publicListPosterEmpty: {
    alignItems: "center",
    justifyContent: "center",
    width: 42,
  },
  publicListName: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  publicListMeta: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  publicListDesc: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },

  // ── Feed section ──────────────────────────────────────────────────────────
  feedSection: { gap: spacing.md },
  empty: {
    marginHorizontal: spacing.lg,
    borderRadius: 20,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: { color: colors.ink, fontWeight: "800", fontSize: 15 },
  emptyBody: { color: colors.muted, fontSize: 13, lineHeight: 18, textAlign: "center" },

  // ── Cinematic post cards ───────────────────────────────────────────────────
  postList: { gap: spacing.md, paddingHorizontal: spacing.lg },
  postCard: {
    height: 210,
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  postCardShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7,11,19,0.55)",
  },
  postCardBody: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 18,
    gap: 4,
  },
  postCardTitle: { color: colors.accent, fontWeight: "800", fontSize: 15 },
  postCardCaption: { color: "rgba(242,244,248,0.88)", fontSize: 13, lineHeight: 17 },
  postCardMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 5 },
  postTime: { color: "rgba(242,244,248,0.5)", fontWeight: "700", fontSize: 11 },

  // ── Rating pill ───────────────────────────────────────────────────────────
  ratingPill: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.pill,
    paddingVertical: 3,
    paddingHorizontal: 9,
    backgroundColor: "rgba(244,196,48,0.12)",
  },
  ratingText: { color: colors.accent, fontWeight: "800", fontSize: 11 },
});
