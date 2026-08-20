import { useEffect, useRef, type ReactNode } from "react";
import { Animated, ScrollView, StyleSheet, View, type ViewStyle } from "react-native";

import { colors, rules, spacing } from "@/constants/theme";

function useShimmerTranslate() {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(progress, { toValue: 1, duration: 1400, useNativeDriver: true })
    );
    anim.start();
    return () => anim.stop();
  }, [progress]);
  return progress.interpolate({ inputRange: [0, 1], outputRange: [-280, 420] });
}

// Thin pulse ring used as a simple loader (no floating orb aesthetic)
export function SignalRing({
  size = 120,
  children,
  style,
}: {
  size?: number;
  children?: ReactNode;
  style?: ViewStyle;
}) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <View style={[{ width: size, height: size, alignItems: "center", justifyContent: "center" }, style]}>
      <Animated.View
        style={{
          width: size * 0.5,
          height: size * 0.5,
          borderRadius: size * 0.25,
          borderWidth: 1,
          borderColor: colors.accent,
          opacity,
        }}
      />
      {children}
    </View>
  );
}

export function ShimmerBlock({
  height,
  width,
  borderRadius = 2,
  style,
}: {
  height: number;
  width?: number | `${number}%`;
  borderRadius?: number;
  style?: ViewStyle;
}) {
  const translateX = useShimmerTranslate();
  return (
    <View
      style={[
        {
          height,
          width: width ?? "100%",
          borderRadius,
          backgroundColor: colors.surface,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [{ translateX }, { skewX: "-18deg" }],
            backgroundColor: "rgba(255, 255, 255, 0.04)",
            width: 120,
          },
        ]}
      />
    </View>
  );
}

export function ForYouSkeleton() {
  return (
    <View style={{ gap: spacing.xl, paddingHorizontal: spacing.xl }}>
      <ShimmerBlock height={32} width="52%" borderRadius={2} />
      <View style={{ gap: spacing.md }}>
        <ShimmerBlock height={1} borderRadius={0} style={{ backgroundColor: rules.gold }} />
        <ShimmerBlock height={24} width="68%" borderRadius={2} />
        <ShimmerBlock height={14} width="82%" borderRadius={2} />
        <ShimmerBlock height={100} borderRadius={2} />
        <ShimmerBlock height={100} borderRadius={2} />
        <ShimmerBlock height={100} borderRadius={2} />
      </View>
      <View style={{ gap: spacing.md }}>
        <ShimmerBlock height={24} width="48%" borderRadius={2} />
        <ShimmerBlock height={14} width="74%" borderRadius={2} />
        <ShimmerBlock height={90} borderRadius={2} />
        <ShimmerBlock height={90} borderRadius={2} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md }}>
        <ShimmerBlock width={120} height={180} borderRadius={2} />
        <ShimmerBlock width={120} height={180} borderRadius={2} />
        <ShimmerBlock width={120} height={180} borderRadius={2} />
      </ScrollView>
    </View>
  );
}

export function FeedCardSkeleton() {
  return (
    <View style={skeletonStyles.card}>
      <View style={skeletonStyles.headerRow}>
        <ShimmerBlock width={36} height={36} borderRadius={18} />
        <View style={{ flex: 1, gap: 7 }}>
          <ShimmerBlock height={13} width="52%" borderRadius={2} />
          <ShimmerBlock height={11} width="38%" borderRadius={2} />
        </View>
      </View>
      <View style={skeletonStyles.mediaRow}>
        <ShimmerBlock width={88} height={132} borderRadius={2} />
        <View style={{ flex: 1, gap: 9 }}>
          <ShimmerBlock height={20} width="82%" borderRadius={2} />
          <ShimmerBlock height={13} width="92%" borderRadius={2} />
          <ShimmerBlock height={13} width="66%" borderRadius={2} />
        </View>
      </View>
    </View>
  );
}

export function FeedSkeleton() {
  return (
    <View style={{ gap: spacing.xs }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <FeedCardSkeleton key={i} />
      ))}
    </View>
  );
}

export function WhatNextSkeleton() {
  return (
    <View style={wnStyles.wrap}>
      <View style={[wnStyles.ghost, wnStyles.ghostFar]} />
      <View style={[wnStyles.ghost, wnStyles.ghostBack]} />
      <View style={wnStyles.card}>
        <ShimmerBlock height={600} borderRadius={4} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const wnStyles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  ghost: {
    position: "absolute",
    left: spacing.lg + 6,
    right: spacing.lg + 6,
    top: spacing.sm,
    bottom: spacing.sm,
    borderRadius: 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: rules.default,
  },
  ghostFar: {
    marginHorizontal: 10,
    opacity: 0.22,
    transform: [{ scaleX: 0.92 }, { translateY: 20 }],
  },
  ghostBack: {
    marginHorizontal: 4,
    opacity: 0.38,
    transform: [{ scaleX: 0.96 }, { translateY: 10 }],
  },
  card: {
    flex: 1,
    borderRadius: 4,
    overflow: "hidden",
  },
});

const skeletonStyles = StyleSheet.create({
  card: {
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  mediaRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
});
