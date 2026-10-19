/**
 * Oct-19 Add-to-Story screen.
 *
 * Pick a title from your watchlist or search the catalog. Optional
 * one-line caption. Posts to /me/stories; the story expires 72h later.
 */
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
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
import { postStory } from "@/lib/stories";


type SearchItem = {
  entity_type: string;
  entity_id: string;
  title: string;
  subtitle?: string | null;
  artwork?: string | null;
  year?: number | null;
};


export default function AddToStoryScreen() {
  const router = useRouter();
  const { sessionToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [caption, setCaption] = useState("");
  const [posting, setPosting] = useState(false);
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
        const res = await apiRequest<{ movies: SearchItem[]; series: SearchItem[] }>(
          `/search?q=${encodeURIComponent(query.trim())}`,
          { token: sessionToken },
        );
        if (cancelled) return;
        setResults([...(res.movies ?? []), ...(res.series ?? [])].slice(0, 20));
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

  async function submit() {
    if (!sessionToken || !selected || posting) return;
    setPosting(true);
    setError(null);
    try {
      await postStory(sessionToken, selected.entity_id, caption.trim() || null);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post your story.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <AppHeader
          variant="detail"
          leftKind="close"
          title="Add to Story"
          rightSlot={
            <Pressable
              onPress={submit}
              hitSlop={10}
              disabled={!selected || posting}
            >
              <Text style={[styles.postLabel, (!selected || posting) && { opacity: 0.4 }]}>
                {posting ? "Posting…" : "Post"}
              </Text>
            </Pressable>
          }
        />

        <View style={styles.body}>
          <Text style={styles.lead}>Expires in 72 hours. Visible to people who follow you.</Text>

          {selected ? (
            <View style={styles.selectedCard}>
              {selected.artwork ? (
                <Image source={{ uri: selected.artwork }} style={styles.selectedPoster} />
              ) : (
                <View style={[styles.selectedPoster, styles.selectedPosterFallback]}>
                  <Ionicons name="film-outline" size={16} color={colors.muted2} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.selectedTitle}>{selected.title}</Text>
                {selected.subtitle ? <Text style={styles.selectedSub}>{selected.subtitle}</Text> : null}
              </View>
              <Pressable onPress={() => setSelected(null)} hitSlop={10}>
                <Ionicons name="close-circle" size={20} color={colors.muted} />
              </Pressable>
            </View>
          ) : (
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
          )}

          {selected ? (
            <>
              <Text style={styles.label}>Add a Take (optional)</Text>
              <TextInput
                style={styles.captionInput}
                multiline
                value={caption}
                onChangeText={(t) => t.length <= 280 && setCaption(t)}
                placeholder="A line about what you're watching…"
                placeholderTextColor={colors.muted2}
                maxLength={280}
              />
              <Text style={styles.counter}>{280 - caption.length} left</Text>
            </>
          ) : searching ? (
            <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => `${item.entity_type}-${item.entity_id}`}
              renderItem={({ item }) => (
                <Pressable style={styles.resultRow} onPress={() => setSelected(item)}>
                  {item.artwork ? (
                    <Image source={{ uri: item.artwork }} style={styles.resultArt} />
                  ) : (
                    <View style={[styles.resultArt, styles.selectedPosterFallback]}>
                      <Ionicons name="film-outline" size={14} color={colors.muted2} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultTitle} numberOfLines={1}>{item.title}</Text>
                    {item.subtitle ? (
                      <Text style={styles.resultSub} numberOfLines={1}>{item.subtitle}</Text>
                    ) : null}
                  </View>
                  <Ionicons name="chevron-forward" size={14} color={colors.muted2} />
                </Pressable>
              )}
              ListEmptyComponent={
                query.trim() ? (
                  <Text style={styles.emptyLabel}>No matches.</Text>
                ) : (
                  <Text style={styles.emptyLabel}>Start typing to find a title.</Text>
                )
              }
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
  postLabel: { fontFamily: fonts.sansSemiBold, color: colors.accent, fontSize: 14 },
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
  resultTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  resultSub: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  emptyLabel: { fontFamily: fonts.sans, color: colors.muted, fontSize: 13, textAlign: "center", padding: spacing.xl },
  selectedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  selectedPoster: {
    width: 44,
    height: 66,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  selectedPosterFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  selectedTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  selectedSub: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  label: {
    marginTop: 12,
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1,
  },
  captionInput: {
    minHeight: 80,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    textAlignVertical: "top",
  },
  counter: {
    textAlign: "right",
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 11,
  },
  error: {
    marginTop: 8,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    fontSize: 12,
  },
});
