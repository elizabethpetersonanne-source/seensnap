import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, fonts } from "@/constants/theme";

/** Accessible confirmation shared by native and web (Alert buttons are native-only). */
export function ConfirmDialog({ visible, title, message, confirmLabel = "Confirm", busy = false, onCancel, onConfirm }: {
  visible: boolean; title: string; message: string; confirmLabel?: string; busy?: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onCancel(); }}>
    <View style={styles.backdrop}>
      <View style={styles.panel} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={{ gap: 16 }}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onConfirm} style={[styles.button, { backgroundColor: colors.accent }]}>
            <Text style={{ color: colors.background, fontFamily: fonts.sansBold, fontSize: 16 }}>{busy ? "Working…" : confirmLabel}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onCancel} style={styles.button}>
            <Text style={styles.message}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, padding: 16, backgroundColor: "rgba(0,0,0,.7)", alignItems: "center", justifyContent: "center" },
  panel: { width: "100%", maxWidth: 520, maxHeight: "90%", padding: 20, borderRadius: 16, backgroundColor: colors.background },
  title: { fontFamily: fonts.sansBold, fontSize: 22, color: colors.ink },
  message: { fontFamily: fonts.sans, fontSize: 16, color: colors.ink },
  button: { minHeight: 48, padding: 12, alignItems: "center", justifyContent: "center", borderRadius: 8 },
});
