import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";

import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { STREAMING_SERVICES } from "@/lib/streaming";

type Profile = {
  user_id: string;
  email: string;
  username: string;
  display_name: string;
  favorite_genres: string[];
  country_code: string;
  avatar_url?: string | null;
  bio?: string | null;
};

type PublicPost = {
  id: string;
  title_name?: string | null;
  title_poster_url?: string | null;
  caption?: string | null;
  rating?: number | null;
  created_at: string;
};

type Preferences = {
  connected_streaming_services: string[];
};

export default function ProfileScreen() {
  const { sessionToken, user, updateSessionUser } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [preferences, setPreferences] = useState<Preferences>({ connected_streaming_services: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);

  const [draftDisplayName, setDraftDisplayName] = useState("");
  const [draftUsername, setDraftUsername] = useState("");
  const [draftBio, setDraftBio] = useState("");
  const [draftAvatarUri, setDraftAvatarUri] = useState<string | null>(null);
  const [draftStreamingServices, setDraftStreamingServices] = useState<string[]>([]);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  const bioCount = draftBio.length;
  const canSave = Boolean(draftDisplayName.trim() && draftUsername.trim().length >= 3 && bioCount <= 280);

  useFocusEffect(
    useCallback(() => {
      async function load() {
        if (!sessionToken) {
          return;
        }
        setIsLoading(true);
        setError(null);
        try {
          const me = await apiRequest<Profile>("/me", { token: sessionToken });
          setProfile(me);
          const prefs = await apiRequest<Preferences>("/me/preferences", { token: sessionToken });
          setPreferences(prefs);
          const history = await apiRequest<PublicPost[]>(`/profiles/${me.user_id}/posts`, { token: sessionToken });
          setPosts(history);
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load profile");
        } finally {
          setIsLoading(false);
        }
      }
      void load();
    }, [sessionToken])
  );

  const firstName = useMemo(() => profile?.display_name?.split(" ")[0] ?? "You", [profile?.display_name]);

  function openEditModal() {
    if (!profile) {
      return;
    }
    setDraftDisplayName(profile.display_name);
    setDraftUsername(profile.username);
    setDraftBio(profile.bio ?? "");
    setDraftAvatarUri(profile.avatar_url ?? null);
    setDraftStreamingServices(preferences.connected_streaming_services);
    setShowEdit(true);
  }

  async function saveProfile() {
    if (!sessionToken || !profile || !canSave) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const updated = await apiRequest<Profile>("/me", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({
          display_name: draftDisplayName.trim(),
          username: draftUsername.trim().toLowerCase(),
          bio: draftBio.trim() || null,
        }),
      });
      setProfile(updated);
      await updateSessionUser({
        display_name: updated.display_name,
        avatar_url: updated.avatar_url ?? null,
      });
      setShowEdit(false);
      setToast("Profile updated");
      setTimeout(() => setToast(null), 1800);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveStreamingPreferences(nextServices: string[]) {
    if (!sessionToken) {
      return;
    }
    setIsSavingPreferences(true);
    setError(null);
    try {
      const updated = await apiRequest<Preferences>("/me/preferences", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ connected_streaming_services: nextServices }),
      });
      setPreferences(updated);
      setDraftStreamingServices(updated.connected_streaming_services);
      trackEvent("streaming_service_selected", {
        services: updated.connected_streaming_services,
        userId: user?.user_id ?? null,
      });
    } catch (preferencesError) {
      setError(
        preferencesError instanceof Error
          ? preferencesError.message
          : "Failed to save streaming services"
      );
    } finally {
      setIsSavingPreferences(false);
    }
  }

  async function toggleStreamingService(serviceId: string) {
    const currentlyEnabled = draftStreamingServices.includes(serviceId);
    const next = currentlyEnabled
      ? draftStreamingServices.filter((entry) => entry !== serviceId)
      : [...draftStreamingServices, serviceId];
    setDraftStreamingServices(next);
    await saveStreamingPreferences(next);
  }

  async function pickAvatarImage() {
    if (!sessionToken || isUploadingAvatar) {
      return;
    }
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Photos access needed", "Allow photo access to upload a profile picture.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (result.canceled || !result.assets.length) {
        return;
      }
      const asset = result.assets[0];
      const filename = asset.fileName || `avatar-${Date.now()}.jpg`;
      const mime = asset.mimeType || "image/jpeg";
      const form = new FormData();
      form.append("file", {
        uri: asset.uri,
        name: filename,
        type: mime,
      } as any);
      setIsUploadingAvatar(true);
      const updated = await apiRequest<Profile>("/me/avatar", {
        method: "POST",
        token: sessionToken,
        body: form,
      });
      setProfile(updated);
      setDraftAvatarUri(updated.avatar_url ?? null);
      await updateSessionUser({
        display_name: updated.display_name,
        avatar_url: updated.avatar_url ?? null,
      });
      setToast("Profile photo updated");
      setTimeout(() => setToast(null), 1800);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload photo");
    } finally {
      setIsUploadingAvatar(false);
    }
  }

  async function removeAvatar() {
    if (!sessionToken || isUploadingAvatar) {
      return;
    }
    setIsUploadingAvatar(true);
    setError(null);
    try {
      const updated = await apiRequest<Profile>("/me/avatar", {
        method: "DELETE",
        token: sessionToken,
      });
      setProfile(updated);
      setDraftAvatarUri(null);
      await updateSessionUser({
        display_name: updated.display_name,
        avatar_url: null,
      });
      setToast("Profile photo removed");
      setTimeout(() => setToast(null), 1800);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove photo");
    } finally {
      setIsUploadingAvatar(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {isLoading ? <ActivityIndicator color={colors.accent} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {profile ? (
          <>
            <View style={styles.profileHero}>
              <View style={styles.profileHeroGlow} />
              <View style={styles.profileAvatarWrap}>
                <Avatar uri={profile.avatar_url} label={profile.display_name} size={80} />
              </View>
              <Text style={styles.profileName}>{profile.display_name}</Text>
              <Text style={styles.profileHandle}>@{profile.username}</Text>
              {profile.bio?.trim() ? <Text style={styles.profileBio}>{profile.bio}</Text> : null}
              <View style={styles.profileStatsRow}>
                <View style={styles.profileStat}>
                  <Text style={styles.profileStatNumber}>{posts.length}</Text>
                  <Text style={styles.profileStatLabel}>Posts</Text>
                </View>
                <View style={styles.profileStatDivider} />
                <View style={styles.profileStat}>
                  <Text style={styles.profileStatNumber}>{preferences.connected_streaming_services.length}</Text>
                  <Text style={styles.profileStatLabel}>Services</Text>
                </View>
              </View>
              <Pressable style={styles.editButton} onPress={openEditModal}>
                <Ionicons name="pencil-outline" size={13} color={colors.accent} />
                <Text style={styles.editButtonText}>Edit Profile</Text>
              </Pressable>
            </View>

            <View style={styles.bioCard}>
              <Text style={styles.sectionKicker}>Your Subscriptions</Text>
              <Text style={styles.sectionLabel}>Streaming Services</Text>
              <Text style={styles.bioText}>
                Select the platforms you subscribe to so SeenSnap can show where you can watch instantly.
              </Text>
              <View style={styles.streamingSummaryRow}>
                {preferences.connected_streaming_services.length ? (
                  preferences.connected_streaming_services.map((serviceId) => {
                    const service = STREAMING_SERVICES.find((entry) => entry.id === serviceId);
                    if (!service) {
                      return null;
                    }
                    return (
                      <View key={service.id} style={[styles.streamingSummaryChip, { borderColor: service.color }]}>
                        <Text style={styles.streamingSummaryText}>{service.name}</Text>
                      </View>
                    );
                  })
                ) : (
                  <Text style={styles.bioMeta}>No subscriptions selected yet.</Text>
                )}
              </View>
            </View>

            <View style={styles.postsHeader}>
              <View>
                <Text style={styles.sectionKicker}>Your Wall</Text>
                <Text style={styles.sectionLabel}>Public Posts</Text>
              </View>
              <Text style={styles.postsCount}>{posts.length}</Text>
            </View>
            {posts.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No public posts yet</Text>
                <Text style={styles.emptyBody}>Posts you share to your wall will appear here.</Text>
              </View>
            ) : (
              posts.map((post) => (
                <View key={post.id} style={styles.postCard}>
                  <Poster uri={post.title_poster_url} />
                  <View style={styles.postCopy}>
                    <Text style={styles.postTitle}>{post.title_name ?? "Freeform post"}</Text>
                    {post.caption ? <Text style={styles.postCaption}>{post.caption}</Text> : null}
                    <View style={styles.postMetaRow}>
                      {typeof post.rating === "number" ? <Text style={styles.postMeta}>{post.rating}/10</Text> : null}
                      <Text style={styles.postMeta}>{relativeTime(post.created_at)}</Text>
                    </View>
                  </View>
                </View>
              ))
            )}
          </>
        ) : null}
      </ScrollView>

      <Modal visible={showEdit} transparent animationType="slide" onRequestClose={() => setShowEdit(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowEdit(false)} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Edit Profile</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalBody}>
              <View style={styles.avatarEditor}>
                <Avatar uri={draftAvatarUri} label={draftDisplayName || profile?.display_name || "You"} size={72} />
                <View style={styles.avatarActions}>
                  <Pressable
                    style={[styles.avatarButton, isUploadingAvatar && styles.modalSaveDisabled]}
                    disabled={isUploadingAvatar}
                    onPress={() => void pickAvatarImage()}
                  >
                    <Text style={styles.avatarButtonText}>{isUploadingAvatar ? "Uploading..." : "Upload Photo"}</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.avatarGhostButton, (!draftAvatarUri || isUploadingAvatar) && styles.modalSaveDisabled]}
                    disabled={!draftAvatarUri || isUploadingAvatar}
                    onPress={() => void removeAvatar()}
                  >
                    <Text style={styles.avatarGhostButtonText}>Remove Photo</Text>
                  </Pressable>
                </View>
              </View>
              <Text style={styles.inputLabel}>Display Name</Text>
              <TextInput
                style={styles.input}
                value={draftDisplayName}
                onChangeText={setDraftDisplayName}
                placeholder="Display name"
                placeholderTextColor={colors.muted}
                autoCapitalize="words"
              />
              <Text style={styles.inputLabel}>Username</Text>
              <TextInput
                style={styles.input}
                value={draftUsername}
                onChangeText={setDraftUsername}
                placeholder="username"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
              />
              <Text style={styles.inputLabel}>Bio</Text>
              <TextInput
                style={[styles.input, styles.bioInput]}
                value={draftBio}
                onChangeText={setDraftBio}
                placeholder="Tell people what you watch"
                placeholderTextColor={colors.muted}
                multiline
                maxLength={280}
              />
              <Text style={styles.counter}>{bioCount}/280</Text>
              <Text style={styles.inputLabel}>Streaming Services</Text>
              <Text style={styles.helperText}>
                Select the platforms you subscribe to so SeenSnap can show where you can watch instantly.
              </Text>
              <View style={styles.streamingGrid}>
                {STREAMING_SERVICES.map((service) => {
                  const selected = draftStreamingServices.includes(service.id);
                  return (
                    <Pressable
                      key={service.id}
                      style={[styles.streamingCard, selected && styles.streamingCardSelected]}
                      onPress={() => void toggleStreamingService(service.id)}
                      disabled={isSavingPreferences}
                    >
                      <View style={[styles.streamingLogo, { backgroundColor: service.color }]}>
                        <Text style={styles.streamingLogoText}>{service.shortName}</Text>
                      </View>
                      <View style={styles.streamingCardCopy}>
                        <Text style={styles.streamingCardTitle}>{service.name}</Text>
                        <Text style={styles.streamingCardMeta}>{selected ? "Selected" : "Tap to add"}</Text>
                      </View>
                      <Ionicons
                        name={selected ? "toggle" : "toggle-outline"}
                        size={30}
                        color={selected ? colors.success : colors.muted}
                      />
                    </Pressable>
                  );
                })}
              </View>
              {isSavingPreferences ? <Text style={styles.counter}>Saving streaming services...</Text> : null}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setShowEdit(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalSave, (!canSave || isSaving) && styles.modalSaveDisabled]}
                disabled={!canSave || isSaving}
                onPress={() => void saveProfile()}
              >
                <Text style={styles.modalSaveText}>{isSaving ? "Saving..." : "Save Changes"}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {toast ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function Avatar({ uri, label, size }: { uri?: string | null; label: string; size: number }) {
  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceSoft }} />;
  }
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Ionicons name="person" color={colors.ink} size={Math.max(size * 0.42, 18)} />
    </View>
  );
}

