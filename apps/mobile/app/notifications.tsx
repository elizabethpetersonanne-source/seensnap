import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SSCompactHeader } from "@/components/headers/ss-compact-header";

import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from "@/lib/notifications";
import { trackEvent } from "@/lib/analytics";

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function NotificationRow({
  item,
  onPress,
}: {
  item: NotificationItem;
  onPress: (item: NotificationItem) => void;
}) {
  const isUnread = item.read_at === null;

  return (
    <Pressable
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowInner}>
        {/* Gold unread indicator */}
        <View style={[styles.unreadDot, !isUnread && styles.unreadDotHidden]} />

        <View style={styles.rowContent}>
          <Text style={[styles.rowTitle, isUnread && styles.rowTitleUnread]} numberOfLines={2}>
            {item.title}
          </Text>
          {item.body ? (
            <Text style={styles.rowBody} numberOfLines={2}>
              {item.body}
            </Text>
          ) : null}
          <Text style={styles.rowMeta}>{timeAgo(item.created_at)}</Text>
        </View>

        <Ionicons
          name="chevron-forward"
          size={12}
          color={colors.muted2}
          style={styles.rowChevron}
        />
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const { sessionToken } = useAuth();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const loadedRef = useRef(false);

  const load = useCallback(
    async (cursor?: string) => {
      if (!sessionToken) return;
      try {
        const result = await fetchNotifications(sessionToken, cursor);
        if (cursor) {
          setItems((prev) => [...prev, ...result.items]);
        } else {
          setItems(result.items);
        }
        setUnreadCount(result.unread_count);
        setNextCursor(result.next_cursor);
        setHasMore(result.next_cursor !== null);
      } catch {
        // Non-fatal
      }
    },
    [sessionToken],
  );

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load().finally(() => setIsLoading(false));
  }, [load]);

  async function handleLoadMore() {
    if (!hasMore || isLoadingMore || !nextCursor) return;
    setIsLoadingMore(true);
    await load(nextCursor).finally(() => setIsLoadingMore(false));
  }

  async function handleMarkAllRead() {
    if (!sessionToken || unreadCount === 0) return;
    await markAllNotificationsRead(sessionToken);
    setItems((prev) => prev.map((n) => ({ ...n, read_at: new Date().toISOString() })));
    setUnreadCount(0);
  }

  async function handleRowPress(item: NotificationItem) {
    if (!sessionToken) return;

    // Mark read server-side
    if (item.read_at === null) {
      setItems((prev) =>
        prev.map((n) => n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n)
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      await markNotificationRead(sessionToken, item.id).catch(() => {});
    }

    trackEvent("notification_opened", {
      type: item.notification_type,
      destination: item.route ?? "none",
    });

    // Navigate to the notification's route
    if (item.route) {
      try {
        router.push(item.route as Parameters<typeof router.push>[0]);
      } catch {
        router.back();
      }
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={["left", "right"]}>
      <SSCompactHeader
        title="Notifications"
        supporting={unreadCount > 0 ? `${unreadCount} unread` : undefined}
        right={
          <>
            {unreadCount > 0 ? (
              <Pressable onPress={() => void handleMarkAllRead()} hitSlop={8}>
                <Text style={styles.markAllRead}>Mark all read</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
              <Ionicons name="close" size={20} color={colors.ink} />
            </Pressable>
          </>
        }
      />

      {isLoading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Nothing yet.</Text>
          <Text style={styles.emptyBody}>
            Your Watch Team activity will appear here — invites, replies and comments that matter.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={(n) => void handleRowPress(n)} />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          onEndReached={() => void handleLoadMore()}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            isLoadingMore ? (
              <View style={styles.loadMoreState}>
                <ActivityIndicator color={colors.muted2} size="small" />
              </View>
            ) : null
          }
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.md,
  },
  backBtn: {
    paddingBottom: 2,
  },
  headerText: {
    gap: 4,
  },
  eyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: "uppercase",
  },
  goldRule: {
    height: 1,
    width: 32,
    backgroundColor: rules.gold,
  },
  headerTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 26,
    lineHeight: 28,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  markAllRead: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.accent,
    textTransform: "uppercase",
    paddingBottom: 4,
  },
  list: {
    paddingBottom: 40,
  },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowInner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  unreadDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.accent,
    marginTop: 6,
    flexShrink: 0,
  },
  unreadDotHidden: {
    opacity: 0,
  },
  rowContent: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 19,
    color: colors.muted,
  },
  rowTitleUnread: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
  },
  rowBody: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.muted2,
  },
  rowMeta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.3,
    color: colors.muted2,
    textTransform: "uppercase",
    marginTop: 2,
  },
  rowChevron: {
    marginTop: 4,
  },
  separator: {
    height: 1,
    backgroundColor: rules.default,
    marginLeft: spacing.lg + 13,
  },
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  loadMoreState: {
    padding: spacing.lg,
    alignItems: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 32,
    lineHeight: 34,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    maxWidth: 300,
  },
});
