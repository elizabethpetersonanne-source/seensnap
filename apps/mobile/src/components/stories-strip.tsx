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
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Avatar } from "@/components/avatar";
import { colors, fonts, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { deleteStory, editStory, fetchStoriesFeed, type StoriesFeedResponse, type StoryActorGroup, type StoryTitleCard } from "@/lib/stories";


export function StoriesStrip({ onAddPress }: { onAddPress: () => void }) {
  const { sessionToken, user } = useAuth();
  const [feed, setFeed] = useState<StoriesFeedResponse | null>(null);
  const [viewing, setViewing] = useState<StoryActorGroup | null>(null);
  // STORY01: owner-only in-place caption editor. Preserves expiry
  // and the original title identity.
  const [editing, setEditing] = useState<StoryTitleCard | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);

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
                          <View style={styles.myStoryActions}>
                            <Pressable
                              onPress={() => {
                                setEditing(s);
                                setEditDraft(s.caption ?? "");
                              }}
                              hitSlop={6}
                              style={styles.editStoryBtn}
                              accessibilityRole="button"
                              accessibilityLabel="Edit this story's caption"
                            >
                              <Ionicons name="create-outline" size={13} color={colors.accent} />
                              <Text style={styles.editStoryLabel}>Edit</Text>
                            </Pressable>
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
                                          setViewing(null);
                                          await load();
                                        } catch {
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
                          </View>
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

      <Modal visible={editing !== null} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setEditing(null)}>
          <Pressable style={styles.editSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.editHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalName}>Edit story caption</Text>
              <Pressable onPress={() => setEditing(null)} hitSlop={10} style={{ marginLeft: "auto" }}>
                <Ionicons name="close" size={20} color={colors.ink} />
              </Pressable>
            </View>
            <TextInput
              value={editDraft}
              onChangeText={(t) => setEditDraft(t.slice(0, 280))}
              multiline
              style={styles.editInput}
              placeholder="Add a caption…"
              placeholderTextColor={colors.muted2}
              textAlignVertical="top"
            />
            <Text style={styles.editExpiryHint}>
              Editing won't extend the 72-hour expiry.
            </Text>
            <Pressable
              onPress={async () => {
                if (!editing || !sessionToken || editBusy) return;
                setEditBusy(true);
                try {
                  await editStory(sessionToken, editing.story_id, { caption: editDraft.trim() || null });
                  setEditing(null);
                  await load();
                } catch (e) {
                  Alert.alert(
                    "Couldn't save",
                    e instanceof Error ? e.message : "The story may have expired.",
                  );
                  // If the story is gone, close the viewer so the stale
                  // card doesn't linger.
                  setViewing(null);
                  await load();
                } finally {
                  setEditBusy(false);
                }
              }}
              disabled={editBusy}
              style={[styles.editSaveBtn, editBusy && { opacity: 0.6 }]}
            >
              <Text style={styles.editSaveLabel}>{editBusy ? "Saving…" : "Save changes"}</Text>
            </Pressable>
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
  myStoryActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  editStoryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  editStoryLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  editSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: 10,
  },
  editHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginBottom: 4,
  },
  editInput: {
    minHeight: 100,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  editExpiryHint: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 11,
  },
  editSaveBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  editSaveLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.background,
    fontSize: 13,
  },
});
