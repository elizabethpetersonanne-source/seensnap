/**
 * Conversation screen — Messaging spec §11.
 *
 * Four zones: header, message timeline, composer, attachment picker.
 * MVP intentionally omits typing indicators, read receipts, presence,
 * reactions. Text + title + list attachments only.
 *
 * Polls every 4s while foregrounded (§36 acceptable MVP realtime).
 */
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import {
  fetchMessages,
  markConversationRead,
  MessageDto,
  sendMessage,
} from "@/lib/messaging";
import { trackEvent } from "@/lib/analytics";

const POLL_INTERVAL_MS = 4_000; // spec §36 — acceptable MVP realtime

export default function ConversationScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { sessionToken, user } = useAuth();
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    if (!sessionToken || !conversationId) return;
    try {
      const items = await fetchMessages(sessionToken, conversationId);
      setMessages(items);
      // Mark read every load — cheap on backend, keeps the inbox badge honest.
      void markConversationRead(sessionToken, conversationId).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load conversation");
    }
  }, [sessionToken, conversationId]);

  useEffect(() => {
    trackEvent("conversation_opened", { conversation_id: conversationId });
    void load();
    const t = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [load, conversationId]);

  useEffect(() => {
    // Auto-scroll to bottom when new messages land.
    if (messages && messages.length > 0) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  }, [messages?.length]);

  async function handleSend() {
    if (!sessionToken || !conversationId) return;
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    const clientMessageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // Optimistic append
    const optimistic: MessageDto = {
      id: `optimistic-${clientMessageId}`,
      conversation_id: conversationId,
      sender_user_id: user?.user_id ?? "me",
      message_type: "text",
      text_body: text,
      content_type: null,
      content_id: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => (prev ? [...prev, optimistic] : [optimistic]));
    setDraft("");
    try {
      const real = await sendMessage(sessionToken, conversationId, {
        textBody: text,
        clientMessageId,
        sourceSurface: "conversation_screen",
      });
      // Reconcile — replace optimistic row with the canonical one.
      setMessages((prev) =>
        prev ? prev.map((m) => (m.id === optimistic.id ? real : m)) : [real],
      );
    } catch (e) {
      setMessages((prev) => (prev ? prev.filter((m) => m.id !== optimistic.id) : prev));
      setDraft(text);
      setError(e instanceof Error ? e.message : "Send failed. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>Conversation</Text>
        <View style={{ width: 22 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={80}
        style={{ flex: 1 }}
      >
        {messages === null ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.timeline}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          >
            {messages.length === 0 ? (
              <Text style={styles.emptyBody}>
                No messages yet. Send the first one to start the conversation.
              </Text>
            ) : (
              messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isMe={m.sender_user_id === user?.user_id}
                />
              ))
            )}
          </ScrollView>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.composerRow}>
          <TextInput
            style={styles.composerInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message"
            placeholderTextColor={colors.muted}
            multiline
            maxLength={1000}
          />
          <Pressable
            onPress={() => void handleSend()}
            disabled={sending || draft.trim().length === 0}
            style={({ pressed }) => [
              styles.sendBtn,
              (sending || draft.trim().length === 0) && { opacity: 0.4 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="send" size={16} color={colors.background} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({ message, isMe }: { message: MessageDto; isMe: boolean }) {
  const isContent = message.content_type === "title" || message.content_type === "list";
  return (
    <View style={[styles.bubbleWrap, isMe ? styles.bubbleWrapMe : styles.bubbleWrapThem]}>
      {isContent ? <ContentCard message={message} /> : null}
      {message.text_body ? (
        <View
          style={[
            styles.textBubble,
            isMe ? styles.textBubbleMe : styles.textBubbleThem,
          ]}
        >
          <Text style={[styles.bubbleText, isMe && styles.bubbleTextMe]}>
            {message.text_body}
          </Text>
        </View>
      ) : null}
      <Text style={styles.bubbleTime}>{relativeTime(message.created_at)}</Text>
    </View>
  );
}

function ContentCard({ message }: { message: MessageDto }) {
  if (message.content_type === "title") {
    const t = message.title;
    if (!t) {
      const snap = message.snapshot as { title?: string } | undefined;
      return (
        <View style={styles.contentCardGone}>
          <Text style={styles.contentCardGoneText}>
            {snap?.title ? `"${snap.title}" is no longer available.` : "This title is no longer available."}
          </Text>
        </View>
      );
    }
    return (
      <Pressable
        style={styles.titleCard}
        onPress={() => router.push(`/titles/${t.content_type === "movie" ? "movie" : "tv"}/${t.tmdb_id}`)}
      >
        {t.poster_url ? (
          <Image source={{ uri: t.poster_url }} style={styles.titleCardPoster} />
        ) : (
          <View style={[styles.titleCardPoster, styles.titleCardPosterEmpty]}>
            <Ionicons name="film-outline" size={22} color={colors.muted} />
          </View>
        )}
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.titleCardName} numberOfLines={2}>{t.title}</Text>
          <Text style={styles.titleCardMeta}>
            {t.content_type === "movie" ? "FILM" : "SERIES"}{t.year ? ` · ${t.year}` : ""}
          </Text>
          <Text style={styles.titleCardOpen}>Open →</Text>
        </View>
      </Pressable>
    );
  }
  if (message.content_type === "list") {
    const l = message.list;
    if (!l) {
      const snap = message.snapshot as { name?: string } | undefined;
      return (
        <View style={styles.contentCardGone}>
          <Text style={styles.contentCardGoneText}>
            {snap?.name ? `"${snap.name}" is no longer available.` : "This list is no longer available."}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.listCard}>
        <Ionicons name="albums-outline" size={20} color={colors.accent} />
        <View style={{ flex: 1 }}>
          <Text style={styles.titleCardName}>{l.name}</Text>
          {l.description ? (
            <Text style={styles.titleCardMeta} numberOfLines={2}>{l.description}</Text>
          ) : null}
        </View>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 18,
    flex: 1,
    textAlign: "center",
  },
  centerState: { flex: 1, alignItems: "center", justifyContent: "center" },
  timeline: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    textAlign: "center",
    marginTop: spacing.xl,
  },
  bubbleWrap: { maxWidth: "82%", gap: 4 },
  bubbleWrapMe: { alignSelf: "flex-end", alignItems: "flex-end" },
  bubbleWrapThem: { alignSelf: "flex-start", alignItems: "flex-start" },
  textBubble: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: rules.default,
  },
  textBubbleMe: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  textBubbleThem: {},
  bubbleText: {
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 19,
  },
  bubbleTextMe: {
    color: colors.background,
  },
  bubbleTime: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.3,
  },
  titleCard: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: 10,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
    maxWidth: 320,
  },
  titleCardPoster: {
    width: 60,
    height: 90,
    borderRadius: 4,
    backgroundColor: colors.surfaceSoft,
  },
  titleCardPosterEmpty: {
    alignItems: "center",
    justifyContent: "center",
  },
  titleCardName: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  titleCardMeta: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  titleCardOpen: {
    color: colors.accent,
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  listCard: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    padding: 10,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.gold,
    maxWidth: 320,
  },
  contentCardGone: {
    padding: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
  },
  contentCardGoneText: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontStyle: "italic",
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    paddingHorizontal: spacing.md,
    paddingBottom: 4,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: rules.default,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surfaceSoft,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
});
