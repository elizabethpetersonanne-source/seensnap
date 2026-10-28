/**
 * Oct-27 personalization follow-up: Compose a new message.
 *
 * Replaces the inbox-only Messages tab. Searches followers +
 * followed users (via /social/users/search) and opens a direct
 * conversation on tap through the existing startDirectConversation
 * endpoint.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { startDirectConversation } from "@/lib/messaging";
import { colors, fonts, radii, spacing } from "@/constants/theme";


type UserSearchResult = {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
};


export default function NewMessageScreen() {
  const { sessionToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!sessionToken || trimmed.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await apiRequest<UserSearchResult[]>(
          `/social/users/search?q=${encodeURIComponent(trimmed)}&limit=20`,
          { token: sessionToken },
        );
        if (!cancelled) setResults(res);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, sessionToken]);

  async function openConversation(user: UserSearchResult) {
    if (!sessionToken || busyId) return;
    setBusyId(user.user_id);
    try {
      const convoId = await startDirectConversation(sessionToken, user.user_id);
      router.replace(`/messages/${convoId}`);
    } catch (e) {
      setBusyId(null);
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>New Message</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={16} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search people"
          placeholderTextColor={colors.muted2}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={styles.searchInput}
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} hitSlop={6}>
            <Ionicons name="close-circle" size={16} color={colors.muted2} />
          </Pressable>
        ) : null}
      </View>

      {query.trim().length < 2 ? (
        <View style={styles.hint}>
          <Text style={styles.hintBody}>
            Search for someone by name or @username to start a message.
          </Text>
        </View>
      ) : loading ? (
        <View style={styles.hint}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : results.length === 0 ? (
        <View style={styles.hint}>
          <Text style={styles.hintBody}>No people found for "{query}".</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(u) => u.user_id}
          contentContainerStyle={{ paddingVertical: spacing.sm }}
          renderItem={({ item }) => {
            const name = item.display_name ?? item.username ?? "SeenSnap user";
            const sub = item.username && item.username !== item.display_name
              ? `@${item.username}`
              : item.bio;
            return (
              <Pressable
                onPress={() => void openConversation(item)}
                disabled={busyId === item.user_id}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
                accessibilityRole="button"
                accessibilityLabel={`Start a conversation with ${name}`}
              >
                {item.avatar_url ? (
                  <Image source={{ uri: item.avatar_url }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Ionicons name="person" size={16} color={colors.muted2} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{name}</Text>
                  {sub ? <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text> : null}
                </View>
                {busyId === item.user_id ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Ionicons name="chevron-forward" size={16} color={colors.muted2} />
                )}
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  headerTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 15 },
  searchWrap: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.1)",
  },
  searchInput: {
    flex: 1,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  hint: { padding: spacing.lg, alignItems: "center" },
  hintBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface },
  avatarFallback: { alignItems: "center", justifyContent: "center" },
  rowName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 14 },
  rowSub: { marginTop: 2, color: colors.muted, fontFamily: fonts.sans, fontSize: 11 },
});
