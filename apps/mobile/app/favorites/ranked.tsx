/**
 * Ranked Favorites — Top 20 / Top 100 per Sep-22 execution brief §14.
 *
 * Single ordered collection of up to 100 unique titles. The two views
 * cannot disagree because they read the same rows. Personal 1-10
 * score displays alongside the collection rank but never overwrites
 * a customized order.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
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
import { SafeAreaView } from "react-native-safe-area-context";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";

type Row = {
  position: number;
  title_id: string;
  tmdb_id: number;
  title: string;
  poster_url: string | null;
  year: number | null;
  media_type: string;
  personal_score: number | null;
  version: number;
};

type ListResponse = { items: Row[]; total: number; max_capacity: number };
type DraftResponse = { draft: Row[]; would_replace: number };

type RankedView = "top20" | "top100";

export default function RankedFavoritesScreen() {
  const { sessionToken } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [view, setView] = useState<RankedView>("top20");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState<Row[] | null>(null);

  const visibleRows = view === "top20" ? rows.slice(0, 20) : rows;

  const load = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<ListResponse>("/me/favorites/ranked?limit=100", { token: sessionToken });
      setRows(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your ranked favorites.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => { void load(); }, [load]);

  async function move(row: Row, direction: "up" | "down") {
    if (!sessionToken || busyId) return;
    const currentIndex = rows.findIndex((r) => r.title_id === row.title_id);
    if (currentIndex < 0) return;
    const target = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (target < 0 || target >= rows.length) return;
    const toPosition = target + 1;
    setBusyId(row.title_id);
    // Optimistic reorder
    const next = [...rows];
    const [taken] = next.splice(currentIndex, 1);
    next.splice(target, 0, taken);
    setRows(next.map((r, i) => ({ ...r, position: i + 1 })));
    try {
      const data = await apiRequest<ListResponse>(
        `/me/favorites/ranked/${row.title_id}/move`,
        {
          method: "POST",
          token: sessionToken,
          body: JSON.stringify({ to_position: toPosition }),
        },
      );
      setRows(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reorder.");
      void load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: Row) {
    if (!sessionToken || busyId) return;
    setBusyId(row.title_id);
    try {
      const data = await apiRequest<ListResponse>(
        `/me/favorites/ranked/${row.title_id}`,
        { method: "DELETE", token: sessionToken },
      );
      setRows(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove.");
    } finally {
      setBusyId(null);
    }
  }

  async function fetchDraft() {
    if (!sessionToken) return;
    try {
      const data = await apiRequest<DraftResponse>(
        "/me/favorites/ranked/rebuild-draft",
        { method: "POST", token: sessionToken },
      );
      setConfirmRebuild(data.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate draft.");
    }
  }

  async function applyDraft() {
    if (!sessionToken || confirmRebuild == null) return;
    try {
      const data = await apiRequest<ListResponse>(
        "/me/favorites/ranked",
        {
          method: "PUT",
          token: sessionToken,
          body: JSON.stringify({ title_ids: confirmRebuild.map((r) => r.title_id) }),
        },
      );
      setRows(data.items);
      setConfirmRebuild(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.heading}>Ranked favorites</Text>
        <Pressable onPress={() => void fetchDraft()} hitSlop={10} accessibilityLabel="Rebuild from ratings">
          <Ionicons name="refresh" size={20} color={colors.accent} />
        </Pressable>
      </View>

      <View style={styles.viewToggle}>
        {(["top20", "top100"] as const).map((v) => {
          const active = view === v;
          return (
            <Pressable key={v} onPress={() => setView(v)} style={[styles.viewChip, active && styles.viewChipActive]}>
              <Text style={[styles.viewChipText, active && styles.viewChipTextActive]}>
                {v === "top20" ? "Top 20" : "Top 100"}
              </Text>
            </Pressable>
          );
        })}
        <View style={{ flex: 1 }} />
        <Text style={styles.countText}>
          {visibleRows.length} of {view === "top20" ? Math.min(rows.length, 20) : rows.length}
        </Text>
      </View>

      {rows.length > 0 ? (
        <Pressable
          style={styles.watchPreviewsBtn}
          onPress={() => router.push("/previews?ranked_source=me")}
          accessibilityLabel="Watch previews for this ranked list"
        >
          <Ionicons name="play-circle" size={16} color={colors.background} />
          <Text style={styles.watchPreviewsText}>Watch previews · this list's order</Text>
        </Pressable>
      ) : null}

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
      ) : rows.length === 0 ? (
        <View style={styles.centerFill}>
          <Ionicons name="trophy-outline" size={40} color={colors.accent} />
          <Text style={styles.emptyTitle}>Nothing ranked yet</Text>
          <Text style={styles.emptyBody}>
            Rate a few Watched titles and tap the refresh icon above to draft a Top 20 from your ratings — you'll always get to review before it saves.
          </Text>
        </View>
      ) : (
        <FlatList
          data={visibleRows}
          keyExtractor={(item) => item.title_id}
          contentContainerStyle={styles.list}
          renderItem={({ item, index }) => (
            <View style={styles.row}>
              <Text style={styles.rank}>#{item.position}</Text>
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
                  {item.media_type === "movie" ? "FILM" : "SERIES"}
                  {item.year ? ` · ${item.year}` : ""}
                  {item.personal_score != null ? ` · You ${item.personal_score}/10` : ""}
                </Text>
              </View>
              <View style={styles.rowActions}>
                <Pressable
                  onPress={() => void move(item, "up")}
                  disabled={busyId === item.title_id || index === 0}
                  style={[styles.iconBtn, index === 0 && { opacity: 0.3 }]}
                  accessibilityLabel="Move up"
                >
                  <Ionicons name="chevron-up" size={16} color={colors.ink} />
                </Pressable>
                <Pressable
                  onPress={() => void move(item, "down")}
                  disabled={busyId === item.title_id || index === visibleRows.length - 1}
                  style={[styles.iconBtn, index === visibleRows.length - 1 && { opacity: 0.3 }]}
                  accessibilityLabel="Move down"
                >
                  <Ionicons name="chevron-down" size={16} color={colors.ink} />
                </Pressable>
                <Pressable
                  onPress={() => void remove(item)}
                  disabled={busyId === item.title_id}
                  style={styles.iconBtn}
                  accessibilityLabel="Remove"
                >
                  <Ionicons name="close" size={16} color={colors.ink} />
                </Pressable>
              </View>
            </View>
          )}
        />
      )}

      {/* Rebuild-from-ratings confirmation preview. */}
      <Modal visible={confirmRebuild != null} transparent animationType="fade" onRequestClose={() => setConfirmRebuild(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setConfirmRebuild(null)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Replace with a rating-based draft?</Text>
            <Text style={styles.modalBody}>
              {rows.length > 0
                ? "Your current custom order will be replaced with a fresh ranking of your watched + rated titles. Preview below."
                : "We built a Top 20 draft from your watched + rated titles. Preview below and save if you want it."}
            </Text>
            <FlatList
              data={(confirmRebuild ?? []).slice(0, 20)}
              keyExtractor={(item) => item.title_id}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => (
                <View style={styles.previewRow}>
                  <Text style={styles.previewRank}>#{item.position}</Text>
                  <Text style={styles.previewTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.previewScore}>
                    {item.personal_score != null ? `${item.personal_score}/10` : ""}
                  </Text>
                </View>
              )}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.actionSecondary} onPress={() => setConfirmRebuild(null)}>
                <Text style={styles.actionSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.actionPrimary} onPress={() => void applyDraft()}>
                <Text style={styles.actionPrimaryText}>Save draft</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  backBtn: { width: 24 },
  heading: { fontFamily: fonts.serifBold, fontSize: 18, color: colors.ink, flex: 1, textAlign: "center" },
  viewToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  viewChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: rules.default,
  },
  viewChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  viewChipText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.ink,
    textTransform: "uppercase",
  },
  viewChipTextActive: {
    color: colors.background,
  },
  countText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.4,
  },
  watchPreviewsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingVertical: 10,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
  },
  watchPreviewsText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.background,
    textTransform: "uppercase",
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    gap: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
  },
  rank: {
    fontFamily: fonts.serifBold,
    fontSize: 14,
    color: colors.accent,
    width: 34,
  },
  poster: {
    width: 40,
    height: 60,
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
    fontSize: 13,
    color: colors.ink,
  },
  rowMeta: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.4,
    color: colors.muted,
    marginTop: 2,
  },
  rowActions: {
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.default,
  },
  centerFill: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: { fontFamily: fonts.serifBold, fontSize: 22, color: colors.ink },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
    maxWidth: 320,
  },
  errorText: { fontFamily: fonts.sans, color: colors.muted, textAlign: "center" },
  retryBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 999,
  },
  retryText: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.5, color: colors.ink },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  modalSheet: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.background,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalTitle: { fontFamily: fonts.serifBold, fontSize: 20, color: colors.ink },
  modalBody: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.muted },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  previewRank: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    color: colors.accent,
    width: 30,
  },
  previewTitle: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink,
  },
  previewScore: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.sm,
  },
  actionSecondary: {
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 6,
  },
  actionSecondaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.ink,
    textTransform: "uppercase",
  },
  actionPrimary: {
    flex: 1.4,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 6,
  },
  actionPrimaryText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.background,
    textTransform: "uppercase",
  },
});
