/** Active Social stories and a permanent entry point to the owner's private history. */
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Avatar } from "@/components/avatar";
import { colors, fonts } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  fetchStoriesFeed,
  subscribeStoryChanges,
  type StoriesFeedResponse,
  type StoryActorGroup,
} from "@/lib/stories";

export function StoriesStrip({ onAddPress }: { onAddPress: () => void }) {
  const { sessionToken, user } = useAuth();
  const { width, height } = useWindowDimensions();
  const [feed, setFeed] = useState<{
    token: string;
    data: StoriesFeedResponse;
  } | null>(null);
  const [viewing, setViewing] = useState<StoryActorGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const tokenRef = useRef(sessionToken);
  tokenRef.current = sessionToken;
  const generation = useRef(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setViewing(null);
      setError(null);
      async function load() {
        if (!sessionToken) return;
        const request = ++generation.current;
        try {
          const result = await fetchStoriesFeed(sessionToken);
          if (
            !active ||
            tokenRef.current !== sessionToken ||
            request !== generation.current
          )
            return;
          setFeed({ token: sessionToken, data: result });
          setError(null);
          setViewing((current) =>
            current
              ? (result.others.find(
                  (group) => group.user_id === current.user_id,
                ) ?? null)
              : null,
          );
        } catch {
          if (active && tokenRef.current === sessionToken) {
            setError("Stories couldn't refresh.");
            setViewing(null);
          }
        }
      }
      void load();
      const unsubscribe = subscribeStoryChanges((token) => {
        if (token === sessionToken) void load();
      });
      const timer = setInterval(() => void load(), 60000);
      return () => {
        active = false;
        generation.current++;
        clearInterval(timer);
        unsubscribe();
      };
    }, [sessionToken, retry]),
  );
  const visibleFeed = feed?.token === sessionToken ? feed.data : null;
  const mine = visibleFeed?.me;
  const posterWidth = Math.min(
    260,
    Math.max(140, width - 100),
    Math.max(140, height * 0.38),
  );
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View your active and previous stories"
          style={styles.cell}
          onPress={() => router.push("/my-stories")}
        >
          <View style={[styles.avatar, !!mine?.stories.length && styles.ring]}>
            <Avatar
              uri={user?.avatar_url ?? null}
              label={user?.display_name ?? ""}
              size={54}
            />
          </View>
          <Text style={styles.label}>Your stories</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a story"
          style={styles.cell}
          onPress={onAddPress}
        >
          <View style={[styles.avatar, styles.add]}>
            <Ionicons name="add" size={26} color={colors.accent} />
          </View>
          <Text style={styles.label}>Add story</Text>
        </Pressable>
        {(visibleFeed?.others ?? []).map((group) => (
          <Pressable
            accessibilityRole="button"
            key={group.user_id}
            style={styles.cell}
            onPress={() => setViewing(group)}
          >
            <View style={[styles.avatar, styles.ring]}>
              <Avatar
                uri={group.avatar_url}
                label={group.display_name ?? group.username ?? ""}
                size={54}
              />
            </View>
            <Text style={styles.label} numberOfLines={1}>
              {group.display_name ?? group.username ?? "Viewer"}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {error ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setRetry((n) => n + 1)}
          style={{
            minHeight: 44,
            paddingHorizontal: 20,
            justifyContent: "center",
          }}
        >
          <Text style={styles.copy}>{error} Tap to retry.</Text>
        </Pressable>
      ) : null}
      <Modal
        visible={!!viewing && !!visibleFeed}
        transparent
        animationType="fade"
        onRequestClose={() => setViewing(null)}
      >
        <View style={styles.backdrop}>
          <View style={styles.panel} accessibilityViewIsModal>
            <View style={styles.heading}>
              <Text style={styles.title}>
                {viewing?.display_name ?? viewing?.username ?? "Stories"}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close stories"
                onPress={() => setViewing(null)}
                style={styles.close}
              >
                <Ionicons name="close" size={22} color={colors.ink} />
              </Pressable>
            </View>
            <ScrollView>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 16 }}
              >
                {(viewing?.stories ?? [])
                  .filter((s) => new Date(s.expires_at).getTime() > Date.now())
                  .map((story) => (
                    <View
                      key={story.story_id}
                      style={{ width: posterWidth, gap: 10, paddingBottom: 16 }}
                    >
                      {story.poster_url ? (
                        <Image
                          source={{ uri: story.poster_url }}
                          style={{
                            width: posterWidth,
                            height: posterWidth * 1.5,
                            borderRadius: 10,
                          }}
                          resizeMode="cover"
                        />
                      ) : null}
                      <Text style={styles.title}>{story.title}</Text>
                      {story.caption ? (
                        <Text style={styles.copy}>{story.caption}</Text>
                      ) : null}
                    </View>
                  ))}
              </ScrollView>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  row: { paddingHorizontal: 20, paddingVertical: 12, gap: 16 },
  cell: { width: 76, alignItems: "center", gap: 7, minHeight: 80 },
  avatar: {
    width: 62,
    height: 62,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 31,
    borderWidth: 2,
    borderColor: "transparent",
  },
  ring: { borderColor: colors.accent },
  add: { backgroundColor: colors.surface },
  label: {
    color: colors.ink,
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    textAlign: "center",
  },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  title: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 18,
    flexShrink: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,.8)",
    padding: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  panel: {
    width: "100%",
    maxWidth: 720,
    maxHeight: "90%",
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.background,
  },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  close: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
