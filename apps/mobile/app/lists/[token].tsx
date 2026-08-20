/**
 * Public shared-list deep-link handler — Sharing Phase B.
 *
 * Opened when a user taps a Universal Link like `https://seensnap.app/lists/{token}`
 * that iOS/Android has associated with the app, or via the `seensnap://lists/{token}`
 * scheme fallback. Renders a read-only view of the shared list; the owner keeps
 * write access via their normal My Picks tab.
 */
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { colors, fonts, radii, spacing } from "@/constants/theme";

type PublicListItem = {
  title_id: string;
  tmdb_id: number;
  title: string;
  content_type: string;
  poster_url: string | null;
  backdrop_url: string | null;
  year: number | null;
};

type PublicList = {
  name: string;
  description: string | null;
  item_count: number;
  shared_by_display_name: string | null;
  items: PublicListItem[];
};

export default function SharedListScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [list, setList] = useState<PublicList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    trackEvent("shared_list_opened", { token });
    let cancelled = false;
    async function load() {
      try {
        // Public endpoint — no auth required. Increments the share's open_count
        // on the server side for owner attribution.
        const data = await apiRequest<PublicList>(`/public/lists/${token}`);
        if (!cancelled) setList(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "This link is no longer active.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)")} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerKicker}>Shared List</Text>
        <View style={{ width: 32 }} />
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorTitle}>Link no longer active</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <Pressable onPress={() => router.replace("/(tabs)")} style={styles.primaryCta}>
            <Text style={styles.primaryCtaText}>Back to SeenSnap</Text>
          </Pressable>
        </View>
      ) : list ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>
              {list.shared_by_display_name ? `Shared by ${list.shared_by_display_name}` : "A SeenSnap list"}
            </Text>
            <Text style={styles.title}>{list.name}</Text>
            {list.description ? <Text style={styles.desc}>{list.description}</Text> : null}
            <Text style={styles.metaLine}>
              {list.item_count} {list.item_count === 1 ? "title" : "titles"}
            </Text>
          </View>
          <View style={styles.grid}>
            {list.items.map((item, idx) => {
              const routeKind = item.content_type === "movie" ? "movie" : "tv";
              return (
                <Pressable
                  key={`${item.title_id}-${idx}`}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
                  onPress={() => {
                    trackEvent("shared_list_title_opened", {
                      token,
                      title_id: item.title_id,
                      tmdb_id: item.tmdb_id,
                    });
                    router.push(`/titles/${routeKind}/${item.tmdb_id}`);
                  }}
                >
                  <View style={styles.poster}>
                    {item.poster_url ? (
                      <Image source={{ uri: item.poster_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                    ) : (
                      <View style={styles.posterFallback}>
                        <Ionicons name="film-outline" size={24} color={colors.muted} />
                      </View>
                    )}
                  </View>
                  <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
                  <Text style={styles.cardMeta}>
                    {item.content_type === "movie" ? "FILM" : "SERIES"}
                    {item.year ? `  ·  ${item.year}` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
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
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  headerKicker: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  content: { padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.lg },
  hero: { gap: 8 },
  eyebrow: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  desc: {
    color: colors.muted,
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 15,
    lineHeight: 21,
  },
  metaLine: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    marginTop: 4,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  card: { width: "47%", gap: 6 },
  poster: {
    width: "100%",
    aspectRatio: 2 / 3,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  posterFallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
    lineHeight: 17,
  },
  cardMeta: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  errorTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 24,
    textAlign: "center",
  },
  errorBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 14,
    textAlign: "center",
    maxWidth: 280,
  },
  primaryCta: {
    marginTop: spacing.md,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  primaryCtaText: {
    color: colors.background,
    fontFamily: fonts.monoSemiBold,
    fontSize: 12,
    letterSpacing: 0.4,
  },
});
