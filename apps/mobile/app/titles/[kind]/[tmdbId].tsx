/**
 * Public shared-title deep-link handler — Sharing Phase B.
 *
 * Opened when a user taps a Universal Link like `https://seensnap.app/titles/tv/1399`
 * that iOS/Android has associated with the app, or via the `seensnap://titles/...`
 * scheme fallback. Fetches the title by its TMDB id and hands off to the
 * UniversalTitleModal so the rest of the app treats it like any other title
 * open (save, rate, share, etc.).
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { UniversalTitleModal } from "@/components/universal-title-modal";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { fetchUniversalTitleByTmdbId, type UniversalTitle } from "@/lib/universal-title";

export default function SharedTitleScreen() {
  const { kind, tmdbId } = useLocalSearchParams<{ kind: string; tmdbId: string }>();
  const { sessionToken } = useAuth();
  const [title, setTitle] = useState<UniversalTitle | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);

  useEffect(() => {
    if (!tmdbId) return;
    trackEvent("shared_title_opened", { kind, tmdb_id: tmdbId });
    let cancelled = false;
    async function load() {
      try {
        const mediaType = kind === "tv" ? "series" : "movie";
        const numericId = Number.parseInt(tmdbId, 10);
        if (!Number.isFinite(numericId)) {
          return;
        }
        const detail = await fetchUniversalTitleByTmdbId(sessionToken ?? "", mediaType, numericId);
        if (!cancelled) setTitle(detail);
      } catch {
        // Ignore — the modal will show its own empty state; we then bounce back.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [kind, tmdbId, sessionToken]);

  return (
    <SafeAreaView style={styles.safeArea}>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}
      <UniversalTitleModal
        visible={!loading}
        loading={false}
        title={title}
        onClose={() => {
          if (router.canGoBack()) router.back();
          else router.replace("/(tabs)");
        }}
        onSaveTitle={(detail) => {
          setSaveTitleId(detail.id);
          setShowSaveSheet(true);
        }}
      />
      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="shared_title_deeplink"
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onError={() => {}}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
