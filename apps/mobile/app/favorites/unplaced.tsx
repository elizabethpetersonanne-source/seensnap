/**
 * Oct-27 follow-up R05–R06: Rated but not ranked.
 *
 * Owner-only list of titles the viewer has rated numerically but has
 * NOT placed in Ranked Favorites yet. Two actions per title:
 *   - Place in ranking → push /favorites/ranked (user picks position)
 *   - Add remaining by rating → bulk append in score order
 *
 * The bulk-add appends to the END of the current ranking and never
 * reshuffles existing manually ranked titles.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


type UnplacedRow = {
  title_id: string;
  tmdb_id: number | null;
  title: string;
  poster_url: string | null;
  year: number | null;
  media_type: string;
  personal_score: number;
};

type UnplacedResponse = { items: UnplacedRow[]; total: number };


export default function UnplacedScreen() {
  const { sessionToken } = useAuth();
  const [rows, setRows] = useState<UnplacedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    try {
      const data = await apiRequest<UnplacedResponse>(
        "/me/favorites/ranked/unplaced?limit=500",
        { token: sessionToken },
      );
      setRows(data.items);
      setTotal(data.total);
    } catch {
      // keep whatever was already shown
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => { void load(); }, [load]);

  async function placeOne(row: UnplacedRow) {
    if (!sessionToken || busyId) return;
    setBusyId(row.title_id);
    try {
      await apiRequest("/me/favorites/ranked", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ title_id: row.title_id }),
      });
      setRows((prev) => prev.filter((r) => r.title_id !== row.title_id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      Alert.alert("Couldn't add", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function bulkAdd() {
    if (!sessionToken || bulkBusy) return;
    Alert.alert(
      `Append ${rows.length} titles by rating?`,
      "They'll be added to the END of your ranking in score order. Your existing manual order isn't changed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Append",
          onPress: async () => {
            setBulkBusy(true);
            try {
              await apiRequest("/me/favorites/ranked/append-unplaced", {
                method: "POST",
                token: sessionToken,
                body: JSON.stringify({}),
              });
              // Everything is placed now.
              setRows([]);
              setTotal(0);
            } catch (e) {
              Alert.alert("Couldn't append", e instanceof Error ? e.message : "Try again.");
            } finally {
              setBulkBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Rated · not yet placed</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.subhead}>
        <Text style={styles.subheadText}>
          {total} rated {total === 1 ? "title" : "titles"} aren't in your Ranked Favorites yet. Place
          them one at a time or append all by score.
        </Text>
      </View>

      {rows.length > 0 ? (
        <Pressable
          onPress={bulkAdd}
          disabled={bulkBusy}
          style={({ pressed }) => [styles.bulkBtn, (bulkBusy || pressed) && { opacity: 0.7 }]}
        >
          <Ionicons name="add-circle-outline" size={16} color={colors.background} />
          <Text style={styles.bulkBtnLabel}>
            {bulkBusy ? "Appending…" : `Append all ${rows.length} by rating`}
          </Text>
        </Pressable>
      ) : null}

      {loading && rows.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="checkmark-circle-outline" size={32} color={colors.muted} />
          <Text style={styles.emptyBody}>Every rated title is placed.</Text>
          <Pressable onPress={() => router.push("/favorites/ranked")} style={styles.emptyCta}>
            <Text style={styles.emptyCtaLabel}>Open Ranked Favorites</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.title_id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.row}>
              {item.poster_url ? (
                <Image source={{ uri: item.poster_url }} style={styles.poster} />
              ) : (
                <View style={[styles.poster, styles.posterEmpty]}>
                  <Ionicons name="film-outline" size={18} color={colors.muted} />
                </View>
              )}
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.rowTitle} numberOfLines={2}>{item.title}</Text>
                <Text style={styles.rowMeta}>
                  {item.media_type === "movie" ? "FILM" : "SERIES"}
                  {item.year ? ` · ${item.year}` : ""}
                  {`  ·  You ${item.personal_score}/10`}
                </Text>
              </View>
              <Pressable
                onPress={() => void placeOne(item)}
                disabled={busyId === item.title_id}
                hitSlop={6}
                style={({ pressed }) => [styles.placeBtn, (pressed || busyId === item.title_id) && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel={`Add ${item.title} to ranking`}
              >
                <Ionicons name="add" size={14} color={colors.background} />
                <Text style={styles.placeBtnLabel}>Place</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  closeBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 15 },
  subhead: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  subheadText: { fontFamily: fonts.sans, color: colors.muted, fontSize: 12, lineHeight: 16 },
  bulkBtn: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.accent,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
  },
  bulkBtnLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.background,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  emptyBody: { fontFamily: fonts.sans, color: colors.ink, fontSize: 13, textAlign: "center" },
  emptyCta: {
    marginTop: spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  emptyCtaLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.background,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  list: { padding: spacing.md, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  poster: { width: 44, height: 66, borderRadius: 4, backgroundColor: colors.surfaceMuted },
  posterEmpty: { alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 13 },
  rowMeta: { fontFamily: fonts.sans, color: colors.muted, fontSize: 11 },
  placeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.accent,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  placeBtnLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.background,
    fontSize: 11,
    letterSpacing: 0.3,
  },
});
