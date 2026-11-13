/**
 * Oct-19 Discover simplified mock: SeenSnap Concierge entry card.
 *
 * Dark cinematic backdrop (no purple aura). Eyebrow + big serif
 * headline + subtitle. "TRY ASKING" label with a single rounded
 * input showing a tappable example; the yellow arrow on the right
 * submits.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  ImageSourcePropType,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";


type SuggestedPrompt = {
  id: string;
  label: string;
  prompt: string;
  required_context?: string | null;
  reference_title_id?: string | null;
};

type SuggestedPromptsResponse = {
  headline: string;
  placeholder: string;
  prompts: SuggestedPrompt[];
  personalised: boolean;
};


export type ConciergeTitleCard = {
  title_id: string;
  tmdb_id: number;
  title: string;
  poster_url: string | null;
  backdrop_url: string | null;
  year: number | null;
  media_type: string;
  overview: string | null;
  watch_options?: Array<{ provider_code: string; provider_name: string; offer_type: string; web_url: string | null }>;
};

export type ConciergeDecisionResponse = {
  version?: number;
  request_id?: string | null;
  can_retry?: boolean;
  retry_after_seconds?: number | null;
  decision_id: string | null;
  status: "ready" | "partial" | "unavailable" | "empty" | "error" | "allowance_exhausted" | "processing";
  status_detail: string;
  rationale: string;
  constraints: Record<string, unknown> | null;
  titles: ConciergeTitleCard[];
  allowance_remaining: number | null;
  allowance_cap: number | null;
  resets_at: string | null;
  // CON01/CON02/CON04 partial-state fields.
  retrieval_exhausted?: boolean;
  exact_match_count?: number;
  requested_count?: number;
  // Typed CON04 partial reason — one of source_exhausted,
  // upstream_failure, retrieval_budget_reached, metadata_unavailable,
  // pick_one_intentional, or null.
  partial_reason?: string | null;
  // C16: per-title "why this fits" short strings keyed by title_id.
  // The featured title's rationale is shown so promoting a thumbnail
  // changes the explanation.
  title_rationales?: Record<string, string>;
  // Chunk D: the composer may stash the original intent on the
  // response so the empty-state recovery UI can rebuild adjustment
  // prompts without plumbing the raw string through Discover state.
  _intent?: string | null;
  // Chunk E: client-side turn counter. The decision persists its
  // own turns on the server; the mobile client tracks whether to
  // show the Undo chip without an extra round-trip.
  _turn_count?: number;
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
  onSubmit,
  draft,
  disabled,
  backdropUri,
  continuing,
  conversationVersion,
}: {
  token: string | null;
  tier: "free" | "premium";
  allowanceRemaining: number | null;
  allowanceCap: number | null;
  resetsAt: string | null;
  onSubmit: (intent: string, options?: { newSearch: boolean }) => Promise<ConciergeDecisionResponse | undefined>;
  draft?: string;
  disabled?: boolean;
  backdropUri?: string | null;
  continuing?: boolean;
  conversationVersion?: string;
}) {
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exampleIdx, setExampleIdx] = useState(0);
  const [suggestions, setSuggestions] = useState<SuggestedPromptsResponse | null>(null);
  // Snapshot the previous draft when the user swaps it with a chip so
  // "Replace with a suggestion" stays reversible per spec.
  const previousDraftRef = useRef<string | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const requestBusy = useRef(false);
  const newSearch = useRef(false);

  useEffect(() => { if (draft !== undefined) setIntent(draft); newSearch.current = false; }, [draft, conversationVersion]);

  const outOfAllowance = tier === "free" && allowanceRemaining != null && allowanceRemaining <= 0;
  const currentExample = ROTATING_EXAMPLES[exampleIdx] ?? DEFAULT_EXAMPLE;
  const placeholder = continuing ? "Something shorter, lighter, or more like the second one…" : suggestions?.placeholder ?? currentExample;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void apiRequest<SuggestedPromptsResponse>("/me/concierge/prompts", { token })
      .then((res) => { if (!cancelled) setSuggestions(res); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  function applyChip(chip: SuggestedPrompt) {
    // Preserve the current draft so the user can undo. We only
    // snapshot once per swap cycle so repeated chip taps don't lose
    // the ORIGINAL draft.
    if (intent.trim() && previousDraftRef.current === null) {
      previousDraftRef.current = intent;
    } else if (!intent.trim()) {
      previousDraftRef.current = null;
    }
    newSearch.current = true;
    setIntent(chip.prompt);
    inputRef.current?.focus();
  }

  function restorePreviousDraft() {
    if (previousDraftRef.current !== null) {
      newSearch.current = false;
      setIntent(previousDraftRef.current);
      previousDraftRef.current = null;
    }
  }

  async function submit() {
    if (!token || requestBusy.current || disabled) return;
    const trimmed = intent.trim();
    if (!trimmed) return;
    requestBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed, { newSearch: newSearch.current });
    } catch {
      setError("Concierge couldn't finish this search. Your request is still here; please try again.");
    } finally {
      requestBusy.current = false;
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
          <Text style={styles.kicker}>SEENSNAP CONCIERGE</Text>
        </View>

        <Text style={styles.headline}>Find your next{"\n"}great watch.</Text>
        <Text style={styles.subhead}>
          {suggestions?.headline ?? "Tell me what you're in the mood for—or let me pick from My Picks."}
        </Text>

        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            placeholder={placeholder}
            placeholderTextColor="rgba(255,255,255,0.65)"
            value={intent}
            onChangeText={(next) => {
              // Any manual edit clears the "undo last chip" state.
              if (previousDraftRef.current !== null) {
                previousDraftRef.current = null;
              }
              setIntent(next);
            }}
            editable={!disabled && !busy && !outOfAllowance}
            onSubmitEditing={submit}
            returnKeyType="send"
            style={styles.input}
            multiline={false}
            maxLength={240}
          />
          <Pressable
            disabled={disabled || busy || outOfAllowance}
            onPress={() => {
              if (!intent.trim()) {
                setIntent(placeholder);
                return;
              }
              void submit();
            }}
            style={({ pressed }) => [
              styles.goBtn,
              (disabled || busy || outOfAllowance) && styles.goBtnDisabled,
              pressed && !busy && styles.goBtnPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Ask SeenSnap Concierge"
          >
            {busy ? (
              <ActivityIndicator size="small" color="#0b0f17" />
            ) : (
              <Ionicons name="arrow-forward" size={16} color="#0b0f17" />
            )}
          </Pressable>
        </View>

        {suggestions && suggestions.prompts.length > 0 ? (
          <View style={styles.promptsBlock}>
            <View style={styles.promptsHead}>
              <Text style={styles.promptsLabel}>{continuing ? "NEW SEARCH IDEAS" : "TRY ASKING"}</Text>
              {previousDraftRef.current !== null ? (
                <Pressable
                  onPress={restorePreviousDraft}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Undo last suggestion"
                >
                  <Text style={styles.undoLabel}>UNDO</Text>
                </Pressable>
              ) : null}
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.promptsRow}
              // Horizontal chip scrolling must not trigger vertical
              // section navigation per spec.
              directionalLockEnabled
            >
              {suggestions.prompts.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => applyChip(p)}
                  hitSlop={4}
                  style={({ pressed }) => [styles.promptChip, pressed && { opacity: 0.75 }]}
                  accessibilityRole="button"
                  accessibilityLabel={p.label}
                >
                  <Text style={styles.promptChipLabel} numberOfLines={1}>{p.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
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
    marginBottom: spacing.md,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#0F1419",
    borderWidth: 1.5,
    // Subtle purple/pink outline per mock A — the only purple on the
    // page. Acts as an accent, not atmosphere.
    borderColor: "rgba(173,120,255,0.42)",
    minHeight: 220,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8,11,14,0.68)",
  },
  body: {
    padding: 18,
    gap: 4,
  },
  kickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 2,
  },
  kicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  headline: {
    marginTop: 4,
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.4,
  },
  subhead: {
    marginTop: 6,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6,
  },
  inputRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
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
  promptsBlock: {
    marginTop: 12,
    gap: 8,
  },
  promptsHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  promptsLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  undoLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  promptsRow: {
    flexDirection: "row",
    gap: 8,
    // Leave a sliver of the next chip visible so the horizontal
    // scroll affordance is obvious per spec.
    paddingRight: 32,
  },
  promptChip: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  promptChipLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 12,
    letterSpacing: 0.2,
  },
  goBtnDisabled: {
    opacity: 0.5,
  },
  goBtnPressed: {
    opacity: 0.8,
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
