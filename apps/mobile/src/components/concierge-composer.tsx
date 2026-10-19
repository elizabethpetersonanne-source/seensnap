/**
 * Oct-19 Discover simplified mock: AI Concierge entry card.
 *
 * Dark cinematic backdrop (no purple aura). Eyebrow + big serif
 * headline + subtitle. "TRY ASKING" label with a single rounded
 * input showing a tappable example; the yellow arrow on the right
 * submits.
 */
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  ImageSourcePropType,
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


const DEFAULT_EXAMPLE = "A funny movie under two hours, on a service I have.";
const ROTATING_EXAMPLES = [
  "A funny movie under two hours, on a service I have.",
  "A slow-burn drama with twists.",
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
  backdropUri,
}: {
  token: string | null;
  tier: "free" | "premium";
  allowanceRemaining: number | null;
  allowanceCap: number | null;
  resetsAt: string | null;
  onDecision: (decision: ConciergeDecisionResponse) => void;
  backdropUri?: string | null;
}) {
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exampleIdx, setExampleIdx] = useState(0);

  const outOfAllowance = tier === "free" && allowanceRemaining != null && allowanceRemaining <= 0;
  const currentExample = ROTATING_EXAMPLES[exampleIdx] ?? DEFAULT_EXAMPLE;

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
      {/* Cinematic backdrop. If the caller supplies a real poster/
          backdrop URI, we use it. Otherwise a dark surface with a
          subtle gradient keeps the card readable. */}
      {backdropUri ? (
        <Image source={{ uri: backdropUri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
      ) : null}
      <View style={styles.scrim} />

      <View style={styles.body}>
        <View style={styles.kickerRow}>
          <Ionicons name="sparkles" size={11} color={colors.accent} />
          <Text style={styles.kicker}>AI CONCIERGE</Text>
        </View>

        <Text style={styles.headline}>What do you feel{"\n"}like watching?</Text>
        <Text style={styles.subhead}>A pick that fits your taste and your services.</Text>

        <Text style={styles.tryLabel}>TRY ASKING</Text>

        <View style={styles.inputRow}>
          <TextInput
            placeholder={currentExample}
            placeholderTextColor="rgba(255,255,255,0.55)"
            value={intent}
            onChangeText={setIntent}
            editable={!busy && !outOfAllowance}
            onSubmitEditing={submit}
            onFocus={() => {
              if (!intent) setIntent(currentExample);
            }}
            returnKeyType="send"
            style={styles.input}
            multiline={false}
            maxLength={240}
          />
          <Pressable
            disabled={busy || outOfAllowance || !intent.trim()}
            onPress={() => {
              if (!intent.trim()) {
                setIntent(currentExample);
                return;
              }
              void submit();
            }}
            style={({ pressed }) => [
              styles.goBtn,
              (busy || outOfAllowance) && styles.goBtnDisabled,
              pressed && !busy && styles.goBtnPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Ask Concierge"
          >
            {busy ? (
              <ActivityIndicator size="small" color="#0b0f17" />
            ) : (
              <Ionicons name="arrow-forward" size={16} color="#0b0f17" />
            )}
          </Pressable>
        </View>

        <Pressable
          onPress={() => setExampleIdx((i) => (i + 1) % ROTATING_EXAMPLES.length)}
          hitSlop={8}
          style={styles.cycleRow}
          accessibilityLabel="Show another example ask"
        >
          <Ionicons name="refresh-outline" size={11} color={colors.muted} />
          <Text style={styles.cycleLabel}>Another example</Text>
        </Pressable>

        <AllowanceStrip
          tier={tier}
          remaining={allowanceRemaining}
          cap={allowanceCap}
          resetsAt={resetsAt}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
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
  if (tier === "premium") return null;
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
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#0F1419",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.1)",
    minHeight: 260,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8,11,14,0.72)",
  },
  body: {
    padding: 20,
    gap: 6,
  },
  kickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  kicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  headline: {
    marginTop: 2,
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.4,
  },
  subhead: {
    marginTop: 4,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  tryLabel: {
    marginTop: 14,
    fontFamily: fonts.monoSemiBold,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  inputRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.4)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
  },
  input: {
    flex: 1,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    paddingVertical: 10,
  },
  goBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  goBtnDisabled: {
    opacity: 0.5,
  },
  goBtnPressed: {
    opacity: 0.8,
  },
  cycleRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: 2,
  },
  cycleLabel: {
    fontFamily: fonts.monoMedium,
    color: colors.muted,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  strip: {
    marginTop: 8,
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
    marginTop: 6,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    fontSize: 12,
  },
});
