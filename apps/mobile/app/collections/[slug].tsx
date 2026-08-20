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

import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

type TitleItem = {
  id: string;
  content_type: string;
  title: string;
  overview?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  genres: string[];
  release_date?: string | null;
  runtime_minutes?: number | null;
  season_count?: number | null;
  tmdb_rating?: number | null;
};

type CollectionDetail = {
  slug: string;
  title: string;
  subtitle?: string | null;
  thesis?: string | null;
  collection_type: string;
  media_scope: string;
  items: TitleItem[];
};

export default function CollectionDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { sessionToken } = useAuth();
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalTitle, setModalTitle] = useState<UniversalTitle | null>(null);

  useEffect(() => {
    if (!sessionToken || !slug) return;
    setLoading(true);
    apiRequest<CollectionDetail>(`/collections/${slug}`, { token: sessionToken })
      .then(setCollection)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [sessionToken, slug]);

  async function openTitle(titleId: string) {
    if (!sessionToken) return;
    setModalVisible(true);
    setModalLoading(true);
    setModalTitle(null);
    try {
      const t = await fetchUniversalTitle(sessionToken, titleId);
      setModalTitle(t);
    } catch {
      setModalVisible(false);
    } finally {
      setModalLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerLabel}>Collections</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : collection ? (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* Hero mosaic using first 4 posters */}
          {collection.items.length > 0 && (
            <View style={styles.hero}>
              {collection.items.slice(0, 4).map((item, i) => (
                <Image
                  key={item.id}
                  source={{ uri: item.backdrop_url ?? item.poster_url ?? "" }}
                  style={styles.heroSlice}
                  resizeMode="cover"
                />
              ))}
              <View style={styles.heroOverlay} />
              <View style={styles.heroText}>
                <Text style={styles.heroType}>
                  {collection.collection_type === "dynamic_discover" ? "CURATED" : collection.collection_type.toUpperCase()}
                </Text>
                <Text style={styles.heroTitle}>{collection.title}</Text>
                {collection.subtitle ? (
                  <Text style={styles.heroSubtitle}>{collection.subtitle}</Text>
                ) : null}
              </View>
            </View>
          )}

          {collection.thesis ? (
            <Text style={styles.thesis}>{collection.thesis}</Text>
          ) : collection.subtitle ? (
            <Text style={styles.thesis}>{collection.subtitle}</Text>
          ) : null}

          <Text style={styles.countLine}>{collection.items.length} titles</Text>

          <View style={styles.grid}>
            {collection.items.map((item, index) => (
              <Pressable
                key={item.id}
                style={({ pressed }) => [styles.posterCard, pressed && styles.pressed]}
                onPress={() => void openTitle(item.id)}
              >
                {item.poster_url ? (
                  <Image source={{ uri: item.poster_url }} style={styles.poster} resizeMode="cover" />
                ) : (
                  <View style={styles.posterFallback}>
                    <Ionicons name="film" size={22} color={colors.muted2} />
                  </View>
                )}
                <View style={styles.posterMeta}>
                  <Text style={styles.posterIndex}>
                    {String(index + 1).padStart(2, "0")}
                  </Text>
                  <Text numberOfLines={2} style={styles.posterTitle}>{item.title}</Text>
                  <Text style={styles.posterType}>
                    {item.content_type === "movie" ? "FILM" : "SERIES"}
                    {item.release_date ? `  ·  ${item.release_date.slice(0, 4)}` : ""}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      ) : null}

      <UniversalTitleModal
        visible={modalVisible}
        loading={modalLoading}
        title={modalTitle}
        onClose={() => {
          setModalVisible(false);
          setModalTitle(null);
        }}
      />
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
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    color: colors.muted,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  hero: {
    flexDirection: "row",
    height: 200,
    marginHorizontal: -spacing.lg,
    marginTop: -spacing.lg,
    marginBottom: spacing.lg,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  heroSlice: {
    flex: 1,
    height: 200,
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7,11,18,0.55)",
  },
  heroText: {
    position: "absolute",
    bottom: spacing.md,
    left: spacing.lg,
    right: spacing.lg,
  },
  heroType: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.8,
    color: colors.accent,
    marginBottom: 4,
  },
  heroTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 26,
    color: colors.ink,
    lineHeight: 30,
  },
  heroSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: "rgba(255,255,255,0.7)",
    marginTop: 4,
    lineHeight: 18,
  },
  thesis: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 22,
    color: colors.muted,
    marginBottom: spacing.md,
  },
  countLine: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.muted2,
    marginBottom: spacing.lg,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  posterCard: {
    width: "32%",
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  pressed: { opacity: 0.7 },
  poster: {
    width: "100%",
    aspectRatio: 2 / 3,
  },
  posterFallback: {
    width: "100%",
    aspectRatio: 2 / 3,
    backgroundColor: colors.backgroundElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  posterMeta: {
    padding: 6,
    gap: 2,
  },
  posterIndex: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.accent,
    letterSpacing: 0.5,
  },
  posterTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 11,
    color: colors.ink,
    lineHeight: 15,
  },
  posterType: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.muted2,
    letterSpacing: 0.3,
  },
  error: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.danger,
    textAlign: "center",
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
});
