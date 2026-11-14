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


function diagnosisFor(
  statusDetail: string | undefined,
  originalIntent: string | null,
  partialReason: string | null | undefined,
): DiagnosisBundle {
  const intentTail = originalIntent ? ` (${originalIntent.slice(0, 60)}${originalIntent.length > 60 ? "…" : ""})` : "";
  // CON04: a retrieval failure is NOT a "no matching titles" state.
  // Say so plainly and offer Retry instead of asking the user to
  // broaden their request.
  if (partialReason === "upstream_failure" || partialReason === "metadata_unavailable") {
    return {
      headline: "I couldn't finish checking the catalog.",
      body: "Some title information could not be checked. Your request is preserved; try again in a moment.",
      adjustments: [
        { id: "retry", label: "Retry", prompt: originalIntent ?? "" },
        { id: "edit", label: "Edit request", prompt: originalIntent ?? "" },
      ],
    };
  }
  if (partialReason === "retrieval_budget_reached" || partialReason === "retrieval_timeout") {
    return {
      headline: "There are more titles to check.",
      body: "Keep looking continues from this search with your filters intact.",
      adjustments: [
        { id: "retry", label: "Keep looking", prompt: originalIntent ?? "" },
      ],
    };
  }
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
        headline: "No watched title fits that mood.",
        body: "This search checks your watched and ranked titles, including ones you haven't rated. Edit the request or search for something new.",
        adjustments: [
          { id: "broaden_catalog", label: "Try a new title instead", prompt: "A new movie I haven't seen that would feel comforting." },
          { id: "any_watched", label: "Any watched title", prompt: "A comforting rewatch from anything I've watched." },
          { id: "edit", label: "Edit request", prompt: originalIntent ?? "" },
        ],
      };
    case "empty_named_list_scope":
      return { headline: "No matching title in this list.", body: "This list has no verified match for your request. You can edit it or explicitly search the full catalog.",
        adjustments: [{ id: "broaden_catalog", label: "Try the full catalog", prompt: "Find a new title for me." },
          { id: "edit", label: "Edit request", prompt: originalIntent ?? "" }] };
    case "needs_list_selection":
      return {
        headline: "Which list should I search?",
        body: "Choose one of your lists so I can search only those titles.",
        adjustments: [
          { id: "edit_named", label: "Choose a list", prompt: originalIntent ?? "From my saved list, " },
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
  partialReason,
  onApplyAdjustment,
  onContinue,
  onEdit,
  busy,
}: {
  statusDetail: string | undefined;
  originalIntent: string | null;
  rationale?: string | null;
  partialReason?: string | null;
  onApplyAdjustment: (prompt: string, adjustment: string) => void;
  onContinue?: () => void;
  onEdit?: () => void;
  busy?: boolean;
}) {
  const d = diagnosisFor(statusDetail, originalIntent, partialReason);
  // Old receipts can contain interpretation prose written before retrieval.
  // A list choice or an empty list must never imply we selected any titles.
  const incomplete = ["retrieval_timeout", "retrieval_budget_reached", "upstream_failure", "metadata_unavailable"].includes(partialReason ?? "");
  const needsList = statusDetail === "needs_list_selection";
  const headline = incomplete || needsList || statusDetail === "empty_named_list_scope" ? d.headline : rationale?.trim() || d.headline;
  return (
    <View style={styles.wrap}>
      <View style={styles.kickerRow}>
        <Ionicons name="alert-circle-outline" size={11} color={colors.accent} />
        <Text style={styles.kicker}>{incomplete ? "SEARCH IN PROGRESS" : needsList ? "CHOOSE A LIST" : "NO EXACT MATCH"}</Text>
      </View>
      <Text style={styles.headline}>{headline}</Text>
      <Text style={styles.body}>{d.body}</Text>
      <View style={styles.chipsRow}>
        {d.adjustments.map((a) => (
          <Pressable
            key={a.id}
            disabled={busy}
            onPress={() => a.id === "edit" && onEdit ? onEdit() : a.id === "retry" && onContinue ? onContinue() : onApplyAdjustment(a.prompt, a.id)}
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
    minHeight: 44,
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
