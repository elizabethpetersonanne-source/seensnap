/**
 * Oct-18 UI/UX rebuild: Premium paywall sheet.
 *
 * Spec image 7 (step 3). Shown when a Free user taps a Premium-gated
 * surface. Clear value proposition, monthly / yearly toggle, Start
 * Premium / Maybe later actions.
 *
 * Oct-18 brief rule: NO fake payments. The current beta grants
 * Premium to everyone server-side, so the Start button opens a toast
 * noting that purchase verification isn't live yet rather than
 * pretending to process a transaction.
 */
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { trackEvent } from "@/lib/analytics";


type Plan = "monthly" | "yearly";

const FEATURES: { icon: keyof typeof import("@expo/vector-icons").Ionicons.glyphMap; title: string; body: string }[] = [
  { icon: "finger-print", title: "Full SceneDNA Analysis", body: "See all your genre, theme and mood signals." },
  { icon: "trending-up", title: "Your Evolving Taste", body: "Track how your taste changes over time." },
  { icon: "star-outline", title: "Personalized Collections", body: "AI-curated lists just for you." },
  { icon: "people-outline", title: "Advanced Team Matching", body: "Find the perfect picks for your watch team." },
  { icon: "aperture-outline", title: "Higher Snip Allowance", body: "More snips per day (when available)." },
  { icon: "close-circle-outline", title: "Ad-Free Experience", body: "A cleaner, more immersive SeenSnap." },
];


export function PremiumPaywallSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<Plan>("monthly");
  const [notice, setNotice] = useState<string | null>(null);

  function handleStart() {
    trackEvent("premium_paywall_start_clicked", { plan });
    // Oct-18 brief: no fake payments. During beta the Premium grant is
    // server-side; purchases will be wired when IAP is configured.
    setNotice(
      "SeenSnap Premium is active for every beta user — no purchase needed right now. In-app purchases will go live once App Store Connect is configured.",
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="close" size={22} color={colors.muted} />
        </Pressable>

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.crown}>
            <Ionicons name="trophy" size={22} color={colors.accent} />
            <Text style={styles.crownLabel}>SeenSnap Premium</Text>
          </View>

          <Text style={styles.headline}>Go deeper into your taste.</Text>
          <Text style={styles.lead}>
            Unlock the full power of SceneDNA and get more from SeenSnap.
          </Text>

          <View style={styles.featureList}>
            {FEATURES.map((f, i) => (
              <View key={i} style={styles.featureRow}>
                <Ionicons name={f.icon} size={20} color={colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.featureTitle}>{f.title}</Text>
                  <Text style={styles.featureBody}>{f.body}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.planRow}>
            <Pressable
              onPress={() => setPlan("monthly")}
              style={[styles.planCard, plan === "monthly" && styles.planCardActive]}
            >
              <View style={[styles.planDot, plan === "monthly" && styles.planDotActive]} />
              <Text style={styles.planPrice}>$6.99<Text style={styles.planUnit}> / month</Text></Text>
              <Text style={styles.planSub}>Cancel anytime</Text>
            </Pressable>
            <Pressable
              onPress={() => setPlan("yearly")}
              style={[styles.planCard, plan === "yearly" && styles.planCardActive]}
            >
              <View style={[styles.planDot, plan === "yearly" && styles.planDotActive]} />
              <Text style={styles.planPrice}>$49.99<Text style={styles.planUnit}> / year</Text></Text>
              <Text style={styles.planSub}>2 months free</Text>
            </Pressable>
          </View>

          <Pressable style={styles.startBtn} onPress={handleStart}>
            <Text style={styles.startBtnLabel}>START PREMIUM</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.maybeLaterLabel}>Maybe later</Text>
          </Pressable>

          {notice ? (
            <View style={styles.notice}>
              <Ionicons name="information-circle-outline" size={16} color={colors.accent} />
              <Text style={styles.noticeBody}>{notice}</Text>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  closeBtn: {
    position: "absolute",
    top: spacing.md,
    right: spacing.md,
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  body: {
    padding: spacing.lg,
    paddingTop: spacing.xl + spacing.md,
    paddingBottom: spacing.xl,
    gap: 12,
  },
  crown: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  crownLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.accent,
    fontSize: 13,
    letterSpacing: 0.4,
  },
  headline: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.3,
    marginTop: 4,
  },
  lead: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  featureList: {
    marginTop: spacing.md,
    gap: spacing.md,
  },
  featureRow: {
    flexDirection: "row",
    gap: 12,
  },
  featureTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
  },
  featureBody: {
    marginTop: 2,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  planRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: spacing.md,
  },
  planCard: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
    backgroundColor: colors.surface,
  },
  planCardActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(255,230,0,0.08)",
  },
  planDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
    marginBottom: 8,
  },
  planDotActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  planPrice: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 20,
  },
  planUnit: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
  },
  planSub: {
    marginTop: 2,
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  startBtn: {
    marginTop: spacing.md,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: colors.accent,
    alignItems: "center",
  },
  startBtnLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    fontSize: 13,
    letterSpacing: 0.6,
  },
  maybeLaterLabel: {
    textAlign: "center",
    marginTop: 8,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
  },
  notice: {
    marginTop: spacing.md,
    flexDirection: "row",
    gap: 8,
    padding: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: "rgba(255,230,0,0.08)",
  },
  noticeBody: {
    flex: 1,
    fontFamily: fonts.sans,
    color: colors.ink,
    fontSize: 12,
    lineHeight: 16,
  },
});
