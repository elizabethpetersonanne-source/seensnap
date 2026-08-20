import { useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, radii } from "@/constants/theme";

export function ratingColor(score: number): string {
  if (score >= 9) return "#2ec4b6";
  if (score >= 7) return "#f4c430";
  if (score >= 5) return "#74c0fc";
  return "#e03131";
}

export function ratingLabel(score: number): string {
  if (score >= 9.5) return "Masterpiece";
  if (score >= 9) return "Exceptional";
  if (score >= 8) return "Great";
  if (score >= 7) return "Good";
  if (score >= 6) return "Decent";
  if (score >= 5) return "Mixed";
  if (score >= 3) return "Disappointing";
  return "Painful";
}

export function RatingCircle({
  score,
  size = 48,
  style,
}: {
  score: number;
  size?: number;
  style?: ViewStyle;
}) {
  const color = ratingColor(score);
  const formatted = score % 1 === 0 ? String(Math.round(score)) : score.toFixed(1);
  return (
    <View
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: `${color}90`,
          shadowColor: color,
        },
        style,
      ]}
    >
      <Text style={[styles.circleScore, { color, fontSize: size * 0.31 }]}>{formatted}</Text>
    </View>
  );
}

export function RatingPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const scaleAnims = useRef(
    Array.from({ length: 10 }, () => new Animated.Value(1))
  ).current;

  function tap(n: number) {
    const anim = scaleAnims[n - 1];
    Animated.sequence([
      Animated.timing(anim, { toValue: 0.84, duration: 70, useNativeDriver: true }),
      Animated.spring(anim, { toValue: 1, bounciness: 14, speed: 20, useNativeDriver: true }),
    ]).start();
    onChange(n);
  }

  const floorVal = value !== null ? Math.floor(value) : null;

  return (
    <View style={styles.picker}>
      {/* Score preview */}
      <View style={styles.pickerPreview}>
        {value !== null ? (
          <RatingCircle score={value} size={62} />
        ) : (
          <View style={styles.pickerPlaceholder}>
            <Text style={styles.pickerPlaceholderText}>—</Text>
          </View>
        )}
        <View style={styles.pickerMeta}>
          <Text style={styles.pickerPrompt}>
            {value !== null ? ratingLabel(value) : "Rate this title"}
          </Text>
          {value !== null ? (
            <Text style={[styles.pickerScore, { color: ratingColor(value) }]}>
              {value % 1 === 0 ? `${Math.round(value)}.0` : value.toFixed(1)} / 10
            </Text>
          ) : (
            <Text style={styles.pickerHint}>Tap a number below</Text>
          )}
        </View>
      </View>

      {/* Number buttons 1–10 */}
      <View style={styles.pickerRow}>
        {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const).map((n) => {
          const isActive = floorVal === n;
          const c = ratingColor(n);
          return (
            <Animated.View key={n} style={[styles.pickerBtnWrap, { transform: [{ scale: scaleAnims[n - 1] }] }]}>
              <Pressable
                onPress={() => tap(n)}
                style={[
                  styles.pickerBtn,
                  isActive && { backgroundColor: `${c}28`, borderColor: c },
                ]}
              >
                <Text style={[styles.pickerBtnText, isActive && { color: c }]}>{n}</Text>
              </Pressable>
            </Animated.View>
          );
        })}
      </View>

      {/* Half step + clear row */}
      <View style={styles.pickerActions}>
        {value !== null && value % 1 === 0 && value > 0.5 ? (
          <Pressable style={styles.halfBtn} onPress={() => onChange(value - 0.5)}>
            <Text style={styles.halfBtnText}>− ½</Text>
          </Pressable>
        ) : null}
        {value !== null && value % 1 !== 0 ? (
          <View style={[styles.halfActiveChip, { borderColor: `${ratingColor(value)}55`, backgroundColor: `${ratingColor(value)}14` }]}>
            <Text style={[styles.halfActiveText, { color: ratingColor(value) }]}>{value.toFixed(1)} ✓</Text>
          </View>
        ) : null}
        {value !== null ? (
          <Pressable style={styles.clearBtn} onPress={() => onChange(null)}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Circle ────────────────────────────────────────────────────────────────
  circle: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(7,11,19,0.82)",
    borderWidth: 2,
    shadowOpacity: 0.7,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  circleScore: { fontWeight: "900", letterSpacing: -0.5 },

  // ── Picker ────────────────────────────────────────────────────────────────
  picker: { gap: 14 },

  pickerPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingVertical: 4,
  },
  pickerPlaceholder: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  pickerPlaceholderText: { color: colors.muted, fontSize: 22, fontWeight: "300" },
  pickerMeta: { flex: 1, gap: 3 },
  pickerPrompt: { color: colors.ink, fontSize: 16, fontWeight: "900" },
  pickerScore: { fontSize: 13, fontWeight: "700" },
  pickerHint: { color: colors.muted, fontSize: 13 },

  pickerRow: { flexDirection: "row", gap: 5 },
  pickerBtnWrap: { flex: 1 },
  pickerBtn: {
    height: 38,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  pickerBtnText: { color: colors.muted, fontWeight: "800", fontSize: 13 },

  pickerActions: { flexDirection: "row", gap: 8, alignItems: "center" },
  halfBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  halfBtnText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  halfActiveChip: {
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  halfActiveText: { fontWeight: "800", fontSize: 12 },
  clearBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  clearBtnText: { color: colors.muted, fontWeight: "700", fontSize: 12 },
});
