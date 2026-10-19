/**
 * Oct-18 UI/UX rebuild: immersive Team Home.
 *
 * Full-screen hero + 4-poster continuation strip per section, vertical
 * paging between Top Picks → Recently Added → Both Want to Watch →
 * Watched. Right-side vertical action rail per spec image 5.
 *
 * Routed to from the Teams tab (team card tap).
 */
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { FullBleedPosterSection, type FullBleedTitle, type VerticalRailAction } from "@/components/full-bleed-poster-section";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { fetchTeamHome, type TeamHomeSections, type TeamHomeTitle } from "@/lib/team-home";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";


type SectionKey = "top_picks" | "recently_added" | "both_want_to_watch" | "watched";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "top_picks", label: "TOP PICKS" },
  { key: "recently_added", label: "RECENTLY ADDED" },
  { key: "both_want_to_watch", label: "BOTH WANT TO WATCH" },
  { key: "watched", label: "WATCHED" },
];


function teamTitleToFullBleed(t: TeamHomeTitle): FullBleedTitle {
  return {
    id: t.id,
    title: t.title,
    poster_url: t.poster_url,
    backdrop_url: t.backdrop_url,
    year: t.year,
    rank_label: t.rank_label,
    context_label: t.context_label,
  };
}


export default function TeamHomeScreen() {
  const { sessionToken } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const params = useLocalSearchParams<{ teamId: string }>();
  const teamId = typeof params.teamId === "string" ? params.teamId : undefined;

  const [data, setData] = useState<TeamHomeSections | null>(null);
  const [loading, setLoading] = useState(true);
  const [titleModalId, setTitleModalId] = useState<string | null>(null);
  const [universalTitle, setUniversalTitle] = useState<UniversalTitle | null>(null);
  const [titleLoading, setTitleLoading] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!sessionToken || !teamId) return;
      setLoading(true);
      fetchTeamHome(sessionToken, teamId)
        .then((res) => { if (!cancelled) setData(res); })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, [sessionToken, teamId]),
  );

  // Reserve bottom padding so the pill nav doesn't cover the posters.
  // Tab bar is hidden on this route via the parent screen options.
  const reservedBottom = insets.bottom + 56;
  const sectionHeight = height - insets.top - reservedBottom;

  // Flatten all sections into a sectioned list. Each section renders
  // a FullBleedPosterSection using the first 5 items in that section.
  const pages: { key: string; sectionLabel: string; hero: TeamHomeTitle; four: TeamHomeTitle[] }[] = useMemo(() => {
    if (!data) return [];
    const result: { key: string; sectionLabel: string; hero: TeamHomeTitle; four: TeamHomeTitle[] }[] = [];
    for (const section of SECTIONS) {
      const items = data[section.key] ?? [];
      if (items.length === 0) continue;
      // One hero + up to 4 continuation per section (first group of 5).
      result.push({
        key: `${section.key}-${items[0].id}`,
        sectionLabel: section.label,
        hero: items[0],
        four: items.slice(1, 5),
      });
    }
    return result;
  }, [data]);

  async function openTitle(titleId: string) {
    if (!sessionToken) return;
    setTitleModalId(titleId);
    setTitleLoading(true);
    try {
      const detail = await fetchUniversalTitle(sessionToken, titleId);
      setUniversalTitle(detail);
    } catch {
      setUniversalTitle(null);
    } finally {
      setTitleLoading(false);
    }
  }

  function buildRail(title: TeamHomeTitle): VerticalRailAction[] {
    // Team variant: Like · Comment · Save · Send · Rate.
    // No "add to team" button — you ARE in the team.
    return [
      { key: "like", icon: "heart-outline", label: "Like" },
      { key: "comment", icon: "chatbubble-outline", label: "Comment" },
      {
        key: "save",
        icon: "bookmark-outline",
        label: "Save",
        onPress: () => {
          setSaveTitleId(title.id);
          setShowSaveSheet(true);
          trackEvent("team_home_save", { team_id: teamId ?? null, title_id: title.id });
        },
      },
      {
        key: "send",
        icon: "paper-plane-outline",
        label: "Send",
        onPress: () => {
          trackEvent("team_home_send", { team_id: teamId ?? null, title_id: title.id });
          void Share.share({ message: `${title.title} — on SeenSnap` }).catch(() => {});
        },
      },
      {
        key: "rate",
        icon: "star-outline",
        label: "Rate",
        onPress: () => void openTitle(title.id),
      },
    ];
  }

  if (!teamId) {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.emptyBody}>Missing team.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>{data?.team_name ?? "Team"}</Text>
          {data ? (
            <Text style={styles.headerSub}>{data.member_count} member{data.member_count === 1 ? "" : "s"}</Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => router.push({ pathname: "/(tabs)/teams" })}
          hitSlop={10}
          style={styles.settingsBtn}
          accessibilityLabel="Team settings"
        >
          <Ionicons name="settings-outline" size={20} color={colors.muted} />
        </Pressable>
      </View>

      {loading && !data ? (
        <View style={[styles.center, { height: sectionHeight }]}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : pages.length === 0 ? (
        <View style={[styles.center, { height: sectionHeight }]}>
          <Ionicons name="people-outline" size={28} color={colors.muted} />
          <Text style={styles.emptyTitle}>Nothing here yet.</Text>
          <Text style={styles.emptyBody}>Add titles to this team to see them show up as sections here.</Text>
        </View>
      ) : (
        <FlatList
          data={pages}
          keyExtractor={(p) => p.key}
          snapToInterval={sectionHeight}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <View style={{ height: sectionHeight }}>
              <FullBleedPosterSection
                heroHeight={sectionHeight}
                sectionKicker={item.sectionLabel}
                hero={teamTitleToFullBleed(item.hero)}
                four={item.four.map(teamTitleToFullBleed)}
                onPressHero={() => void openTitle(item.hero.id)}
                onPressContinuation={(t) => void openTitle(t.id)}
                railActions={buildRail(item.hero)}
              />
            </View>
          )}
        />
      )}

      <UniversalTitleModal
        visible={titleModalId !== null}
        title={universalTitle}
        loading={titleLoading}
        onClose={() => {
          setTitleModalId(null);
          setUniversalTitle(null);
        }}
      />

      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="team_home"
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onSaved={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
      />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingTop: 4,
    paddingBottom: 8,
    zIndex: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
  },
  headerTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 15,
    letterSpacing: 0.1,
  },
  headerSub: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 10,
    marginTop: 2,
    letterSpacing: 0.4,
  },
  settingsBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    gap: 8,
  },
  emptyTitle: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 18,
    marginTop: 8,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    textAlign: "center",
    maxWidth: 280,
  },
});
