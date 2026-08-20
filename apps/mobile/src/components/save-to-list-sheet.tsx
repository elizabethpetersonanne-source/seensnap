import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { EditorialSheet } from "@/components/editorial-sheet";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";

type WatchlistSummary = {
  id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  is_system_list: boolean;
  title_count: number;
};

type Props = {
  visible: boolean;
  token: string | null;
  titleId: string | null;
  source: string;
  onClose: () => void;
  onSaved?: (listName: string, alreadySaved?: boolean) => void;
  onError?: (message: string) => void;
};

export function SaveToListSheet({ visible, token, titleId, source, onClose, onSaved, onError }: Props) {
  const [lists, setLists] = useState<WatchlistSummary[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!visible) {
      setCreating(false);
      setNewName("");
      setNewDescription("");
      setSelectedListId(null);
      return;
    }
  }, [visible]);

  useEffect(() => {
    async function loadLists() {
      if (!visible || !token) {
        return;
      }
      try {
        const data = await apiRequest<WatchlistSummary[]>("/me/watchlist/lists", { token });
        setLists(data);
        setSelectedListId(data[0]?.id ?? null);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : "Failed to load lists");
      }
    }
    void loadLists();
  }, [onError, token, visible]);

  async function saveToList() {
    const selectedList = lists.find((item) => item.id === selectedListId) ?? null;
    if (!token || !titleId || !selectedList || isBusy) {
      return;
    }
    setIsBusy(true);
    try {
      const list = await apiRequest<{ id: string; items: Array<{ content_title_id: string }> }>(
        `/me/watchlist/lists/${selectedList.id}`,
        { token }
      );
      const already = list.items.some((item) => item.content_title_id === titleId);
      await apiRequest("/me/watchlist/items", {
        method: "POST",
        token,
        body: JSON.stringify({
          content_title_id: titleId,
          list_id: selectedList.id,
          added_via: source,
        }),
      });
      onSaved?.(selectedList.name, already);
      onClose();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setIsBusy(false);
    }
  }

  async function createListAndSave() {
    if (!token || !titleId || !newName.trim() || isBusy) {
      return;
    }
    setIsBusy(true);
    try {
      const created = await apiRequest<{ id: string; name: string }>("/me/watchlist/lists", {
        method: "POST",
        token,
        body: JSON.stringify({
          name: newName.trim(),
          description: newDescription.trim() || null,
        }),
      });
      await apiRequest("/me/watchlist/items", {
        method: "POST",
        token,
        body: JSON.stringify({
          content_title_id: titleId,
          list_id: created.id,
          added_via: source,
        }),
      });
      onSaved?.(created.name, false);
      setCreating(false);
      setNewName("");
      setNewDescription("");
      onClose();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Failed to create list");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <EditorialSheet
      visible={visible}
      onClose={onClose}
      title={creating ? "New list" : "Save to a list"}
      supporting={creating ? "Give it a name — you can always change it later." : "Where should this live?"}
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {!creating ? (
          <View style={styles.listBody}>
            <ScrollView style={styles.listScroll} contentContainerStyle={styles.listScroller}>
              {lists.map((list) => {
                const selected = selectedListId === list.id;
                return (
                  <Pressable
                    key={list.id}
                    style={[styles.listRow, selected && styles.listRowSelected]}
                    onPress={() => setSelectedListId(list.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listName}>{list.name}</Text>
                      <Text style={styles.listMeta}>{list.title_count} titles</Text>
                    </View>
                    <Text style={[styles.selectLabel, !selected && styles.selectLabelIdle]}>
                      {selected ? "Selected" : "Select"}
                    </Text>
                  </Pressable>
                );
              })}
              {!lists.length ? (
                <Text style={styles.emptyText}>No lists yet. Create one to save this title.</Text>
              ) : null}
            </ScrollView>
            <Pressable style={styles.createButton} onPress={() => setCreating(true)}>
              <Text style={styles.createButtonText}>+ Create new list</Text>
            </Pressable>
            <View style={styles.footerActions}>
              <Pressable style={styles.secondary} onPress={onClose}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primary, (!selectedListId || isBusy) && styles.disabled]}
                disabled={!selectedListId || isBusy}
                onPress={() => void saveToList()}
              >
                <Text style={styles.primaryText}>{isBusy ? "Saving..." : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.createBody}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="List name"
              placeholderTextColor={colors.muted2}
              style={styles.input}
              maxLength={60}
            />
            <TextInput
              value={newDescription}
              onChangeText={setNewDescription}
              placeholder="Description (optional)"
              placeholderTextColor={colors.muted2}
              style={styles.input}
              maxLength={120}
            />
            <View style={styles.createActions}>
              <Pressable style={styles.secondary} onPress={() => setCreating(false)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primary, (!newName.trim() || isBusy) && styles.disabled]}
                disabled={!newName.trim() || isBusy}
                onPress={() => void createListAndSave()}
              >
                <Text style={styles.primaryText}>{isBusy ? "Creating..." : "Create and save"}</Text>
              </Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </EditorialSheet>
  );
}

const styles = StyleSheet.create({
  listBody: { gap: spacing.sm, paddingBottom: spacing.sm },
  listScroll: { maxHeight: 320 },
  listScroller: { gap: 8, paddingBottom: spacing.sm },
  listRow: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  listRowSelected: {
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.06)",
  },
  listName: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
  },
  listMeta: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
    letterSpacing: 0.3,
  },
  selectLabel: {
    color: colors.accent,
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  selectLabelIdle: { color: colors.muted2 },
  emptyText: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 20,
    paddingVertical: 6,
  },
  createButton: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    paddingVertical: 12,
    alignItems: "center",
  },
  createButtonText: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
  },
  footerActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  createBody: { gap: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
  },
  createActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  secondary: {
    flex: 1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryText: {
    color: colors.ink,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.0,
    textTransform: "uppercase",
  },
  primary: {
    flex: 1,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryText: {
    color: colors.paperInk,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.0,
    textTransform: "uppercase",
  },
  disabled: { opacity: 0.4 },
});
