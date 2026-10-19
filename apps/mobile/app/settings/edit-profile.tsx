/**
 * Oct-18 UI/UX rebuild: Edit Profile sub-screen.
 * Spec image 4 (step 3). Avatar + cover + name + username + bio.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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

import { Avatar } from "@/components/avatar";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";


type Me = {
  user_id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
};


export default function EditProfileScreen() {
  const { sessionToken } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    apiRequest<Me>("/me", { token: sessionToken })
      .then((res) => {
        if (cancelled) return;
        setMe(res);
        setName(res.display_name ?? "");
        setUsername(res.username ?? "");
        setBio(res.bio ?? "");
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionToken]);

  async function save() {
    if (!sessionToken || saving) return;
    setSaving(true);
    try {
      await apiRequest("/me", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ display_name: name, username, bio }),
      });
      router.back();
    } catch (err) {
      Alert.alert("Could not save", err instanceof Error ? err.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Edit Profile</Text>
          <Pressable onPress={save} hitSlop={10} disabled={saving}>
            <Text style={[styles.saveLabel, saving && { opacity: 0.5 }]}>
              {saving ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            <View style={styles.avatarRow}>
              <View style={styles.avatarWrap}>
                <Avatar uri={me?.avatar_url ?? null} label={me?.display_name ?? ""} size={80} />
                <View style={styles.avatarEdit}>
                  <Ionicons name="camera" size={14} color="#0b0f17" />
                </View>
              </View>
              <Pressable style={styles.coverEdit}>
                <Ionicons name="camera-outline" size={14} color={colors.ink} />
                <Text style={styles.coverEditLabel}>Change Cover</Text>
              </Pressable>
            </View>

            <Text style={styles.label}>Name</Text>
            <TextInput value={name} onChangeText={setName} style={styles.input} placeholderTextColor={colors.muted2} maxLength={50} />

            <Text style={styles.label}>Username</Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              style={styles.input}
              autoCapitalize="none"
              placeholderTextColor={colors.muted2}
              maxLength={40}
            />

            <Text style={styles.label}>Bio</Text>
            <TextInput
              value={bio}
              onChangeText={(t) => t.length <= 150 && setBio(t)}
              style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
              multiline
              placeholderTextColor={colors.muted2}
              maxLength={150}
            />
            <Text style={styles.counter}>{bio.length}/150</Text>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
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
  saveLabel: { fontFamily: fonts.sansSemiBold, color: colors.accent, fontSize: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.lg, gap: 10 },
  avatarRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  avatarWrap: { position: "relative" },
  avatarEdit: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.background,
  },
  coverEdit: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  coverEditLabel: { fontFamily: fonts.sansMedium, color: colors.ink, fontSize: 12 },
  label: {
    marginTop: 10,
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1,
  },
  input: {
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  counter: { textAlign: "right", fontFamily: fonts.monoMedium, color: colors.muted2, fontSize: 11 },
});
