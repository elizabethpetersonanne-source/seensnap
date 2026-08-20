/**
 * ShareComposerSheet — Social brief §8 + §9 + §41 + §42.
 *
 * ONE reusable composer for every "Share to Feed" flow. Entity types:
 *   - title  → title_share (recommend a movie/show)
 *   - rating → rating_share (share your rating; optional caption)
 *   - list   → list_share (share one of your watchlists)
 *
 * Composer shape:
 *   [Poster + title/list summary]
 *   [Optional caption input, 500 chars]
 *   [Visibility picker: Followers (default) | Public | Private]
 *   [Cancel] [Post]
 *
 * Server enforces identity + visibility rules (§57). Client posts to
 * /social/posts and closes on success.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

type Visibility = "public" | "followers" | "private";

type BaseProps = {
  visible: boolean;
  token: string | null;
  sourceSurface: string;
  onClose: () => void;
  onPosted?: (postId: string) => void;
};

type TitleProps = BaseProps & {
  entityType: "title";
  titleId: string;
  titleName: string;
  posterUrl?: string | null;
  contentType?: string;
};

type RatingProps = BaseProps & {
  entityType: "rating";
  ratingId: string;
  titleId: string;
  titleName: string;
  ratingScore: number;
  posterUrl?: string | null;
};

type ListProps = BaseProps & {
  entityType: "list";
  listId: string;
  listName: string;
  listDescription?: string | null;
  itemCount?: number;
  previewPosters?: string[];
};

export type ShareComposerProps = TitleProps | RatingProps | ListProps;


function labelForVisibility(v: Visibility): string {
  return v === "public" ? "Public" : v === "followers" ? "Followers" : "Only me";
}

function iconForVisibility(v: Visibility): keyof typeof Ionicons.glyphMap {
  return v === "public" ? "globe-outline" : v === "followers" ? "people-outline" : "lock-closed-outline";
}


export function ShareComposerSheet(props: ShareComposerProps) {
  const { visible, token, sourceSurface, onClose, onPosted } = props;
  const [caption, setCaption] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("followers");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset composer state each time it opens.
  useEffect(() => {
    if (visible) {
      setCaption("");
      setVisibility("followers");
      setError(null);
      trackEvent("share_to_feed_started", {
        entity_type: props.entityType,
        source_surface: sourceSurface,
      });
    }
  }, [visible]);

  async function submit() {
    if (!token) {
      setError("Sign in required.");
      return;
    }
    setPosting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        visibility,
        caption: caption.trim() || null,
      };
      if (props.entityType === "title") {
        body.post_type = "title_share";
        body.title_id = props.titleId;
      } else if (props.entityType === "rating") {
        body.post_type = "rating_share";
        body.rating_id = props.ratingId;
        body.title_id = props.titleId;
      } else {
        body.post_type = "list_share";
        body.list_id = props.listId;
      }
      const resp = await apiRequest<{ id: string }>("/social/posts", {
        method: "POST",
        token,
        body: JSON.stringify(body),
      });
      trackEvent("share_to_feed_completed", {
        entity_type: props.entityType,
        source_surface: sourceSurface,
        post_id: resp.id,
        visibility,
      });
      onPosted?.(resp.id);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't post — try again.";
      setError(msg);
      trackEvent("share_to_feed_failed", {
        entity_type: props.entityType,
        source_surface: sourceSurface,
        reason: msg,
      });
    } finally {
      setPosting(false);
    }
  }

  function handleCancel() {
    trackEvent("share_to_feed_cancelled", {
      entity_type: props.entityType,
      source_surface: sourceSurface,
    });
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleCancel}>
      <Pressable style={styles.backdrop} onPress={handleCancel}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.handle} />
            <Text style={styles.kicker}>Share to Feed</Text>

            {/* Entity preview — different shape per type but same slot. */}
            {props.entityType === "title" || props.entityType === "rating" ? (
              <View style={styles.previewRow}>
                <View style={styles.previewPoster}>
                  {props.posterUrl ? (
                    <Image source={{ uri: props.posterUrl }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                  ) : (
                    <Ionicons name="film-outline" size={24} color={colors.muted} />
                  )}
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.previewTitle} numberOfLines={2}>{props.titleName}</Text>
                  {props.entityType === "rating" ? (
                    <View style={styles.ratingChip}>
                      <Text style={styles.ratingChipText}>{props.ratingScore.toFixed(1)} / 10</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : (
              <View style={styles.listPreview}>
                <Text style={styles.previewTitle}>{props.listName}</Text>
                {props.listDescription ? (
                  <Text style={styles.listDesc} numberOfLines={2}>{props.listDescription}</Text>
                ) : null}
                <Text style={styles.listMeta}>
                  {(props.itemCount ?? props.previewPosters?.length ?? 0)} titles
                </Text>
                {props.previewPosters && props.previewPosters.length > 0 ? (
                  <View style={styles.listPreviewRow}>
                    {props.previewPosters.slice(0, 5).map((url, i) => (
                      <View key={`${url}-${i}`} style={styles.listPreviewPoster}>
                        <Image source={{ uri: url }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            )}

            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder={placeholderFor(props)}
              placeholderTextColor={colors.muted}
              multiline
              maxLength={500}
              style={styles.captionInput}
            />
            <Text style={styles.captionCounter}>{caption.length} / 500</Text>

            <Text style={styles.sectionLabel}>Who can see this?</Text>
            <View style={styles.visibilityRow}>
              {(["followers", "public", "private"] as const).map((v) => {
                const selected = visibility === v;
                return (
                  <Pressable
                    key={v}
                    onPress={() => setVisibility(v)}
                    style={[styles.visibilityChip, selected && styles.visibilityChipActive]}
                  >
                    <Ionicons
                      name={iconForVisibility(v)}
                      size={14}
                      color={selected ? colors.background : colors.muted}
                    />
                    <Text style={[styles.visibilityText, selected && styles.visibilityTextActive]}>
                      {labelForVisibility(v)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <View style={styles.footerRow}>
              <Pressable style={styles.cancelBtn} onPress={handleCancel} disabled={posting}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.postBtn, posting && styles.postBtnDisabled]}
                onPress={() => void submit()}
                disabled={posting}
              >
                {posting ? (
                  <ActivityIndicator color={colors.background} size="small" />
                ) : (
                  <Text style={styles.postBtnText}>Post</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function placeholderFor(props: ShareComposerProps): string {
  switch (props.entityType) {
    case "title": return "Your take on this title…";
    case "rating": return "Optional — why you gave it that score…";
    case "list": return "Optional — a note about this list…";
  }
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(4,8,14,0.72)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: spacing.lg,
    paddingTop: 12,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: rules.default,
    marginBottom: spacing.sm,
  },
  kicker: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  previewRow: {
    flexDirection: "row",
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
  },
  previewPoster: {
    width: 52,
    height: 78,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: colors.backgroundElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  previewTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 17,
    lineHeight: 21,
    letterSpacing: -0.2,
  },
  ratingChip: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  ratingChipText: {
    color: colors.background,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.4,
  },
  listPreview: {
    padding: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    gap: 6,
  },
  listDesc: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  listMeta: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  listPreviewRow: { flexDirection: "row", gap: 6, marginTop: 8 },
  listPreviewPoster: {
    flex: 1,
    aspectRatio: 2 / 3,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: colors.backgroundElevated,
  },
  captionInput: {
    minHeight: 88,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    padding: 12,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    backgroundColor: colors.surface,
    textAlignVertical: "top",
  },
  captionCounter: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 10,
    textAlign: "right",
  },
  sectionLabel: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginTop: 6,
  },
  visibilityRow: { flexDirection: "row", gap: 8 },
  visibilityChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
  },
  visibilityChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  visibilityText: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
  },
  visibilityTextActive: { color: colors.background },
  errorText: {
    color: colors.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 4,
  },
  footerRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.sm,
  },
  cancelBtn: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: rules.default,
  },
  cancelBtnText: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
  },
  postBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  postBtnDisabled: { opacity: 0.6 },
  postBtnText: {
    color: colors.background,
    fontFamily: fonts.monoSemiBold,
    fontSize: 13,
    letterSpacing: 0.4,
  },
});
