/**
 * Oct-27 Concierge brief chunk D: recovery states.
 *
 * When a decision comes back empty, show a plain-language diagnosis
 * of the main limiting condition and 2–3 adjustment chips. Each chip
 * fills the editable input with a reworded intent that flips ONE
 * named constraint — everything else is preserved so the user can
 * still edit before submitting.
 *
 * The adjustment copy is driven by status_detail from the server.
 * The server emits a short diagnostic code; the mobile layer owns
 * the user-facing copy so a backend deploy isn't required to tune
 * the microcopy.
 */
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";


type Adjustment = { id: string; label: string; prompt: string };


type DiagnosisBundle = {
  headline: string;
  body: string;
  adjustments: Adjustment[];
};


function diagnosisFor(statusDetail: string | undefined, originalIntent: string | null): DiagnosisBundle {
  const intentTail = originalIntent ? ` (${originalIntent.slice(0, 60)}${originalIntent.length > 60 ? "…" : ""})` : "";
  switch (statusDetail) {
    case "empty_next_watch_scope":
      return {
        headline: "Nothing in My Next Watch fits that ask.",
        body: "Your Next Watch queue didn't have a title matching that request.",
        adjustments: [
          { id: "broaden_catalog", label: "Try the full catalog", prompt: `Something new for me${intentTail ? " —" + intentTail : ""}` },
          { id: "add_to_next_watch", label: "Add to Next Watch first", prompt: "Help me pick a few titles to save to My Next Watch." },
          { id: "edit", label: "Edit request", prompt: originalIntent ?? "" },
        ],
      };
    case "empty_watched_scope":
      return {
        headline: "No watched + liked title fits that mood.",
        body: "A comfort rewatch searches titles you've already watched and rated 7+. Loosen the ask or search the whole catalog.",
        adjustments: [
          { id: "broaden_catalog", label: "Try a new title instead", prompt: "A new movie I haven't seen that would feel comforting." },
          { id: "any_watched", label: "Any watched title", prompt: "A comforting rewatch from anything I've watched." },
          { id: "edit", label: "Edit request", prompt: originalIntent ?? "" },
        ],
      };
    case "needs_list_selection":
      return {
        headline: "Which list?",
        body: "Tell me the name of the list you want to pick from, or open a list to browse.",
        adjustments: [
          { id: "edit_named", label: "Name the list", prompt: originalIntent ?? "From my saved list, " },
        ],
      };
    case "empty_provider_constraint":
      return {
        headline: "Nothing matched on those services.",
        body: "Nothing in our catalog matched after the provider filter. Try your other services or drop the provider requirement.",
        adjustments: [
          { id: "any_service", label: "Any service", prompt: originalIntent ? originalIntent.replace(/\bon\s+(netflix|hulu|max|disney\+?|prime|amazon|apple\s*tv\+?|peacock|paramount\+?)\b/gi, "") : "" },
          { id: "other_services", label: "My other services", prompt: "Something on one of my other streaming services." },
          { id: "edit", label: "Edit request", prompt: originalIntent ?? "" },
        ],
      };
    case "empty_runtime_constraint":
      return {
        headline: "Nothing matched within that runtime.",
        body: "Nothing in our catalog fit under the time limit. Loosen it or drop it.",
        adjustments: [
          { id: "up_to_120", label: "Up to 120 min", prompt: (originalIntent ?? "").replace(/under\s+\d+\s*(min|minutes|m)\b/i, "under 120 minutes") || "A movie under 120 minutes." },
          { id: "any_length", label: "Any length", prompt: (originalIntent ?? "").replace(/under\s+\d+\s*(min|minutes|m)\b/i, "") || "" },
          { id: "edit", label: "Edit request", prompt: originalIntent ?? "" },
        ],
      };
    default:
      return {
        headline: "No exact match for that right now.",
        body: "Nothing in our catalog verified against the full request. Try broadening or editing it.",
        adjustments: [
          { id: "broaden_catalog", label: "Try the full catalog", prompt: "Something new for me." },
          { id: "surprise", label: "Surprise me", prompt: "Find something outside my usual taste that I might enjoy." },
          { id: "edit", label: "Edit request", prompt: originalIntent ?? "" },
        ],
      };
  }
}


export function ConciergeEmptyState({
  statusDetail,
  originalIntent,
  rationale,
  onApplyAdjustment,
}: {
  statusDetail: string | undefined;
  originalIntent: string | null;
  rationale?: string | null;
  onApplyAdjustment: (prompt: string) => void;
}) {
  const d = diagnosisFor(statusDetail, originalIntent);
  // Prefer the server's rationale when it's non-empty — Chunk C may
  // have populated it with a precise explanation; otherwise fall back
  // to the generic copy table.
  const headline = rationale && rationale.trim().length > 0 ? rationale.trim() : d.headline;
  return (
    <View style={styles.wrap}>
      <View style={styles.kickerRow}>
        <Ionicons name="alert-circle-outline" size={11} color={colors.accent} />
        <Text style={styles.kicker}>NO EXACT MATCH</Text>
      </View>
      <Text style={styles.headline}>{headline}</Text>
      <Text style={styles.body}>{d.body}</Text>
      <View style={styles.chipsRow}>
        {d.adjustments.map((a) => (
          <Pressable
            key={a.id}
            onPress={() => onApplyAdjustment(a.prompt)}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            style={({ pressed }) => [styles.chip, pressed && { opacity: 0.75 }]}
          >
            <Text style={styles.chipLabel}>{a.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 8,
  },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kicker: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  headline: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 16,
    lineHeight: 22,
  },
  body: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  chipsRow: {
    marginTop: 6,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  chipLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 12,
    letterSpacing: 0.2,
  },
});
