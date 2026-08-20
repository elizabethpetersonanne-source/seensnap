import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

import { GoldButton } from "@/components/gold-button";
import { colors, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type TeamResponse = { id: string; name: string; description?: string | null; member_count: number };

export default function TeamJoinScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const { sessionToken } = useAuth();
  const [status, setStatus] = useState<"loading" | "ready" | "joining" | "joined" | "error">("loading");
  const [teamPreview, setTeamPreview] = useState<{ name: string; memberCount: number } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [joinedTeamId, setJoinedTeamId] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setStatus("error");
      setErrorMessage("No invite code provided.");
      return;
    }
    if (!sessionToken) {
      // Will be redirected to sign-in by AuthGate; deep link preserved on return
      return;
    }
    setStatus("ready");
    trackEvent("deep_link_opened", { route: "teams/join", code });
  }, [code, sessionToken]);

  async function joinTeam() {
    if (!sessionToken || !code) return;
    setStatus("joining");
    try {
      const team = await apiRequest<TeamResponse>("/teams/join", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ invite_code: code }),
      });
      setTeamPreview({ name: team.name, memberCount: team.member_count });
      setJoinedTeamId(team.id);
      setStatus("joined");
      trackEvent("team_joined", { team_id: team.id, source: "deep_link" });
    } catch (err) {
      setStatus("error");
      const msg = err instanceof Error ? err.message : "Could not join team";
      setErrorMessage(msg.includes("already") ? "You're already a member of this team." : msg.includes("not found") ? "This invite link has expired or the team no longer exists." : msg);
    }
  }

  function goToTeam() {
    router.replace("/(tabs)/teams");
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.iconCircle}>
          <Ionicons
            name={status === "joined" ? "checkmark-done" : status === "error" ? "alert-circle-outline" : "people"}
            size={38}
            color={status === "error" ? "#ff7b7b" : colors.accent}
          />
        </View>

        {status === "loading" || status === "ready" ? (
          <>
            <Text style={styles.headline}>You've been invited</Text>
            <Text style={styles.body}>
              {code ? `Use invite code ${code} to join a Watch Team on SeenSnap.` : "Loading invite…"}
            </Text>
            {status === "ready" ? (
              <GoldButton
                label="Join Team"
                icon="people"
                size="lg"
                onPress={() => void joinTeam()}
                style={styles.cta}
              />
            ) : null}
          </>
        ) : null}

        {status === "joining" ? (
          <>
            <Text style={styles.headline}>Joining…</Text>
            <Text style={styles.body}>Just a moment.</Text>
          </>
        ) : null}

        {status === "joined" ? (
          <>
            <Text style={styles.headline}>You're in!</Text>
            <Text style={styles.body}>
              {teamPreview ? `Welcome to ${teamPreview.name}.` : "You've joined the team."}
            </Text>
            <GoldButton
              label="Go to Teams"
              icon="people"
              size="lg"
              onPress={goToTeam}
              style={styles.cta}
            />
          </>
        ) : null}

        {status === "error" ? (
          <>
            <Text style={styles.headline}>Couldn't join</Text>
            <Text style={styles.body}>{errorMessage ?? "Something went wrong. Try again."}</Text>
            <GoldButton
              label="Open SeenSnap"
              icon="home"
              size="lg"
              onPress={() => router.replace("/(tabs)")}
              style={styles.cta}
            />
          </>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(255,210,31,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,210,31,0.28)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  headline: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "900",
    textAlign: "center",
  },
  body: {
    color: "rgba(242,244,248,0.75)",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  cta: {
    marginTop: spacing.lg,
    width: "100%",
  },
});
