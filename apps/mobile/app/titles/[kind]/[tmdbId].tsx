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
import { ActivityIndicator, Pressable, Text, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/components/headers/app-header";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { fetchUniversalTitle, fetchUniversalTitleByTmdbId, type UniversalTitle } from "@/lib/universal-title";
import { isStrictNumericId, isUuid, normalizeMediaType } from "@/lib/title-ref";

export default function SharedTitleScreen() {
  const { kind, tmdbId } = useLocalSearchParams<{ kind: string; tmdbId: string }>();
  const { sessionToken } = useAuth();
  const [title, setTitle] = useState<UniversalTitle | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry,setRetry]=useState(0);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);

  useEffect(() => {
    if (!tmdbId) return;
    trackEvent("shared_title_opened", { kind, tmdb_id: tmdbId });
    let cancelled = false;setLoading(true);setTitle(null);
    async function load() {
      try {
        const mediaType = normalizeMediaType(kind);
        if(!mediaType)return;
        // Oct-27 spec ID-01: strict external parse. The {tmdbId} slot
        // must be either a strictly numeric TMDB id OR an internal
        // UUID — never a partial numeric parse of a UUID that starts
        // with digits. The Social → external-route bug was
        // Number.parseInt("550abc…") → 550, which surfaced the
        // wrong movie.
        if (isStrictNumericId(tmdbId)) {
          const detail = await fetchUniversalTitleByTmdbId(sessionToken ?? "", mediaType, Number(tmdbId));
          if (!cancelled) setTitle(detail);
          return;
        }
        if (isUuid(tmdbId)) {
          // Internal UUID handed to the external route — happens when
          // an in-app caller doesn't have a TMDB id yet. Resolve via
          // the UUID endpoint.
          const detail = await fetchUniversalTitle(sessionToken ?? "", tmdbId);
          if (!cancelled) setTitle(detail);
          return;
        }
        // Neither numeric nor UUID → modal shows an empty state.
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
  }, [kind, tmdbId, sessionToken,retry]);

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      <AppHeader variant="detail" leftKind="back" title={title?.title??"Shared title"}/>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}
      <UniversalTitleModal
        visible={!loading && !!title}
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
      {!loading&&!title?<View style={styles.center}><Text style={{fontSize:16,color:colors.ink}}>This title could not be loaded. Check your connection or ask for a new link.</Text><Pressable style={{minHeight:44,padding:12}} onPress={()=>setRetry(n=>n+1)}><Text style={{color:colors.accent,fontSize:16}}>Retry</Text></Pressable></View>:null}
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
