/** Explain real access. Purchases are not offered until billing is available. */
import { router } from "expo-router";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, fonts } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { useEntitlement } from "@/lib/entitlement";

export function PremiumPaywallSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { sessionToken } = useAuth();
  const membership = useEntitlement(sessionToken);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 20, maxWidth: 640, width: "100%", alignSelf: "center" }}>
        <Text style={{ color: colors.accent, fontFamily: fonts.serifBold, fontSize: 28 }}>SeenSnap Premium</Text>
        <Text style={{ color: colors.ink, fontFamily: fonts.sans, fontSize: 16, lineHeight: 24 }}>
          {membership?.is_beta ? "Premium is included during beta. No purchase or cancellation is needed." : membership?.verified && membership.tier === "premium" ? "Your Premium membership is active." : "Check your membership and explore Premium benefits. Paid upgrades are not available in this beta."}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 16, lineHeight: 24 }}>Get recommendations from SeenSnap Concierge, explore your SceneDNA, and discover titles with your Watch Teams.</Text>
        <Pressable accessibilityRole="button" onPress={() => { onClose(); router.push("/settings/premium"); }} style={{ minHeight: 48, backgroundColor: colors.accent, borderRadius: 12, padding: 16 }}>
          <Text style={{ color: colors.background, fontFamily: fonts.sansSemiBold }}>View membership and benefits</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} style={{ minHeight: 48, justifyContent: "center", alignItems: "center" }}><Text style={{ color: colors.ink, fontSize: 16 }}>Close</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
