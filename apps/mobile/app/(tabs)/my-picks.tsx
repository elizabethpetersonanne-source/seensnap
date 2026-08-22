import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";

import { SSAnimatedRule } from "@/components/ss-animated-rule";
import { SSPosterContact } from "@/components/ss-poster-contact";
import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { shareList } from "@/lib/share";
import { ShareComposerSheet } from "@/components/share-composer-sheet";
import { SendToUserSheet } from "@/components/send-to-user-sheet";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, rules, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { apiRequest, resolveMediaUrl, resolvedApiBaseUrl } from "@/lib/api";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

type WatchlistSummary = {
  id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  is_system_list: boolean;
  title_count: number;
  updated_at?: string | null;
  preview_posters: string[];
};

type WatchlistItem = {
  id: string;
  content_title_id: string;
  added_via: string;
  created_at: string;
  title: {
    id: string;
    title: string;
    content_type: string;
    overview?: string | null;
    poster_url?: string | null;
    release_date?: string | null;
  };
};

type WatchlistResponse = {
  id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  is_system_list: boolean;
  items: WatchlistItem[];
};

export default function MyPicksScreen() {
  const { sessionToken } = useAuth();
  const { width: windowWidth } = useWindowDimensions();
  // Poster grid: 3 columns. Percentage widths + `gap` overflow because gap adds
  // to total row width; compute exact cell width so 3 tiles actually fit.
  const gridGap = 8;
  const gridColumns = 3;
  const gridHorizontalPadding = spacing.xl * 2; // matches styles.content paddingHorizontal
  const posterWidth = Math.floor(
    (windowWidth - gridHorizontalPadding - gridGap * (gridColumns - 1)) / gridColumns,
  );
  const [lists, setLists] = useState<WatchlistSummary[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [selectedList, setSelectedList] = useState<WatchlistResponse | null>(null);
  // Share-to-Feed composer for the currently open list.
  const [showShareToFeed, setShowShareToFeed] = useState(false);
  // Send-to-user sheet for privately DMing the list.
  const [showSendSheet, setShowSendSheet] = useState(false);
  // Public share status for the currently selected list (PRIVATE / PUBLIC LINK
  // pill). Fetched on list change; refreshed after publish/revoke actions.
  const [shareStatus, setShareStatus] = useState<{
    is_public: boolean;
    token: string | null;
    url: string | null;
  }>({ is_public: false, token: null, url: null });
  const [shareStatusLoading, setShareStatusLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [listName, setListName] = useState("");
  const [listDescription, setListDescription] = useState("");

  const [showDetails, setShowDetails] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);

  const [isFocused, setIsFocused] = useState(false);

  const totals = useMemo(() => {
    const totalTitles = lists.reduce((acc, item) => acc + item.title_count, 0);
    return { totalTitles, listCount: lists.length };
  }, [lists]);

  const savedPosters = useMemo(
    () => [...new Set(lists.flatMap((l) => l.preview_posters))].slice(0, 4),
    [lists]
  );
  const hasSavedPosters = savedPosters.length >= 2;

  const loadShareStatus = useCallback(async (listId: string) => {
    if (!sessionToken) return;
    setShareStatusLoading(true);
    try {
      const s = await apiRequest<{ is_public: boolean; token: string | null; url: string | null }>(
        `/me/watchlist/lists/${listId}/share`,
        { token: sessionToken },
      );
      setShareStatus({ is_public: s.is_public, token: s.token, url: s.url });
    } catch {
      // Silent — pill just stays in PRIVATE state
      setShareStatus({ is_public: false, token: null, url: null });
    } finally {
      setShareStatusLoading(false);
    }
  }, [sessionToken]);

  const loadLists = useCallback(async () => {
    if (!sessionToken) return;
    const summaries = await apiRequest<WatchlistSummary[]>("/me/watchlist/lists", { token: sessionToken });
    setLists(summaries);
    const defaultList =
      summaries.find((s) => s.name.toLowerCase() === "my next watch") ??
      summaries.find((s) => s.is_default) ??
      summaries[0];
    const nextSelected =
      selectedListId && summaries.some((item) => item.id === selectedListId)
        ? selectedListId
        : defaultList?.id ?? null;
    setSelectedListId(nextSelected);
    if (nextSelected) {
      const detail = await apiRequest<WatchlistResponse>(`/me/watchlist/lists/${nextSelected}`, { token: sessionToken });
      setSelectedList(detail);
      void loadShareStatus(nextSelected);
    } else {
      setSelectedList(null);
      setShareStatus({ is_public: false, token: null, url: null });
    }
  }, [selectedListId, sessionToken, loadShareStatus]);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      async function load() {
        if (!sessionToken) return;
        setIsLoading(true);
        setError(null);
        try {
          await loadLists();
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load My Picks");
        } finally {
          setIsLoading(false);
        }
      }
      void load();
      return () => setIsFocused(false);
    }, [loadLists, sessionToken])
  );

  async function openList(listId: string) {
    if (!sessionToken) return;
    setSelectedListId(listId);
    try {
      const detail = await apiRequest<WatchlistResponse>(`/me/watchlist/lists/${listId}`, { token: sessionToken });
      setSelectedList(detail);
      // Load share status so the PRIVATE / PUBLIC LINK pill reflects
      // reality without waiting for the user to interact.
      void loadShareStatus(listId);
    } catch (listError) {
      setError(listError instanceof Error ? listError.message : "Failed to load list");
    }
  }

  async function createList() {
    if (!sessionToken || !listName.trim()) return;
    try {
      const created = await apiRequest<WatchlistResponse>("/me/watchlist/lists", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ name: listName.trim(), description: listDescription.trim() || null }),
      });
      setShowCreate(false);
      setListName("");
      setListDescription("");
      setToast(`Created ${created.name}`);
      await loadLists();
      setSelectedListId(created.id);
      setSelectedList(created);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create list");
    }
  }

  async function renameList() {
    if (!sessionToken || !selectedList || !listName.trim()) return;
    try {
      const updated = await apiRequest<WatchlistResponse>(`/me/watchlist/lists/${selectedList.id}`, {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ name: listName.trim(), description: listDescription.trim() || null }),
      });
      setShowRename(false);
      setToast(`Updated ${updated.name}`);
      await loadLists();
      setSelectedList(updated);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "Failed to update list");
    }
  }

  async function deleteList() {
    if (!sessionToken || !selectedList || selectedList.is_default) return;
    try {
      await apiRequest<void>(`/me/watchlist/lists/${selectedList.id}`, {
        method: "DELETE",
        token: sessionToken,
      });
      setToast("List deleted");
      await loadLists();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete list");
    }
  }

  async function publishList() {
    if (!sessionToken || !selectedList) return;
    try {
      const resp = await apiRequest<{ token: string; url: string }>(
        `/me/watchlist/lists/${selectedList.id}/share`,
        { method: "POST", token: sessionToken, body: "{}" },
      );
      setShareStatus({ is_public: true, token: resp.token, url: resp.url });
      // Also copy to clipboard so the user can share immediately.
      const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })?.navigator?.clipboard;
      if (clipboard?.writeText) {
        try { await clipboard.writeText(resp.url); } catch {}
      }
      setToast("List is now public — link copied");
      setTimeout(() => setToast(null), 2400);
    } catch (err) {
      Alert.alert("Couldn't publish", err instanceof Error ? err.message : "Please try again.");
    }
  }

  async function copyPublicLink() {
    if (!shareStatus.url) return;
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })?.navigator?.clipboard;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(shareStatus.url);
        setToast("Link copied");
        setTimeout(() => setToast(null), 1800);
        return;
      } catch {
        // fall through
      }
    }
    Alert.alert("Public link", shareStatus.url);
  }

  async function revokePublicLink() {
    if (!sessionToken || !selectedList) return;
    Alert.alert(
      "Make this list private?",
      "The public link will stop working. Anyone with the link can no longer view the list.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Make private",
          style: "destructive",
          onPress: async () => {
            try {
              await apiRequest<void>(`/me/watchlist/lists/${selectedList.id}/share`, {
                method: "DELETE",
                token: sessionToken,
              });
              setShareStatus({ is_public: false, token: null, url: null });
              setToast("List is private");
              setTimeout(() => setToast(null), 1800);
            } catch (err) {
              Alert.alert("Couldn't revoke", err instanceof Error ? err.message : "Please try again.");
            }
          },
        },
      ],
    );
  }

  async function removeFromList(item: WatchlistItem) {
    if (!sessionToken || !selectedList) return;
    try {
      const updated = await apiRequest<WatchlistResponse>(
        `/me/watchlist/lists/${selectedList.id}/titles/${item.content_title_id}`,
        { method: "DELETE", token: sessionToken }
      );
      setSelectedList(updated);
      await loadLists();
      setToast(`Removed from ${selectedList.name}`);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Failed to remove title");
    }
  }

  async function openDetails(item: WatchlistItem) {
    if (!sessionToken) return;
    setShowDetails(true);
    setDetailLoading(true);
    try {
      const details = await fetchUniversalTitle(sessionToken, item.title.id, item.title);
      setDetailTitle(details);
    } catch (detailError) {
      setDetailTitle(null);
      setError(detailError instanceof Error ? detailError.message : "Failed to load title details");
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      {/* When the user has saved posters, use a cinematic header with a moving
          poster collage of their real archive behind the title (per audit:
          "tasteful moving collage from recently saved / representative titles,
          behind a protected text zone"). Otherwise, the tighter compact header
          keeps the archive starting sooner. */}
      {/* Unified Header §7 + §13 — H1 "My Picks", utility subtitle showing
          real counts. Artwork is a poster mosaic from the user's ACTUAL saves
          (personalized header). When there are no saves yet the header
          gracefully falls back to the SeenSnap brand texture. */}
      <SeenSnapHeader
        title="My Picks"
        subtitle={
          totals.totalTitles > 0
            ? {
                text: `${totals.totalTitles} titles · ${totals.listCount} lists`,
                style: "utility",
              }
            : "Your personal archive."
        }
        fallbackSeed={7}
        artworkNode={
          hasSavedPosters ? (
            <SSPosterContact posters={savedPosters} active={isFocused} style={{ flex: 1, opacity: 0.55 }} />
          ) : undefined
        }
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Lists section header */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionLabel}>SHELVES</Text>
          <Pressable style={styles.newListBtn} onPress={() => { setListName(""); setListDescription(""); setShowCreate(true); }}>
            <Ionicons name="add" size={12} color={colors.accent} />
            <Text style={styles.newListText}>NEW LIST</Text>
          </Pressable>
        </View>

        {/* List cards — horizontal scroll */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.listRow}>
          {lists.map((list, idx) => {
            const isActive = selectedListId === list.id;
            return (
              <Pressable
                key={list.id}
                style={[styles.listCard, isActive && styles.listCardActive]}
                onPress={() => void openList(list.id)}
              >
                {/* Index number */}
                <Text style={styles.listIndex}>{String(idx + 1).padStart(2, "0")}</Text>

                {/* Poster stack */}
                <View style={styles.listPosters}>
                  {list.preview_posters.slice(0, 3).map((poster, pIdx) => (
                    <Image
                      key={poster + pIdx}
                      source={{ uri: resolveMediaUrl(poster) ?? poster }}
                      style={[styles.stackPoster, pIdx > 0 && { marginLeft: -12 }]}
                      resizeMode="cover"
                    />
                  ))}
                  {list.preview_posters.length === 0 ? (
                    <View style={[styles.stackPoster, styles.stackPosterEmpty]}>
                      <Ionicons name="bookmark-outline" size={14} color={colors.muted2} />
                    </View>
                  ) : null}
                </View>

                {/* Active indicator */}
                {isActive ? <View style={styles.listActiveRule} /> : null}

                <Text style={styles.listName} numberOfLines={2}>{list.name}</Text>
                <Text style={styles.listMeta}>{list.title_count} {list.title_count === 1 ? "title" : "titles"}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Selected list header */}
        <View style={styles.listDetailRule} />
        {selectedList ? (
          <View style={styles.selectedListHeader}>
            <View style={styles.selectedListInfo}>
              <Text style={styles.selectedListName}>{selectedList.name}</Text>
              {selectedList.description ? (
                <Text style={styles.selectedListDesc}>{selectedList.description}</Text>
              ) : null}
              {/* Public/private status pill — explicit, tap-to-toggle
                  affordance so users don't have to discover that the
                  Share icon secretly makes lists public. */}
              {shareStatusLoading ? null : shareStatus.is_public ? (
                <View style={styles.publicStatusRow}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.publicPill,
                      pressed && { opacity: 0.7 },
                    ]}
                    hitSlop={6}
                    onPress={() => void copyPublicLink()}
                  >
                    <Ionicons name="link" size={12} color={colors.accent} />
                    <Text style={styles.publicPillText}>PUBLIC LINK · TAP TO COPY</Text>
                  </Pressable>
                  <Pressable hitSlop={8} onPress={() => void revokePublicLink()}>
                    <Ionicons name="close-circle" size={16} color={colors.muted} />
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  style={({ pressed }) => [
                    styles.privatePill,
                    pressed && { opacity: 0.7 },
                  ]}
                  hitSlop={6}
                  onPress={() => void publishList()}
                >
                  <Ionicons name="lock-closed" size={11} color={colors.muted} />
                  <Text style={styles.privatePillText}>PRIVATE · TAP TO PUBLISH</Text>
                </Pressable>
              )}
            </View>
            <View style={styles.actionsRow}>
              {/* Post to Feed — Social brief §9. Primary action for surfacing
                  the list to followers via a real social post (references the
                  canonical list, not a copy). */}
              <Pressable
                style={({ pressed }) => [
                  styles.sharePill,
                  pressed && styles.sharePillPressed,
                ]}
                hitSlop={8}
                onPress={() => {
                  if (!sessionToken || !selectedList) return;
                  setShowShareToFeed(true);
                }}
              >
                <Ionicons name="megaphone-outline" color={colors.accent} size={14} />
                <Text style={styles.sharePillText}>POST</Text>
              </Pressable>
              {/* Send — 1:1 DM this list to a SeenSnap user (Messaging §17). */}
              <Pressable
                hitSlop={8}
                style={{ paddingHorizontal: 6 }}
                onPress={() => {
                  if (!sessionToken || !selectedList) return;
                  setShowSendSheet(true);
                }}
              >
                <Ionicons name="paper-plane-outline" color={colors.accent} size={16} />
              </Pressable>
              {/* External Share — native OS share sheet with the public list URL. */}
              <Pressable
                hitSlop={8}
                style={{ paddingHorizontal: 6 }}
                onPress={() => {
                  if (!sessionToken || !selectedList) return;
                  void shareList({
                    token: sessionToken,
                    listId: selectedList.id,
                    listName: selectedList.name,
                    entryPoint: "my_picks_shelf",
                  });
                }}
              >
                <Ionicons name="share-outline" color={colors.muted} size={16} />
              </Pressable>
              <Pressable onPress={() => { setListName(selectedList.name); setListDescription(selectedList.description || ""); setShowRename(true); }} hitSlop={8}>
                <Ionicons name="create-outline" color={colors.muted} size={16} />
              </Pressable>
              {!selectedList.is_default ? (
                <Pressable
                  onPress={() =>
                    Alert.alert(
                      "Delete this list?",
                      "Titles will only be removed from this list.",
                      [
                        { text: "Cancel", style: "cancel" },
                        { text: "Delete", style: "destructive", onPress: () => void deleteList() },
                      ]
                    )
                  }
                >
                  <Ionicons name="trash-outline" color={colors.danger} size={16} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.selectedListHeader}>
            <Text style={styles.selectedListName}>Select a shelf</Text>
          </View>
        )}

        {isLoading ? <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} /> : null}
        {error ? <Text style={styles.errorText}>{error} ({resolvedApiBaseUrl})</Text> : null}

        {/* Empty state */}
        {!isLoading && selectedList && selectedList.items.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIndex}>00 / 00</Text>
            <View style={styles.emptyRule} />
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.emptyBody}>
              Save titles from Discover, Watch Teams, or the Swipe deck to fill this shelf.
            </Text>
          </View>
        ) : null}

        {/* Items grid — archive style */}
        <View style={styles.grid}>
          {selectedList?.items.map((item) => (
            <Pressable
              key={item.id}
              style={[styles.posterCard, { width: posterWidth }]}
              onPress={() => void openDetails(item)}
            >
              {item.title.poster_url ? (
                <Image source={{ uri: item.title.poster_url }} style={styles.poster} resizeMode="cover" />
              ) : (
                <View style={styles.posterFallback}>
                  <Ionicons name="film" size={22} color={colors.muted2} />
                </View>
              )}
              {/* Remove button */}
              <Pressable
                style={styles.removeBtn}
                onPress={() => void removeFromList(item)}
                hitSlop={8}
              >
                <Ionicons name="close" size={10} color={colors.muted} />
              </Pressable>
              {/* Metadata */}
              <View style={styles.posterMeta}>
                <Text numberOfLines={1} style={styles.posterTitle}>{item.title.title}</Text>
                <Text style={styles.posterMetaLine}>
                  {item.title.content_type === "movie" ? "FILM" : "SERIES"}{"  ·  "}{formatSavedDate(item.created_at)}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>

      </ScrollView>

      <ListEditorModal
        visible={showCreate}
        title="New Shelf"
        confirmLabel="Create"
        name={listName}
        description={listDescription}
        onChangeName={setListName}
        onChangeDescription={setListDescription}
        onCancel={() => setShowCreate(false)}
        onConfirm={() => void createList()}
      />

      <ListEditorModal
        visible={showRename}
        title="Edit Shelf"
        confirmLabel="Save"
        name={listName}
        description={listDescription}
        onChangeName={setListName}
        onChangeDescription={setListDescription}
        onCancel={() => setShowRename(false)}
        onConfirm={() => void renameList()}
      />

      <UniversalTitleModal
        visible={showDetails}
        loading={detailLoading}
        title={detailTitle}
        onClose={() => setShowDetails(false)}
        onSaveTitle={(detail) => {
          setSaveTitleId(detail.id);
          setShowSaveSheet(true);
        }}
      />

      {selectedList ? (
        <ShareComposerSheet
          visible={showShareToFeed}
          token={sessionToken}
          sourceSurface="my_picks_shelf"
          entityType="list"
          listId={selectedList.id}
          listName={selectedList.name}
          listDescription={selectedList.description}
          itemCount={selectedList.items?.length ?? 0}
          previewPosters={
            (selectedList.items ?? [])
              .map((i) => i.title.poster_url)
              .filter((u): u is string => Boolean(u))
              .slice(0, 5)
          }
          onClose={() => setShowShareToFeed(false)}
          onPosted={() => setToast(`Shared "${selectedList.name}" to your feed`)}
        />
      ) : null}

      {selectedList ? (
        <SendToUserSheet
          visible={showSendSheet}
          token={sessionToken}
          contentType="list"
          contentId={selectedList.id}
          sourceSurface="my_picks_shelf"
          preview={{
            headline: selectedList.name,
            subline: `${(selectedList.items ?? []).length} ${(selectedList.items ?? []).length === 1 ? "title" : "titles"}`,
            thumbnailUrl:
              (selectedList.items ?? []).map((i) => i.title.poster_url).find((u) => Boolean(u)) ?? null,
          }}
          onClose={() => setShowSendSheet(false)}
          onSent={(_msg, recipient) =>
            setToast(`Sent "${selectedList.name}" to ${recipient.display_name ?? "them"}`)
          }
          onError={(m) => setToast(m)}
        />
      ) : null}

      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="my_picks"
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onSaved={(listNameSaved, alreadySaved) => {
          void loadLists();
          setToast(alreadySaved ? `Already in ${listNameSaved}` : `Saved to ${listNameSaved}`);
        }}
        onError={(message) => setError(message)}
      />

      {toast ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function ListEditorModal({
  visible,
  title,
  confirmLabel,
  name,
  description,
  onChangeName,
  onChangeDescription,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  confirmLabel: string;
  name: string;
  description: string;
  onChangeName: (value: string) => void;
  onChangeDescription: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.modalBackdrop} onPress={onCancel} />
      <View style={styles.modalSheet}>
        <View style={styles.modalHeaderRule} />
        <Text style={styles.modalTitle}>{title}</Text>
        <TextInput
          value={name}
          onChangeText={onChangeName}
          placeholder="Shelf name"
          placeholderTextColor={colors.muted2}
          style={styles.input}
        />
        <TextInput
          value={description}
          onChangeText={onChangeDescription}
          placeholder="Description (optional)"
          placeholderTextColor={colors.muted2}
          style={styles.input}
        />
        <View style={styles.modalActions}>
          <Pressable style={styles.modalCancel} onPress={onCancel}>
            <Text style={styles.modalCancelText}>CANCEL</Text>
          </Pressable>
          <Pressable
            style={[styles.modalConfirm, !name.trim() && styles.modalConfirmDisabled]}
            onPress={onConfirm}
            disabled={!name.trim()}
          >
            <Text style={styles.modalConfirmText}>{confirmLabel.toUpperCase()}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function formatSavedDate(isoDate: string): string {
  const date = new Date(isoDate);
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: 120 },

  // Editorial header
  pageHeader: { gap: 5, paddingBottom: spacing.lg },
  pageEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.4,
    color: colors.accent,
  },
  pageTitle: {
    fontFamily: fonts.serif,
    fontSize: 36,
    lineHeight: 40,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  headerPosterContact: { height: 110, marginBottom: spacing.sm, borderRadius: 12, overflow: "hidden" },

  // Section header
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.md,
  },
  sectionLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.4,
    color: colors.muted2,
  },
  newListBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: rules.gold,
    borderRadius: 2,
  },
  newListText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.0,
    color: colors.accent,
  },

  // List cards (horizontal scroll)
  listRow: { gap: 10, paddingBottom: spacing.md, paddingLeft: 0 },
  listCard: {
    width: 148,
    padding: 12,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    borderRadius: 2,
    gap: 8,
  },
  listCardActive: {
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.04)",
  },
  listIndex: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.8,
    color: colors.muted2,
  },
  listPosters: { flexDirection: "row", alignItems: "flex-end" },
  stackPoster: {
    width: 40,
    height: 58,
    borderRadius: 1,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
  },
  stackPosterEmpty: {
    alignItems: "center",
    justifyContent: "center",
  },
  listActiveRule: {
    height: 2,
    backgroundColor: colors.accent,
    marginHorizontal: -12,
  },
  listName: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
    lineHeight: 17,
    color: colors.ink,
  },
  listMeta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.6,
    color: colors.muted2,
  },

  // Selected list
  listDetailRule: {
    height: 1,
    backgroundColor: rules.default,
    marginBottom: spacing.md,
  },
  selectedListHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  selectedListInfo: { flex: 1, gap: 4 },
  selectedListName: {
    fontFamily: fonts.serifBold,
    fontSize: 24,
    lineHeight: 28,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  selectedListDesc: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
  },
  actionsRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 4 },
  sharePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.06)",
    borderRadius: 2,
  },
  sharePillPressed: {
    backgroundColor: "rgba(244,196,48,0.14)",
  },
  sharePillText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.accent,
  },
  publicStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  publicPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.08)",
    borderRadius: 2,
    alignSelf: "flex-start",
  },
  publicPillText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.1,
    color: colors.accent,
  },
  privatePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
    marginTop: 8,
    alignSelf: "flex-start",
  },
  privatePillText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.1,
    color: colors.muted,
  },

  // Loading / error
  errorText: { fontFamily: fonts.sans, color: colors.danger, fontSize: 12, marginTop: spacing.sm },

  // Empty state
  emptyState: { paddingVertical: spacing.xxl, gap: spacing.md },
  emptyIndex: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    color: colors.muted2,
  },
  emptyRule: { height: 1, width: 32, backgroundColor: rules.default },
  emptyTitle: {
    fontFamily: fonts.serif,
    fontSize: 26,
    lineHeight: 30,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
    maxWidth: 280,
  },

  // Grid
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  posterCard: {
    // width is applied inline at render time (computed from window dimensions
    // so 3 columns actually fit — % + gap overflows on standard phone widths).
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  poster: { width: "100%", aspectRatio: 2 / 3 },
  posterFallback: {
    width: "100%",
    aspectRatio: 2 / 3,
    backgroundColor: colors.backgroundElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  removeBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(7,11,18,0.72)",
    borderWidth: 1,
    borderColor: rules.default,
  },
  posterMeta: { padding: 8, gap: 3 },
  posterTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
    lineHeight: 15,
    color: colors.ink,
  },
  posterMetaLine: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.muted2,
  },

  // Modal
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(5,10,16,0.72)" },
  modalSheet: {
    marginTop: "auto",
    borderTopWidth: 1,
    borderTopColor: rules.default,
    borderLeftWidth: 1,
    borderLeftColor: rules.default,
    borderRightWidth: 1,
    borderRightColor: rules.default,
    backgroundColor: colors.backgroundElevated,
    padding: spacing.xl,
    gap: spacing.md,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  modalHeaderRule: { height: 1, backgroundColor: rules.gold, marginBottom: spacing.xs },
  modalTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 26,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  input: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
  },
  modalActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  modalCancel: {
    flex: 1,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
    alignItems: "center",
    paddingVertical: 11,
  },
  modalCancelText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.0,
    color: colors.muted,
  },
  modalConfirm: {
    flex: 1,
    borderRadius: 2,
    backgroundColor: colors.accent,
    alignItems: "center",
    paddingVertical: 11,
  },
  modalConfirmDisabled: { opacity: 0.4 },
  modalConfirmText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.0,
    color: colors.paperInk,
  },

  // Toast
  toast: {
    position: "absolute",
    left: spacing.xl,
    right: spacing.xl,
    bottom: 96,
    borderWidth: 1,
    borderColor: rules.gold,
    backgroundColor: colors.surface,
    alignItems: "center",
    paddingVertical: 11,
    borderRadius: 2,
  },
  toastText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.ink,
  },
});