function Poster({ uri }: { uri?: string | null }) {
  if (!uri) {
    return (
      <View style={styles.posterFallback}>
        <Ionicons name="film" size={16} color={colors.muted} />
      </View>
    );
  }
  return <Image source={{ uri }} style={styles.poster} />;
}

function relativeTime(dateString: string) {
  const now = Date.now();
  const ts = new Date(dateString).getTime();
  if (Number.isNaN(ts)) {
    return "now";
  }
  const diff = Math.max(now - ts, 0);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
  },
  profileHero: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(46,64,87,0.65)",
    backgroundColor: colors.surface,
    padding: spacing.lg,
    alignItems: "center",
    gap: spacing.sm,
    overflow: "hidden",
    marginTop: spacing.sm,
  },
  profileHeroGlow: {
    position: "absolute",
    top: -60,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "rgba(244,196,48,0.065)",
  },
  profileAvatarWrap: {
    marginBottom: 4,
  },
  profileName: {
    color: colors.ink,
    fontWeight: "900",
    fontSize: 24,
    letterSpacing: -0.5,
  },
  profileHandle: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "600",
  },
  profileBio: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 20,
    marginTop: 4,
  },
  profileStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
    marginTop: 8,
    marginBottom: 4,
  },
  profileStat: {
    alignItems: "center",
    gap: 2,
  },
  profileStatNumber: {
    color: colors.ink,
    fontWeight: "900",
    fontSize: 20,
  },
  profileStatLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  profileStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: colors.border,
  },
  editButton: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  editButtonText: {
    color: colors.accent,
    fontWeight: "800",
    fontSize: 12,
  },
  bioCard: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    borderColor: colors.border,
    borderWidth: 1,
    padding: spacing.md,
    gap: 8,
  },
  sectionKicker: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.3,
    marginBottom: 2,
  },
  sectionLabel: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 16,
  },
  bioText: {
    color: colors.ink,
    lineHeight: 20,
  },
  bioMeta: {
    color: colors.muted,
    fontSize: 12,
  },
  streamingSummaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  streamingSummaryChip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
  streamingSummaryText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "700",
  },
  postsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  postsCount: {
    color: colors.accent,
    fontWeight: "800",
    fontSize: 14,
  },
  postCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderColor: colors.border,
    borderWidth: 1,
    padding: spacing.md,
    flexDirection: "row",
    gap: spacing.md,
  },
  poster: {
    width: 58,
    height: 87,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
  },
  posterFallback: {
    width: 58,
    height: 87,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  postCopy: {
    flex: 1,
    gap: 4,
  },
  postTitle: {
    color: colors.accent,
    fontWeight: "800",
    fontSize: 15,
  },
  postCaption: {
    color: colors.ink,
    lineHeight: 19,
  },
  postMetaRow: {
    marginTop: 6,
    flexDirection: "row",
    gap: spacing.md,
  },
  postMeta: {
    color: colors.muted,
    fontSize: 12,
  },
  empty: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    padding: spacing.lg,
    gap: 8,
  },
  emptyTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 16,
  },
  emptyBody: {
    color: colors.muted,
    lineHeight: 20,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(2, 6, 12, 0.72)",
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderColor: colors.border,
    borderTopWidth: 1,
    maxHeight: "88%",
    paddingTop: spacing.lg,
  },
  modalTitle: {
    color: colors.ink,
    fontWeight: "900",
    fontSize: 20,
    paddingHorizontal: spacing.lg,
  },
  helperText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  streamingGrid: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  streamingCard: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    padding: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  streamingCardSelected: {
    borderColor: colors.success,
    backgroundColor: colors.surface,
  },
  streamingLogo: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  streamingLogoText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "900",
  },
  streamingCardCopy: {
    flex: 1,
    gap: 2,
  },
  streamingCardTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: "800",
  },
  streamingCardMeta: {
    color: colors.muted,
    fontSize: 12,
  },
  modalBody: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: 8,
  },
  inputLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 6,
  },
  avatarEditor: {
    marginBottom: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  avatarActions: {
    flex: 1,
    gap: spacing.xs,
  },
  avatarButton: {
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingVertical: 10,
    alignItems: "center",
  },
  avatarButtonText: {
    color: colors.background,
    fontWeight: "800",
    fontSize: 12,
  },
  avatarGhostButton: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    paddingVertical: 9,
    alignItems: "center",
  },
  avatarGhostButtonText: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
    color: colors.ink,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  bioInput: {
    minHeight: 92,
    textAlignVertical: "top",
  },
  counter: {
    color: colors.muted,
    fontSize: 12,
    textAlign: "right",
  },
  modalActions: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.lg + (Platform.OS === "ios" ? 8 : 0),
  },
  modalCancel: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalCancelText: {
    color: colors.ink,
    fontWeight: "700",
  },
  modalSave: {
    flex: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalSaveDisabled: {
    opacity: 0.55,
  },
  modalSaveText: {
    color: colors.background,
    fontWeight: "900",
  },
  avatarFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSoft,
  },
  toast: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    backgroundColor: colors.success,
    borderRadius: radii.pill,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    alignItems: "center",
  },
  toastText: {
    color: colors.background,
    fontWeight: "800",
  },
});
