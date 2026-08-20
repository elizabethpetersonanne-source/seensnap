import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
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

import { colors, fonts, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type CollectionSummary = {
  slug: string;
  title: string;
  subtitle?: string | null;
  thesis?: string | null;
  collection_type: string;
  media_scope: string;
  editorial_rank: number;
  poster_urls: string[];
  item_count?: number | null;
};

export default function CollectionsScreen() {
  const { sessionToken } = useAuth();
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionToken) return;
    setLoading(true);
    apiRequest<CollectionSummary[]>("/collections?limit=50", { token: sessionToken })
      .then(setCollections)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [sessionToken]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.ink} />
        </Pressable>
        <View>
          <Text style={styles.headerEyebrow}>EDITORIAL</Text>
          <Text style={styles.headerTitle}>Collections</Text>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {collections.map((coll) => (
            <Pressable
              key={coll.slug}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
              onPress={() => router.push(`/collections/${coll.slug}`)}
            >
              {/* Poster mosaic hero */}
              <View style={styles.heroRow}>
                {coll.poster_urls.slice(0, 4).map((url, i) => (
                  <Image
                    key={i}
                    source={{ uri: url }}
                    style={styles.heroImage}
                    resizeMode="cover"
                  />
                ))}
                {coll.poster_urls.length === 0 && (
                  <View style={[styles.heroImage, styles.heroImageFallback]}>
                    <Ionicons name="library-outline" size={28} color={colors.muted2} />
                  </View>
                )}
                <View style={styles.heroOverlay} />
              </View>

              {/* Info below */}
              <View style={styles.info}>
                <Text style={styles.type}>
                  {coll.collection_type === "dynamic_discover" ? "CURATED" : coll.collection_type.toUpperCase()}
                </Text>
                <Text style={styles.title} numberOfLines={1}>{coll.title}</Text>
                {coll.subtitle ? (
                  <Text style={styles.subtitle} numberOfLines={2}>{coll.subtitle}</Text>
                ) : null}
                <View style={styles.cardFooter}>
                  {coll.item_count ? (
                    <Text style={styles.count}>{coll.item_count} titles</Text>
                  ) : null}
                  <Ionicons name="chevron-forward" size={12} color={colors.muted2} />
                </View>
              </View>
            </Pressable>
          ))}
          <View style={{ height: 40 }} />
        </ScrollView>
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
  headerEyebrow: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.8,
    color: colors.accent,
  },
  headerTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    color: colors.ink,
    marginTop: 2,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  card: {
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  pressed: { opacity: 0.75 },
  heroRow: {
    flexDirection: "row",
    height: 110,
    backgroundColor: colors.backgroundElevated,
  },
  heroImage: {
    flex: 1,
    height: 110,
  },
  heroImageFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7,11,18,0.22)",
  },
  info: {
    padding: spacing.sm,
    gap: 3,
  },
  type: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.accent,
  },
  title: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
    color: colors.ink,
    lineHeight: 20,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.muted,
    lineHeight: 17,
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  count: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted2,
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
