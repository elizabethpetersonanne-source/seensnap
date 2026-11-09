import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
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
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { colors, fonts } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  fetchStoryHistory,
  subscribeStoryChanges,
  type StoryTitleCard,
} from "@/lib/stories";

type Filter = "all" | "active" | "archived";
export default function MyStoriesScreen() {
  const { sessionToken } = useAuth();
  const { width } = useWindowDimensions();
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<StoryTitleCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = `${sessionToken}|${filter}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const requestRef = useRef<object | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const deleted = useRef(new Set<string>());
  const columns = Math.max(2, Math.min(5, Math.floor((width - 40) / 160)));
  const cardWidth = (Math.min(width, 1100) - 40 - (columns - 1) * 12) / columns;

  async function load(next: string | null = null) {
    if (!sessionToken) return;
    const request = {};
    requestRef.current = request;
    setLoading(true);
    setError(null);
    if (!next) {
      setItems([]);
      setCursor(null);
    }
    try {
      const result = await fetchStoryHistory(sessionToken, filter, next);
      if (scopeRef.current !== scope || requestRef.current !== request) return;
      setItems((previous) => [
        ...new Map(
          [...(next ? previous : []), ...result.items]
            .filter((s) => !deleted.current.has(s.story_id))
            .map((s) => [s.story_id, s]),
        ).values(),
      ]);
      setCursor(result.next_cursor);
      setTotal(result.total);
      setLoadedScope(scope);
    } catch {
      if (scopeRef.current === scope && requestRef.current === request)
        setError("Couldn't load your stories. Please try again.");
    } finally {
      if (scopeRef.current === scope && requestRef.current === request) {
        setLoading(false);
        requestRef.current = null;
      }
    }
  }
  useEffect(() => {
    deleted.current.clear();
    void load();
    return () => {
      requestRef.current = null;
    };
  }, [scope]);
  useEffect(
    () =>
      subscribeStoryChanges((token, change) => {
        if (token !== sessionToken) return;
        if (change.kind === "deleted") {
          if (deleted.current.has(change.storyId)) return;
          deleted.current.add(change.storyId);
          setItems((previous) =>
            previous.filter((item) => item.story_id !== change.storyId),
          );
          if (itemsRef.current.some((item) => item.story_id === change.storyId))
            setTotal((previous) => Math.max(0, previous - 1));
        } else if (change.created) {
          const active =
            new Date(change.story.expires_at).getTime() > Date.now();
          if (
            filter === "all" ||
            (filter === "active" && active) ||
            (filter === "archived" && !active)
          ) {
            setItems((previous) => [
              change.story,
              ...previous.filter(
                (item) => item.story_id !== change.story.story_id,
              ),
            ]);
            setTotal((previous) => previous + 1);
          }
        } else {
          setItems((previous) =>
            previous.map((item) =>
              item.story_id === change.story.story_id ? change.story : item,
            ),
          );
        }
      }),
    [sessionToken, filter],
  );

  return (
    <SafeAreaView edges={[]} style={styles.root}>
      <AppHeader variant="detail" leftKind="back" title="Your stories" />
      <FlatList
        key={columns}
        data={loadedScope === scope ? items : []}
        numColumns={columns}
        keyExtractor={(item) => item.story_id}
        contentContainerStyle={styles.content}
        columnWrapperStyle={{ gap: 12 }}
        refreshing={loading && items.length === 0}
        onRefresh={() => void load()}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 20 }}>
            <Text style={styles.copy}>
              Your private history. Stories leave Social after 72 hours; expired
              stories remain here for you.
            </Text>
            <View style={styles.controls}>
              {(["all", "active", "archived"] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: filter === value }}
                  onPress={() => setFilter(value)}
                  style={[styles.button, filter === value && styles.selected]}
                >
                  <Text style={styles.label}>
                    {value === "all"
                      ? "All"
                      : value === "active"
                        ? "Active"
                        : "Archived"}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.controls}>
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => router.push("/add-to-story")}
              >
                <Text style={styles.label}>+ Add a story</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={loading}
                style={styles.button}
                onPress={() => void load()}
              >
                <Text style={styles.label}>Refresh</Text>
              </Pressable>
            </View>
            <Text style={styles.copy}>
              {loadedScope === scope ? total : 0}{" "}
              {total === 1 ? "story" : "stories"}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View your story: ${item.title}`}
            style={[styles.card, { width: cardWidth }]}
            onPress={() =>
              router.push({
                pathname: "/my-stories/[storyId]",
                params: { storyId: item.story_id },
              })
            }
          >
            {item.poster_url ? (
              <Image
                source={{ uri: item.poster_url }}
                resizeMode="cover"
                style={{
                  width: cardWidth,
                  height: cardWidth * 1.5,
                  borderRadius: 10,
                }}
              />
            ) : (
              <View
                style={[
                  styles.placeholder,
                  { width: cardWidth, height: cardWidth * 1.5 },
                ]}
              >
                <Ionicons name="film-outline" size={30} color={colors.muted} />
              </View>
            )}
            <Text style={styles.title} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.copy}>
              {new Date(item.created_at).toLocaleDateString()} ·{" "}
              {new Date(item.expires_at).getTime() > Date.now()
                ? "Active"
                : "Archived"}
            </Text>
            {item.caption ? (
              <Text style={styles.copy} numberOfLines={3}>
                {item.caption}
              </Text>
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          !loading && !error ? (
            <Text style={styles.copy}>
              No {filter === "all" ? "" : `${filter} `}stories yet.
            </Text>
          ) : null
        }
        ListFooterComponent={
          <View style={{ gap: 12, paddingVertical: 20 }}>
            {error ? (
              <Text accessibilityRole="alert" style={styles.copy}>
                {error}
              </Text>
            ) : null}
            {loading ? (
              <ActivityIndicator color={colors.accent} />
            ) : cursor || error ? (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => void load(cursor)}
              >
                <Text style={styles.label}>
                  {error ? "Try again" : "Load more stories"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        }
      />
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: 20,
    paddingBottom: 100,
    width: "100%",
    maxWidth: 1100,
    alignSelf: "center",
  },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  button: {
    minHeight: 44,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.muted2,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  selected: { borderColor: colors.accent, backgroundColor: colors.surface },
  label: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 15 },
  copy: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
  },
  title: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 16 },
  card: { gap: 6, marginBottom: 24 },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderRadius: 10,
  },
});
