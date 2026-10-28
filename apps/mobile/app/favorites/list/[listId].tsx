/**
 * Oct-27 personalization follow-up: dedicated list detail route.
 *
 * Users land here by tapping a list name in My Picks → My Lists.
 * Shows the list's titles, exposes a Previews button (same pattern
 * as Ranked Favorites), and offers Edit + Remove title + Delete
 * list through the already-shipped watchlist endpoints.
 */
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


type ListItem = {
  id: string;
  content_title_id: string;
  added_via: string;
  title: {
    id: string;
    title: string;
    content_type: string;
    poster_url: string | null;
    release_date: string | null;
  };
};

type ListResponse = {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  is_system_list: boolean;
  visibility: string;
  items: ListItem[];
};


export default function ListDetailScreen() {
  const { sessionToken } = useAuth();
  const { listId } = useLocalSearchParams<{ listId: string }>();
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editVisibility, setEditVisibility] = useState<"private" | "followers" | "public">("private");
  const [saving, setSaving] = useState(false);
  const [busyTitleId, setBusyTitleId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionToken || !listId) return;
    try {
      const res = await apiRequest<ListResponse>(`/me/watchlist/lists/${listId}`, { token: sessionToken });
      setList(res);
      setEditName(res.name);
      setEditDescription(res.description ?? "");
      setEditVisibility((res.visibility as "private" | "followers" | "public") ?? "private");
    } catch {
      setList(null);
    } finally {
      setLoading(false);
    }
  }, [sessionToken, listId]);

  useEffect(() => { void load(); }, [load]);

  async function saveEdits() {
    if (!sessionToken || !listId) return;
    const name = editName.trim();
    if (!name) {
      Alert.alert("Name required", "Give your list a name.");
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/me/watchlist/lists/${listId}`, {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({
          name,
          description: editDescription.trim() || null,
          visibility: editVisibility,
        }),
      });
      setEditing(false);
      await load();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function removeTitle(item: ListItem) {
    if (!sessionToken || !listId || busyTitleId) return;
    setBusyTitleId(item.content_title_id);
    try {
      await apiRequest(`/me/watchlist/lists/${listId}/titles/${item.content_title_id}`, {
        method: "DELETE",
        token: sessionToken,
      });
      setList((prev) => prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : prev);
    } catch (e) {
      Alert.alert("Couldn't remove", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusyTitleId(null);
    }
  }

  async function deleteList() {
    if (!sessionToken || !listId) return;
    Alert.alert(
      "Delete this list?",
      "The titles stay in your library — only this list and its share token are removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await apiRequest(`/me/watchlist/lists/${listId}`, { method: "DELETE", token: sessionToken });
              router.back();
            } catch (e) {
              Alert.alert("Couldn't delete", e instanceof Error ? e.message : "Try again.");
            }
          },
        },
      ],
    );
  }

  const canDelete = list && !list.is_default && !list.is_system_list;

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{list?.name ?? "List"}</Text>
        <Pressable
          onPress={() => setEditing((v) => !v)}
          hitSlop={10}
          style={styles.closeBtn}
          accessibilityRole="button"
          accessibilityLabel={editing ? "Done editing" : "Edit list details"}
        >
          <Ionicons name={editing ? "checkmark" : "create-outline"} size={20} color={colors.ink} />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : list === null ? (
        <View style={styles.center}>
          <Text style={styles.emptyBody}>Couldn't load this list.</Text>
          <Pressable onPress={load} style={styles.previewBtn}>
            <Text style={styles.previewBtnLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {editing ? (
            <View style={styles.editBlock}>
              <Text style={styles.label}>NAME</Text>
              <TextInput
                value={editName}
                onChangeText={setEditName}
                maxLength={60}
                style={styles.input}
              />
              <Text style={styles.label}>DESCRIPTION</Text>
              <TextInput
                value={editDescription}
                onChangeText={setEditDescription}
                multiline
                maxLength={280}
                style={[styles.input, { minHeight: 60 }]}
                placeholder="Describe this list…"
                placeholderTextColor={colors.muted2}
                textAlignVertical="top"
              />
              <Text style={styles.label}>VISIBILITY</Text>
              <View style={styles.audRow}>
                {(["private", "followers", "public"] as const).map((v) => {
                  const active = editVisibility === v;
                  return (
                    <Pressable
                      key={v}
                      onPress={() => setEditVisibility(v)}
                      style={[styles.audChip, active && styles.audChipActive]}
                    >
                      <Text style={[styles.audLabel, active && styles.audLabelActive]}>{v}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.editRow}>
                <Pressable style={styles.ghostBtn} onPress={() => setEditing(false)}>
                  <Text style={styles.ghostLabel}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={() => void saveEdits()} disabled={saving}>
                  <Text style={styles.saveLabel}>{saving ? "Saving…" : "Save"}</Text>
                </Pressable>
              </View>
              {canDelete ? (
                <Pressable style={styles.dangerBtn} onPress={() => void deleteList()}>
                  <Ionicons name="trash-outline" size={14} color={colors.danger} />
                  <Text style={styles.dangerLabel}>Delete this list</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {list.items.length > 0 ? (
            <Pressable
              style={styles.previewBtn}
              onPress={() => router.push({ pathname: "/(tabs)/previews", params: { list_id: list.id } })}
              accessibilityRole="button"
              accessibilityLabel="Watch previews of titles in this list"
            >
              <Ionicons name="play-circle-outline" size={16} color={colors.background} />
              <Text style={styles.previewBtnLabel}>Watch previews</Text>
            </Pressable>
          ) : null}

          <FlatList
            data={list.items}
            keyExtractor={(i) => i.id}
            contentContainerStyle={styles.listBody}
            renderItem={({ item }) => (
              <View style={styles.row}>
                {item.title.poster_url ? (
                  <Image source={{ uri: item.title.poster_url }} style={styles.poster} />
                ) : (
                  <View style={[styles.poster, styles.posterFallback]}>
                    <Ionicons name="film-outline" size={16} color={colors.muted2} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={2}>{item.title.title}</Text>
                  <Text style={styles.rowMeta}>
                    {item.title.content_type === "movie" ? "FILM" : "SERIES"}
                    {item.title.release_date ? ` · ${item.title.release_date.slice(0, 4)}` : ""}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void removeTitle(item)}
                  disabled={busyTitleId === item.content_title_id}
                  hitSlop={6}
                  style={styles.removeBtn}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.title.title} from this list`}
                >
                  {busyTitleId === item.content_title_id ? (
                    <ActivityIndicator size="small" color={colors.muted} />
                  ) : (
                    <Ionicons name="remove-circle-outline" size={18} color={colors.muted} />
                  )}
                </Pressable>
              </View>
            )}
            ListEmptyComponent={
              <View style={styles.center}>
                <Ionicons name="list-outline" size={28} color={colors.muted} />
                <Text style={styles.emptyBody}>No titles in this list yet.</Text>
              </View>
            }
          />
        </>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: spacing.sm },
  emptyBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  editBlock: {
    padding: spacing.md,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  label: { fontFamily: fonts.monoSemiBold, color: colors.muted, fontSize: 10, letterSpacing: 1.2, marginTop: 4 },
  input: {
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  audRow: { flexDirection: "row", gap: 6 },
  audChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
  },
  audChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  audLabel: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 12 },
  audLabelActive: { color: colors.background },
  editRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  ghostBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
  },
  ghostLabel: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 13 },
  saveBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    alignItems: "center",
  },
  saveLabel: { fontFamily: fonts.sansSemiBold, color: colors.background, fontSize: 13 },
  dangerBtn: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(224,42,70,0.3)",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  dangerLabel: { fontFamily: fonts.sansSemiBold, color: colors.danger, fontSize: 12 },
  previewBtn: {
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  previewBtnLabel: { fontFamily: fonts.sansSemiBold, color: colors.background, fontSize: 13 },
  listBody: { padding: spacing.md, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  poster: { width: 44, height: 66, borderRadius: 4, backgroundColor: colors.surfaceMuted },
  posterFallback: { alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 13 },
  rowMeta: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 11 },
  removeBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
});
