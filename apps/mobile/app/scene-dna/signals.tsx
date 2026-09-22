/**
 * SceneDNA — Recent Signals list with Remove influence controls.
 *
 * Sep-22 execution brief §8. Free-tier surface (per §9): correction
 * is never gated behind Premium.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
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
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

type SignalRow = {
  id: string;
  title_id: string;
  title: string;
  poster_url: string | null;
  action: "left" | "right" | "up" | string;
  influence_active: boolean;
  created_at: string;
};

type SignalListResponse = {
  items: SignalRow[];
  next_offset: number | null;
  total: number;
};

export default function SceneDNASignalsScreen() {
  const { sessionToken } = useAuth();
  const [items, setItems] = useState<SignalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<SignalListResponse>(
        "/me/scene-dna/signals?limit=50",
        { token: sessionToken },
      );
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your signals.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: SignalRow) {
    if (!sessionToken || busyId) return;
    setBusyId(row.id);
    const nextActive = !row.influence_active;
    // Optimistic — snap the row's visible state then reconcile.
    setItems((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, influence_active: nextActive } : r)),
    );
    try {
      const endpoint = nextActive ? "enable" : "disable";
      await apiRequest(`/me/scene-dna/signals/${row.id}/${endpoint}`, {
        method: "POST",
        token: sessionToken,
      });
    } catch (e) {
      // Roll back on failure
      setItems((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, influence_active: !nextActive } : r)),
      );
      setError(e instanceof Error ? e.message : "Couldn't update signal.");
    } finally {
      setBusyId(null);
    }
  }

  const actionLabel = (a: string) =>
    a === "right" ? "Liked" : a === "up" ? "Saved" : a === "left" ? "Passed" : a;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.heading}>Recent SceneDNA signals</Text>
        <View style={{ width: 24 }} />
      </View>
      <Text style={styles.subheading}>
        {total > 0
          ? `${total} signal${total === 1 ? "" : "s"} shaping your taste. Remove any that don't feel like you.`
          : "Your signals will appear as you swipe, save, and rate."}
      </Text>
      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.centerFill}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => void load()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.centerFill}>
          <Ionicons name="pulse-outline" size={38} color={colors.accent} />
          <Text style={styles.emptyBody}>
            No signals yet — swipe or save a few titles and they'll appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
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
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={2}>{item.title}</Text>
                <Text style={styles.rowMeta}>
                  {actionLabel(item.action)}
                  {" · "}
                  {new Date(item.created_at).toLocaleDateString()}
                </Text>
                {!item.influence_active ? (
                  <Text style={styles.mutedTag}>Influence removed</Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => void toggle(item)}
                disabled={busyId === item.id}
                style={[
                  styles.actionBtn,
                  item.influence_active ? styles.actionRemove : styles.actionRestore,
                  busyId === item.id && { opacity: 0.5 },
                ]}
              >
                <Text
                  style={[
                    styles.actionText,
                    item.influence_active ? styles.actionRemoveText : styles.actionRestoreText,
                  ]}
                >
                  {item.influence_active ? "Remove" : "Restore"}
                </Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  backBtn: { width: 24, alignItems: "flex-start" },
  heading: {
    fontFamily: fonts.serifBold,
    fontSize: 18,
    color: colors.ink,
    flex: 1,
    textAlign: "center",
  },
  subheading: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted,
    padding: spacing.md,
    lineHeight: 18,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    gap: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
  },
  poster: {
    width: 42,
    height: 62,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  posterEmpty: {
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.default,
  },
  rowTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.ink,
  },
  rowMeta: {
    marginTop: 2,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.4,
    color: colors.muted,
  },
  mutedTag: {
    marginTop: 4,
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.accent,
    textTransform: "uppercase",
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  actionRemove: {
    borderColor: rules.default,
  },
  actionRestore: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  actionText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  actionRemoveText: {
    color: colors.ink,
  },
  actionRestoreText: {
    color: colors.background,
  },
  centerFill: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
    maxWidth: 320,
  },
  errorText: {
    fontFamily: fonts.sans,
    color: colors.muted,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 999,
  },
  retryText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.ink,
  },
});
