/**
 * Oct-19 Visual Design brief §11: shared loading / empty / error /
 * offline primitives so every primary screen can render the same
 * designed states. Loading reserves the final layout geometry;
 * empty collections use short useful copy + one next action;
 * failed network operations get concise retry feedback.
 *
 * Keep usage consistent — don't invent per-screen variants.
 */
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";


export function LoadingView({ height, label, style }: { height?: number; label?: string; style?: ViewStyle }) {
  return (
    <View style={[styles.loading, { minHeight: height ?? 200 }, style]}>
      <ActivityIndicator color={colors.accent} size="small" />
      {label ? <Text style={styles.loadingLabel}>{label}</Text> : null}
    </View>
  );
}


export function EmptyView({
  icon,
  title,
  body,
  actionLabel,
  onAction,
  height,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  height?: number;
}) {
  return (
    <View style={[styles.empty, { minHeight: height ?? 240 }]}>
      {icon ? (
        <View style={styles.emptyIcon}>
          <Ionicons name={icon} size={22} color={colors.muted} />
        </View>
      ) : null}
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}>
          <Text style={styles.ctaLabel}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}


export function ErrorView({
  title,
  body,
  onRetry,
  height,
}: {
  title?: string;
  body?: string;
  onRetry?: () => void;
  height?: number;
}) {
  return (
    <View style={[styles.empty, { minHeight: height ?? 240 }]}>
      <View style={styles.emptyIcon}>
        <Ionicons name="warning-outline" size={22} color={colors.danger} />
      </View>
      <Text style={styles.emptyTitle}>{title ?? "Something went wrong."}</Text>
      <Text style={styles.emptyBody}>{body ?? "Give it another try."}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}>
          <Text style={styles.ctaLabel}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}


export function OfflineView({ onRetry, height }: { onRetry?: () => void; height?: number }) {
  return (
    <ErrorView
      title="You're offline"
      body="Reconnect and we'll pull your feed."
      onRetry={onRetry}
      height={height}
    />
  );
}


const styles = StyleSheet.create({
  loading: {
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: spacing.xl,
  },
  loadingLabel: {
    fontFamily: fonts.monoMedium,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  emptyTitle: {
    fontFamily: fonts.sansBold,
    color: colors.ink,
    fontSize: 18,
    textAlign: "center",
  },
  emptyBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    maxWidth: 320,
  },
  cta: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  ctaLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    fontSize: 12,
    letterSpacing: 0.6,
  },
});
