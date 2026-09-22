/**
 * Sep-22 execution brief §2 — Category chips shared by Swipe and Previews.
 *
 * Filter semantics:
 *   - Movies / Series set a mutually exclusive media_type filter.
 *   - Genre chips (Comedy, Thriller, Documentary, Action, More) layer
 *     on top of the media-type choice.
 *   - For You clears both dimensions and restores the personalized feed.
 *   - Tapping the currently-selected type or genre clears that dimension.
 *
 * Filter changes bubble up via onChange so each screen can reset its
 * queue and cancel stale requests.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

export type MediaType = "movie" | "show" | null;
export type Genre = string | null; // lowercase — matches ContentTitle.genres

export type CategoryFilter = { media_type: MediaType; genre: Genre };

const PRIMARY_GENRES = [
  { label: "Comedy", value: "comedy" },
  { label: "Thriller", value: "thriller" },
  { label: "Documentary", value: "documentary" },
  { label: "Action", value: "action" },
];

// "More" sheet — TMDB's common genres, mirrored here as lowercase
// strings. Kept small; the server does case-insensitive membership
// against ContentTitle.genres so unknown labels degrade to no filter.
const MORE_GENRES = [
  { label: "Drama", value: "drama" },
  { label: "Romance", value: "romance" },
  { label: "Horror", value: "horror" },
  { label: "Sci-Fi", value: "science fiction" },
  { label: "Fantasy", value: "fantasy" },
  { label: "Animation", value: "animation" },
  { label: "Family", value: "family" },
  { label: "Mystery", value: "mystery" },
  { label: "Crime", value: "crime" },
  { label: "Adventure", value: "adventure" },
  { label: "History", value: "history" },
  { label: "War", value: "war" },
  { label: "Music", value: "music" },
  { label: "Western", value: "western" },
];

export function CategoryChips({
  value,
  onChange,
}: {
  value: CategoryFilter;
  onChange: (next: CategoryFilter) => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const forYouActive = value.media_type == null && value.genre == null;

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        <Chip
          label="For You"
          active={forYouActive}
          onPress={() => onChange({ media_type: null, genre: null })}
        />
        <Chip
          label="Movies"
          active={value.media_type === "movie"}
          onPress={() =>
            onChange({
              media_type: value.media_type === "movie" ? null : "movie",
              genre: value.genre,
            })
          }
        />
        <Chip
          label="Series"
          active={value.media_type === "show"}
          onPress={() =>
            onChange({
              media_type: value.media_type === "show" ? null : "show",
              genre: value.genre,
            })
          }
        />
        {PRIMARY_GENRES.map((g) => (
          <Chip
            key={g.value}
            label={g.label}
            active={value.genre === g.value}
            onPress={() =>
              onChange({
                media_type: value.media_type,
                genre: value.genre === g.value ? null : g.value,
              })
            }
          />
        ))}
        <Chip
          label="More"
          active={value.genre != null && !PRIMARY_GENRES.find((g) => g.value === value.genre)}
          onPress={() => setShowMore(true)}
          icon="chevron-down"
        />
      </ScrollView>

      {value.media_type != null || value.genre != null ? (
        <Text style={styles.activeSummary}>
          {value.media_type === "movie"
            ? "Movies"
            : value.media_type === "show"
              ? "Series"
              : ""}
          {value.media_type != null && value.genre != null ? " · " : ""}
          {value.genre != null
            ? [...PRIMARY_GENRES, ...MORE_GENRES].find((g) => g.value === value.genre)?.label ?? value.genre
            : ""}
        </Text>
      ) : null}

      <Modal
        visible={showMore}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMore(false)}
      >
        <Pressable style={styles.moreBackdrop} onPress={() => setShowMore(false)}>
          <Pressable style={styles.moreSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.moreHeader}>
              <Text style={styles.moreTitle}>More genres</Text>
              <Pressable onPress={() => setShowMore(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.moreGrid}>
              {MORE_GENRES.map((g) => (
                <Pressable
                  key={g.value}
                  onPress={() => {
                    onChange({ media_type: value.media_type, genre: g.value });
                    setShowMore(false);
                  }}
                  style={[styles.moreChip, value.genre === g.value && styles.moreChipActive]}
                >
                  <Text
                    style={[
                      styles.moreChipText,
                      value.genre === g.value && styles.moreChipTextActive,
                    ]}
                  >
                    {g.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
      {icon ? (
        <Ionicons
          name={icon}
          size={12}
          color={active ? colors.background : colors.ink}
          style={{ marginLeft: 4 }}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: rules.default,
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.4,
    color: colors.ink,
    textTransform: "uppercase",
  },
  chipTextActive: {
    color: colors.background,
  },
  activeSummary: {
    marginTop: 6,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.muted,
  },
  moreBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  moreSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radii.md,
    borderTopRightRadius: radii.md,
    borderTopWidth: 1,
    borderColor: rules.default,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
    maxHeight: "70%",
  },
  moreHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  moreTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 20,
    color: colors.ink,
  },
  moreGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  moreChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: rules.default,
  },
  moreChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  moreChipText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.ink,
  },
  moreChipTextActive: {
    color: colors.background,
    fontFamily: fonts.sansBold,
  },
});
