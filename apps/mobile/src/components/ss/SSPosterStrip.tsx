import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { SSPosterFrame } from "./SSPosterFrame";
import { SSMetadataRail } from "./SSMetadataRail";

type PosterItem = {
  id: string;
  imageUri?: string | null;
  title: string;
  year?: number | string | null;
  type?: string | null;
};

type SSPosterStripProps = {
  items: PosterItem[];
  onPress?: (item: PosterItem) => void;
  posterWidth?: number;
  posterHeight?: number;
  style?: ViewStyle;
  showMetadata?: boolean;
};

export function SSPosterStrip({
  items,
  onPress,
  posterWidth = 120,
  posterHeight = 180,
  style,
  showMetadata = true,
}: SSPosterStripProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.content, style]}
    >
      {items.map((item) => (
        <Pressable
          key={item.id}
          onPress={() => onPress?.(item)}
          style={[styles.item, { width: posterWidth }]}
        >
          <SSPosterFrame uri={item.imageUri} width={posterWidth} height={posterHeight} style={styles.poster} />
          {showMetadata ? (
            <View style={styles.meta}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <SSMetadataRail items={[item.year?.toString(), item.type]} />
            </View>
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  item: {
    gap: spacing.xs,
  },
  poster: {
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
  },
  meta: {
    gap: 3,
  },
  title: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.ink,
    lineHeight: 16,
  },
});
