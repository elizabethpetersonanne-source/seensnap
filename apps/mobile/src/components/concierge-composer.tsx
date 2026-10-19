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


const DEFAULT_EXAMPLES = [
  "A funny movie under two hours, on a service I have.",
  "Something like a slow-burn drama with twists.",
  "A rewatch that'll put me in a good mood.",
  "A smart documentary I haven't seen yet.",
];

export function ConciergeComposer({
  token,
  tier,
  allowanceRemaining,
  allowanceCap,
  resetsAt,
  onDecision,
  examples = DEFAULT_EXAMPLES,
  prominent = false,
}: {
  token: string | null;
  tier: "free" | "premium";
  allowanceRemaining: number | null;
  allowanceCap: number | null;
  resetsAt: string | null;
  onDecision: (decision: ConciergeDecisionResponse) => void;
  examples?: string[];
  prominent?: boolean;
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
      {prominent ? (
        <View style={styles.prominentHeader}>
          <View style={styles.kickerRow}>
            <Ionicons name="sparkles" size={11} color={colors.accent} />
            <Text style={styles.prominentKicker}>CONCIERGE</Text>
          </View>
          <Text style={styles.prominentHeadline}>What do you feel like watching?</Text>
        </View>
      ) : null}

      <View style={styles.row}>
        <View style={[styles.inputWrap, prominent && styles.inputWrapProminent]}>
          <Ionicons name="sparkles-outline" size={prominent ? 18 : 16} color={colors.accent} style={{ marginRight: 8 }} />
          <TextInput
            placeholder={tier === "premium" ? "Ask Concierge anything…" : "Ask Concierge — e.g. slow burn drama under 2h"}
            placeholderTextColor={colors.muted2}
            value={intent}
            onChangeText={setIntent}
            editable={!busy && !outOfAllowance}
            onSubmitEditing={submit}
            returnKeyType="send"
            style={[styles.input, prominent && styles.inputProminent]}
            multiline={false}
            maxLength={240}
          />
        </View>
        <Pressable
          disabled={busy || outOfAllowance || !intent.trim()}
          onPress={submit}
          style={({ pressed }) => [
            styles.goBtn,
            prominent && styles.goBtnProminent,
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

      {examples.length > 0 && !intent ? (
        <View style={styles.examplesWrap}>
          <Text style={styles.examplesLabel}>Try asking</Text>
          {examples.slice(0, 2).map((ex) => (
            <Pressable
              key={ex}
              onPress={() => setIntent(ex)}
              style={({ pressed }) => [styles.exampleRow, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="return-down-forward-outline" size={13} color={colors.accent} />
              <Text style={styles.exampleText}>{ex}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

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
    gap: 10,
  },
  prominentHeader: {
    gap: 6,
    marginBottom: 4,
  },
  kickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  prominentKicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  prominentHeadline: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  inputWrapProminent: {
    paddingVertical: 12,
    borderRadius: radii.md,
  },
  inputProminent: {
    fontSize: 15,
  },
  goBtnProminent: {
    paddingVertical: 14,
  },
  examplesWrap: {
    gap: 4,
    marginTop: 2,
  },
  examplesLabel: {
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 2,
  },
  exampleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
  },
  exampleText: {
    flex: 1,
    fontFamily: fonts.serif,
    color: colors.ink,
    fontSize: 13,
    lineHeight: 17,
    fontStyle: "italic",
    opacity: 0.86,
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
    borderColor: "rgba(255,230,0,0.28)",
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
