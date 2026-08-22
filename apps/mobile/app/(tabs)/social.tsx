/**
 * Social tab — Social brief §5-§6 + §69.
 *
 * The Following feed is the default. Empty state is REAL (no seeded users
 * or fake activity per §4 + §100) with actionable paths to find people:
 *   - Search SeenSnap users
 *   - Follow members of an existing Watch Team
 *   - (Future: contacts import)
 *
 * Feed items render three post types today:
 *   - title_share    — someone recommends a title
 *   - rating_share   — someone rated a title
 *   - list_share     — someone shared a list
 *
 * Every card exposes: open title, save-to-my-picks, like, comment count.
 * Attribution (§37) captured via analytics events on every interaction.
 */
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { SendToUserSheet } from "@/components/send-to-user-sheet";
import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { relativeTime } from "@/lib/format";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCyclingBackdrop, useFallbackBackdrop } from "@/lib/backdrop-pool";
import { trackEvent } from "@/lib/analytics";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

// ─── Types matching backend /social/feed response ────────────────────────────

type PostAuthor = {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
};

type PostTitle = {
  id: string;
  title: string;
  content_type: string;
  poster_url: string | null;
  backdrop_url: string | null;
};

type PostRating = { id: string; score: number | null };

type PostList = {
  id: string;
  name: string;
  description: string | null;
  item_count: number;
  preview: { title_id: string; title_name: string; poster_url: string | null }[];
  share_token: string | null;
};

type SocialPost = {
  id: string;
  post_type: "title_share" | "rating_share" | "review_share" | "list_share" | "list_publish";
  visibility: "public" | "followers" | "private";
  caption: string | null;
  created_at: string;
  author: PostAuthor;
  title: PostTitle | null;
  rating: PostRating | null;
  list: PostList | null;
  engagement: { like_count: number; comment_count: number };
  viewer_state: { liked: boolean; following_author: boolean; is_author: boolean };
};

type FeedResponse = {
  items: SocialPost[];
  next_cursor: string | null;
  has_more: boolean;
};

type UserSearchResult = {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
};

