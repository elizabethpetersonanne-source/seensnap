/**
 * Oct-27 follow-up S01–S04: "Your taste matches" carousel.
 *
 * Horizontal row of compact person cards immediately below the
 * Social header and above Stories. Each card shows avatar + display
 * name + @handle + canonical SceneDNA compatibility + one viewer-safe
 * reason + a Follow button that's distinct from profile navigation.
 *
 * The server already enforces:
 *   - eligibility (no blocked / dismissed / demo / discovery-disabled
 *     / self / already-followed accounts)
 *   - canonical compatibility (not the people-discovery coarse score)
 *   - evidence requirement (null compat → omitted, never a fabricated %)
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Avatar } from "@/components/avatar";
import { CompatibilitySheet } from "@/components/compatibility-sheet";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


type TasteMatchCard = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  compatibility: number | null;
  reason: string | null;
};

type EmptyState =
  | "ok"
  | "no_eligible"
  | "viewer_cold"
  | "no_candidates"
  | "all_followed";

type TasteMatchesDiagnostics = {
  eligible_total: number;
  scored_total: number;
  scored_with_evidence: number;
  scored_learning: number;
  viewer_rated_count: number;
};

type TasteMatchesResponse = {
  items: TasteMatchCard[];
  has_evidence: boolean;
  empty_state?: EmptyState;
  diagnostics?: TasteMatchesDiagnostics;
};


export function TasteMatchesCarousel() {
  const { sessionToken } = useAuth();
  const [data, setData] = useState<TasteMatchesResponse | null>(null);
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [pendingFollowIds, setPendingFollowIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [detailFor, setDetailFor] = useState<{ userId: string; displayName: string | null } | null>(null);

  const load = useCallback(async () => {
    if (!sessionToken) return;
    try {
      const res = await apiRequest<TasteMatchesResponse>(
        "/social/people/taste-matches?limit=12",
        { token: sessionToken },
      );
      setData(res);
    } catch {
      setData({ items: [], has_evidence: false });
    } finally {
      setLoaded(true);
    }
  }, [sessionToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleFollow(userId: string, currentlyFollowed: boolean) {
    if (!sessionToken || pendingFollowIds.has(userId)) return;
    setPendingFollowIds((s) => new Set(s).add(userId));
    // Optimistic
    setFollowedIds((s) => {
      const next = new Set(s);
      if (currentlyFollowed) next.delete(userId);
      else next.add(userId);
      return next;
    });
    try {
      await apiRequest(`/profiles/${userId}/follow`, {
        method: currentlyFollowed ? "DELETE" : "POST",
        token: sessionToken,
      });
    } catch {
      // Rollback — spec requires useful error feedback and no stuck UI.
      setFollowedIds((s) => {
        const next = new Set(s);
        if (currentlyFollowed) next.add(userId);
        else next.delete(userId);
        return next;
      });
    } finally {
      setPendingFollowIds((s) => {
        const next = new Set(s);
        next.delete(userId);
        return next;
      });
    }
  }

  if (!loaded) {
    // Keep layout quiet while loading; a skeleton would be louder than
    // the carousel itself at this scale.
    return null;
  }

  if (!data || data.items.length === 0) {
    // MATCH02: pick honest copy based on the server's diagnosis.
    const state = data?.empty_state ?? "no_eligible";
    const copy = state === "viewer_cold"
      ? {
          body: "Rate a few titles to help us find your taste matches.",
          cta: "Rate titles",
          onPress: () => router.push("/(tabs)/swipe"),
        }
      : state === "all_followed"
        ? {
            body: "You already follow everyone we can match you with. Dismiss or unfollow to see new ones.",
            cta: "Find people",
            onPress: () => router.push("/social/people"),
          }
        : state === "no_candidates"
          ? {
              body: "No one with a public profile has rated enough titles to match yet. Invite a friend or try again later.",
              cta: "Find people",
              onPress: () => router.push("/social/people"),
            }
          : {
              body: "No new taste matches yet. Follow or dismiss cards and check back.",
              cta: "Find people",
              onPress: () => router.push("/social/people"),
            };
    return (
      <View style={styles.wrap}>
        <View style={styles.headRow}>
          <Text style={styles.heading}>Your taste matches</Text>
          <Pressable
            onPress={() => router.push("/social/people")}
            hitSlop={6}
            accessibilityRole="button"
          >
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>
        <View style={styles.emptyCard}>
          <Ionicons name="sparkles-outline" size={20} color={colors.muted} />
          <Text style={styles.emptyTitle}>{copy.body}</Text>
          <Pressable onPress={copy.onPress} style={styles.emptyCta}>
            <Text style={styles.emptyCtaLabel}>{copy.cta}</Text>
          </Pressable>
          {data?.diagnostics ? (
            <Text style={styles.diagLine}>
              {data.diagnostics.eligible_total} discoverable · {data.diagnostics.scored_with_evidence} matched · you've rated {data.diagnostics.viewer_rated_count}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <Text style={styles.heading}>Your taste matches</Text>
        <Pressable
          onPress={() => router.push("/social/people")}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="See all people with similar taste"
        >
          <Text style={styles.seeAll}>See all</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {data.items.map((card) => {
          const followed = followedIds.has(card.user_id);
          const pending = pendingFollowIds.has(card.user_id);
          const label = card.display_name ?? card.username ?? "User";
          return (
            <Pressable
              key={card.user_id}
              onPress={() => router.push(`/profile/${card.user_id}`)}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel={`Open ${label}'s profile`}
            >
              <View style={styles.cardTop}>
                <Avatar uri={card.avatar_url} label={label} size={48} />
                {/* Tap the compat badge to open the detail sheet.
                    stopPropagation keeps the parent card press from
                    firing a profile navigation. */}
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    setDetailFor({ userId: card.user_id, displayName: label });
                  }}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={
                    card.compatibility != null
                      ? `${card.compatibility} percent match with ${label}. View details.`
                      : `Match evidence for ${label} is still learning. View details.`
                  }
                >
                  {card.compatibility != null ? (
                    <View style={styles.compatBadge}>
                      <Text style={styles.compatBadgeText}>{card.compatibility}%</Text>
                    </View>
                  ) : (
                    <View style={styles.compatBadgeMuted}>
                      <Text style={styles.compatBadgeMutedText}>Learning</Text>
                    </View>
                  )}
                </Pressable>
              </View>
              <Text style={styles.name} numberOfLines={1}>{label}</Text>
              {card.username ? (
                <Text style={styles.handle} numberOfLines={1}>@{card.username}</Text>
              ) : null}
              {card.reason ? (
                <Text style={styles.reason} numberOfLines={2}>{card.reason}</Text>
              ) : null}
              <Pressable
                onPress={(e) => {
                  // Prevent the card press from navigating to the profile.
                  e.stopPropagation();
                  void toggleFollow(card.user_id, followed);
                }}
                hitSlop={6}
                style={[
                  styles.followBtn,
                  followed ? styles.followBtnFollowing : styles.followBtnDefault,
                  pending && { opacity: 0.6 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={followed ? `Unfollow ${label}` : `Follow ${label}`}
              >
                <Text
                  style={followed ? styles.followBtnFollowingLabel : styles.followBtnDefaultLabel}
                >
                  {followed ? "Following" : "+ Follow"}
                </Text>
              </Pressable>
            </Pressable>
          );
        })}
      </ScrollView>
      <CompatibilitySheet
        visible={detailFor !== null}
        userId={detailFor?.userId ?? null}
        displayName={detailFor?.displayName ?? null}
        onClose={() => setDetailFor(null)}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  wrap: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    marginBottom: 8,
  },
  heading: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
    letterSpacing: 0.1,
  },
  seeAll: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    gap: 10,
  },
  card: {
    width: 140,
    padding: 10,
    gap: 4,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  compatBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  compatBadgeText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.background,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  compatBadgeMuted: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  compatBadgeMutedText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 9,
    letterSpacing: 0.5,
  },
  name: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 13,
  },
  handle: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 11,
  },
  reason: {
    marginTop: 2,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 14,
  },
  followBtn: {
    marginTop: 6,
    paddingVertical: 6,
    borderRadius: 999,
    alignItems: "center",
  },
  followBtnDefault: {
    backgroundColor: colors.accent,
  },
  followBtnDefaultLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.background,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  followBtnFollowing: {
    backgroundColor: "transparent",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.2)",
  },
  followBtnFollowingLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  emptyCard: {
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
    alignItems: "flex-start",
    gap: 8,
  },
  emptyTitle: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 12,
    lineHeight: 16,
  },
  emptyCta: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  diagLine: {
    marginTop: 8,
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.3,
  },
  emptyCtaLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.background,
    fontSize: 11,
    letterSpacing: 0.3,
  },
});
