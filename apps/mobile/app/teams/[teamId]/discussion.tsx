import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors } from "@/constants/theme";
type Discussion = { items: { id: string; actor: string; text: string }[] };
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
export default function Discussion() {
  const { teamId, titleId } = useLocalSearchParams<{
    teamId: string;
    titleId: string;
  }>();
  const { sessionToken } = useAuth();
  const [items, setItems] = useState<Discussion["items"]>([]),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const retry = useRef<{ text: string; id: string } | null>(null);
  const path = `/teams/${teamId}/discussions/${titleId}`;
  useEffect(() => {
    let active = true;
    if (sessionToken)
      void apiRequest<Discussion>(path, { token: sessionToken })
        .then((r) => {
          if (active) setItems(r.items);
        })
        .catch(() => {
          if (active) setError("This private discussion is unavailable.");
        });
    return () => {
      active = false;
    };
  }, [path, sessionToken]);
  async function send() {
    if (!sessionToken || !draft.trim() || busy) return;
    setBusy(true);
    setError("");
    if (retry.current?.text !== draft.trim())
      retry.current = { text: draft.trim(), id: uuid() };
    try {
      const res = await apiRequest<Discussion>(path, {
        token: sessionToken,
        method: "POST",
        body: JSON.stringify({
          text: retry.current.text,
          request_id: retry.current.id,
        }),
      });
      setItems(res.items);
      setDraft("");
      retry.current = null;
    } catch {
      setError("Could not send. Your comment is still here to retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={[]}
    >
      <AppHeader variant="detail" leftKind="back" title="Team discussion" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
          <Text style={{ color: colors.muted, fontSize: 14 }}>
            Only active members of this team can read this discussion.
          </Text>
          {items.map((i) => (
            <View key={i.id} style={{ gap: 6 }}>
              <Text style={{ color: colors.accent, fontSize: 14 }}>
                {i.actor}
              </Text>
              <Text style={{ color: colors.ink, fontSize: 16 }}>{i.text}</Text>
            </View>
          ))}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: colors.accent }}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
        <View style={{ padding: 16, paddingBottom: 100, gap: 8 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={500}
            accessibilityLabel="Private team comment"
            placeholder="Add a private comment…"
            placeholderTextColor={colors.muted}
            style={{
              color: colors.ink,
              fontSize: 16,
              minHeight: 48,
              padding: 12,
              borderWidth: 1,
              borderColor: colors.muted2,
              borderRadius: 8,
            }}
          />
          <Pressable
            onPress={() => void send()}
            disabled={busy}
            style={{ minHeight: 44, padding: 12 }}
          >
            <Text style={{ color: colors.accent, fontSize: 16 }}>
              {busy ? "Sending…" : "Send to team"}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
