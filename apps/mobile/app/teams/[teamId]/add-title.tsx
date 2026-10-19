/**
 * Oct-19: Add Title to a Team.
 *
 * Search the global catalog, tap a result, we POST to
 * /teams/{id}/titles with content_title_id. Mirrors the add-to-story
 * flow but writes into the team's shared pool.
 */
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/components/headers/app-header";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";


type SearchItem = {
  id: string;
  tmdb_id: number;
  title: string;
  content_type: string;
  poster_url: string | null;
  release_date: string | null;
};


export default function AddTeamTitleScreen() {
  const router = useRouter();
  const { sessionToken } = useAuth();
  const params = useLocalSearchParams<{ teamId: string }>();
  const teamId = typeof params.teamId === "string" ? params.teamId : undefined;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionToken || !query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await apiRequest<SearchItem[]>(
          `/titles/search?q=${encodeURIComponent(query.trim())}`,
          { token: sessionToken },
        );
        if (cancelled) return;
        setResults(res ?? []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, sessionToken]);

  async function addTitle(item: SearchItem) {
    if (!sessionToken || !teamId || adding) return;
    setAdding(item.id);
    setError(null);
    try {
      await apiRequest(`/teams/${teamId}/titles`, {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ content_title_id: item.id, also_post_to_feed: true }),
      });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that title.");
    } finally {
      setAdding(null);
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <AppHeader
          variant="detail"
          leftKind="close"
          title="Add Title"
          hideProfileAvatar
        />

        <View style={styles.body}>
          <Text style={styles.lead}>Pick a movie or series to share with your team.</Text>

          <View style={styles.searchRow}>
            <Ionicons name="search" size={14} color={colors.muted2} />
            <TextInput
              autoFocus
              placeholder="Find a title"
              placeholderTextColor={colors.muted2}
              value={query}
              onChangeText={setQuery}
              style={styles.searchInput}
            />
          </View>

          {searching ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [styles.resultRow, pressed && { opacity: 0.6 }]}
                  onPress={() => void addTitle(item)}
                  disabled={adding !== null}
                >
                  {item.poster_url ? (
                    <Image source={{ uri: item.poster_url }} style={styles.resultArt} />
                  ) : (
                    <View style={[styles.resultArt, styles.resultArtFallback]}>
                      <Ionicons name="film-outline" size={14} color={colors.muted2} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultTitle} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.resultSub} numberOfLines={1}>
                      {item.content_type === "movie" ? "MOVIE" : "SERIES"}
                      {item.release_date ? ` · ${item.release_date.slice(0, 4)}` : ""}
                    </Text>
                  </View>
                  {adding === item.id ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <Ionicons name="add-circle" size={22} color={colors.accent} />
                  )}
                </Pressable>
              )}
              ListEmptyComponent={
                query.trim() ? (
                  <Text style={styles.empty}>No matches.</Text>
                ) : (
                  <Text style={styles.empty}>Start typing to find a title.</Text>
                )
              }
              keyboardShouldPersistTaps="handled"
            />
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: 10 },
  lead: { fontFamily: fonts.sans, color: colors.muted, fontSize: 12, marginBottom: 4 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 14,
    padding: 0,
  },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xl },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  resultArt: {
    width: 36,
    height: 54,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  resultArtFallback: { alignItems: "center", justifyContent: "center" },
  resultTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  resultSub: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 11, letterSpacing: 0.4 },
  empty: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    textAlign: "center",
    padding: spacing.xl,
  },
  error: {
    marginTop: 8,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    fontSize: 12,
  },
});
