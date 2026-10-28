/**
 * Oct-27 personalization brief LIST01–LIST06: Manage lists.
 *
 * Replaces the previous single-select Save-to-list flow. Shows every
 * owned list with a checkbox indicating whether the current title is
 * a member. Checkbox changes are a local draft until Save; Cancel
 * writes nothing. Submit sends only the explicit additions and
 * removals so unloaded pages are preserved.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { EditorialSheet } from "@/components/editorial-sheet";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";


type WatchlistSummary = {
  id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  is_system_list: boolean;
  visibility?: string;
  title_count: number;
};

type TitleMembership = {
  list_id: string;
  name: string;
  is_default: boolean;
  is_system_list: boolean;
  visibility?: string;
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


export function SaveToListSheet({ visible, token, titleId, onClose, onSaved, onError }: Props) {
  const [lists, setLists] = useState<WatchlistSummary[]>([]);
  const [originalMembership, setOriginalMembership] = useState<Set<string>>(new Set());
  // Draft is the current checked state; a diff vs originalMembership
  // becomes the add/remove payload at Save.
  const [draftMembership, setDraftMembership] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  // Reset local state when the sheet opens/closes.
  useEffect(() => {
    if (!visible) {
      setCreating(false);
      setNewName("");
      setNewDescription("");
      setLists([]);
      setOriginalMembership(new Set());
      setDraftMembership(new Set());
    }
  }, [visible]);

  // Load lists + current memberships in parallel. Membership read uses
  // the batch endpoint so N round-trips become 2.
  useEffect(() => {
    async function load() {
      if (!visible || !token || !titleId) return;
      setLoading(true);
      try {
        const [listsRes, membershipRes] = await Promise.all([
          apiRequest<WatchlistSummary[]>("/me/watchlist/lists", { token }),
          apiRequest<TitleMembership[]>(`/me/watchlist/memberships/${titleId}`, { token }),
        ]);
        setLists(listsRes);
        const original = new Set(membershipRes.map((m) => m.list_id));
        setOriginalMembership(original);
        setDraftMembership(new Set(original));
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Failed to load lists");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [visible, titleId, token, onError]);

  const addIds = useMemo(
    () => [...draftMembership].filter((id) => !originalMembership.has(id)),
    [draftMembership, originalMembership],
  );
  const removeIds = useMemo(
    () => [...originalMembership].filter((id) => !draftMembership.has(id)),
    [draftMembership, originalMembership],
  );
  const dirty = addIds.length > 0 || removeIds.length > 0;

  function toggle(listId: string) {
    setDraftMembership((prev) => {
      const next = new Set(prev);
      if (next.has(listId)) next.delete(listId);
      else next.add(listId);
      return next;
    });
  }

  async function applyChanges() {
    if (!token || !titleId || !dirty || isBusy) return;
    setIsBusy(true);
    try {
      await apiRequest("/me/watchlist/memberships/" + titleId + "/apply", {
        method: "POST",
        token,
        body: JSON.stringify({
          add_list_ids: addIds,
          remove_list_ids: removeIds,
        }),
      });
      // Broadcast title-state so other surfaces update immediately.
      // saved=true when there is any membership after the save.
      const { patchTitleState } = await import("@/lib/title-state");
      const anyMembership = draftMembership.size > 0;
      patchTitleState(titleId, { saved: anyMembership, updated_at: new Date().toISOString() });
      // Report back with a short summary name so the caller can show
      // a confirmation toast.
      const summary =
        addIds.length === 0 && removeIds.length === 1
          ? "Removed from " + (lists.find((l) => l.id === removeIds[0])?.name ?? "list")
          : addIds.length === 1 && removeIds.length === 0
            ? "Saved to " + (lists.find((l) => l.id === addIds[0])?.name ?? "list")
            : "Updated " + draftMembership.size + " list" + (draftMembership.size === 1 ? "" : "s");
      onSaved?.(summary, originalMembership.size > 0 && !dirty);
      onClose();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setIsBusy(false);
    }
  }

  async function createListAndCheck() {
    if (!token || !newName.trim() || isBusy) return;
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
      // Add to local list and check it in the draft.
      setLists((prev) => [
        {
          id: created.id,
          name: created.name,
          description: null,
          is_default: false,
          is_system_list: false,
          title_count: 0,
          visibility: "private",
        },
        ...prev,
      ]);
      setDraftMembership((prev) => new Set(prev).add(created.id));
      setCreating(false);
      setNewName("");
      setNewDescription("");
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to create list");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <EditorialSheet
      visible={visible}
      onClose={onClose}
      title={creating ? "New list" : "Manage lists"}
      supporting={creating ? "Name it; you can change this later." : "Pick every list this title should live in."}
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {!creating ? (
          <View style={styles.listBody}>
            {loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : (
              <ScrollView style={styles.listScroll} contentContainerStyle={styles.listScroller}>
                {lists.map((list) => {
                  const checked = draftMembership.has(list.id);
                  return (
                    <Pressable
                      key={list.id}
                      onPress={() => toggle(list.id)}
                      style={[styles.listRow, checked && styles.listRowSelected]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      accessibilityLabel={`${list.name}, ${list.title_count} ${list.title_count === 1 ? "title" : "titles"}`}
                    >
                      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                        {checked ? (
                          <Ionicons name="checkmark" size={14} color={colors.background} />
                        ) : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listName}>
                          {list.name}
                          {list.is_system_list ? " · system" : list.is_default ? " · default" : ""}
                        </Text>
                        <Text style={styles.listMeta}>
                          {list.title_count} {list.title_count === 1 ? "title" : "titles"}
                          {list.visibility && list.visibility !== "private" ? " · " + list.visibility : ""}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
                {!lists.length ? (
                  <Text style={styles.emptyText}>No lists yet. Create one to save this title.</Text>
                ) : null}
              </ScrollView>
            )}
            <Pressable style={styles.createButton} onPress={() => setCreating(true)}>
              <Text style={styles.createButtonText}>+ Create new list</Text>
            </Pressable>
            <View style={styles.footerActions}>
              <Pressable style={styles.secondary} onPress={onClose}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primary, (!dirty || isBusy) && styles.disabled]}
                disabled={!dirty || isBusy}
                onPress={() => void applyChanges()}
              >
                <Text style={styles.primaryText}>
                  {isBusy ? "Saving..." : dirty ? `Save ${addIds.length + removeIds.length} change${(addIds.length + removeIds.length) === 1 ? "" : "s"}` : "No changes"}
                </Text>
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
              autoFocus
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
                onPress={() => void createListAndCheck()}
              >
                <Text style={styles.primaryText}>{isBusy ? "Creating..." : "Create and check"}</Text>
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
  loadingWrap: { paddingVertical: spacing.lg, alignItems: "center" },
  listScroll: { maxHeight: 360 },
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
    backgroundColor: "rgba(255,230,0,0.06)",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: rules.default,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  listName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 14 },
  listMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, marginTop: 2, letterSpacing: 0.3 },
  emptyText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, paddingVertical: 6 },
  createButton: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    paddingVertical: 12,
    alignItems: "center",
  },
  createButtonText: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 13 },
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
  secondaryText: { color: colors.ink, fontFamily: fonts.monoSemiBold, fontSize: 11, letterSpacing: 1.0, textTransform: "uppercase" },
  primary: {
    flex: 1,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryText: { color: colors.paperInk, fontFamily: fonts.monoSemiBold, fontSize: 11, letterSpacing: 1.0, textTransform: "uppercase" },
  disabled: { opacity: 0.4 },
});
