import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { EditorialSheet } from "@/components/editorial-sheet";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";

type TeamSummary = {
  id: string;
  name: string;
};

type AddTarget = {
  id: string;
  title: string;
};

type Props = {
  visible: boolean;
  token: string | null;
  title: AddTarget | null;
  onClose: () => void;
  onAdded?: (teamName: string) => void;
  onError?: (message: string) => void;
};

export function AddToTeamSheet({ visible, token, title, onClose, onAdded, onError }: Props) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [alsoPost, setAlsoPost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    async function loadTeams() {
      if (!visible || !token) {
        return;
      }
      setLocalError(null);
      try {
        const data = await apiRequest<TeamSummary[]>("/teams", { token });
        setTeams(data);
        setSelectedTeamId(data[0]?.id ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load teams";
        setLocalError(message);
        onError?.(message);
      }
    }
    void loadTeams();
  }, [onError, token, visible]);

  const selectedTeam = useMemo(() => teams.find((team) => team.id === selectedTeamId) ?? null, [selectedTeamId, teams]);

  async function submit() {
    if (!token || !title || !selectedTeamId || busy) {
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await apiRequest(`/teams/${selectedTeamId}/titles`, {
        method: "POST",
        token,
        body: JSON.stringify({
          content_title_id: title.id,
          note: note.trim() || null,
          also_post_to_feed: alsoPost,
        }),
      });
      const teamName = selectedTeam?.name ?? "team";
      setNote("");
      setAlsoPost(false);
      onAdded?.(teamName);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add to team";
      setLocalError(message);
      onError?.(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <EditorialSheet
      visible={visible}
      onClose={onClose}
      title="Add to a Watch Team"
      supporting={title?.title ? `“${title.title}”` : undefined}
    >
      <ScrollView style={{ maxHeight: 200 }} contentContainerStyle={{ gap: 6 }}>
        {teams.map((team) => {
          const selected = selectedTeamId === team.id;
          return (
            <Pressable
              key={team.id}
              style={[styles.teamRow, selected && styles.teamRowSelected]}
              onPress={() => setSelectedTeamId(team.id)}
            >
              <Text style={[styles.teamText, selected && styles.teamTextSelected]}>{team.name}</Text>
            </Pressable>
          );
        })}
        {teams.length === 0 ? (
          <Text style={styles.emptyText}>You're not in any teams yet.</Text>
        ) : null}
      </ScrollView>
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Why are you adding this?"
        placeholderTextColor={colors.muted2}
        style={styles.input}
        maxLength={200}
      />
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Also post to team feed</Text>
        <Switch value={alsoPost} onValueChange={setAlsoPost} trackColor={{ true: colors.accent, false: rules.default }} />
      </View>
      {localError ? <Text style={styles.error}>{localError}</Text> : null}
      <Pressable
        style={[styles.submit, (!selectedTeamId || busy) && styles.submitDisabled]}
        disabled={!selectedTeamId || busy}
        onPress={() => void submit()}
      >
        <Text style={styles.submitText}>{busy ? "Adding..." : "Add"}</Text>
      </Pressable>
    </EditorialSheet>
  );
}

const styles = StyleSheet.create({
  teamRow: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  teamRowSelected: {
    borderColor: rules.gold,
    backgroundColor: "rgba(244,196,48,0.06)",
  },
  teamText: {
    color: colors.muted,
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
  },
  teamTextSelected: {
    color: colors.ink,
  },
  emptyText: {
    color: colors.muted2,
    fontFamily: fonts.sans,
    fontSize: 13,
    paddingVertical: spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  switchLabel: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  submit: {
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: spacing.md,
  },
  submitDisabled: {
    opacity: 0.4,
  },
  submitText: {
    color: colors.paperInk,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.0,
    textTransform: "uppercase",
  },
});
