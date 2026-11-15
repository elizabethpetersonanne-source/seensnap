import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { colors, fonts } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/api";
import { fetchEntitlement, type EntitlementResponse } from "@/lib/entitlement";
import { membershipChanged } from "@/lib/membership-events";
import { nativePurchasesAvailable, storePackages, buyPackage, restoreStorePurchases, type StorePackage } from "@/lib/purchases";

type BillingConfig = { available: boolean; purchases_enabled: boolean; purchase_allowed: boolean; product_ids: string[]; sandbox_tester: boolean };
export default function PremiumSettings() {
  const { sessionToken, user } = useAuth();
  const [membership, setMembership] = useState<EntitlementResponse | null>(null);
  const [billing, setBilling] = useState<BillingConfig | null>(null);
  const [packages, setPackages] = useState<StorePackage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const operation = useRef(false);
  const reads = useRef(0);
  const currentAccount = useRef(sessionToken);
  currentAccount.current = sessionToken;
  useFocusEffect(useCallback(() => {
    let active = true;
    setMembership(null); setBilling(null); setPackages([]); setError(null); setNotice(null); setBusy(operation.current); setVerificationPending(false);
    async function load() {
      const generation = ++reads.current;
      const valid = () => active && currentAccount.current === sessionToken && reads.current === generation;
      if (!sessionToken || !user) return;
      try {
        const ent = await fetchEntitlement(sessionToken);
        if (!valid()) return;
        setMembership(ent);
        // Old web deployments still work before the billing API is deployed.
        if (!nativePurchasesAvailable) return;
        const config = await apiRequest<BillingConfig>("/billing/config", { token: sessionToken });
        if (!valid()) return;
        setBilling(config);
        if (config.available && ent.sources.includes("purchase")) {
          const fresh = await apiRequest<EntitlementResponse>("/billing/sync", { method: "POST", token: sessionToken, timeoutMs: 20000 });
          if (!valid()) return;
          setMembership(fresh); membershipChanged();
          config.purchase_allowed = config.purchases_enabled && fresh.tier === "free";
          setBilling({ ...config });
        }
        if (config.purchase_allowed) {
          const options = await storePackages(user.user_id, config.product_ids);
          if (valid()) setPackages(options);
        }
      } catch { if (valid()) setError("Couldn't refresh membership or purchase options. Please retry."); }
    }
    void load();
    const subscription = AppState.addEventListener("change", state => { if (state === "active" && !operation.current) void load(); });
    return () => { active = false; subscription.remove(); };
  }, [sessionToken, user?.user_id, reload]));

  async function transact(pack?: StorePackage) {
    if (!sessionToken || !user || operation.current || !billing?.available) return;
    reads.current++;
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    const token = sessionToken;
    const valid = () => currentAccount.current === token;
    try {
      if (pack) {
        await buyPackage(user.user_id, pack);
        if (valid()) setVerificationPending(true);
      }
      else await restoreStorePurchases(user.user_id);
      if (!valid()) return;
      const verified = await apiRequest<EntitlementResponse>("/billing/sync", { method: "POST", token, timeoutMs: 20000 });
      if (!valid()) return;
      setMembership(verified); membershipChanged();
      if (verified.sources.includes("purchase")) setVerificationPending(false);
      setBilling(value => value ? { ...value, purchase_allowed: value.purchases_enabled && verified.tier === "free" } : value);
      setNotice(verified.sources.includes("purchase") ? "Your App Store subscription is verified." : pack
        ? "Apple has finished the purchase step. Verification is still pending. Use Restore purchases to check again; don't purchase again."
        : "No active App Store subscription was found for this account.");
    } catch (err) {
      if (!valid()) return;
      const purchaseError = err as { userCancelled?: boolean; code?: string };
      if (purchaseError.code === "20") setVerificationPending(true);
      if (!purchaseError.userCancelled) setError(purchaseError.code === "20"
        ? "Your purchase is awaiting approval. Premium will update after Apple confirms it."
        : "We couldn't verify the purchase or restore. If Apple confirmed payment, use Restore purchases to check again before trying another purchase.");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  const purchased = membership?.sources.includes("purchase");
  const text = { color: colors.ink, fontFamily: fonts.sans, fontSize: 16, lineHeight: 24 };
  const link = (label: string, url: string) => <Pressable key={label} accessibilityRole="link" style={{ minHeight: 48, justifyContent: "center" }} onPress={() => void Linking.openURL(url).catch(() => setError("Couldn't open that page. Please try again."))}><Text style={{ ...text, color: colors.accent }}>{label}</Text></Pressable>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
    <AppHeader variant="detail" leftKind="back" title="SeenSnap Premium" ownsSafeArea={false} />
    <ScrollView contentContainerStyle={{ width: "100%", maxWidth: 640, alignSelf: "center", padding: 24, gap: 20, paddingBottom: 48 }}>
      {!membership && !error ? <ActivityIndicator color={colors.accent} /> : null}
      {error ? <View><Text accessibilityRole="alert" style={text}>{error}</Text><Pressable accessibilityRole="button" disabled={busy} onPress={() => setReload(n => n + 1)} style={{ minHeight: 48, justifyContent: "center" }}><Text style={{ ...text, color: colors.accent }}>Retry membership</Text></Pressable></View> : null}
      {notice ? <Text accessibilityRole="alert" style={text}>{notice}</Text> : null}
      {membership ? <>
        <Text style={{ ...text, fontFamily: fonts.serifBold, fontSize: 28, lineHeight: 34 }}>{membership.tier === "premium" ? "Premium is active" : "Your membership"}</Text>
        <Text style={text}>{membership.is_beta ? "Premium is included during beta. No payment, trial renewal or cancellation is required for your beta access." : membership.tier === "premium" ? "Your Premium access is confirmed." : "You are on the Free plan."}</Text>
        <Text style={{ ...text, color: colors.accent }}>With SeenSnap Premium</Text>
        <Text style={text}>Use SeenSnap Concierge without the Free plan's monthly request allowance. Service usage limits still apply.</Text>
        <Text style={text}>Your personal recommendations, ratings, SceneDNA and Watch Teams remain part of SeenSnap.</Text>
        {billing?.purchase_allowed ? <View style={{ gap: 16 }}>
          {packages.length === 0 ? <Text style={text}>Subscription options are temporarily unavailable. Please retry.</Text> : packages.map(pack => <Pressable key={pack.identifier} accessibilityRole="button" disabled={busy || verificationPending} onPress={() => void transact(pack)} style={{ minHeight: 64, padding: 16, borderRadius: 12, backgroundColor: colors.accent, opacity: busy || verificationPending ? 0.6 : 1 }}>
            <Text style={{ ...text, color: colors.background, fontFamily: fonts.sansSemiBold }}>{pack.product.subscriptionPeriod === "P1Y" ? "Annual" : "Monthly"} Premium</Text>
            <Text style={{ ...text, color: colors.background }}>{pack.product.priceString} / {pack.product.subscriptionPeriod === "P1Y" ? "year" : "month"}</Text>
          </Pressable>)}
          <Text style={text}>Payment is charged to your Apple Account when you confirm. Subscriptions renew automatically unless canceled at least 24 hours before the current period ends. Manage or cancel in Apple Settings.</Text>
          {billing.sandbox_tester ? <Text style={text}>This account is configured for billing tests. TestFlight purchases use Apple's sandbox.</Text> : null}
        </View> : null}
        {nativePurchasesAvailable && billing?.available ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void transact()} style={{ minHeight: 48, justifyContent: "center" }}><Text style={{ ...text, color: colors.accent }}>{busy ? "Checking with Apple…" : "Restore purchases"}</Text></Pressable> : null}
        <Text style={{ ...text, fontFamily: fonts.sansSemiBold }}>Membership management</Text>
        <Text style={text}>{membership.expires_at ? `Access through ${new Date(membership.expires_at).toLocaleDateString()}.` : membership.tier === "premium" ? "No scheduled expiry." : "No active Premium subscription."}</Text>
        {purchased || billing?.available ? link("Manage App Store subscription", "https://apps.apple.com/account/subscriptions") : membership.is_beta ? <Text style={text}>Your complimentary beta access does not create a paid subscription.</Text> : !billing?.available ? <Text style={text}>Paid upgrades are not available in this build.</Text> : null}
        {link("Terms of Service", process.env.EXPO_PUBLIC_TERMS_URL || "https://seensnap.app/terms")}
        {link("Privacy Policy", process.env.EXPO_PUBLIC_PRIVACY_URL || "https://seensnap.app/privacy")}
      </> : null}
    </ScrollView>
  </SafeAreaView>;
}
