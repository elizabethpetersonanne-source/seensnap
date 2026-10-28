/**
 * Oct-27 Concierge chunk E completion: named-list picker.
 *
 * When the user asks "from my saved list" without naming one, the
 * Concierge decision returns status_detail=needs_list_selection.
 * This sheet lets them pick a specific list and re-runs the
 * decision pinned to that list_id. Previously the empty state only
 * surfaced a text-prompt chip, which forced the user to re-type the
 * list name instead of picking.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


type WatchlistSummary = {
  id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  is_system_list: boolean;
  visibility?: string;
  title_count: number;
  preview_posters?: string[];
};


export function ConciergeListPicker({
  visible,
  onCancel,
  onPick,
}: {
  visible: boolean;
  onCancel: () => void;
  // Caller re-runs the Concierge decision with collection_list_id.
  onPick: (listId: string, listName: string) => void;
}) {
  const { sessionToken } = useAuth();
  const [lists, setLists] = useState<WatchlistSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !sessionToken) return;
    let cancelled = false;
    setLoading(true);
    apiRequest<WatchlistSummary[]>("/me/watchlist/lists", { token: sessionToken })
      .then((rows) => { if (!cancelled) setLists(rows); })
      .catch(() => { if (!cancelled) setLists([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, sessionToken]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>PICK A LIST</Text>
              <Text style={styles.heading}>Which list should Concierge search?</Text>
            </View>
            <Pressable onPress={onCancel} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.ink} />
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : lists.length === 0 ? (
            <View style={styles.center}>
              <Ionicons name="list-outline" size={28} color={colors.muted} />
              <Text style={styles.emptyBody}>
                You don't have any saved lists yet. Create one in My Picks to use this flow.
              </Text>
            </View>
          ) : (
            <FlatList
              data={lists}
              keyExtractor={(l) => l.id}
              contentContainerStyle={styles.listBody}
              renderItem={({ item }) => {
                const poster = item.preview_posters?.[0];
                return (
                  <Pressable
                    onPress={() => onPick(item.id, item.name)}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Pick ${item.name}`}
                  >
                    {poster ? (
                      <Image source={{ uri: poster }} style={styles.rowPoster} />
                    ) : (
                      <View style={[styles.rowPoster, styles.rowPosterFallback]}>
                        <Ionicons name="list-outline" size={16} color={colors.muted2} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.rowMeta}>
                        {item.title_count} {item.title_count === 1 ? "title" : "titles"}
                        {item.is_default ? "  ·  default" : ""}
                        {item.visibility && item.visibility !== "private" ? `  ·  ${item.visibility}` : ""}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.muted2} />
                  </Pressable>
                );
              }}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}


const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    maxHeight: "80%",
    minHeight: 280,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  eyebrow: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  heading: {
    marginTop: 4,
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 18,
    letterSpacing: -0.1,
  },
  center: { padding: spacing.xl, alignItems: "center", gap: spacing.sm },
  emptyBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    maxWidth: 300,
  },
  listBody: { gap: 8, paddingBottom: spacing.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  rowPoster: {
    width: 44,
    height: 66,
    borderRadius: 4,
    backgroundColor: colors.surfaceMuted,
  },
  rowPosterFallback: { alignItems: "center", justifyContent: "center" },
  rowName: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  rowMeta: { fontFamily: fonts.sans, color: colors.muted, fontSize: 11, marginTop: 2 },
});
