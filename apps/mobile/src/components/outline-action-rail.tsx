/**
 * Oct-18 build brief §4 shared visual primitive: OutlineActionRail.
 *
 * No black circular backplates. No filled capsules. No text labels in
 * resting state. Outline icons spaced for comfortable thumbs, with
 * accessible labels + large invisible touch targets. Rating opens the
 * horizontal InlineRatingRail inline (never a modal here).
 *
 * Variants:
 *   discovery  — Save · Send · Team · Rate
 *   social     — Like · Comment · Save · Send · Team · Rate
 *   team       — Like · Comment · Save · Send · Rate   (no Team button inside a Team)
 *
 * Personal Favorite, Save, and social Like are DISTINCT states/actions
 * — brief §4 explicitly forbids merging them into one boolean. The
 * owning screen keeps independent state for each and passes it in.
 */
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, View } from "react-native";

import { InlineRatingRail, type RatingSnapshot } from "@/components/rating-editor";
import { colors } from "@/constants/theme";


export type RailVariant = "discovery" | "social" | "team";


export function OutlineActionRail({
  variant,
  token,
  titleId,
  // Per-action state
  saved,
  liked,
  // Per-action handlers
  onSave,
  onLike,
  onComment,
  onSend,
  onTeam,
  // Rating state passed through to InlineRatingRail
  ratingSnapshot,
  onRatingChanged,
  // Visual sizing
  size = "md",
}: {
  variant: RailVariant;
  token: string | null;
  titleId: string | null;
  saved: boolean;
  liked?: boolean;
  onSave: () => void;
  onLike?: () => void;
  onComment?: () => void;
  onSend: () => void;
  onTeam?: () => void;
  ratingSnapshot: RatingSnapshot | null;
  onRatingChanged?: (next: RatingSnapshot) => void;
  size?: "sm" | "md" | "lg";
}) {
  const iconSize = size === "sm" ? 18 : size === "lg" ? 26 : 22;
  return (
    <View style={styles.row}>
      {variant !== "discovery" ? (
        <>
          <RailButton
            icon={liked ? "heart" : "heart-outline"}
            label={liked ? "Unlike post" : "Like post"}
            onPress={onLike}
            iconColor={liked ? colors.accent : colors.ink}
            size={iconSize}
          />
          <RailButton
            icon="chatbubble-outline"
            label="Open comments"
            onPress={onComment}
            size={iconSize}
          />
        </>
      ) : null}
      <RailButton
        icon={saved ? "bookmark" : "bookmark-outline"}
        label={saved ? "Saved" : "Save"}
        onPress={onSave}
        iconColor={saved ? colors.accent : colors.ink}
        size={iconSize}
      />
      <RailButton
        icon="paper-plane-outline"
        label="Send"
        onPress={onSend}
        size={iconSize}
      />
      {variant !== "team" ? (
        <RailButton
          icon="people-outline"
          label="Add to a Watch Team"
          onPress={onTeam}
          size={iconSize}
        />
      ) : null}
      <View style={styles.ratingSlot}>
        <InlineRatingRail
          token={token}
          titleId={titleId}
          snapshot={ratingSnapshot}
          onChanged={onRatingChanged}
          size={size}
        />
      </View>
    </View>
  );
}

function RailButton({
  icon,
  label,
  onPress,
  iconColor = colors.ink,
  size = 22,
}: {
  icon: keyof typeof import("@expo/vector-icons/build/Ionicons").default.glyphMap;
  label: string;
  onPress: (() => void) | undefined;
  iconColor?: string;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.btn, pressed && { opacity: 0.65 }]}
    >
      <Ionicons name={icon as any} size={size} color={iconColor} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
  },
  btn: {
    // Invisible 44x44 touch target per brief §4 accessibility.
    minWidth: 44,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  ratingSlot: {
    marginLeft: "auto",
    minHeight: 44,
    justifyContent: "center",
  },
});
