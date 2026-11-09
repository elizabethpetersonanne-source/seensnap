import { useLocalSearchParams, router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";
import { Avatar } from "@/components/avatar";
import { AppHeader } from "@/components/headers/app-header";
import { apiRequest, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
type Row = {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_following: boolean;
};
type Page = { items: Row[]; total: number; next_offset: number | null };
export default function FollowsScreen() {
  const { userId, mode: initialMode } = useLocalSearchParams<{
    userId: string;
    mode?: string;
  }>();
  const { sessionToken, user } = useAuth();
  const [mode, setMode] = useState(
    initialMode === "followers" ? "followers" : "following",
  );
  const [page, setPage] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [changing, setChanging] = useState<string | null>(null);
  const generation = useRef(0),
    loading = useRef(false),
    changeLock = useRef(false);
  async function load(offset = 0, version = generation.current) {
    if (!sessionToken || loading.current) return;
    loading.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<Page>(
        `/profiles/${userId}/${mode}?offset=${offset}&limit=40`,
        { token: sessionToken },
      );
      if (version === generation.current)
        setPage((old) => ({
          ...next,
          items:
            offset && old
              ? [
                  ...new Map(
                    [...old.items, ...next.items].map((r) => [r.user_id, r]),
                  ).values(),
                ]
              : next.items,
        }));
    } catch (e) {
      if (version === generation.current) {
        if (e instanceof ApiError && [403, 404].includes(e.status))
          setPage(null);
        setError(
          "Could not load these people. The profile may no longer be available to you.",
        );
      }
    } finally {
      if (version === generation.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const version = ++generation.current;
    loading.current = false;
    setPage(null);
    void load(0, version);
    return () => {
      generation.current++;
      loading.current = false;
    };
  }, [sessionToken, userId, mode]);
  useEffect(
    () => setMode(initialMode === "followers" ? "followers" : "following"),
    [initialMode, userId],
  );
  async function toggle(row: Row) {
    if (!sessionToken || changeLock.current) return;
    changeLock.current = true;
    setChanging(row.user_id);
    const version = generation.current;
    try {
      await apiRequest(`/profiles/${row.user_id}/follow`, {
        method: row.is_following ? "DELETE" : "POST",
        token: sessionToken,
      });
      if (version === generation.current) {
        setPage((old) =>
          old
            ? {
                ...old,
                items: old.items.map((r) =>
                  r.user_id === row.user_id
                    ? { ...r, is_following: !r.is_following }
                    : r,
                ),
              }
            : old,
        );
      }
    } catch {
      if (version === generation.current)
        setError("Could not update this follow. Please try again.");
    } finally {
      changeLock.current = false;
      setChanging(null);
    }
  }
  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      <AppHeader
        variant="detail"
        leftKind="back"
        title={mode === "following" ? "Following" : "Followers"}
      />
      <View style={styles.segmentRow}>
        {["following", "followers"].map((m) => (
          <Pressable
            key={m}
            onPress={() => setMode(m)}
            style={[styles.segmentBtn, mode === m && styles.segmentBtnActive]}
          >
            <Text style={styles.segmentText}>
              {m === "following" ? "Following" : "Followers"}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? (
        <View style={{ padding: 16 }}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => void load(page?.next_offset ?? 0)}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {busy && !page ? <ActivityIndicator color={colors.accent} /> : null}
      <FlatList
        data={page?.items ?? []}
        keyExtractor={(r) => r.user_id}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingBottom: 110,
            maxWidth: 800,
            width: "100%",
            alignSelf: "center",
          },
        ]}
        onEndReached={() => {
          if (page?.next_offset != null && !error) void load(page.next_offset);
        }}
        ListHeaderComponent={
          page ? (
            <Text style={styles.countText}>
              {page.total} {mode}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          page ? (
            <Text style={styles.emptyBody}>No people to show here yet.</Text>
          ) : null
        }
        ListFooterComponent={
          busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : page?.next_offset != null ? (
            <Pressable
              style={styles.retryBtn}
              onPress={() => void load(page.next_offset!)}
            >
              <Text style={styles.retryText}>Load more</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Pressable
              style={{
                flex: 1,
                flexDirection: "row",
                gap: 12,
                alignItems: "center",
              }}
              onPress={() => router.push(`/profile/${item.user_id}`)}
            >
              <Avatar
                uri={item.avatar_url}
                label={item.display_name ?? ""}
                size={44}
              />
              <View style={styles.rowMeta}>
                <Text style={styles.rowName}>
                  {item.display_name ?? item.username ?? "Member"}
                </Text>
                {item.username ? (
                  <Text style={styles.rowHandle}>@{item.username}</Text>
                ) : null}
              </View>
            </Pressable>
            {item.user_id !== user?.user_id ? (
              <Pressable
                disabled={!!changing}
                style={[
                  styles.retryBtn,
                  { minHeight: 44, justifyContent: "center", marginTop: 0 },
                ]}
                onPress={() => void toggle(item)}
              >
                <Text style={styles.retryText}>
                  {changing === item.user_id
                    ? "Saving…"
                    : item.is_following
                      ? "Unfollow"
                      : "Follow"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      />
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
