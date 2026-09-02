import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PlaceholderCard } from "@/components/placeholder-card";
import { Screen } from "@/components/screen";
import { colors, radii, spacing } from "@/constants/theme";

export default function SnipScreen() {
  return (
    <Screen
      title="Snip"
      subtitle="Manual title search and assisted image match are the agreed MVP recognition flow."
    >
      <View style={styles.mockup}>
        <View style={styles.preview}>
          <Text style={styles.brand}>SeenSnap</Text>
          <View style={styles.poster}>
            <Text style={styles.posterCaption}>Elizabeth</Text>
            <Text style={styles.posterTitle}>A local classic</Text>
          </View>
          <Text style={styles.previewMeta}>Point • Snip • Identify • Share</Text>
          <Pressable style={styles.snapButton} accessibilityLabel="Snip a title">
            <Text style={styles.snapButtonLabel}>SNIP</Text>
          </Pressable>
          <View style={styles.toolRow}>
            <View style={styles.tool}>
              <Ionicons name="camera" color={colors.ink} size={20} />
              <Text style={styles.toolLabel}>Identify</Text>
            </View>
            <View style={styles.tool}>
              <Ionicons name="star" color={colors.ink} size={20} />
              <Text style={styles.toolLabel}>Top 10</Text>
            </View>
            <View style={styles.tool}>
              <Ionicons name="disc" color={colors.ink} size={20} />
              <Text style={styles.toolLabel}>Spotify</Text>
            </View>
            <View style={styles.tool}>
              <Ionicons name="help" color={colors.ink} size={20} />
              <Text style={styles.toolLabel}>Quiz</Text>
            </View>
          </View>
          <Pressable style={styles.teamBar}>
            <Ionicons name="albums" color={colors.accent} size={18} />
            <Text style={styles.teamBarText}>Add snips to team</Text>
          </Pressable>
        </View>
      </View>
      <PlaceholderCard
        eyebrow="Capture"
        title="Camera and upload flow"
        body="This layout mirrors the Snip capture mockup. The next implementation step is wiring camera capture, upload, and manual match fallback into the existing backend Snip endpoints."
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  mockup: {
    alignItems: "center",
  },
  preview: {
    width: "100%",
    maxWidth: 360,
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: 32,
    backgroundColor: "#041120",
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 14 },
  },
  brand: {
    textAlign: "center",
    color: colors.accent,
    fontSize: 30,
    fontWeight: "900",
  },
  poster: {
    minHeight: 220,
    justifyContent: "flex-end",
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceSoft,
  },
  posterCaption: {
    color: colors.accent,
    fontWeight: "800",
  },
  posterTitle: {
    marginTop: 6,
    color: colors.ink,
    fontSize: 24,
    fontWeight: "900",
  },
  previewMeta: {
    textAlign: "center",
    color: colors.muted,
  },
  snapButton: {
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingVertical: 16,
  },
  snapButtonLabel: {
    textAlign: "center",
    color: colors.background,
    fontWeight: "900",
    fontSize: 28,
  },
  toolRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  tool: {
    alignItems: "center",
    gap: 8,
  },
  toolLabel: {
    color: colors.ink,
    fontSize: 12,
  },
  teamBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
  },
  teamBarText: {
    color: colors.ink,
    fontWeight: "700",
  },
});
