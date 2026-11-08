import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
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
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { ProtectedImage } from "@/components/protected-image";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, fonts } from "@/constants/theme";
type Team = {
  id: string;
  name: string;
  description: string | null;
  cover_image: string | null;
  poster_artwork: string[];
  member_count: number;
  unread_activity_count: number;
  latest_activity: string | null;
};
export default function TeamsScreen() {
  const { sessionToken } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  const [create, setCreate] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    generation = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const version = ++generation.current;
      setLoading(true);
      setError(null);
      if (sessionToken)
        void apiRequest<Team[]>("/teams", { token: sessionToken })
          .then((next) => {
            if (version === generation.current) setTeams(next);
          })
          .catch(() => {
            if (version === generation.current) {
              setTeams([]);
              setError("Could not load your teams. Please retry.");
            }
          })
          .finally(() => {
            if (version === generation.current) setLoading(false);
          });
      return () => {
        generation.current++;
      };
    }, [sessionToken, retry]),
  );
  async function createTeam() {
    if (!sessionToken || lock.current || !name.trim()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const version = generation.current;
    try {
      const team = await apiRequest<Team>("/teams", {
        token: sessionToken,
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          visibility: "private",
          max_members: 8,
        }),
      });
      if (version === generation.current) {
        setCreate(false);
        setName("");
        setDescription("");
        router.push({
          pathname: "/teams/[teamId]/home",
          params: { teamId: team.id },
        });
      }
    } catch {
      if (version === generation.current)
        setError(
          "Could not create the team. Your draft is kept; please try again.",
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={s.root} edges={[]}>
      <AppHeader title="Watch Teams" />
      <FlatList
        data={teams}
        keyExtractor={(t) => t.id}
        contentContainerStyle={s.content}
        refreshing={loading}
        onRefresh={() => setRetry((n) => n + 1)}
        ListHeaderComponent={
          <View style={{ gap: 12, paddingBottom: 18 }}>
            <Text style={s.intro}>Your people. Your next watch.</Text>
            <Text style={s.muted}>
              Team activity stays private unless you choose to share it.
            </Text>
            <View style={s.row}>
              <Pressable style={s.button} onPress={() => setCreate(true)}>
                <Text style={s.accent}>New team</Text>
              </Pressable>
              <Pressable
                style={s.button}
                onPress={() => router.push("/teams/join")}
              >
                <Text style={s.text}>Join with a code</Text>
              </Pressable>
            </View>
            {error ? (
              <>
                <Text style={s.text} accessibilityRole="alert">
                  {error}
                </Text>
                <Pressable
                  style={s.button}
                  onPress={() => setRetry((n) => n + 1)}
                >
                  <Text style={s.accent}>Retry</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : !error ? (
            <Text style={s.text}>
              Create a team or join one to save, rank and discuss titles
              together.
            </Text>
          ) : null
        }
        renderItem={({ item: team }) => (
          <Pressable
            style={s.card}
            onPress={() =>
              router.push({
                pathname: "/teams/[teamId]/home",
                params: { teamId: team.id },
              })
            }
            accessibilityRole="button"
            accessibilityLabel={`Open ${team.name}`}
          >
            <View style={s.art}>
              {team.cover_image ? (
                <ProtectedImage
                  source={{ uri: team.cover_image }}
                  style={{ width: "100%", height: "100%" }}
                  resizeMode="cover"
                />
              ) : team.poster_artwork?.length ? (
                <View
                  style={{ flex: 1, flexDirection: "row", flexWrap: "wrap" }}
                >
                  {team.poster_artwork.slice(0, 4).map((uri, i) => (
                    <Image
                      key={`${uri}-${i}`}
                      source={{ uri }}
                      style={{
                        width:
                          team.poster_artwork.length === 1 ? "100%" : "50%",
                        height: team.poster_artwork.length > 2 ? "50%" : "100%",
                      }}
                      resizeMode="cover"
                    />
                  ))}
                </View>
              ) : (
                <Ionicons name="film-outline" size={28} color={colors.accent} />
              )}
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={s.name}>{team.name}</Text>
              <Text style={s.muted}>
                {team.member_count} members
                {team.unread_activity_count
                  ? ` · ${team.unread_activity_count} new`
                  : ""}
              </Text>
              {team.latest_activity ? (
                <Text style={s.muted} numberOfLines={2}>
                  {team.latest_activity}
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        )}
      />
      <Modal
        visible={create}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setCreate(false);
        }}
      >
        <KeyboardAvoidingView
          style={s.scrim}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={s.sheet}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ gap: 16 }}
            >
              <Text style={s.intro}>New Watch Team</Text>
              <Text style={s.muted}>
                Start with up to eight people. Invite them from Team settings
                after creating your team.
              </Text>
              <TextInput
                accessibilityLabel="Team name"
                placeholder="Team name"
                placeholderTextColor={colors.muted}
                value={name}
                onChangeText={setName}
                maxLength={120}
                style={s.input}
              />
              <TextInput
                accessibilityLabel="Team description"
                placeholder="A short description (optional)"
                placeholderTextColor={colors.muted}
                value={description}
                onChangeText={setDescription}
                maxLength={280}
                multiline
                style={s.input}
              />
              {error ? (
                <Text style={s.text} accessibilityRole="alert">
                  {error}
                </Text>
              ) : null}
              <Pressable
                style={s.button}
                disabled={busy || !name.trim()}
                onPress={() => void createTeam()}
              >
                <Text style={s.accent}>
                  {busy ? "Creating…" : "Create private team"}
                </Text>
              </Pressable>
              <Pressable
                disabled={busy}
                style={s.button}
                onPress={() => setCreate(false)}
              >
                <Text style={s.text}>Cancel</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: 20,
    paddingBottom: 110,
    width: "100%",
    maxWidth: 840,
    alignSelf: "center",
  },
  intro: { fontSize: 28, fontFamily: fonts.serifBold, color: colors.ink },
  text: { fontSize: 16, color: colors.ink },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  accent: { fontSize: 16, color: colors.accent },
  name: { fontSize: 20, fontFamily: fonts.serifBold, color: colors.ink },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 24 },
  button: { minHeight: 44, paddingVertical: 12, justifyContent: "center" },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    minHeight: 108,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.surface,
  },
  art: {
    width: 76,
    height: 80,
    backgroundColor: colors.surface,
    borderRadius: 10,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  scrim: {
    flex: 1,
    padding: 20,
    backgroundColor: "rgba(0,0,0,.75)",
    alignItems: "center",
    justifyContent: "center",
  },
  sheet: {
    backgroundColor: colors.background,
    padding: 24,
    borderRadius: 16,
    width: "100%",
    maxWidth: 560,
    maxHeight: "85%",
  },
  input: {
    minHeight: 48,
    fontSize: 16,
    color: colors.ink,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.muted2,
    borderRadius: 8,
  },
});
