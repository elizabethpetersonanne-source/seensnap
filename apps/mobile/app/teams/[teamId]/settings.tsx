import { SHARE_BASE } from "@/lib/share";
import { useCallback, useRef, useState } from "react";
import { useFocusEffect, useLocalSearchParams, router } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  StyleSheet,
  Share,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { ProtectedImage } from "@/components/protected-image";
import { Avatar } from "@/components/avatar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiRequest } from "@/lib/api";
import { pickImageForm } from "@/lib/image-upload";
import { useAuth } from "@/lib/auth";
import { colors, fonts } from "@/constants/theme";
type Member = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  role: string;
  status: string;
};
type Team = {
  id: string;
  name: string;
  description: string | null;
  cover_image: string | null;
  invite_code: string;
  members: Member[];
};
export default function TeamSettings() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const { sessionToken, user } = useAuth();
  const [team, setTeam] = useState<Team | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [confirm, setConfirm] = useState<Member | "leave" | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (sessionToken)
        void apiRequest<Team>(`/teams/${teamId}`, { token: sessionToken })
          .then((t) => {
            if (active) {
              setTeam(t);
              setName(t.name);
              setDescription(t.description ?? "");
            }
          })
          .catch(() => {
            if (active) setError("This team is unavailable.");
          });
      return () => {
        active = false;
      };
    }, [teamId, sessionToken]),
  );
  const lock = useRef(false),
    currentToken = useRef(sessionToken);
  currentToken.current = sessionToken;
  const role = team?.members.find(
    (m) => m.user_id === user?.user_id && m.status === "active",
  )?.role;
  const admin = role === "owner" || role === "admin";
  async function update(
    action: "save" | "image" | "remove-image" | "leave" | "remove-member",
    member?: Member,
  ) {
    if (!sessionToken || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const path = `/teams/${teamId}`;
      if (action === "leave") {
        await apiRequest(`${path}/leave`, {
          token: sessionToken,
          method: "POST",
        });
        router.replace("/(tabs)/teams");
        return;
      }
      let next: Team;
      if (action === "image") {
        const form = await pickImageForm();
        if (!form) return;
        next = await apiRequest<Team>(`${path}/image`, {
          token: sessionToken,
          method: "POST",
          body: form,
          timeoutMs: 30000,
        });
      } else if (action === "remove-image")
        next = await apiRequest<Team>(`${path}/image`, {
          token: sessionToken,
          method: "DELETE",
        });
      else if (action === "remove-member")
        next = await apiRequest<Team>(`${path}/members/${member!.user_id}`, {
          token: sessionToken,
          method: "DELETE",
        });
      else
        next = await apiRequest<Team>(path, {
          token: sessionToken,
          method: "PATCH",
          body: JSON.stringify({ name, description }),
        });
      if (currentToken.current !== sessionToken) return;
      setTeam(next);
      setConfirm(null);
    } catch {
      setError(
        "Could not update the team. Your role or membership may have changed; please refresh and try again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={s.root} edges={[]}>
      <AppHeader variant="detail" leftKind="back" title="Team settings" />
      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
      >
        {error ? (
          <Text accessibilityRole="alert" style={s.accent}>
            {error}
          </Text>
        ) : null}
        {team ? (
          <>
            <Text style={s.title}>{team.name}</Text>
            <Text style={s.text}>Private to this team's active members.</Text>
            {team.cover_image ? (
              <ProtectedImage
                source={{ uri: team.cover_image }}
                style={{ width: 120, height: 120, borderRadius: 16 }}
              />
            ) : null}
            {admin ? (
              <>
                <Pressable
                  disabled={busy}
                  style={s.button}
                  onPress={() => void update("image")}
                >
                  <Text style={s.accent}>Choose team picture</Text>
                </Pressable>
                {team.cover_image ? (
                  <Pressable
                    disabled={busy}
                    style={s.button}
                    onPress={() => void update("remove-image")}
                  >
                    <Text style={s.text}>Remove picture</Text>
                  </Pressable>
                ) : null}
                <Text style={s.text}>Team name</Text>
                <TextInput
                  accessibilityLabel="Team name"
                  value={name}
                  onChangeText={setName}
                  maxLength={120}
                  style={s.input}
                />
                <Text style={s.text}>Description</Text>
                <TextInput
                  accessibilityLabel="Team description"
                  value={description}
                  onChangeText={setDescription}
                  maxLength={280}
                  multiline
                  style={s.input}
                />
                <Pressable
                  disabled={busy}
                  style={s.button}
                  onPress={() => void update("save")}
                >
                  <Text style={s.accent}>Save changes</Text>
                </Pressable>
                <Pressable
                  style={s.button}
                  onPress={() =>
                    void Share.share({
                      message: `Join ${team.name} on SeenSnap: ${SHARE_BASE}/teams/join?code=${encodeURIComponent(team.invite_code)}`,
                    }).catch(() => setError("Could not open sharing."))
                  }
                >
                  <Text style={s.accent}>Invite someone</Text>
                </Pressable>
              </>
            ) : null}
            <Text style={s.title}>Members</Text>
            {team.members
              .filter((m) => m.status === "active")
              .map((m) => (
                <View key={m.user_id} style={s.row}>
                  <Avatar
                    uri={m.avatar_url}
                    label={m.display_name ?? "Member"}
                    size={44}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={s.text}>{m.display_name ?? "Member"}</Text>
                    <Text style={s.muted}>{m.role}</Text>
                  </View>
                  {admin &&
                  m.user_id !== user?.user_id &&
                  m.role !== "owner" &&
                  (role === "owner" || m.role === "member") ? (
                    <Pressable style={s.button} onPress={() => setConfirm(m)}>
                      <Text style={s.accent}>Remove</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            <Pressable
              disabled={busy}
              style={s.button}
              onPress={() => setConfirm("leave")}
            >
              <Text style={s.text}>Leave team</Text>
            </Pressable>
          </>
        ) : !error ? (
          <ActivityIndicator color={colors.accent} />
        ) : null}
        {busy ? <ActivityIndicator color={colors.accent} /> : null}
      </ScrollView>
      <ConfirmDialog
        visible={confirm !== null}
        title={confirm === "leave" ? "Leave this team?" : "Remove this member?"}
        message={
          confirm === "leave"
            ? "You will lose access to private team discussions and shared statuses."
            : "This member will lose access to private team activity."
        }
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          void update(
            confirm === "leave" ? "leave" : "remove-member",
            confirm && confirm !== "leave" ? confirm : undefined,
          )
        }
      />
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: {
    padding: 20,
    paddingBottom: 110,
    gap: 12,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  title: { fontFamily: fonts.serifBold, fontSize: 25, color: colors.ink },
  text: { fontSize: 16, color: colors.ink },
  accent: { fontSize: 16, color: colors.accent },
  muted: { fontSize: 13, color: colors.muted },
  button: { minHeight: 44, paddingVertical: 12, justifyContent: "center" },
  input: {
    fontSize: 16,
    color: colors.ink,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.muted2,
    borderRadius: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
});
