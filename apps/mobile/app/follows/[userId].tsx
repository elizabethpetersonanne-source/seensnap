/**
 * Follows list — shows who a given user follows or who follows them.
 *
 * Route: /follows/[userId]?mode=following|followers
 *
 * Product ask: "we should also have an area somewhere to see everyone
 * you follow" — this screen is that area. Same route serves both
 * directions (`?mode=following` default, `?mode=followers` optional)
 * and works for the viewer's own profile OR anyone else's, since the
 * backend endpoints (/profiles/{user_id}/following, /followers) are
 * public-to-auth. Entry point: tapping the Following / Followers
 * counters on any profile screen.
 */
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

type FollowRow = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  followed_at: string;
};

type FollowListResponse = {
  items: FollowRow[];
  total: number;
};

type Mode = "following" | "followers";

export default function FollowsScreen() {
  const { userId, mode: initialMode } = useLocalSearchParams<{ userId: string; mode?: Mode }>();
  const { sessionToken, user } = useAuth();
  const isSelf = user?.user_id === userId;
  const [mode, setMode] = useState<Mode>(initialMode === "followers" ? "followers" : "following");
  const [rows, setRows] = useState<FollowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionToken || !userId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<FollowListResponse>(
        `/profiles/${userId}/${mode}?limit=100`,
        { token: sessionToken },
      );
      setRows(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load follows.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken, userId, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const heading = useMemo(() => {
    if (mode === "following") {
      return isSelf ? "People you follow" : "Following";
    }
    return isSelf ? "Your followers" : "Followers";
  }, [mode, isSelf]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.heading} numberOfLines={1}>
          {heading}
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.segmentRow}>
        {(["following", "followers"] as const).map((m) => {
          const active = m === mode;
          return (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={[styles.segmentBtn, active && styles.segmentBtnActive]}
              accessibilityRole="button"
              accessibilityLabel={m === "following" ? "Show following" : "Show followers"}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {m === "following" ? "Following" : "Followers"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.centerFill}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => void load()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.centerFill}>
          <Text style={styles.emptyTitle}>
            {mode === "following" ? "Not following anyone yet" : "No followers yet"}
          </Text>
          <Text style={styles.emptyBody}>
            {mode === "following"
              ? "Find people whose taste you trust to fill your feed."
              : "Share what you're watching to attract followers."}
          </Text>
          {mode === "following" ? (
            <Pressable style={styles.emptyCta} onPress={() => router.push("/social/people")}>
              <Ionicons name="person-add-outline" size={14} color={colors.background} />
              <Text style={styles.emptyCtaText}>Find people</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.user_id}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListHeaderComponent={
            <Text style={styles.countText}>
              {total} {mode === "following" ? "following" : total === 1 ? "follower" : "followers"}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`/profile/${item.user_id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.display_name ?? item.username ?? "profile"}`}
            >
              <Avatar
                uri={item.avatar_url ?? null}
                label={item.display_name ?? item.username ?? ""}
                size={44}
              />
              <View style={styles.rowMeta}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.display_name ?? item.username ?? "Someone"}
                </Text>
                {item.username ? (
                  <Text style={styles.rowHandle} numberOfLines={1}>@{item.username}</Text>
                ) : null}
                {item.bio ? (
                  <Text style={styles.rowBio} numberOfLines={2}>{item.bio}</Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  backBtn: {
    width: 28,
    height: 28,
    justifyContent: "center",
  },
  heading: {
    fontFamily: fonts.serifBold,
    fontSize: 18,
    color: colors.ink,
    flex: 1,
    textAlign: "center",
  },
  segmentRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  segmentBtnActive: {
    borderBottomColor: colors.accent,
  },
  segmentText: {
    fontFamily: fonts.sansMedium,
    color: colors.muted,
    fontSize: 14,
    letterSpacing: 0.3,
  },
  segmentTextActive: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
  },
  listContent: {
    paddingVertical: spacing.md,
  },
  separator: {
    height: 1,
    backgroundColor: rules.default,
    marginLeft: spacing.md + 44 + spacing.md,
    marginRight: spacing.md,
  },
  countText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.muted,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    textTransform: "uppercase",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  rowMeta: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 15,
  },
  rowHandle: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  rowBio: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  centerFill: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    color: colors.ink,
    textAlign: "center",
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
    maxWidth: 320,
  },
  emptyCta: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
  },
  emptyCtaText: {
    fontFamily: fonts.sansBold,
    color: colors.background,
    fontSize: 13,
    letterSpacing: 0.3,
  },
  errorText: {
    fontFamily: fonts.sans,
    color: colors.muted,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.pill,
  },
  retryText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.ink,
  },
});
