/**
 * Messages Inbox — Messaging spec §7-§8.
 *
 * Deliberately simple: one row per conversation, most recent first,
 * unread indicator, tap → conversation. No fake conversations in the
 * empty state (spec §8).
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import {
  ConversationSummary,
  fetchInbox,
  markConversationRead,
} from "@/lib/messaging";
import { trackEvent } from "@/lib/analytics";

export default function MessagesInboxScreen() {
  const { sessionToken } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionToken) return;
    try {
      setError(null);
      const items = await fetchInbox(sessionToken);
      setConversations(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load messages");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionToken]);

  useFocusEffect(
    useCallback(() => {
      trackEvent("messages_inbox_viewed", {});
      void load();
    }, [load]),
  );

  function openConversation(convoId: string) {
    // Mark read immediately for perceived snappiness — server call happens
    // inside the conversation screen too, so double-firing is fine.
    if (sessionToken) void markConversationRead(sessionToken, convoId).catch(() => {});
    router.push(`/messages/${convoId}`);
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Messages</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorTitle}>Couldn't load messages</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void load()}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        </View>
      ) : !conversations || conversations.length === 0 ? (
        <View style={styles.emptyRoot}>
          <View style={styles.emptyIcon}>
            <Ionicons name="chatbubbles-outline" size={38} color={colors.accent} />
          </View>
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptyBody}>
            Send a movie, show, or list to someone you follow and the conversation will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c.conversation_id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.accent}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => openConversation(item.conversation_id)}
            >
              <View style={styles.avatarBubble}>
                {item.other_user.avatar_url ? (
                  <Image
                    source={{ uri: item.other_user.avatar_url }}
                    style={styles.avatarImage}
                  />
                ) : (
                  <Text style={styles.avatarInitial}>
                    {(item.other_user.display_name ?? item.other_user.username ?? "?")
                      .slice(0, 1)
                      .toUpperCase()}
                  </Text>
                )}
                {item.unread_count > 0 ? <View style={styles.unreadDot} /> : null}
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.other_user.display_name ?? "SeenSnap user"}
                  </Text>
                  <Text style={styles.timestamp}>{relativeTime(item.updated_at)}</Text>
                </View>
                <Text
                  style={[
                    styles.preview,
                    item.unread_count > 0 && styles.previewUnread,
                  ]}
                  numberOfLines={1}
                >
                  {previewFor(item)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function previewFor(c: ConversationSummary): string {
  const last = c.last_message;
  if (!last) return "New conversation";
  if (last.content_type === "title") {
    const name = (last.snapshot as { title?: string } | undefined)?.title ?? "a title";
    return last.text_body ? `🎬 ${name} — "${last.text_body}"` : `🎬 ${name}`;
  }
  if (last.content_type === "list") {
    const name = (last.snapshot as { name?: string } | undefined)?.name ?? "a list";
    return last.text_body ? `📚 ${name} — "${last.text_body}"` : `📚 ${name}`;
  }
  return last.text_body ?? "";
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 22,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  errorTitle: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 18 },
  errorBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, textAlign: "center" },
  retryBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.sm,
  },
  retryBtnText: { color: colors.accent, fontFamily: fonts.monoSemiBold, fontSize: 11, letterSpacing: 1 },
  emptyRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 22 },
  emptyBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 320,
  },
  list: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radii.sm,
  },
  avatarBubble: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  avatarImage: { width: 44, height: 44, borderRadius: 22 },
  avatarInitial: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
  },
  unreadDot: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.background,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  name: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
    flex: 1,
  },
  timestamp: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  preview: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  previewUnread: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
  },
});
