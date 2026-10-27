/**
 * Oct-19 Social Stories strip (mock reference).
 *
 * Horizontal row of story avatars at the top of Social. Each actor's
 * avatar has a gold ring when they have an active story. The viewer's
 * own slot has a "+" affordance to add a title to their story.
 *
 * Stories expire 72 hours after creation server-side.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Avatar } from "@/components/avatar";
import { colors, fonts, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { deleteStory, fetchStoriesFeed, type StoriesFeedResponse, type StoryActorGroup } from "@/lib/stories";
import { Alert } from "react-native";


export function StoriesStrip({ onAddPress }: { onAddPress: () => void }) {
  const { sessionToken, user } = useAuth();
  const [feed, setFeed] = useState<StoriesFeedResponse | null>(null);
  const [viewing, setViewing] = useState<StoryActorGroup | null>(null);

  async function load() {
    if (!sessionToken) return;
    try {
      const res = await fetchStoriesFeed(sessionToken);
      setFeed(res);
    } catch {
      // non-fatal — strip renders empty
    }
  }

  useEffect(() => {
    void load();
  }, [sessionToken]);

  const mine = feed?.me ?? null;
  const others = feed?.others ?? [];

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {/* Your Story — add if none, otherwise view mine */}
        <Pressable
          style={styles.cell}
          onPress={() => {
            if (mine && mine.stories.length > 0) {
              setViewing(mine);
            } else {
              onAddPress();
            }
          }}
        >
          <View style={styles.avatarWrap}>
            <Avatar uri={user?.avatar_url ?? null} label={user?.display_name ?? ""} size={54} />
            <View style={styles.plusDot}>
              <Ionicons name="add" size={13} color={colors.background} />
            </View>
            {mine && mine.stories.length > 0 ? <View style={styles.ring} /> : null}
          </View>
          <Text style={styles.label} numberOfLines={1}>Your Story</Text>
        </Pressable>

        {others.map((group) => (
          <Pressable key={group.user_id} style={styles.cell} onPress={() => setViewing(group)}>
            <View style={styles.avatarWrap}>
              <Avatar uri={group.avatar_url} label={group.display_name ?? group.username ?? ""} size={54} />
              <View style={styles.ring} />
            </View>
            <Text style={styles.label} numberOfLines={1}>
              {group.display_name ?? group.username ?? "User"}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <Modal visible={viewing !== null} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setViewing(null)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            {viewing && viewing.stories.length > 0 ? (
              <>
                <View style={styles.modalHeader}>
                  <Avatar uri={viewing.avatar_url} label={viewing.display_name ?? ""} size={28} />
                  <Text style={styles.modalName}>{viewing.display_name ?? viewing.username ?? "User"}</Text>
                  <Pressable onPress={() => setViewing(null)} hitSlop={10} style={{ marginLeft: "auto" }}>
                    <Ionicons name="close" size={20} color={colors.ink} />
                  </Pressable>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
                  {viewing.stories.map((s) => {
                    const isMine = viewing.user_id === user?.user_id;
                    return (
                      <View key={s.story_id} style={styles.storyCard}>
                        {s.poster_url ? (
                          <Image source={{ uri: s.poster_url }} style={styles.storyPoster} resizeMode="cover" />
                        ) : (
                          <View style={[styles.storyPoster, { alignItems: "center", justifyContent: "center" }]}>
                            <Ionicons name="film-outline" size={28} color={colors.muted2} />
                          </View>
                        )}
                        <Text style={styles.storyTitle} numberOfLines={2}>{s.title}</Text>
                        {s.caption ? (
                          <Text style={styles.storyCaption} numberOfLines={3}>"{s.caption}"</Text>
                        ) : null}
                        {isMine ? (
                          <Pressable
                            onPress={() => {
                              Alert.alert(
                                "Delete this story?",
                                "This can't be undone.",
                                [
                                  { text: "Cancel", style: "cancel" },
                                  {
                                    text: "Delete",
                                    style: "destructive",
                                    onPress: async () => {
                                      if (!sessionToken) return;
                                      try {
                                        await deleteStory(sessionToken, s.story_id);
                                        // Remove from local view; reload the strip.
                                        setViewing(null);
                                        await load();
                                      } catch {
                                        // Non-fatal; refresh anyway.
                                        await load();
                                      }
                                    },
                                  },
                                ],
                              );
                            }}
                            hitSlop={6}
                            style={styles.deleteStoryBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Delete this story"
                          >
                            <Ionicons name="trash-outline" size={13} color={colors.danger} />
                            <Text style={styles.deleteStoryLabel}>Delete</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    );
                  })}
                </ScrollView>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}


const styles = StyleSheet.create({
  row: {
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 14,
  },
  cell: {
    alignItems: "center",
    width: 66,
    gap: 6,
  },
  avatarWrap: {
    width: 62,
    height: 62,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  ring: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderColor: colors.accent,
    borderRadius: 31,
  },
  plusDot: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.background,
  },
  label: {
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 11,
    textAlign: "center",
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.78)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: spacing.md,
    gap: spacing.sm,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  modalName: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
  },
  storyCard: {
    width: 160,
    gap: 6,
  },
  storyPoster: {
    width: 160,
    height: 240,
    borderRadius: 8,
    backgroundColor: colors.surfaceMuted,
  },
  storyTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 13,
  },
  storyCaption: {
    fontFamily: fonts.serif,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
    fontStyle: "italic",
  },
  deleteStoryBtn: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  deleteStoryLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.danger,
    fontSize: 10,
    letterSpacing: 0.5,
  },
});