export default function SocialScreen() {
  const { sessionToken } = useAuth();
  // Cycling backdrop from the shared trending pool so the header matches the
  // visual weight of Discover / SceneDNA / Teams. Offset 9 is unique to
  // Social so different tabs pull different backdrops from the same pool.
  const socialFallbackBackdrop = useFallbackBackdrop(9);
  const socialCyclingBackdrop = useCyclingBackdrop([socialFallbackBackdrop]);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFindPeople, setShowFindPeople] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const loadFeed = useCallback(async () => {
    if (!sessionToken) return;
    try {
      setError(null);
      const data = await apiRequest<FeedResponse>("/social/feed?limit=20", {
        token: sessionToken,
      });
      setFeed(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your feed.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionToken]);

  useFocusEffect(
    useCallback(() => {
      trackEvent("social_feed_viewed", {});
      void loadFeed();
    }, [loadFeed]),
  );

  async function runSearch(q: string) {
    if (!sessionToken || q.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      trackEvent("user_search_started", { q_length: q.length });
      const rows = await apiRequest<UserSearchResult[]>(
        `/social/users/search?q=${encodeURIComponent(q.trim())}`,
        { token: sessionToken },
      );
      setSearchResults(rows);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }

  async function toggleFollow(userId: string) {
    if (!sessionToken) return;
    try {
      // Optimistic: profile follow endpoint returns 204 no-content.
      await apiRequest(`/profiles/${userId}/follow`, {
        method: "POST",
        token: sessionToken,
      });
      trackEvent("user_followed", { user_id: userId, entry_point: "find_people" });
      void loadFeed();
    } catch {
      // silent — search UI stays put
    }
  }

  function reportPost(postId: string) {
    if (!sessionToken) return;
    Alert.alert(
      "Report this post?",
      "Our team will review it. This does not remove the post automatically.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Report",
          style: "destructive",
          onPress: async () => {
            try {
              await apiRequest("/social/reports", {
                method: "POST",
                token: sessionToken,
                body: JSON.stringify({
                  target_type: "post",
                  target_id: postId,
                  reason: "inappropriate",
                }),
              });
              trackEvent("social_post_reported", { post_id: postId });
              Alert.alert("Thanks — we'll take a look.");
            } catch (e) {
              Alert.alert("Couldn't report", e instanceof Error ? e.message : "Try again shortly.");
            }
          },
        },
      ],
    );
  }

  function blockUser(userId: string, displayName: string) {
    if (!sessionToken) return;
    Alert.alert(
      `Block ${displayName}?`,
      "You won't see their posts or comments. They won't be notified.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: async () => {
            try {
              await apiRequest(`/social/users/${userId}/block`, {
                method: "POST",
                token: sessionToken,
              });
              trackEvent("user_blocked", { user_id: userId });
              // Refresh so their posts drop out of the feed immediately.
              void loadFeed();
            } catch (e) {
              Alert.alert("Couldn't block", e instanceof Error ? e.message : "Try again shortly.");
            }
          },
        },
      ],
    );
  }

  async function toggleLike(postId: string) {
    if (!sessionToken) return;
    // Optimistic UI update
    setFeed((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((p) =>
          p.id === postId
            ? {
                ...p,
                viewer_state: { ...p.viewer_state, liked: !p.viewer_state.liked },
                engagement: {
                  ...p.engagement,
                  like_count:
                    p.engagement.like_count + (p.viewer_state.liked ? -1 : 1),
                },
              }
            : p,
        ),
      };
    });
    try {
      await apiRequest(`/social/posts/${postId}/likes`, {
        method: "POST",
        token: sessionToken,
      });
      trackEvent("social_post_liked", { post_id: postId });
    } catch {
      // roll back
      void loadFeed();
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      {/* Unified Header §7 — H1 "Social", editorial subtitle. Backdrop
          cycles through the shared trending pool so the header has real
          artwork weight matching Discover / SceneDNA / Teams. */}
      <SeenSnapHeader
        title="Social"
        subtitle="People whose taste you care about."
        artworkSource={socialCyclingBackdrop ?? socialFallbackBackdrop}
        fallbackSeed={9}
        contextualAction={
          <Pressable
            onPress={() => setShowFindPeople((s) => !s)}
            hitSlop={10}
            style={styles.contextualBtn}
          >
            <Ionicons name="person-add-outline" size={18} color={colors.ink} />
          </Pressable>
        }
      />

      {showFindPeople ? (
        <View style={styles.findPeoplePanel}>
          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={colors.muted} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={(v) => {
                setSearchQuery(v);
                void runSearch(v);
              }}
              placeholder="Find people on SeenSnap"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {searchQuery ? (
              <Pressable onPress={() => { setSearchQuery(""); setSearchResults([]); }}>
                <Ionicons name="close-circle" size={18} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
          {searchLoading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 320 }}>
              {searchResults.length === 0 && searchQuery.length >= 2 ? (
                <Text style={styles.emptyBody}>
                  No matches. Try a display name or @handle.
                </Text>
              ) : null}
              {searchResults.map((u) => (
                <View key={u.user_id} style={styles.searchResultRow}>
                  <Pressable
                    style={styles.searchResultLeft}
                    onPress={() => router.push(`/profile/${u.user_id}`)}
                  >
                    <Avatar uri={u.avatar_url} label={u.display_name ?? u.username ?? "?"} size={40} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.searchResultName} numberOfLines={1}>
                        {u.display_name ?? "SeenSnap user"}
                      </Text>
                      {u.username ? (
                        <Text style={styles.searchResultHandle} numberOfLines={1}>
                          @{u.username}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                  <Pressable
                    style={styles.followBtn}
                    onPress={() => void toggleFollow(u.user_id)}
                  >
                    <Text style={styles.followBtnText}>Follow</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorTitle}>Couldn't load your feed</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <Pressable onPress={() => void loadFeed()} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        </View>
      ) : feed && feed.items.length > 0 ? (
        <FlatList
          data={feed.items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void loadFeed();
              }}
              tintColor={colors.accent}
            />
          }
          renderItem={({ item }) => (
            <FeedCard
              post={item}
              token={sessionToken}
              onLike={() => void toggleLike(item.id)}
              onReport={reportPost}
              onBlock={blockUser}
            />
          )}
        />
      ) : (
        // Real empty state per §69 — no seeded activity, functional paths to
        // find people the user actually cares about.
        <ScrollView contentContainerStyle={styles.emptyRoot}>
          <View style={styles.emptyIcon}>
            <Ionicons name="people-outline" size={40} color={colors.accent} />
          </View>
          <Text style={styles.emptyTitle}>Your feed starts with people you follow.</Text>
          <Text style={styles.emptyBody}>
            Search SeenSnap users, follow your Watch Team members, or invite a friend to see their ratings, reviews, and shared lists here.
          </Text>
          <View style={styles.emptyActions}>
            <Pressable
              style={[styles.actionBtn, styles.actionBtnPrimary]}
              onPress={() => setShowFindPeople(true)}
            >
              <Ionicons name="search" size={16} color={colors.background} />
              <Text style={styles.actionBtnPrimaryText}>Find people</Text>
            </Pressable>
            <Pressable
              style={[styles.actionBtn, styles.actionBtnSecondary]}
              onPress={() => router.push("/(tabs)/teams")}
            >
              <Ionicons name="people-outline" size={16} color={colors.ink} />
              <Text style={styles.actionBtnSecondaryText}>From your teams</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Feed card ───────────────────────────────────────────────────────────────

function FeedCard({
  post,
  token,
  onLike,
  onReport,
  onBlock,
}: {
  post: SocialPost;
  token: string | null;
  onLike: () => void;
  onReport: (postId: string) => void;
  onBlock: (userId: string, displayName: string) => void;
}) {
  const author = post.author;
  const authorName = author.display_name ?? author.username ?? "SeenSnap user";
  const handle = author.username ? `@${author.username}` : null;
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<
    { id: string; body: string; created_at: string; author: PostAuthor }[]
  >([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentPosting, setCommentPosting] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [saveSheetOpen, setSaveSheetOpen] = useState(false);
  const [sendSheetOpen, setSendSheetOpen] = useState(false);
  const [saveToast, setSaveToast] = useState<string | null>(null);

  async function loadComments() {
    if (!token) return;
    try {
      const resp = await apiRequest<{
        items: { id: string; body: string; created_at: string; author: PostAuthor }[];
      }>(`/social/posts/${post.id}/comments`, { token });
      setComments(resp.items);
    } catch {
      // ignore — the "no comments yet" copy stays put
    }
  }

  async function postComment() {
    if (!token || !commentDraft.trim()) return;
    setCommentPosting(true);
    try {
      await apiRequest(`/social/posts/${post.id}/comments`, {
        method: "POST",
        token,
        body: JSON.stringify({ body: commentDraft.trim() }),
      });
      trackEvent("social_post_commented", { post_id: post.id });
      setCommentDraft("");
      await loadComments();
    } finally {
      setCommentPosting(false);
    }
  }

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.cardAuthorRow}
        onPress={() => router.push(`/profile/${author.user_id}`)}
      >
        <Avatar uri={author.avatar_url} label={authorName} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={styles.cardAuthorName} numberOfLines={1}>{authorName}</Text>
          <Text style={styles.cardAuthorMeta} numberOfLines={1}>
            {handle ? `${handle}  ·  ` : ""}
            {formatPostType(post)}  ·  {relativeTime(post.created_at)}
          </Text>
        </View>
      </Pressable>

      {post.caption ? (
        <Text style={styles.cardCaption}>{post.caption}</Text>
      ) : null}

      {post.title ? (
        <Pressable
          style={styles.cardTitleBlock}
          onPress={() => {
            trackEvent("social_post_opened", { post_id: post.id, entry: "title_open", post_type: post.post_type });
            router.push(`/titles/${post.title!.content_type === "movie" ? "movie" : "tv"}/${post.title!.id}`);
          }}
        >
          {post.title.backdrop_url ? (
            <Image source={{ uri: post.title.backdrop_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
          ) : null}
          <View style={styles.cardTitleShade} />
          <View style={styles.cardTitleBody}>
            <Text style={styles.cardTitleName} numberOfLines={2}>{post.title.title}</Text>
            {post.rating?.score !== undefined && post.rating?.score !== null ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingBadgeText}>{post.rating.score.toFixed(1)}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      ) : null}

      {post.list ? (
        <Pressable
          style={styles.cardListBlock}
          onPress={() => {
            if (!post.list?.share_token) return;
            trackEvent("social_post_opened", {
              post_id: post.id,
              entry: "list_open",
              post_type: post.post_type,
            });
            router.push(`/lists/${post.list.share_token}`);
          }}
          disabled={!post.list.share_token}
        >
          <Text style={styles.cardListName}>{post.list.name}</Text>
          <Text style={styles.cardListMeta}>
            {post.list.item_count} {post.list.item_count === 1 ? "title" : "titles"}
          </Text>
          <View style={styles.cardListPreviewRow}>
            {post.list.preview.slice(0, 5).map((t) => (
              <View key={t.title_id} style={styles.cardListPreviewPoster}>
                {t.poster_url ? (
                  <Image source={{ uri: t.poster_url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                ) : null}
              </View>
            ))}
          </View>
        </Pressable>
      ) : null}

      <View style={styles.cardActions}>
        <Pressable style={styles.cardAction} onPress={onLike}>
          <Ionicons
            name={post.viewer_state.liked ? "heart" : "heart-outline"}
            size={18}
            color={post.viewer_state.liked ? colors.accent : colors.muted}
          />
          <Text style={styles.cardActionText}>{post.engagement.like_count}</Text>
        </Pressable>
        <Pressable
          style={styles.cardAction}
          onPress={() => {
            const opening = !showComments;
            setShowComments(opening);
            if (opening && comments.length === 0) void loadComments();
          }}
        >
          <Ionicons name="chatbubble-outline" size={16} color={colors.muted} />
          <Text style={styles.cardActionText}>{post.engagement.comment_count}</Text>
        </Pressable>
        {post.title ? (
          <Pressable
            style={styles.cardAction}
            onPress={() => {
              trackEvent("social_post_save_started", {
                post_id: post.id,
                title_id: post.title!.id,
                post_type: post.post_type,
              });
              setSaveSheetOpen(true);
            }}
          >
            <Ionicons name="bookmark-outline" size={16} color={colors.muted} />
            <Text style={styles.cardActionText}>Save</Text>
          </Pressable>
        ) : null}
        {/* Send — 1:1 DM the underlying SeenSnap object (Messaging §58). */}
        {post.title || post.list ? (
          <Pressable
            style={styles.cardAction}
            onPress={() => setSendSheetOpen(true)}
          >
            <Ionicons name="paper-plane-outline" size={16} color={colors.muted} />
            <Text style={styles.cardActionText}>Send</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        {post.visibility !== "public" ? (
          <Text style={styles.cardVisibility}>
            {post.visibility === "followers" ? "FOLLOWERS" : "PRIVATE"}
          </Text>
        ) : null}
        {!post.viewer_state.is_author ? (
          <Pressable
            onPress={() => setShowOverflow((v) => !v)}
            hitSlop={10}
            style={styles.overflowBtn}
          >
            <Ionicons name="ellipsis-horizontal" size={16} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      {showOverflow && !post.viewer_state.is_author ? (
        <View style={styles.overflowMenu}>
          <Pressable
            style={styles.overflowItem}
            onPress={() => {
              setShowOverflow(false);
              onReport(post.id);
            }}
          >
            <Ionicons name="flag-outline" size={14} color={colors.muted} />
            <Text style={styles.overflowItemText}>Report post</Text>
          </Pressable>
          <Pressable
            style={styles.overflowItem}
            onPress={() => {
              setShowOverflow(false);
              onBlock(post.author.user_id, authorName);
            }}
          >
            <Ionicons name="ban-outline" size={14} color={colors.muted} />
            <Text style={styles.overflowItemText}>Block {authorName}</Text>
          </Pressable>
        </View>
      ) : null}

      {showComments ? (
        <View style={styles.commentsBlock}>
          {comments.length === 0 ? (
            <Text style={styles.commentsEmpty}>No comments yet — be the first.</Text>
          ) : (
            comments.map((c) => (
              <View key={c.id} style={styles.commentRow}>
                <Avatar uri={c.author.avatar_url} label={c.author.display_name ?? "?"} size={26} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.commentAuthor}>
                    {c.author.display_name ?? c.author.username ?? "SeenSnap user"}
                    <Text style={styles.commentMeta}>  {relativeTime(c.created_at)}</Text>
                  </Text>
                  <Text style={styles.commentBody}>{c.body}</Text>
                </View>
              </View>
            ))
          )}
          <View style={styles.commentComposer}>
            <TextInput
              value={commentDraft}
              onChangeText={setCommentDraft}
              placeholder="Add a comment…"
              placeholderTextColor={colors.muted}
              style={styles.commentInput}
              multiline
              maxLength={500}
            />
            <Pressable
              onPress={() => void postComment()}
              disabled={commentPosting || !commentDraft.trim()}
              style={[
                styles.commentSendBtn,
                (commentPosting || !commentDraft.trim()) && styles.commentSendBtnDisabled,
              ]}
            >
              <Ionicons name="send" size={16} color={colors.background} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {saveToast ? (
        <View style={styles.saveToast}>
          <Ionicons name="checkmark-circle" size={14} color={colors.accent} />
          <Text style={styles.saveToastText}>{saveToast}</Text>
        </View>
      ) : null}

      {/* Attribution — Social brief §37. `source="social_feed"` becomes
          `added_via` on the WatchlistItem so we can measure how well the
          social surface drives real saves. */}
      <SaveToListSheet
        visible={saveSheetOpen}
        token={token}
        titleId={post.title?.id ?? null}
        source="social_feed"
        onClose={() => setSaveSheetOpen(false)}
        onSaved={(listName, alreadySaved) => {
          setSaveSheetOpen(false);
          trackEvent("social_post_saved", {
            post_id: post.id,
            title_id: post.title?.id ?? null,
            list_name: listName,
            already_saved: alreadySaved ?? false,
          });
          setSaveToast(alreadySaved ? `Already in ${listName}` : `Saved to ${listName}`);
          setTimeout(() => setSaveToast(null), 2400);
        }}
        onError={(msg) => {
          setSaveSheetOpen(false);
          setSaveToast(msg);
          setTimeout(() => setSaveToast(null), 2800);
        }}
      />

      {/* Send — 1:1 DM the underlying object (Messaging §58). Sends the
          canonical SeenSnap entity, not a screenshot of the post. */}
      <SendToUserSheet
        visible={sendSheetOpen}
        token={token}
        contentType={post.title ? "title" : post.list ? "list" : undefined}
        contentId={post.title?.id ?? post.list?.id}
        sourceSurface="social_feed"
        preview={
          post.title
            ? {
                headline: post.title.title,
                subline: post.title.content_type === "movie" ? "FILM" : "SERIES",
                thumbnailUrl: post.title.poster_url,
              }
            : post.list
            ? {
                headline: post.list.name,
                subline: `${post.list.item_count} ${post.list.item_count === 1 ? "title" : "titles"}`,
                thumbnailUrl: post.list.preview[0]?.poster_url ?? null,
              }
            : undefined
        }
        onClose={() => setSendSheetOpen(false)}
        onSent={(_msg, recipient) => {
          setSaveToast(`Sent to ${recipient.display_name ?? "them"}`);
          setTimeout(() => setSaveToast(null), 2400);
        }}
        onError={(m) => {
          setSaveToast(m);
          setTimeout(() => setSaveToast(null), 2800);
        }}
      />
    </View>
  );
}

function formatPostType(post: SocialPost): string {
  switch (post.post_type) {
    case "title_share": return "recommended";
    case "rating_share": return post.rating?.score ? `rated ${post.rating.score.toFixed(1)}` : "rated";
    case "review_share": return "reviewed";
    case "list_share": return "shared a list";
    case "list_publish": return "published a list";
    default: return post.post_type;
  }
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  contextualBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: rules.default,
  },
  // maxWidth caps the feed to a comfortable reading column on desktop
  // (mobile web ignores it because it's narrower than 640 anyway).
  // alignSelf: center keeps the column centered in wide viewports.
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyRoot: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(244,196,48,0.10)",
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.30)",
    marginBottom: spacing.sm,
  },
  emptyTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 26,
    textAlign: "center",
    letterSpacing: -0.3,
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 320,
    paddingHorizontal: spacing.md,
  },
  emptyActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.md,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radii.pill,
  },
  actionBtnPrimary: { backgroundColor: colors.accent },
  actionBtnPrimaryText: { color: colors.background, fontFamily: fonts.monoSemiBold, fontSize: 12, letterSpacing: 0.4 },
  actionBtnSecondary: { borderWidth: 1, borderColor: rules.default },
  actionBtnSecondaryText: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 12 },
  errorTitle: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 20 },
  errorBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, textAlign: "center" },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  retryBtnText: { color: colors.background, fontFamily: fonts.monoSemiBold, fontSize: 12 },
  // Find-people panel (appears when contextual "+person" tapped)
  findPeoplePanel: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
    gap: spacing.sm,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: rules.default,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.background,
  },
  searchInput: {
    flex: 1,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    padding: 0,
  },
  searchResultRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  searchResultLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  searchResultName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 14 },
  searchResultHandle: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  followBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  followBtnText: { color: colors.background, fontFamily: fonts.monoSemiBold, fontSize: 11, letterSpacing: 0.4 },
  // Feed card
  card: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  cardAuthorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: spacing.md,
  },
  cardAuthorName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 14 },
  cardAuthorMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  cardCaption: {
    color: colors.ink,
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 15,
    lineHeight: 20,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  cardTitleBlock: {
    height: 180,
    marginHorizontal: spacing.md,
    borderRadius: radii.sm,
    overflow: "hidden",
    backgroundColor: colors.background,
  },
  cardTitleShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(4,8,14,0.55)",
  },
  cardTitleBody: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 14,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 10,
  },
  cardTitleName: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.3,
    flex: 1,
  },
  ratingBadge: {
    minWidth: 44,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
  },
  ratingBadgeText: { color: colors.background, fontFamily: fonts.monoSemiBold, fontSize: 13 },
  cardListBlock: {
    marginHorizontal: spacing.md,
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.background,
    gap: 6,
  },
  cardListName: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 17, letterSpacing: -0.2 },
  cardListMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.5 },
  cardListPreviewRow: { flexDirection: "row", gap: 6, marginTop: 8 },
  cardListPreviewPoster: {
    // Fixed size — previously flex:1 which meant on desktop web each
    // poster ballooned to ~400px wide (viewport / 5) with a 2:3 aspect
    // ratio, filling half the screen. Fixed dimensions keep the row a
    // proper mini-strip on every viewport.
    width: 60,
    height: 90,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    padding: spacing.md,
    paddingTop: spacing.sm,
  },
  cardAction: { flexDirection: "row", alignItems: "center", gap: 5 },
  cardActionText: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12 },
  cardVisibility: {
    color: colors.muted,
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.2,
  },
  overflowBtn: {
    padding: 4,
    marginLeft: 6,
  },
  overflowMenu: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.surfaceSoft,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    overflow: "hidden",
  },
  overflowItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  overflowItemText: {
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  commentsBlock: {
    borderTopWidth: 1,
    borderTopColor: rules.default,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  commentsEmpty: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontStyle: "italic",
  },
  commentRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start",
  },
  commentAuthor: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
    marginBottom: 2,
  },
  commentMeta: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "400",
  },
  commentBody: {
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  commentComposer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  commentInput: {
    flex: 1,
    minHeight: 36,
    maxHeight: 100,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    backgroundColor: colors.surfaceSoft,
    borderRadius: radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: rules.default,
  },
  commentSendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  commentSendBtnDisabled: {
    opacity: 0.4,
  },
  saveToast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    backgroundColor: colors.surfaceSoft,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.gold,
  },
  saveToastText: {
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
  },
});
