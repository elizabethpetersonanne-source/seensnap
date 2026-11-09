import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import {
  FullBleedPosterSection,
  type VerticalRailAction,
} from "@/components/full-bleed-poster-section";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { RatingEditor } from "@/components/rating-editor";
import {
  TitleActionSheets,
  type TitleActionTarget,
} from "@/components/title-action-sheets";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { apiRequest, ApiError } from "@/lib/api";
import { patchTitleState } from "@/lib/title-state";
import {
  fetchTeamHome,
  fetchTeamPage,
  type SectionKey,
  type TeamHomeSections,
  type TeamHomeTitle,
} from "@/lib/team-home";
import {
  fetchUniversalTitle,
  type UniversalTitle,
} from "@/lib/universal-title";
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "top_picks", label: "TOP PICKS" },
  { key: "recently_added", label: "RECENTLY ADDED" },
  { key: "both_want_to_watch", label: "BOTH WANT TO WATCH" },
  { key: "watched", label: "WATCHED" },
];
export default function TeamHomeScreen() {
  const { sessionToken } = useAuth();
  const router = useRouter();
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const [data, setData] = useState<TeamHomeSections | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Partial<Record<SectionKey, string>>>(
    {},
  );
  const [viewport, setViewport] = useState(600),
    [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<UniversalTitle | null>(null),
    [detailId, setDetailId] = useState<string | null>(null),
    [detailBusy, setDetailBusy] = useState(false);
  const [save, setSave] = useState<TeamHomeTitle | null>(null),
    [rate, setRate] = useState<TeamHomeTitle | null>(null),
    [action, setAction] = useState<TitleActionTarget | null>(null);
  const [statusTitle, setStatusTitle] = useState<TeamHomeTitle | null>(null),
    [position, setPosition] = useState("1"),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    detailGeneration = useRef(0),
    mutating = useRef(false),
    loadingPages = useRef(new Set<SectionKey>()),
    dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    setData(null);
    setSelected({});
    setStatusTitle(null);
    setDetailId(null);
    setRate(null);
    setSave(null);
    setAction(null);
    detailGeneration.current++;
  }, [teamId, sessionToken]);
  useFocusEffect(
    useCallback(() => {
      const version = ++generation.current;
      loadingPages.current.clear();
      setError(null);
      setLoading(true);
      if (!sessionToken || !teamId) return;
      (async () => {
        try {
          const next = await fetchTeamHome(sessionToken, teamId);
          // Preserve access to a selected title beyond page one after returning.
          const previous = dataRef.current;
          if (previous?.team_id === teamId)
            for (const { key } of SECTIONS) {
              while (
                next.next_offsets[key] !== null &&
                next[key].length < (previous[key]?.length ?? 0)
              ) {
                const page = await fetchTeamPage(
                  sessionToken,
                  teamId,
                  key,
                  next.next_offsets[key]!,
                );
                if (version !== generation.current) return;
                next[key].push(...page.items);
                next.next_offsets[key] = page.next_offset;
                next.totals[key] = page.total;
              }
            }
          if (version === generation.current) setData(next);
        } catch (e) {
          if (version === generation.current) {
            if (e instanceof ApiError && [403, 404].includes(e.status))
              setData(null);
            setError(
              "Could not load this team. Check your connection and membership, then retry.",
            );
          }
        } finally {
          if (version === generation.current) setLoading(false);
        }
      })();
      return () => {
        generation.current++;
        detailGeneration.current++;
      };
    }, [teamId, sessionToken, reload]),
  );
  async function more(key: SectionKey) {
    const offset = data?.next_offsets[key];
    if (!sessionToken || offset == null || loadingPages.current.has(key))
      return;
    const version = generation.current;
    loadingPages.current.add(key);
    try {
      const page = await fetchTeamPage(sessionToken, teamId, key, offset);
      if (version !== generation.current) return;
      setData((old) =>
        old
          ? {
              ...old,
              [key]: [
                ...new Map(
                  [...old[key], ...page.items].map((t) => [t.id, t]),
                ).values(),
              ],
              totals: { ...old.totals, [key]: page.total },
              next_offsets: { ...old.next_offsets, [key]: page.next_offset },
            }
          : old,
      );
    } catch {
      if (version === generation.current)
        setError("Could not load more titles. Scroll again to retry.");
    } finally {
      if (version === generation.current) loadingPages.current.delete(key);
    }
  }
  async function openTitle(id: string) {
    if (!sessionToken) return;
    const version = ++detailGeneration.current;
    setDetailId(id);
    setDetail(null);
    setDetailBusy(true);
    try {
      const result = await fetchUniversalTitle(sessionToken, id);
      if (version === detailGeneration.current) setDetail(result);
    } catch {
      if (version === detailGeneration.current) {
        setDetailId(null);
        setError("Could not load title details. Please try again.");
      }
    } finally {
      if (version === detailGeneration.current) setDetailBusy(false);
    }
  }
  async function mutate(path: string, body: object, done?: () => void) {
    if (!sessionToken || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError(null);
    const version = generation.current;
    try {
      await apiRequest(`/teams/${teamId}/${path}`, {
        token: sessionToken,
        method: path.startsWith("rankings/") ? "PATCH" : "PUT",
        body: JSON.stringify(body),
      });
      if (version === generation.current) {
        done?.();
        setReload((n) => n + 1);
      }
    } catch (e) {
      if (version === generation.current) {
        setError(
          e instanceof ApiError
            ? e.message
            : "Could not save. Please try again.",
        );
        if (e instanceof ApiError && e.status === 409) {
          setStatusTitle(null);
          setReload((n) => n + 1);
        }
      }
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  function rail(title: TeamHomeTitle): VerticalRailAction[] {
    return [
      {
        key: "heart",
        icon: title.liked_by_me ? "heart" : "heart-outline",
        label: "Like in this team",
        active: title.liked_by_me,
        count: title.like_count,
        onPress: () =>
          void mutate(`titles/${title.id}/like`, { liked: !title.liked_by_me }),
      },
      {
        key: "comment",
        icon: "chatbubble-outline",
        label: "Team discussion",
        onPress: () =>
          router.push({
            pathname: "/teams/[teamId]/discussion",
            params: { teamId, titleId: title.id, title: title.title },
          }),
      },
      {
        key: "save",
        icon: "bookmark-outline",
        label: "Save",
        onPress: () => setSave(title),
      },
      {
        key: "send",
        icon: "paper-plane-outline",
        label: "Send title",
        onPress: () =>
          setAction({
            action: "send",
            id: title.id,
            title: title.title,
            poster: title.poster_url,
          }),
      },
      {
        key: "rate",
        icon: "star-outline",
        label: "Rate",
        onPress: () => setRate(title),
      },
    ];
  }
  function shareState(state: TeamHomeTitle["my_state"], shareRating = false) {
    if (!statusTitle) return;
    const id = statusTitle.id;
    void mutate(
      `titles/${id}/my-state`,
      {
        state,
        share_rating: shareRating,
        expected_version: statusTitle.my_state_version,
      },
      () => {
        if (state === "watched") patchTitleState(id, { watched: true });
        setStatusTitle(null);
      },
    );
  }
  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <AppHeader
        variant="detail"
        leftKind="back"
        title={data?.team_name ?? "Watch Team"}
        rightSlot={
          <View style={styles.row}>
            <Pressable
              style={styles.icon}
              accessibilityLabel="Add title"
              onPress={() =>
                router.push({
                  pathname: "/teams/[teamId]/add-title",
                  params: { teamId },
                })
              }
            >
              <Ionicons name="add" size={24} color={colors.ink} />
            </Pressable>
            <Pressable
              style={styles.icon}
              accessibilityLabel="Team settings"
              onPress={() =>
                router.push({
                  pathname: "/teams/[teamId]/settings",
                  params: { teamId },
                })
              }
            >
              <Ionicons name="settings-outline" size={22} color={colors.ink} />
            </Pressable>
          </View>
        }
      />
      <Text style={styles.summary}>
        {data ? `${data.member_count} members · Private team` : "Private team"}
      </Text>
      {error ? (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.body}>
            {error}
          </Text>
          <Pressable
            style={styles.button}
            onPress={() => setReload((n) => n + 1)}
          >
            <Text style={styles.accent}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      <View
        style={{ flex: 1 }}
        onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
      >
        {loading && !data ? (
          <ActivityIndicator color={colors.accent} />
        ) : data ? (
          <FlatList
            data={SECTIONS}
            keyExtractor={(s) => s.key}
            snapToInterval={viewport}
            decelerationRate="fast"
            showsVerticalScrollIndicator={false}
            renderItem={({ item: section }) => {
              const titles = data[section.key],
                hero =
                  titles.find((t) => t.id === selected[section.key]) ??
                  titles[0];
              return (
                <View style={{ height: viewport }}>
                  {hero ? (
                    <>
                      <FullBleedPosterSection
                        heroHeight={Math.max(220, viewport - 56)}
                        sectionKicker={`${section.key === "both_want_to_watch" && data.member_count > 2 ? "MEMBERS WANT TO WATCH" : section.label} · ${data.totals[section.key]}`}
                        hero={hero}
                        four={titles}
                        railActions={rail(hero)}
                        onPressHero={() => void openTitle(hero.id)}
                        onPressContinuation={(t) =>
                          setSelected((prev) => ({
                            ...prev,
                            [section.key]: t.id,
                          }))
                        }
                        onEndReached={() => void more(section.key)}
                      />
                      <Pressable
                        style={styles.statusButton}
                        onPress={() => {
                          setStatusTitle(hero);
                          setPosition((hero.rank_label ?? "#1").slice(1));
                        }}
                      >
                        <Text style={styles.accent}>
                          Members’ status &amp; ratings · Share yours
                        </Text>
                      </Pressable>
                    </>
                  ) : (
                    <View style={styles.empty}>
                      <Text style={styles.title}>{section.label}</Text>
                      <Text style={styles.body}>
                        {section.key === "both_want_to_watch"
                          ? "Titles appear here when at least two members explicitly share Want to Watch."
                          : section.key === "watched"
                            ? "Titles appear here when a member shares Watched with this team."
                            : "Add a title to start this section."}
                      </Text>
                      <Pressable
                        style={styles.button}
                        onPress={() =>
                          router.push({
                            pathname: "/teams/[teamId]/add-title",
                            params: { teamId },
                          })
                        }
                      >
                        <Text style={styles.accent}>Add a title</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              );
            }}
          />
        ) : null}
      </View>
      <UniversalTitleModal
        visible={detailId !== null}
        title={detail}
        loading={detailBusy}
        onClose={() => {
          detailGeneration.current++;
          setDetailId(null);
          setDetail(null);
        }}
      />
      <SaveToListSheet
        visible={!!save}
        token={sessionToken}
        titleId={save?.id ?? null}
        source="team_home"
        onClose={() => setSave(null)}
        onSaved={() => setSave(null)}
      />
      <RatingEditor
        visible={!!rate}
        token={sessionToken}
        titleId={rate?.id ?? null}
        titleName={rate?.title}
        initial={null}
        onClose={() => setRate(null)}
      />
      <TitleActionSheets
        target={action}
        token={sessionToken}
        source="team_home"
        onClose={() => setAction(null)}
      />
      <Modal
        visible={!!statusTitle}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setStatusTitle(null);
        }}
      >
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <ScrollView contentContainerStyle={{ gap: 14 }}>
              <Text style={styles.title}>{statusTitle?.title}</Text>
              <Text style={styles.body}>
                Only what members explicitly share with this team appears here.
                Personal ratings stay private until shared.
              </Text>
              {statusTitle?.members.map((m) => (
                <Text key={m.user_id} style={styles.body}>
                  {m.name} ·{" "}
                  {m.state === "watched" ? "Watched" : "Wants to watch"}
                  {m.rating != null ? ` · ${m.rating}/10` : ""}
                </Text>
              ))}
              {statusTitle?.member_average != null ? (
                <Text style={styles.accent}>
                  Member average {statusTitle.member_average}/10 ·{" "}
                  {statusTitle.rating_count} shared ratings
                </Text>
              ) : (
                <Text style={styles.body}>No shared ratings yet.</Text>
              )}
              <Text style={styles.body}>
                You shared: {statusTitle?.my_state.replaceAll("_", " ")}
              </Text>
              {(
                [
                  ["want_to_watch", "Share Want to Watch"],
                  ["watched", "Mark Watched & share with team"],
                  ["unknown", "Remove my shared status"],
                ] as const
              ).map(([state, label]) => (
                <Pressable
                  key={state}
                  disabled={busy}
                  style={styles.button}
                  onPress={() => shareState(state)}
                >
                  <Text style={styles.accent}>{label}</Text>
                </Pressable>
              ))}
              <Pressable
                disabled={busy}
                style={styles.button}
                onPress={() => shareState("watched", true)}
              >
                <Text style={styles.accent}>
                  Share my current rating with this team
                </Text>
              </Pressable>
              {data?.can_manage ? (
                <View style={{ gap: 8 }}>
                  <Text style={styles.body}>
                    Team ranking is set by the owner and admins. It is separate
                    from TMDB and personal ratings.
                  </Text>
                  <TextInput
                    accessibilityLabel="Team rank position"
                    keyboardType="number-pad"
                    value={position}
                    onChangeText={setPosition}
                    style={styles.input}
                  />
                  <Pressable
                    disabled={
                      busy || !/^\d+$/.test(position) || Number(position) < 1
                    }
                    style={styles.button}
                    onPress={() =>
                      void mutate(
                        `rankings/${statusTitle?.id}`,
                        { position: Number(position) },
                        () => setStatusTitle(null),
                      )
                    }
                  >
                    <Text style={styles.accent}>
                      Move to position {position}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
              {error ? (
                <Text accessibilityRole="alert" style={styles.body}>
                  {error}
                </Text>
              ) : null}
              {busy ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Pressable
                  style={styles.button}
                  onPress={() => setStatusTitle(null)}
                >
                  <Text style={styles.body}>Close</Text>
                </Pressable>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  row: { flexDirection: "row" },
  icon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  summary: {
    color: colors.muted,
    fontSize: 12,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  notice: { paddingHorizontal: 20, gap: 6 },
  body: { fontSize: 16, color: colors.ink },
  title: { fontSize: 25, fontFamily: fonts.serifBold, color: colors.ink },
  accent: { fontSize: 15, color: colors.accent },
  button: { minHeight: 44, paddingVertical: 12 },
  statusButton: {
    minHeight: 56,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 28,
    gap: 18,
  },
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,.75)",
    padding: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  sheet: {
    backgroundColor: colors.background,
    padding: 20,
    width: "100%",
    maxWidth: 560,
    maxHeight: "85%",
    borderRadius: 16,
  },
  input: {
    fontSize: 16,
    minHeight: 44,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.muted,
    padding: 10,
  },
});
