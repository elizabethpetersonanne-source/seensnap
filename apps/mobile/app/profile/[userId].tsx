/**
 * Oct-18 UI/UX rebuild: immersive public profile pod.
 *
 * Spec image 1. Five vertical pages:
 *   1. Identity hero (avatar + name + bio + counters + MY TOP 4 strip)
 *   2. Ranked Favorites — full-screen hero #1 + 4 continuation
 *   3. Public Lists — full-screen hero list + 4 continuation
 *   4. Recent Activity — full-screen hero post + reactions
 *   5. Back to Profile (loops to page 1)
 *
 * Each page snaps to the viewport, so the whole pod reads as one
 * curated story. Uses existing profile endpoints — this file replaces
 * the earlier non-immersive profile card.
 */
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { FullBleedPosterSection, type FullBleedTitle, type VerticalRailAction } from "@/components/full-bleed-poster-section";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";


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
  compatibility?: { compatibility: number | null; top_shared_genres: string[]; summary?: string | null } | null;
};

type RankedRow = {
  position: number;
  title_id: string;
  tmdb_id: number;
  title: string;
  poster_url: string | null;
  year: number | null;
  media_type: string;
  personal_score: number | null;
  version: number;
};

type PublicList = {
  list_id: string;
  name: string;
  description: string | null;
  item_count: number;
  share_token: string;
  preview_posters: string[];
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


type PageKey = "identity" | "ranked" | "lists" | "activity" | "loop";


export default function PublicProfileScreen() {
  const { sessionToken, user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const params = useLocalSearchParams<{ userId: string }>();
  const userId = typeof params.userId === "string" ? params.userId : undefined;

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [ranked, setRanked] = useState<RankedRow[]>([]);
  const [lists, setLists] = useState<PublicList[]>([]);
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [loading, setLoading] = useState(true);

  const [titleModalId, setTitleModalId] = useState<string | null>(null);
  const [universalTitle, setUniversalTitle] = useState<UniversalTitle | null>(null);
  const [titleLoading, setTitleLoading] = useState(false);

  const listRef = useRef<FlatList<{ key: PageKey }>>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!sessionToken || !userId) return;
      setLoading(true);
      Promise.allSettled([
        apiRequest<PublicProfile>(`/profiles/${userId}`, { token: sessionToken }),
        apiRequest<{ items: RankedRow[]; total: number }>(`/profiles/${userId}/favorites/ranked`, { token: sessionToken }).catch(() => ({ items: [], total: 0 })),
        apiRequest<PublicList[]>(`/profiles/${userId}/public-lists`, { token: sessionToken }).catch(() => []),
        apiRequest<PublicPost[]>(`/profiles/${userId}/posts?limit=10`, { token: sessionToken }).catch(() => []),
      ]).then((results) => {
        if (cancelled) return;
        if (results[0].status === "fulfilled") setProfile(results[0].value);
        if (results[1].status === "fulfilled") setRanked(results[1].value?.items ?? []);
        if (results[2].status === "fulfilled") setLists(results[2].value ?? []);
        if (results[3].status === "fulfilled") setPosts(results[3].value ?? []);
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
      return () => { cancelled = true; };
    }, [sessionToken, userId]),
  );

  const sectionHeight = height - insets.top - insets.bottom;

  async function openTitle(titleId: string) {
    if (!sessionToken) return;
    setTitleModalId(titleId);
    setTitleLoading(true);
    try {
      const detail = await fetchUniversalTitle(sessionToken, titleId);
      setUniversalTitle(detail);
    } catch {
      setUniversalTitle(null);
    } finally {
      setTitleLoading(false);
    }
  }

  function rankedToFullBleed(r: RankedRow): FullBleedTitle {
    return {
      id: r.title_id,
      title: r.title,
      poster_url: r.poster_url,
      backdrop_url: r.poster_url,
      year: r.year,
      rank_label: `#${r.position}`,
    };
  }

  function postToFullBleed(p: PublicPost): FullBleedTitle | null {
    if (!p.title_id) return null;
    return {
      id: p.title_id,
      title: p.title_name ?? "",
      poster_url: p.title_poster_url ?? null,
      backdrop_url: p.title_poster_url ?? null,
      year: null,
    };
  }

  const topFour = ranked.slice(0, 4);
  const rankedHero = ranked[0];
  const rankedFour = ranked.slice(1, 5);
  const activityPost = posts.find((p) => p.title_id) ?? null;

  const pages: { key: PageKey }[] = useMemo(() => {
    const base: PageKey[] = ["identity"];
    if (rankedHero) base.push("ranked");
    if (lists.length > 0) base.push("lists");
    if (activityPost) base.push("activity");
    base.push("loop");
    return base.map((k) => ({ key: k }));
  }, [rankedHero, lists.length, activityPost]);

  async function toggleFollow() {
    if (!sessionToken || !profile) return;
    const next = !profile.is_following;
    setProfile({ ...profile, is_following: next });
    try {
      await apiRequest(`/profiles/${profile.user_id}/follow`, {
        method: next ? "POST" : "DELETE",
        token: sessionToken,
      });
      trackEvent(next ? "profile_follow" : "profile_unfollow", { target_user_id: profile.user_id });
    } catch {
      // Revert on failure.
      setProfile({ ...profile, is_following: !next });
    }
  }

  function sharePublic() {
    if (!profile) return;
    const url = `https://seensnap.com/profiles/${profile.username}`;
    void Share.share({ message: `${profile.display_name} on SeenSnap — ${url}` }).catch(() => {});
  }

  if (!userId) {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.emptyBody}>Missing profile id.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.topBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={sharePublic} hitSlop={10} style={styles.topBtn}>
          <Ionicons name="ellipsis-horizontal" size={20} color={colors.ink} />
        </Pressable>
      </View>

      {loading && !profile ? (
        <View style={[styles.center, { height: sectionHeight }]}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : !profile ? (
        <View style={[styles.center, { height: sectionHeight }]}>
          <Text style={styles.emptyTitle}>Profile not found.</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={pages}
          keyExtractor={(p) => p.key}
          snapToInterval={sectionHeight}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          renderItem={({ item, index }) => {
            if (item.key === "identity" || item.key === "loop") {
              return (
                <IdentityPage
                  height={sectionHeight}
                  profile={profile}
                  topFour={topFour}
                  isOwnProfile={profile.user_id === user?.user_id}
                  onToggleFollow={toggleFollow}
                  onOpenTitle={openTitle}
                  onEditProfile={() => router.push("/(tabs)/settings")}
                  onLoop={() => {
                    if (item.key === "loop") {
                      listRef.current?.scrollToIndex({ index: 0, animated: true });
                    }
                  }}
                />
              );
            }
            if (item.key === "ranked" && rankedHero) {
              return (
                <View style={{ height: sectionHeight }}>
                  <FullBleedPosterSection
                    heroHeight={sectionHeight}
                    sectionKicker="RANKED FAVORITES"
                    hero={rankedToFullBleed(rankedHero)}
                    four={rankedFour.map(rankedToFullBleed)}
                    onPressHero={() => void openTitle(rankedHero.title_id)}
                    onPressContinuation={(t) => void openTitle(t.id)}
                    railActions={[]}
                  />
                </View>
              );
            }
            if (item.key === "lists") {
              const hero = lists[0];
              const four = lists.slice(1, 5);
              return (
                <View style={{ height: sectionHeight }}>
                  <View style={styles.listHeroWrap}>
                    <Image
                      source={{ uri: hero.preview_posters[0] }}
                      style={StyleSheet.absoluteFillObject}
                      resizeMode="cover"
                    />
                    <View style={styles.listHeroShade} />
                    <View style={styles.listHeroBody}>
                      <Text style={styles.sectionKicker}>PUBLIC LISTS</Text>
                      <Text style={styles.listHeroName}>{hero.name}</Text>
                      <Text style={styles.listHeroMeta}>
                        {hero.item_count} title{hero.item_count === 1 ? "" : "s"}
                      </Text>
                    </View>
                    {four.length > 0 ? (
                      <View style={styles.listsRow}>
                        {four.map((l) => (
                          <Pressable
                            key={l.list_id}
                            style={styles.listTile}
                            onPress={() => router.push(`/lists/${l.share_token}`)}
                          >
                            {l.preview_posters[0] ? (
                              <Image source={{ uri: l.preview_posters[0] }} style={styles.listTilePoster} />
                            ) : (
                              <View style={[styles.listTilePoster, styles.listTileFallback]}>
                                <Ionicons name="library-outline" size={14} color={colors.muted2} />
                              </View>
                            )}
                            <Text style={styles.listTileName} numberOfLines={1}>{l.name}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            }
            if (item.key === "activity" && activityPost) {
              return (
                <View style={{ height: sectionHeight }}>
                  <ActivityPage
                    height={sectionHeight}
                    post={activityPost}
                    profile={profile}
                    onOpenTitle={(id) => void openTitle(id)}
                  />
                </View>
              );
            }
            return null;
          }}
        />
      )}

      <UniversalTitleModal
        visible={titleModalId !== null}
        title={universalTitle}
        loading={titleLoading}
        onClose={() => {
          setTitleModalId(null);
          setUniversalTitle(null);
        }}
      />
    </SafeAreaView>
  );
}


function IdentityPage({
  height,
  profile,
  topFour,
  isOwnProfile,
  onToggleFollow,
  onOpenTitle,
  onEditProfile,
  onLoop,
}: {
  height: number;
  profile: PublicProfile;
  topFour: RankedRow[];
  isOwnProfile: boolean;
  onToggleFollow: () => void;
  onOpenTitle: (id: string) => void;
  onEditProfile: () => void;
  onLoop: () => void;
}) {
  // Hero backdrop from top poster or avatar — avoids a blank header
  // when no cover image is present. Spec image 1 shows a cinematic
  // environmental photo; we approximate by using the first ranked
  // poster or the user's avatar at wide crop.
  const heroImage = profile.top_posters?.[0] || profile.avatar_url;
  return (
    <View style={{ height, backgroundColor: "#000" }}>
      {heroImage ? (
        <Image
          source={{ uri: resolveMediaUrl(heroImage) ?? heroImage }}
          style={[StyleSheet.absoluteFillObject, { height: height * 0.55 }]}
          resizeMode="cover"
        />
      ) : null}
      <View style={[styles.identityShade, { height: height * 0.55 }]} />

      <ScrollView contentContainerStyle={{ paddingTop: height * 0.44 }}>
        <View style={styles.identityCard}>
          <Avatar uri={profile.avatar_url ?? null} label={profile.display_name} size={64} />
          <View style={styles.identityNameRow}>
            <Text style={styles.identityName}>{profile.display_name}</Text>
            <Ionicons name="checkmark-circle" size={16} color={colors.accent} />
          </View>
          <Text style={styles.identityHandle}>@{profile.username}</Text>
          {profile.bio ? (
            <Text style={styles.identityBio} numberOfLines={3}>{profile.bio}</Text>
          ) : null}

          <View style={styles.counterRow}>
            <View style={styles.counterCol}>
              <Text style={styles.counterValue}>{formatCount(profile.follower_count)}</Text>
              <Text style={styles.counterLabel}>Followers</Text>
            </View>
            <View style={styles.counterCol}>
              <Text style={styles.counterValue}>{formatCount(profile.following_count)}</Text>
              <Text style={styles.counterLabel}>Following</Text>
            </View>
            {profile.compatibility ? (
              <View style={styles.counterCol}>
                {profile.compatibility.compatibility != null ? (
                  <>
                    <Text style={[styles.counterValue, { color: colors.accent }]}>
                      {Math.round(profile.compatibility.compatibility)}%
                    </Text>
                    <Text style={styles.counterLabel}>SceneDNA with you</Text>
                  </>
                ) : (
                  <>
                    <Text style={[styles.counterValue, { color: colors.muted, fontSize: 14 }]} numberOfLines={1}>
                      Learning
                    </Text>
                    <Text style={styles.counterLabel}>Still learning your taste</Text>
                  </>
                )}
              </View>
            ) : null}
          </View>

          {isOwnProfile ? (
            <Pressable style={styles.identityCta} onPress={onEditProfile}>
              <Text style={styles.identityCtaLabel}>Edit Profile</Text>
            </Pressable>
          ) : profile.can_follow ? (
            <Pressable
              style={[styles.identityCta, profile.is_following && styles.identityCtaFollowing]}
              onPress={onToggleFollow}
            >
              <Text style={[styles.identityCtaLabel, profile.is_following && { color: colors.ink }]}>
                {profile.is_following ? "Following" : "+ Follow"}
              </Text>
            </Pressable>
          ) : null}

          {topFour.length > 0 ? (
            <>
              <Text style={styles.topFourKicker}>MY TOP 4</Text>
              <View style={styles.topFourRow}>
                {topFour.map((t) => (
                  <Pressable
                    key={t.title_id}
                    style={styles.topFourTile}
                    onPress={() => onOpenTitle(t.title_id)}
                  >
                    {t.poster_url ? (
                      <Image source={{ uri: t.poster_url }} style={styles.topFourPoster} />
                    ) : (
                      <View style={[styles.topFourPoster, styles.topFourFallback]}>
                        <Ionicons name="film-outline" size={14} color={colors.muted2} />
                      </View>
                    )}
                    <View style={styles.topFourRankBadge}>
                      <Text style={styles.topFourRankLabel}>{t.position}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          <Pressable onPress={onLoop} style={styles.loopCta}>
            <Ionicons name="chevron-down" size={18} color={colors.muted} />
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}


function ActivityPage({
  height,
  post,
  profile,
  onOpenTitle,
}: {
  height: number;
  post: PublicPost;
  profile: PublicProfile;
  onOpenTitle: (id: string) => void;
}) {
  const image = post.title_poster_url;
  return (
    <View style={{ height, backgroundColor: "#000" }}>
      {image ? (
        <Image source={{ uri: image }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
      ) : null}
      <View style={styles.activityShade} />
      <View style={styles.activityHeader}>
        <Avatar uri={profile.avatar_url ?? null} label={profile.display_name} size={28} />
        <View>
          <Text style={styles.activityActor}>{profile.display_name} rated {post.title_name}</Text>
          <Text style={styles.activityTime}>{relativeTime(post.created_at)}</Text>
        </View>
      </View>

      <View style={styles.activityCenter}>
        {post.rating != null ? (
          <View style={styles.activityRatingRow}>
            <Ionicons name="star" size={32} color={colors.accent} />
            <Text style={styles.activityRating}>{post.rating}<Text style={styles.activityRatingOutOf}>/10</Text></Text>
          </View>
        ) : null}
        {post.caption ? (
          <Text style={styles.activityCaption} numberOfLines={5}>“{post.caption}”</Text>
        ) : null}
      </View>

      <View style={styles.activityRail}>
        <View style={styles.activityRailBtn}>
          <Ionicons name="heart-outline" size={26} color={colors.ink} />
          <Text style={styles.activityRailCount}>—</Text>
        </View>
        <View style={styles.activityRailBtn}>
          <Ionicons name="chatbubble-outline" size={26} color={colors.ink} />
          <Text style={styles.activityRailCount}>—</Text>
        </View>
        <Pressable
          style={styles.activityRailBtn}
          onPress={() => post.title_id && onOpenTitle(post.title_id)}
          hitSlop={10}
        >
          <Ionicons name="paper-plane-outline" size={26} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}


function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingTop: 8,
    zIndex: 20,
  },
  topBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 18,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
  },

  identityShade: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: "rgba(0,0,0,0.42)",
  },
  identityCard: {
    marginHorizontal: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: "rgba(13,19,30,0.9)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
  },
  identityNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
  },
  identityName: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 26,
    letterSpacing: -0.3,
  },
  identityHandle: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    marginTop: 2,
  },
  identityBio: {
    marginTop: 8,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    textAlign: "center",
  },
  counterRow: {
    flexDirection: "row",
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  counterCol: {
    alignItems: "center",
  },
  counterValue: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 18,
  },
  counterLabel: {
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.6,
    marginTop: 2,
  },
  identityCta: {
    marginTop: spacing.md,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  identityCtaFollowing: {
    backgroundColor: "transparent",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.3)",
  },
  identityCtaLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    fontSize: 13,
    letterSpacing: 0.4,
  },
  topFourKicker: {
    marginTop: spacing.lg,
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 1.3,
    alignSelf: "flex-start",
  },
  topFourRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    alignSelf: "stretch",
  },
  topFourTile: {
    flex: 1,
    aspectRatio: 2 / 3,
    borderRadius: radii.sm,
    overflow: "hidden",
    backgroundColor: colors.surfaceMuted,
    position: "relative",
  },
  topFourPoster: {
    width: "100%",
    height: "100%",
  },
  topFourFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  topFourRankBadge: {
    position: "absolute",
    top: 4,
    left: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: radii.sm,
  },
  topFourRankLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 12,
  },
  loopCta: {
    marginTop: spacing.md,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },

  listHeroWrap: {
    flex: 1,
    position: "relative",
  },
  listHeroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  listHeroBody: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: 180,
  },
  sectionKicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 1.4,
  },
  listHeroName: {
    marginTop: 10,
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 42,
    lineHeight: 44,
  },
  listHeroMeta: {
    marginTop: 6,
    fontFamily: fonts.monoMedium,
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.5,
  },
  listsRow: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.sm,
    flexDirection: "row",
    gap: 8,
  },
  listTile: {
    flex: 1,
  },
  listTilePoster: {
    width: "100%",
    aspectRatio: 2 / 3,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  listTileFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  listTileName: {
    marginTop: 4,
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 10,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    textAlign: "center",
  },

  activityShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  activityHeader: {
    position: "absolute",
    top: 60,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  activityActor: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
  },
  activityTime: {
    fontFamily: fonts.monoMedium,
    color: colors.muted,
    fontSize: 10,
    letterSpacing: 0.4,
    marginTop: 2,
  },
  activityCenter: {
    position: "absolute",
    left: spacing.lg,
    right: 80,
    bottom: 140,
  },
  activityRatingRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    marginBottom: spacing.sm,
  },
  activityRating: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 54,
    lineHeight: 54,
  },
  activityRatingOutOf: {
    fontFamily: fonts.serif,
    color: colors.muted,
    fontSize: 24,
  },
  activityCaption: {
    fontFamily: fonts.serif,
    color: colors.ink,
    fontSize: 18,
    lineHeight: 24,
  },
  activityRail: {
    position: "absolute",
    right: spacing.md,
    bottom: 160,
    gap: spacing.md,
  },
  activityRailBtn: {
    alignItems: "center",
  },
  activityRailCount: {
    marginTop: 2,
    fontFamily: fonts.monoMedium,
    color: colors.ink,
    fontSize: 11,
  },
});
