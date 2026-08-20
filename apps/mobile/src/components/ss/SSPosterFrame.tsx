import { Image, StyleSheet, View, type ViewStyle } from "react-native";

import { colors, rules } from "@/constants/theme";

type SSPosterFrameProps = {
  uri?: string | null;
  width?: number | string;
  height?: number | string;
  style?: ViewStyle;
  frameMark?: boolean;
  children?: React.ReactNode;
};

export function SSPosterFrame({
  uri,
  width = "100%",
  height = "100%",
  style,
  frameMark = false,
  children,
}: SSPosterFrameProps) {
  return (
    <View style={[styles.container, { width: width as number, height: height as number }, style]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]} />
      )}

      {frameMark ? (
        <>
          <View style={[styles.markTL, styles.markH]} />
          <View style={[styles.markTL, styles.markV]} />
          <View style={[styles.markTR, styles.markH]} />
          <View style={[styles.markTR, styles.markV]} />
          <View style={[styles.markBL, styles.markH]} />
          <View style={[styles.markBL, styles.markV]} />
          <View style={[styles.markBR, styles.markH]} />
          <View style={[styles.markBR, styles.markV]} />
        </>
      ) : null}

      {children}
    </View>
  );
}

const MARK_SIZE = 16;
const MARK_THICKNESS = 1;
const MARK_COLOR = "rgba(244,196,48,0.55)";

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
    backgroundColor: colors.surfaceMuted,
  },
  placeholder: {
    backgroundColor: colors.surface,
  },
  markTL: { position: "absolute", top: 12, left: 12 },
  markTR: { position: "absolute", top: 12, right: 12 },
  markBL: { position: "absolute", bottom: 12, left: 12 },
  markBR: { position: "absolute", bottom: 12, right: 12 },
  markH: { width: MARK_SIZE, height: MARK_THICKNESS, backgroundColor: MARK_COLOR },
  markV: { width: MARK_THICKNESS, height: MARK_SIZE, backgroundColor: MARK_COLOR, position: "absolute" },
});
