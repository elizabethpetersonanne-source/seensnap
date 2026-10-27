/**
 * Oct-27 spec LINK-01: typed title share resolver.
 *
 * Entry point for /share/t/<kind>/<id> links. Resolves the TitleRef and
 * redirects to the correct detail route — never reuses an unrelated
 * SceneDNA/Discover route. For unknown kinds or inaccessible content,
 * shows a neutral unavailable state.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, spacing } from "@/constants/theme";
import { detailPathForRef, isStrictNumericId, isUuid, normalizeMediaType, type MediaType } from "@/lib/title-ref";


export default function TitleShareResolver() {
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const mediaType: MediaType | null = (() => {
      const normalized = normalizeMediaType(kind ?? null);
      if (normalized) return normalized;
      if (kind === "tv") return "series";
      return null;
    })();

    if (!mediaType || !id) {
      setUnavailable(true);
      return;
    }

    if (isUuid(id)) {
      router.replace(detailPathForRef({ titleId: id, tmdbId: null, mediaType }) as Parameters<typeof router.replace>[0]);
      return;
    }

    if (isStrictNumericId(id)) {
      router.replace(detailPathForRef({ titleId: "", tmdbId: Number(id), mediaType }) as Parameters<typeof router.replace>[0]);
      return;
    }

    setUnavailable(true);
  }, [kind, id]);

  if (unavailable) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.body}>
          <Text style={styles.title}>This link is unavailable</Text>
          <Text style={styles.body2}>
            The title isn't available anymore, or the link is invalid.
          </Text>
          <Pressable onPress={() => router.replace("/(tabs)")} style={styles.btn}>
            <Text style={styles.btnLabel}>Return to Discover</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.subtitle}>Opening…</Text>
      </View>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  title: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 18, textAlign: "center" },
  subtitle: { fontFamily: fonts.sans, color: colors.muted, fontSize: 13 },
  body2: { fontFamily: fonts.sans, color: colors.muted, fontSize: 13, textAlign: "center", lineHeight: 19 },
  btn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderRadius: 10,
  },
  btnLabel: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
});
