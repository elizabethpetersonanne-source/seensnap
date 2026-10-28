/**
 * Oct-27 spec PICKS-01: dedicated create-list surface, launched from
 * the "+ New List" button inside the My Lists section of My Picks.
 *
 * Spec: "The create flow asks for name and visibility (default
 * Private), with description if already supported. It must persist a
 * real list and return to the correct section."
 *
 * Visibility is now persisted on Watchlist (migration 0033). The
 * mobile client sends it in the create request; the backend defaults
 * to private if the field is omitted so older clients remain safe.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts, radii, spacing } from "@/constants/theme";


export default function NewListScreen() {
  const { sessionToken } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert("Name required", "Give your list a name.");
      return;
    }
    if (!sessionToken) return;
    setSubmitting(true);
    try {
      await apiRequest("/me/watchlist/lists", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({
          name: trimmed,
          description: description.trim() || null,
          visibility,
        }),
      });
      router.back();
    } catch {
      Alert.alert("Couldn't create list", "Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>New List</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.label}>LIST NAME</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Films to watch with Ben"
          placeholderTextColor={colors.muted2}
          style={styles.input}
          maxLength={60}
          autoFocus
        />

        <Text style={styles.label}>DESCRIPTION (OPTIONAL)</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Describe what this list is for…"
          placeholderTextColor={colors.muted2}
          style={[styles.input, { minHeight: 80 }]}
          maxLength={280}
          multiline
          textAlignVertical="top"
        />

        <Text style={styles.label}>VISIBILITY</Text>
        <View style={styles.visRow}>
          {([
            { key: "private", title: "Private", body: "Only you can see this list." },
            { key: "public", title: "Public", body: "Anyone with the link." },
          ] as const).map((v) => {
            const active = v.key === visibility;
            return (
              <Pressable
                key={v.key}
                onPress={() => setVisibility(v.key)}
                style={[styles.visCard, active && styles.visCardActive]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
              >
                <View style={styles.visHeadRow}>
                  <Ionicons
                    name={v.key === "private" ? "lock-closed-outline" : "earth-outline"}
                    size={16}
                    color={active ? colors.accent : colors.ink}
                  />
                  <Text style={[styles.visTitle, active && { color: colors.accent }]}>{v.title}</Text>
                </View>
                <Text style={styles.visBody}>{v.body}</Text>
              </Pressable>
            );
          })}
        </View>
        {visibility === "public" ? (
          <Text style={styles.visWarn}>
            Anyone with the share link can view this list. You can change the
            audience at any time.
          </Text>
        ) : null}

        <Pressable
          onPress={submit}
          disabled={submitting || !name.trim()}
          style={({ pressed }) => [
            styles.submitBtn,
            (submitting || !name.trim()) && { opacity: 0.4 },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.submitLabel}>{submitting ? "Creating…" : "Create list"}</Text>
        </Pressable>
      </ScrollView>
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
  body: { padding: spacing.lg, gap: spacing.md },
  label: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.2,
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  visRow: { flexDirection: "row", gap: spacing.sm },
  visCard: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "transparent",
    gap: 6,
  },
  visCardActive: { borderColor: colors.accent },
  visHeadRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  visTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  visBody: { fontFamily: fonts.sans, color: colors.muted, fontSize: 11, lineHeight: 16 },
  visWarn: { fontFamily: fonts.sans, color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4, fontStyle: "italic" },
  submitBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: "center",
  },
  submitLabel: { fontFamily: fonts.sansSemiBold, color: colors.background, fontSize: 14, letterSpacing: 0.3 },
});
