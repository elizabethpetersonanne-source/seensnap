import { AppHeader } from "@/components/headers/app-header";
/**
 * All of a user's ranked favorites — tapped from the profile RANKED
 * FAVORITES section. Mirrors the /favorites/ranked.tsx shape but
 * reads the public, owner-ordered feed and never surfaces personal
 * scores (brief §7 privacy rule).
 *
 * Supports a "Watch previews" entry at the top so the viewer can
 * launch the preview feed with the owner's exact order.
 */
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useRef } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAudiencePages } from "@/lib/use-audience-pages";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


type RankedRow = {
  position: number;
  title_id: string;
  tmdb_id: number;
  title: string;
  poster_url: string | null;
  year: number | null;
  media_type: string;
};


type RankedResponse = {
  owner_display_name: string | null;
  owner_user_id: string;
  items: RankedRow[];
  total: number;
};


export default function PublicRankedScreen() {
  const { sessionToken } = useAuth();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const { data, nextOffset, checking, busy, error, more, refresh, scope } = useAudiencePages<RankedResponse>(
    `/profiles/${userId}/favorites/ranked`, sessionToken, !!sessionToken && !!userId,
  );
  const list = useRef<FlatList<RankedRow>>(null);
  const position = useRef({ scope, y: 0 });
  if (position.current.scope !== scope) position.current = { scope, y: 0 };

  const ownerName = data?.owner_display_name ?? "This user";

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <AppHeader variant="detail" leftKind="back" title={`${ownerName}'s rankings`} ownsSafeArea={false} />

      {checking ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : error && !data ? (
        <View style={styles.center}>
          <Text style={styles.emptyBody}>{error}</Text>
          <Pressable onPress={refresh} style={styles.previewBtn}>
            <Text style={styles.previewBtnLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : !data || data.items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="trophy-outline" size={28} color={colors.muted} />
          <Text style={styles.emptyBody}>No rankings yet.</Text>
        </View>
      ) : (
        <>
          <Pressable
            style={styles.previewBtn}
            onPress={() =>
              router.push({
                pathname: "/(tabs)/previews",
                params: { ranked_source: String(userId) },
              })
            }
            accessibilityRole="button"
            accessibilityLabel={`Watch previews of ${ownerName}'s rankings`}
          >
            <Ionicons name="play-circle-outline" size={16} color={colors.background} />
            <Text style={styles.previewBtnLabel}>Watch previews</Text>
          </Pressable>

          <FlatList
            ref={list}
            key={scope}
            onScroll={event => { position.current.y = event.nativeEvent.contentOffset.y; }}
            contentOffset={{ x: 0, y: position.current.y }}
            scrollEventThrottle={100}
            onLayout={() => list.current?.scrollToOffset({ offset: position.current.y, animated: false })}
            onEndReached={() => { if (!error) void more(); }}
            onEndReachedThreshold={0.5}
            ListHeaderComponent={<Text style={styles.emptyBody}>{data.total} ranked titles</Text>}
            ListFooterComponent={busy ? <ActivityIndicator color={colors.accent} /> : nextOffset !== null ? (
              <View>
                {error ? <Text accessibilityRole="alert" style={styles.emptyBody}>{error}</Text> : null}
                <Pressable accessibilityRole="button" accessibilityLabel="Load more rankings" onPress={() => void more()} style={styles.previewBtn}>
                  <Text style={styles.previewBtnLabel}>{error ? "Retry" : "Load more rankings"}</Text>
                </Pressable>
              </View>
            ) : null}
            data={data.items}
            keyExtractor={(r) => r.title_id}
            contentContainerStyle={styles.listBody}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.title}`}
                onPress={() => router.push(`/titles/${item.media_type === "movie" ? "movie" : "tv"}/${item.tmdb_id}`)}
                style={styles.row}
              >
                <Text style={styles.rank}>{item.position}</Text>
                {item.poster_url ? (
                  <Image source={{ uri: item.poster_url }} style={styles.poster} />
                ) : (
                  <View style={[styles.poster, styles.posterFallback]}>
                    <Ionicons name="film-outline" size={16} color={colors.muted2} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={2}>{item.title}</Text>
                  <Text style={styles.rowMeta}>
                    {item.media_type === "movie" ? "FILM" : "SERIES"}
                    {item.year ? ` · ${item.year}` : ""}
                  </Text>
                </View>
              </Pressable>
            )}
          />
        </>
      )}
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  iconBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 15 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: spacing.sm },
  emptyBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  previewBtn: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  previewBtnLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.background,
    fontSize: 13,
    letterSpacing: 0.2,
  },
  listBody: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg + 24, gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  rank: {
    width: 28,
    textAlign: "right",
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 13,
  },
  poster: {
    width: 44,
    height: 66,
    borderRadius: 6,
    backgroundColor: colors.surfaceMuted,
  },
  posterFallback: { alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 13 },
  rowMeta: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 11 },
});
