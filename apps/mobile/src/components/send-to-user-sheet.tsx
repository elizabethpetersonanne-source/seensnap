/**
 * SendToUserSheet — Messaging spec §73.
 *
 * ONE reusable send flow for every SeenSnap surface. Never fork the
 * send UX into per-surface variants; wire this component in wherever
 * you need a "Send to someone" affordance.
 *
 * Props:
 *   visible          — sheet open/closed
 *   token            — session token
 *   contentType      — 'title' | 'list' | undefined (undefined = pure text)
 *   contentId        — required if contentType is set
 *   sourceSurface    — analytics attribution ('title_detail', 'my_picks', …)
 *   preview          — optional { headline, subline, thumbnailUrl } shown at
 *                      the top of the sheet so the sender sees what they're
 *                      sending. Purely presentational.
 *   onClose          — called when the user dismisses OR after a successful send
 *   onSent           — called after a successful send with the created message
 *   onError          — called on any send failure
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { apiRequest } from "@/lib/api";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";
import {
  MessageContentType,
  MessageDto,
  sendMessage,
  startDirectConversation,
} from "@/lib/messaging";

type Recipient = {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
};

type Props = {
  visible: boolean;
  token: string | null;
  contentType?: MessageContentType;
  contentId?: string;
  sourceSurface: string;
  preview?: {
    headline: string;
    subline?: string | null;
    thumbnailUrl?: string | null;
  };
  onClose: () => void;
  onSent?: (message: MessageDto, recipient: Recipient) => void;
  onError?: (message: string) => void;
};

export function SendToUserSheet({
  visible,
  token,
  contentType,
  contentId,
  sourceSurface,
  preview,
  onClose,
  onSent,
  onError,
}: Props) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Recipient[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [selected, setSelected] = useState<Recipient | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  // Fetch initial suggestion pool (people you follow) when the sheet opens.
  useEffect(() => {
    if (!visible || !token) return;
    setQuery("");
    setSelected(null);
    setNote("");
    setLoadingRecipients(true);
    // /social/users/search with empty query returns a small default cohort
    // (mutual + following); we use it as the "recent" list. When user types,
    // we re-hit /social/users/search with their query.
    apiRequest<Recipient[]>("/social/users/search?q=", { token })
      .then((rows) => setSuggestions(rows ?? []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoadingRecipients(false));
    trackEvent("send_sheet_opened", {
      source_surface: sourceSurface,
      content_type: contentType ?? null,
    });
  }, [visible, token, sourceSurface, contentType]);

  const runSearch = useCallback(async (q: string) => {
    if (!token) return;
    if (q.trim().length < 2) return;
    setLoadingRecipients(true);
    try {
      const rows = await apiRequest<Recipient[]>(
        `/social/users/search?q=${encodeURIComponent(q.trim())}`,
        { token },
      );
      setSuggestions(rows ?? []);
    } catch {
      // silent — empty results is fine
    } finally {
      setLoadingRecipients(false);
    }
  }, [token]);

  async function handleSend() {
    if (!token || !selected || sending) return;
    setSending(true);
    try {
      const conversationId = await startDirectConversation(token, selected.user_id);
      const clientMessageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const message = await sendMessage(token, conversationId, {
        textBody: note.trim() || undefined,
        contentType,
        contentId,
        clientMessageId,
        sourceSurface,
      });
      onSent?.(message, selected);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      onError?.(msg);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>Send to</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>

          {preview ? (
            <View style={styles.preview}>
              {preview.thumbnailUrl ? (
                <Image source={{ uri: preview.thumbnailUrl }} style={styles.previewThumb} resizeMode="cover" />
              ) : (
                <View style={[styles.previewThumb, styles.previewThumbEmpty]}>
                  <Ionicons name="film-outline" size={18} color={colors.muted} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.previewHeadline} numberOfLines={1}>{preview.headline}</Text>
                {preview.subline ? (
                  <Text style={styles.previewSubline} numberOfLines={1}>{preview.subline}</Text>
                ) : null}
              </View>
            </View>
          ) : null}

          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={colors.muted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={(v) => {
                setQuery(v);
                void runSearch(v);
              }}
              placeholder="Search SeenSnap"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {loadingRecipients ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.md }} />
          ) : (
            <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
              {suggestions.length === 0 ? (
                <Text style={styles.emptyBody}>
                  {query.trim().length < 2 ? "Follow someone to send them titles." : "No matches."}
                </Text>
              ) : (
                suggestions.map((r) => {
                  const isSelected = selected?.user_id === r.user_id;
                  return (
                    <Pressable
                      key={r.user_id}
                      style={[styles.recipientRow, isSelected && styles.recipientRowSelected]}
                      onPress={() => setSelected(r)}
                    >
                      <View style={styles.avatarBubble}>
                        <Text style={styles.avatarInitial}>
                          {(r.display_name ?? r.username ?? "?").slice(0, 1).toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.recipientName} numberOfLines={1}>
                          {r.display_name ?? "SeenSnap user"}
                        </Text>
                        {r.username ? (
                          <Text style={styles.recipientHandle} numberOfLines={1}>
                            @{r.username}
                          </Text>
                        ) : null}
                      </View>
                      {isSelected ? (
                        <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
                      ) : null}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          )}

          {selected ? (
            <View style={styles.composerBlock}>
              <TextInput
                style={styles.composerInput}
                value={note}
                onChangeText={setNote}
                placeholder="Add a message…"
                placeholderTextColor={colors.muted}
                multiline
                maxLength={500}
              />
              <Pressable
                onPress={() => void handleSend()}
                disabled={sending}
                style={({ pressed }) => [
                  styles.sendBtn,
                  pressed && { opacity: 0.85 },
                  sending && { opacity: 0.5 },
                ]}
              >
                <Text style={styles.sendBtnText}>
                  {sending ? "Sending…" : `Send to ${selected.display_name ?? "them"}`}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    maxHeight: "80%",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 22,
  },
  preview: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    marginBottom: spacing.md,
  },
  previewThumb: {
    width: 40,
    height: 60,
    borderRadius: 3,
    backgroundColor: colors.surface,
  },
  previewThumbEmpty: {
    alignItems: "center",
    justifyContent: "center",
  },
  previewHeadline: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
  },
  previewSubline: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.sm,
    marginBottom: spacing.md,
  },
  searchInput: {
    flex: 1,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  results: {
    maxHeight: 260,
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontStyle: "italic",
    padding: spacing.md,
  },
  recipientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  recipientRowSelected: {
    backgroundColor: "rgba(244,196,48,0.08)",
  },
  avatarBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
  },
  recipientName: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
  },
  recipientHandle: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  composerBlock: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  composerInput: {
    minHeight: 60,
    maxHeight: 140,
    padding: 12,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surfaceSoft,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingVertical: 14,
    alignItems: "center",
  },
  sendBtnText: {
    color: colors.background,
    fontFamily: fonts.monoSemiBold,
    fontSize: 12,
    letterSpacing: 1.0,
    textTransform: "uppercase",
  },
});
