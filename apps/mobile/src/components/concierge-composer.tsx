/**
 * Oct-18 build brief §4: Concierge composer.
 *
 * Lives on Discover for every user — Premium gets unlimited, Free
 * gets a visible monthly allowance strip. Submits a natural-language
 * intent; on success the parent renders the result set as a
 * HeroFourSection.
 *
 * Honest unavailable state when the server reports no AI provider.
 * No fabricated latency, no fake decisions.
 */
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";


export type ConciergeTitleCard = {
  title_id: string;
  tmdb_id: number;
  title: string;
  poster_url: string | null;
  backdrop_url: string | null;
  year: number | null;
  media_type: string;
  overview: string | null;
};

export type ConciergeDecisionResponse = {
  decision_id: string | null;
  status: "ready" | "unavailable" | "empty" | "error" | "allowance_exhausted";
  status_detail: string;
  rationale: string;
  constraints: Record<string, unknown> | null;
  titles: ConciergeTitleCard[];
  allowance_remaining: number | null;
  allowance_cap: number | null;
  resets_at: string | null;
};


export function ConciergeComposer({
  token,
  tier,
  allowanceRemaining,
  allowanceCap,
  resetsAt,
  onDecision,
}: {
  token: string | null;
  tier: "free" | "premium";
  allowanceRemaining: number | null;
  allowanceCap: number | null;
  resetsAt: string | null;
  onDecision: (decision: ConciergeDecisionResponse) => void;
}) {
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outOfAllowance = tier === "free" && allowanceRemaining != null && allowanceRemaining <= 0;

  async function submit() {
    if (!token || busy) return;
    const trimmed = intent.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const idempotency_key = `concierge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await apiRequest<ConciergeDecisionResponse>("/me/concierge/decision", {
        method: "POST",
        token,
        body: JSON.stringify({ intent: trimmed, idempotency_key }),
      });
      onDecision(res);
      if (res.status === "unavailable") setError("Concierge is unavailable right now.");
      else if (res.status === "error") setError(res.status_detail || "Something went wrong.");
      else if (res.status === "allowance_exhausted") setError("Monthly allowance used up — resets next month.");
      else if (res.status === "empty") setError("No matches with that constraint.");
      else setIntent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.inputWrap}>
          <Ionicons name="sparkles-outline" size={16} color={colors.accent} style={{ marginRight: 8 }} />
          <TextInput
            placeholder={tier === "premium" ? "Ask Concierge anything…" : "Ask Concierge — e.g. slow burn drama under 2h"}
            placeholderTextColor={colors.muted2}
            value={intent}
            onChangeText={setIntent}
            editable={!busy && !outOfAllowance}
            onSubmitEditing={submit}
            returnKeyType="send"
            style={styles.input}
            multiline={false}
            maxLength={240}
          />
        </View>
        <Pressable
          disabled={busy || outOfAllowance || !intent.trim()}
          onPress={submit}
          style={({ pressed }) => [
            styles.goBtn,
            (busy || outOfAllowance || !intent.trim()) && styles.goBtnDisabled,
            pressed && !busy && styles.goBtnPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#0b0f17" />
          ) : (
            <Text style={styles.goBtnLabel}>Ask</Text>
          )}
        </Pressable>
      </View>

      <AllowanceStrip
        tier={tier}
        remaining={allowanceRemaining}
        cap={allowanceCap}
        resetsAt={resetsAt}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function AllowanceStrip({
  tier,
  remaining,
  cap,
  resetsAt,
}: {
  tier: "free" | "premium";
  remaining: number | null;
  cap: number | null;
  resetsAt: string | null;
}) {
  if (tier === "premium") {
    return (
      <View style={styles.strip}>
        <Ionicons name="infinite" size={11} color={colors.accent} />
        <Text style={styles.stripLabel}>UNLIMITED · Premium</Text>
      </View>
    );
  }
  if (remaining == null || cap == null) return null;
  const resets = resetsAt ? new Date(resetsAt) : null;
  const resetsLabel = resets ? resets.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  return (
    <View style={styles.strip}>
      <Text style={styles.stripLabel}>
        {remaining}/{cap} LEFT THIS MONTH
      </Text>
      {resetsLabel ? <Text style={styles.stripResets}>resets {resetsLabel}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  inputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(244,196,48,0.28)",
  },
  input: {
    flex: 1,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    paddingVertical: 0,
  },
  goBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  goBtnDisabled: {
    opacity: 0.4,
  },
  goBtnPressed: {
    opacity: 0.7,
  },
  goBtnLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    letterSpacing: 0.6,
    fontSize: 13,
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stripLabel: {
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 1.1,
  },
  stripResets: {
    fontFamily: fonts.sans,
    color: colors.muted2,
    fontSize: 10,
  },
  error: {
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    fontSize: 12,
  },
});
