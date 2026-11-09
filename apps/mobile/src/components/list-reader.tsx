/** Shared list reader; UUID links and explicit share tokens use distinct API paths. */
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { apiRequest, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts } from "@/constants/theme";
type Item = {
  title_id: string;
  tmdb_id: number;
  title: string;
  content_type: string;
  poster_url: string | null;
  year: number | null;
};
type List = {
  name: string;
  description: string | null;
  item_count: number;
  shared_by_display_name: string | null;
  owner_user_id: string;
  list_id: string;
  next_offset: number | null;
  items: Item[];
};
export function ListReader({ endpoint }: { endpoint: string }) {
  const { sessionToken } = useAuth();
  const { width } = useWindowDimensions();
  const [list, setList] = useState<List | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    loading = useRef(false);
  const returnTo = endpoint.startsWith("/public/lists/")
    ? endpoint.replace("/public/lists/", "/lists/")
    : endpoint.replace("/lists/", "/list/");
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  async function load(offset: number, version = generation.current) {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<List>(
        `${endpoint}?limit=40&offset=${offset}`,
        { token: sessionToken },
      );
      if (version !== generation.current) return;
      setList((previous) => ({
        ...next,
        items:
          offset && previous
            ? [
                ...new Map(
                  [...previous.items, ...next.items].map((t) => [
                    t.title_id,
                    t,
                  ]),
                ).values(),
              ]
            : next.items,
      }));
    } catch (failure) {
      if (version !== generation.current) return;
      const unavailable =
        failure instanceof ApiError && [403, 404].includes(failure.status);
      if (unavailable) setList(null);
      setError(
        unavailable
          ? "This list is private, deleted, or no longer shared with you."
          : "Couldn't load the list. Please try again.",
      );
    } finally {
      if (version === generation.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const version = ++generation.current;
    loading.current = false;
    setList(null);
    void load(0, version);
    return () => {
      generation.current++;
      loading.current = false;
    };
  }, [endpoint, sessionToken]);
  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <AppHeader
        variant="detail"
        leftKind="back"
        title={list?.name ?? "Shared list"}
      />
      {error ? (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.body}>
            {error}
          </Text>
          <Pressable
            style={styles.button}
            onPress={() => void load(list?.next_offset ?? 0)}
          >
            <Text style={styles.accent}>Retry</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            onPress={() => router.replace("/(tabs)/social")}
          >
            <Text style={styles.body}>Go to Social</Text>
          </Pressable>
        </View>
      ) : null}
      {!sessionToken ? (
        <Pressable
          style={[styles.button, { paddingHorizontal: 20 }]}
          onPress={() =>
            router.push({ pathname: "/sign-in", params: { returnTo } })
          }
        >
          <Text style={styles.accent}>Sign in to SeenSnap</Text>
        </Pressable>
      ) : null}
      {busy && !list ? (
        <ActivityIndicator style={{ margin: 24 }} color={colors.accent} />
      ) : null}
      {list ? (
        <FlatList
          key={columns}
          numColumns={columns}
          data={list.items}
          keyExtractor={(item) => item.title_id}
          contentContainerStyle={styles.content}
          columnWrapperStyle={{ gap: 12 }}
          onEndReached={() => {
            if (list.next_offset !== null && !error)
              void load(list.next_offset);
          }}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View style={styles.heading}>
              <Text style={styles.by}>
                {list.shared_by_display_name
                  ? `By ${list.shared_by_display_name}`
                  : "A SeenSnap list"}
              </Text>
              <Text style={styles.title}>{list.name}</Text>
              {list.description ? (
                <Text style={styles.body}>{list.description}</Text>
              ) : null}
              <Text style={styles.body}>{list.item_count} titles</Text>
              {sessionToken ? (
                <Pressable
                  style={styles.button}
                  onPress={() =>
                    router.push({
                      pathname: "/(tabs)/previews",
                      params: {
                        list_id: list.list_id,
                        owner_id: list.owner_user_id,
                      },
                    })
                  }
                >
                  <Text style={styles.accent}>Watch available previews</Text>
                </Pressable>
              ) : (
                <Text style={styles.body}>
                  Sign in to save, rate or watch previews.
                </Text>
              )}
            </View>
          }
          ListEmptyComponent={
            <Text style={styles.body}>
              No titles have been added to this list yet.
            </Text>
          }
          ListFooterComponent={
            busy ? (
              <ActivityIndicator color={colors.accent} />
            ) : list.next_offset !== null ? (
              <Pressable
                style={styles.button}
                onPress={() => void load(list.next_offset!)}
              >
                <Text style={styles.accent}>Load more titles</Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.title}`}
              style={[
                styles.card,
                {
                  width:
                    (Math.min(width, 1000) - 32 - 12 * (columns - 1)) / columns,
                },
              ]}
              onPress={() =>
                router.push(
                  `/titles/${item.content_type === "movie" ? "movie" : "tv"}/${item.tmdb_id}`,
                )
              }
            >
              {item.poster_url ? (
                <Image
                  source={{ uri: item.poster_url }}
                  style={styles.poster}
                />
              ) : (
                <View style={styles.poster} />
              )}
              <Text style={styles.body} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.by}>
                {item.year ?? ""} ·{" "}
                {item.content_type === "movie" ? "Film" : "Series"}
              </Text>
            </Pressable>
          )}
        />
      ) : null}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: 16,
    paddingBottom: 100,
    maxWidth: 1000,
    width: "100%",
    alignSelf: "center",
  },
  heading: { gap: 10, paddingBottom: 24 },
  title: { fontFamily: fonts.serifBold, fontSize: 30, color: colors.ink },
  body: { fontFamily: fonts.sans, fontSize: 16, color: colors.ink },
  by: { fontSize: 13, color: colors.muted },
  accent: { fontSize: 16, color: colors.accent },
  notice: { padding: 20, gap: 8 },
  button: { minHeight: 44, paddingVertical: 12 },
  card: { marginBottom: 20, gap: 6 },
  poster: {
    width: "100%",
    aspectRatio: 2 / 3,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
});
