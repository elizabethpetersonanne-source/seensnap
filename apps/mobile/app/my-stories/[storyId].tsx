import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts } from "@/constants/theme";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  deleteStory,
  editStory,
  fetchMyStory,
  type StoryTitleCard,
} from "@/lib/stories";
import {
  fetchUniversalTitle,
  type UniversalTitle,
} from "@/lib/universal-title";

export default function MyStoryScreen() {
  const { storyId } = useLocalSearchParams<{ storyId: string }>();
  const { sessionToken } = useAuth();
  const [story, setStory] = useState<StoryTitleCard | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [loadedScope, setLoadedScope] = useState("");
  const scope = `${sessionToken}|${storyId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generation = useRef(0),
    mutation = useRef(false),
    detailGeneration = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const request = ++generation.current;
      setStory(null);
      setEditing(false);
      setConfirm(false);
      setShowDetails(false);
      setLoading(true);
      setError(null);
      if (!sessionToken || !storyId) {
        setLoading(false);
        return;
      }
      fetchMyStory(sessionToken, storyId)
        .then((value) => {
          if (request !== generation.current || scopeRef.current !== scope)
            return;
          setStory(value);
          setDraft(value.caption ?? "");
          setLoadedScope(scope);
        })
        .catch(() => {
          if (request === generation.current)
            setError(
              "This story is unavailable or could not load. You can retry or return to your history.",
            );
        })
        .finally(() => {
          if (request === generation.current) setLoading(false);
        });
      return () => {
        generation.current++;
        detailGeneration.current++;
      };
    }, [sessionToken, storyId, reload]),
  );

  async function save() {
    if (!sessionToken || !story || mutation.current) return;
    const request = generation.current;
    mutation.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = await editStory(sessionToken, story.story_id, {
        caption: draft.trim() || null,
      });
      if (scopeRef.current !== scope || request !== generation.current) return;
      setStory(updated);
      setEditing(false);
    } catch (failure) {
      if (scopeRef.current === scope)
        setError(
          failure instanceof ApiError && failure.status === 410
            ? "This story has expired. You can still view or delete it; editing won't republish it."
            : "Couldn't save your caption. Your draft is still here.",
        );
    } finally {
      mutation.current = false;
      if (scopeRef.current === scope) setBusy(false);
    }
  }
  async function remove() {
    if (!sessionToken || !story || mutation.current) return;
    const request = generation.current;
    mutation.current = true;
    setBusy(true);
    setError(null);
    try {
      await deleteStory(sessionToken, story.story_id);
      if (scopeRef.current !== scope || request !== generation.current) return;
      setConfirm(false);
      setStory(null);
      if (router.canGoBack()) router.back();
      else router.replace("/my-stories");
    } catch {
      if (scopeRef.current === scope)
        setError("Couldn't delete your story. Please try again.");
    } finally {
      mutation.current = false;
      if (scopeRef.current === scope) setBusy(false);
    }
  }
  async function openTitle() {
    if (!story || !sessionToken) return;
    const request = ++detailGeneration.current;
    setShowDetails(true);
    setDetail(null);
    setDetailLoading(true);
    try {
      const result = await fetchUniversalTitle(sessionToken, story.title_id);
      if (request === detailGeneration.current && scopeRef.current === scope)
        setDetail(result);
    } catch {
      if (request === detailGeneration.current && scopeRef.current === scope)
        setDetail(null);
    } finally {
      if (request === detailGeneration.current) setDetailLoading(false);
    }
  }
  const current = loadedScope === scope ? story : null;
  const active = current && new Date(current.expires_at).getTime() > Date.now();
  return (
    <SafeAreaView edges={[]} style={styles.root}>
      <AppHeader variant="detail" leftKind="back" title="Your story" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : current ? (
            <>
              <Text style={styles.meta}>
                {active
                  ? "Active on Social"
                  : "Archived · only you can view this"}
              </Text>
              <Text style={styles.meta}>
                {new Date(current.created_at).toLocaleString()}
              </Text>
              {current.poster_url ? (
                <Image
                  source={{ uri: current.poster_url }}
                  style={styles.poster}
                  resizeMode="contain"
                />
              ) : null}
              <Text style={styles.title}>{current.title}</Text>
              {editing ? (
                <>
                  <TextInput
                    accessibilityLabel="Story caption"
                    value={draft}
                    onChangeText={setDraft}
                    editable={!busy}
                    multiline
                    maxLength={280}
                    placeholder="Add your thoughts"
                    placeholderTextColor={colors.muted}
                    style={styles.input}
                  />
                  <Text style={styles.meta}>{draft.length}/280</Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void save()}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>
                      {busy ? "Saving…" : "Save caption"}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => {
                      setEditing(false);
                      setDraft(current.caption ?? "");
                    }}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Cancel edit</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  {current.caption ? (
                    <Text style={styles.caption}>{current.caption}</Text>
                  ) : (
                    <Text style={styles.meta}>No caption</Text>
                  )}
                  {active ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => setEditing(true)}
                      style={styles.button}
                    >
                      <Text style={styles.buttonText}>Edit caption</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() => void openTitle()}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Open title details</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  setError(null);
                  setConfirm(true);
                }}
                style={styles.button}
              >
                <Text style={[styles.buttonText, { color: colors.danger }]}>
                  Delete story
                </Text>
              </Pressable>
            </>
          ) : null}
          {error && !confirm ? (
            <Text accessibilityRole="alert" style={styles.caption}>
              {error}
            </Text>
          ) : null}
          {!loading && !current ? (
            <Pressable
              style={styles.button}
              onPress={() => setReload((n) => n + 1)}
            >
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => router.replace("/my-stories")}
          >
            <Text style={styles.buttonText}>Your story history</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
      <ConfirmDialog
        visible={confirm && !!current}
        title="Delete this story?"
        message={`${error ? `${error}\n\n` : ""}This permanently removes the story from Social and your private history. It won't remove the title from your lists or change your rating.`}
        confirmLabel="Delete story"
        busy={busy}
        onCancel={() => {
          setConfirm(false);
          setError(null);
        }}
        onConfirm={() => void remove()}
      />
      <UniversalTitleModal
        visible={showDetails && !!current}
        title={detail}
        loading={detailLoading}
        onClose={() => {
          detailGeneration.current++;
          setShowDetails(false);
        }}
      />
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    padding: 20,
    paddingBottom: 100,
    gap: 14,
  },
  poster: {
    width: "100%",
    aspectRatio: 2 / 3,
    maxHeight: 480,
    borderRadius: 12,
  },
  title: { fontFamily: fonts.serifBold, fontSize: 28, color: colors.ink },
  caption: {
    fontFamily: fonts.sans,
    fontSize: 17,
    lineHeight: 25,
    color: colors.ink,
  },
  meta: { fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  input: {
    minHeight: 120,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: colors.muted2,
    padding: 14,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 17,
  },
  button: {
    minHeight: 48,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.muted2,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 16,
    color: colors.ink,
  },
});
