import { Ionicons } from "@expo/vector-icons";
import { appendImageToFormData, pickImageFromLibrary } from "@/lib/image-picker";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";

import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "@/components/avatar";
import { SSAnimatedRule } from "@/components/ss-animated-rule";
import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { SSPosterContact } from "@/components/ss-poster-contact";
import { colors, fonts, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { useProfileArtwork } from "@/lib/header-artwork";
import {
  fetchNotificationPrefs,
  getNotificationPermissionStatus,
  type NotificationPrefs,
  updateNotificationPrefs,
} from "@/lib/notifications";
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
  const { sessionToken, user, updateSessionUser, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [preferences, setPreferences] = useState<Preferences>({ connected_streaming_services: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs | null>(null);
  const [pushPermissionState, setPushPermissionState] = useState<string>("undetermined");
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
          const notifPrefsData = await fetchNotificationPrefs(sessionToken).catch(() => null);
          if (notifPrefsData) setNotifPrefs(notifPrefsData);
          const permStatus = await getNotificationPermissionStatus().catch(() => "undetermined");
          setPushPermissionState(permStatus);
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

  // Profile header backdrop — pull from the user's saved-list posters (same
  // source My Picks uses) so the mosaic reflects their actual taste. Prior
  // implementation only used posters from posts the user had published,
  // which meant demo/new accounts fell back to the brand orbs while every
  // other tab had rich imagery — that's the "doesn't match the rest"
  // complaint. `useProfileArtwork` returns saved-list posters (§16 in the
  // Header brief: personalized artwork per destination).
  const profileArtworkPosters = useProfileArtwork(6);

  const profilePosters = useMemo(() => {
    // Prefer the shared artwork source (saves). Fall back to the user's own
    // posts if for some reason /me/watchlist/lists returned nothing.
    if (profileArtworkPosters.length > 0) return profileArtworkPosters;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of posts) {
      const url = p.title_poster_url;
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
      if (out.length >= 6) break;
    }
    return out;
  }, [posts]);

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
      let picked;
      try {
        picked = await pickImageFromLibrary();
      } catch (permissionError) {
        if (permissionError instanceof Error && permissionError.message === "PERMISSION_DENIED") {
          Alert.alert("Photos access needed", "Allow photo access to upload a profile picture.");
          return;
        }
        throw permissionError;
      }
      if (!picked) return;
      const form = new FormData();
      appendImageToFormData(form, "file", picked);
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

  async function handleDeleteAccount() {
    Alert.alert(
      "Delete Account",
      "This permanently deletes your SeenSnap account, all picks, swipes, and team history. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Forever",
          style: "destructive",
          onPress: async () => {
            if (!sessionToken) return;
            setIsDeletingAccount(true);
            try {
              await apiRequest("/auth/me", { method: "DELETE", token: sessionToken });
              await signOut();
            } catch (deleteError) {
              setError(deleteError instanceof Error ? deleteError.message : "Account deletion failed");
            } finally {
              setIsDeletingAccount(false);
            }
          },
        },
      ]
    );
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
    <SafeAreaView style={styles.safeArea} edges={[]}>
      {/* Unified Header §7 + §15 — H1 "Profile", utility subtitle "@handle".
          Fixes the duplicate "SeenSnap Demo" identity block by making the
          header the destination name and letting the profile body render the
          user's display name / avatar / bio without repeating the title. */}
      <SeenSnapHeader
        title="Profile"
        subtitle={
          profile?.username
            ? { text: `@${profile.username}`, style: "utility" }
            : undefined
        }
        fallbackSeed={8}
        artworkNode={
          profilePosters.length > 0 ? (
            <SSPosterContact posters={profilePosters} active style={{ flex: 1, opacity: 0.5 }} />
          ) : undefined
        }
      />
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

            {/* Streaming Services — cleaner inline chip row under a serif section
                heading (audit remediation: kill the "another large dark box"). */}
            <View style={styles.streamingSection}>
              <Text style={styles.streamingSectionTitle}>Streaming</Text>
              <Text style={styles.streamingSectionHint}>
                Select platforms you subscribe to so Watch Now knows where to send you.
              </Text>
              <View style={styles.streamingSummaryRow}>
                {preferences.connected_streaming_services.length ? (
                  preferences.connected_streaming_services.map((serviceId) => {
                    const service = STREAMING_SERVICES.find((entry) => entry.id === serviceId);
                    if (!service) {
                      return null;
                    }
                    return (
                      <View
                        key={service.id}
                        style={[styles.streamingSummaryChip, { borderColor: service.color }]}
                      >
                        <View style={[styles.streamingDot, { backgroundColor: service.color }]} />
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

        {/* Notification preferences */}
        {notifPrefs !== null && (
          <View style={styles.notifSection}>
            <Text style={styles.sectionKicker}>NOTIFICATIONS</Text>
            <View style={styles.sectionRule} />

            {pushPermissionState === "denied" && (
              <Pressable
                style={styles.notifDeniedBanner}
                onPress={() => void Linking.openSettings()}
              >
                <Ionicons name="notifications-off-outline" size={14} color={colors.muted} />
                <Text style={styles.notifDeniedText}>
                  Notifications are disabled in system settings.{" "}
                  <Text style={styles.notifDeniedLink}>Open Settings</Text>
                </Text>
              </Pressable>
            )}

            {[
              { key: "team_activity" as const, label: "Watch Teams", desc: "Invites, joins, and team activity" },
              { key: "direct_engagement" as const, label: "Replies & Comments", desc: "Direct replies to you" },
            ].map((pref) => (
              <View key={pref.key} style={styles.notifRow}>
                <View style={styles.notifRowText}>
                  <Text style={styles.notifRowLabel}>{pref.label}</Text>
                  <Text style={styles.notifRowDesc}>{pref.desc}</Text>
                </View>
                <Switch
                  value={notifPrefs[pref.key]}
                  onValueChange={async (value) => {
                    const updated = { ...notifPrefs, [pref.key]: value };
                    setNotifPrefs(updated);
                    if (sessionToken) {
                      await updateNotificationPrefs(sessionToken, { [pref.key]: value }).catch(() => {});
                    }
                    trackEvent("notification_preferences_changed", { category: pref.key, enabled: value });
                  }}
                  trackColor={{ false: colors.surface, true: colors.accent }}
                  thumbColor={colors.ink}
                  ios_backgroundColor={colors.surface}
                />
              </View>
            ))}
          </View>
        )}

        {/* Account actions */}
        <View style={styles.accountSection}>
          <Text style={styles.sectionKicker}>ACCOUNT</Text>
          <View style={styles.accountRule} />
          <Pressable
            style={({ pressed }) => [styles.accountBtn, pressed && styles.accountBtnPressed]}
            onPress={() => {
              void signOut();
            }}
          >
            <Text style={styles.accountBtnLabel}>SIGN OUT</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.accountBtn, styles.accountBtnDanger, pressed && styles.accountBtnPressed]}
            disabled={isDeletingAccount}
            onPress={() => void handleDeleteAccount()}
          >
            <Text style={[styles.accountBtnLabel, styles.accountBtnLabelDanger]}>
              {isDeletingAccount ? "DELETING..." : "DELETE ACCOUNT"}
            </Text>
          </Pressable>
        </View>
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
    paddingBottom: 100,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  error: { fontFamily: fonts.sans, color: colors.danger, fontSize: 13 },

  // Profile hero — no glow, no rounded glass card
  profileHero: {
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    padding: spacing.xl,
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: 4,
    marginTop: spacing.sm,
  },
  profileHeroGlow: { display: "none" },
  profileAvatarWrap: { marginBottom: 4 },
  profileName: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.4,
  },
  profileHandle: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  profileBio: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 16,
    marginTop: 2,
  },
  profileStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    marginTop: 6,
    marginBottom: 2,
  },
  profileStat: { alignItems: "center", gap: 2 },
  profileStatNumber: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 22,
    lineHeight: 26,
  },
  profileStatLabel: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  profileStatDivider: { width: 1, height: 28, backgroundColor: rules.default },
  profileActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 2,
  },
  editButton: {
    borderWidth: 1,
    borderColor: rules.gold,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 2,
  },
  signOutInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 9,
  },
  signOutInlineText: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 9,
    letterSpacing: 0.8,
  },
  editButtonText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 9,
    letterSpacing: 1.0,
  },

  // Services section
  bioCard: {
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: 8,
    borderRadius: 2,
  },
  sectionKicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 9,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  sectionLabel: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: -0.3,
  },
  bioText: {
    fontFamily: fonts.sans,
    color: colors.muted,
    lineHeight: 20,
    fontSize: 13,
  },
  bioMeta: { fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  // Streaming section — no boxed card wrapper; just tight typography + chip row.
  streamingSection: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  streamingSectionTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 26,
    color: colors.ink,
    letterSpacing: -0.2,
  },
  streamingSectionHint: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
  },
  streamingSummaryRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  streamingSummaryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 2,
  },
  streamingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  streamingSummaryText: {
    fontFamily: fonts.monoMedium,
    color: colors.ink,
    fontSize: 10,
    letterSpacing: 0.4,
  },

  // Posts section
  postsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  postsCount: {
    fontFamily: fonts.mono,
    color: colors.accent,
    fontSize: 12,
  },
  postCard: {
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
    paddingVertical: spacing.md,
    flexDirection: "row",
    gap: spacing.md,
  },
  poster: {
    width: 52,
    height: 78,
    borderRadius: 2,
    backgroundColor: colors.surfaceSoft,
  },
  posterFallback: {
    width: 52,
    height: 78,
    borderRadius: 2,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  postCopy: { flex: 1, gap: 4 },
  postTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 18,
  },
  postCaption: {
    fontFamily: fonts.sans,
    color: colors.muted,
    lineHeight: 18,
    fontSize: 13,
  },
  postMetaRow: { marginTop: 4, flexDirection: "row", gap: spacing.sm },
  postMeta: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.3,
  },

  empty: {
    borderWidth: 1,
    borderColor: rules.default,
    padding: spacing.lg,
    gap: 8,
    borderRadius: 2,
  },
  emptyTitle: {
    fontFamily: fonts.serif,
    color: colors.ink,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: -0.3,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    lineHeight: 20,
    fontSize: 13,
  },

  // Edit modal
  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(2,6,12,0.72)",
  },
  modalSheet: {
    backgroundColor: colors.backgroundElevated,
    borderTopWidth: 1,
    borderTopColor: rules.gold,
    borderLeftWidth: 1,
    borderLeftColor: rules.default,
    borderRightWidth: 1,
    borderRightColor: rules.default,
    maxHeight: "88%",
    paddingTop: spacing.lg,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  modalTitle: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.3,
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.sm,
  },
  helperText: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  streamingGrid: { gap: spacing.xs, marginTop: spacing.xs },
  streamingCard: {
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: 2,
  },
  streamingCardSelected: {
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.04)",
  },
  streamingLogo: {
    width: 36,
    height: 36,
    borderRadius: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  streamingLogoText: {
    fontFamily: fonts.monoSemiBold,
    color: "#fff",
    fontSize: 9,
    letterSpacing: 0.5,
  },
  streamingCardCopy: { flex: 1, gap: 2 },
  streamingCardTitle: {
    fontFamily: fonts.sansMedium,
    color: colors.ink,
    fontSize: 13,
  },
  streamingCardMeta: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.3,
  },
  modalBody: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: 8,
  },
  inputLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted2,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 1.1,
    marginTop: 6,
  },
  avatarEditor: {
    marginBottom: spacing.xs,
    padding: spacing.sm,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  avatarActions: { flex: 1, gap: spacing.xs },
  avatarButton: {
    borderRadius: 2,
    backgroundColor: colors.accent,
    paddingVertical: 10,
    alignItems: "center",
  },
  avatarButtonText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.paperInk,
    fontSize: 9,
    letterSpacing: 1.0,
  },
  avatarGhostButton: {
    borderRadius: 2,
    borderWidth: 1,
    borderColor: rules.default,
    paddingVertical: 9,
    alignItems: "center",
  },
  avatarGhostButtonText: {
    fontFamily: fonts.monoMedium,
    color: colors.muted,
    fontSize: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
    backgroundColor: colors.surface,
    fontFamily: fonts.sans,
    color: colors.ink,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
    fontSize: 14,
  },
  bioInput: { minHeight: 88, textAlignVertical: "top" },
  counter: {
    fontFamily: fonts.mono,
    color: colors.muted2,
    fontSize: 10,
    textAlign: "right",
  },
  modalActions: {
    borderTopWidth: 1,
    borderTopColor: rules.default,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.xl,
    paddingBottom: spacing.xl + (Platform.OS === "ios" ? 8 : 0),
  },
  modalCancel: {
    flex: 1,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalCancelText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 9,
    letterSpacing: 1.0,
  },
  modalSave: {
    flex: 1,
    borderRadius: 2,
    backgroundColor: colors.accent,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalSaveDisabled: { opacity: 0.5 },
  modalSaveText: {
    fontFamily: fonts.monoSemiBold,
    color: colors.paperInk,
    fontSize: 9,
    letterSpacing: 1.0,
  },
  toast: {
    position: "absolute",
    left: spacing.xl,
    right: spacing.xl,
    bottom: spacing.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.gold,
    borderRadius: 2,
    paddingVertical: 11,
    paddingHorizontal: spacing.md,
    alignItems: "center",
  },
  toastText: {
    fontFamily: fonts.sansMedium,
    color: colors.ink,
    fontSize: 12,
  },
  accountSection: {
    gap: spacing.sm,
    paddingTop: spacing.md,
  },
  accountRule: {
    height: 1,
    backgroundColor: rules.default,
    marginBottom: spacing.xs,
  },
  accountBtn: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
    paddingVertical: 14,
    alignItems: "center",
  },
  accountBtnDanger: {
    borderColor: "rgba(224,112,112,0.30)",
  },
  accountBtnPressed: {
    opacity: 0.7,
  },
  accountBtnLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  accountBtnLabelDanger: {
    color: colors.danger,
  },
  // Notification preferences
  notifSection: {
    gap: spacing.sm,
    paddingTop: spacing.md,
  },
  sectionRule: {
    height: 1,
    backgroundColor: rules.default,
    marginBottom: spacing.xs,
  },
  notifDeniedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  notifDeniedText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.muted,
    flex: 1,
  },
  notifDeniedLink: {
    color: colors.accent,
  },
  notifRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  notifRowText: {
    flex: 1,
    gap: 2,
  },
  notifRowLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink,
  },
  notifRowDesc: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.muted2,
  },
});
