import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { motion } from "@/constants/theme";

/**
 * EditorialSheet — canonical bottom-sheet modal wrapper for SeenSnap flows
 * (save-to-list, add-to-team, share, filter, confirm, etc.).
 *
 * Provides: dark overlay, slide-up motion, drag handle, optional serif title,
 * optional right-side action (e.g. Close), safe-area padding for iOS bottom.
 *
 * Content is passed as children — the caller controls the inner layout. This
 * shell just standardizes the SeenSnap sheet feel across every modal surface.
 */
export function EditorialSheet({
  visible,
  onClose,
  title,
  supporting,
  right,
  children,
  contentStyle,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  supporting?: string;
  right?: ReactNode;
  children: ReactNode;
  contentStyle?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(80)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(overlayOpacity, {
          toValue: 1,
          duration: motion.timing.enter,
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: 0,
          ...motion.spring.snap,
        }),
      ]).start();
    } else {
      overlayOpacity.setValue(0);
      translateY.setValue(80);
    }
  }, [visible, overlayOpacity, translateY]);

  return (
    <Modal
      transparent
      animationType="none"
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]} />
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom + spacing.md, spacing.lg), transform: [{ translateY }] },
            contentStyle,
          ]}
        >
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>
          {title || supporting || right ? (
            <View style={styles.headerRow}>
              <View style={{ flex: 1 }}>
                {title ? <Text style={styles.title}>{title}</Text> : null}
                {supporting ? <Text style={styles.supporting}>{supporting}</Text> : null}
              </View>
              {right !== undefined ? (
                right
              ) : (
                <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
                  <Ionicons name="close" size={18} color={colors.muted} />
                </Pressable>
              )}
            </View>
          ) : null}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(3,5,10,0.72)",
  },
  sheet: {
    backgroundColor: colors.backgroundElevated,
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: rules.default,
  },
  handleWrap: {
    alignItems: "center",
    paddingBottom: spacing.sm,
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: rules.default,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  title: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 26,
    color: colors.ink,
    letterSpacing: -0.2,
  },
  supporting: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
    marginTop: 3,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
});
