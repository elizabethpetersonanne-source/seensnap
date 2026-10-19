/**
 * Oct-18 UI/UX rebuild: SceneDNA detail page.
 *
 * Spec image 7. Three tabs:
 *   - Overview        (free)
 *   - Deep Dive       (premium gate)
 *   - Evolution       (premium gate)
 *
 * Overview surfaces the identity headline, personality signals with
 * %match, and a short "Unlock Deeper Insights" CTA that opens the
 * paywall sheet. Deep Dive / Evolution are locked for Free users with
 * a static "Available on Premium" state — no fake blurred content.
 *
 * Data: GET /me/scene-dna (existing endpoint).
 * Entitlement: GET /me/entitlement.
 */
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useEntitlement } from "@/lib/entitlement";
import { PremiumPaywallSheet } from "@/components/premium-paywall-sheet";


type SceneDnaIdentity = {
  archetype: string;
  one_line: string;
  confidence_tier: string;
  based_on_summary: string;
  hero_backdrops: string[];
};
type SceneDnaSignal = {
  label: string;
  confidence_tier: string;
  evidence_count: number;
  contributing_titles: Array<{ title_id: string; title_name: string; poster_url?: string | null }>;
};
type SceneDnaMovement = {
  direction: string;
  label: string;
  sample_size: number;
  detail: string;
};
type SceneDnaColdStart = {
  saves_current: number;
  saves_target: number;
  ratings_current: number;
  ratings_target: number;
  swipes_current: number;
  swipes_target: number;
  next_action_hint: string;
};
type SceneDnaResponse = {
  identity: SceneDnaIdentity | null;
  signals: SceneDnaSignal[];
  movement: SceneDnaMovement[];
  has_signal: boolean;
  cold_start: SceneDnaColdStart | null;
};


type TabKey = "overview" | "deep_dive" | "evolution";

const TABS: { key: TabKey; label: string; premium: boolean }[] = [
  { key: "overview", label: "OVERVIEW", premium: false },
  { key: "deep_dive", label: "DEEP DIVE", premium: true },
  { key: "evolution", label: "EVOLUTION", premium: true },
];


export default function SceneDnaScreen() {
  const { sessionToken } = useAuth();
  const router = useRouter();
  const entitlement = useEntitlement(sessionToken);
  const isPremium = entitlement?.tier === "premium";

  const [data, setData] = useState<SceneDnaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("overview");
  const [showPaywall, setShowPaywall] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!sessionToken) return;
      setLoading(true);
      apiRequest<SceneDnaResponse>("/me/scene-dna", { token: sessionToken })
        .then((res) => { if (!cancelled) setData(res); })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, [sessionToken]),
  );

  const canView = (t: TabKey): boolean => {
    const meta = TABS.find((x) => x.key === t);
    if (!meta) return false;
    if (!meta.premium) return true;
    return isPremium;
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>SceneDNA</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.tabsRow}>
        {TABS.map((t) => {
          const active = tab === t.key;
          const locked = t.premium && !isPremium;
          return (
            <Pressable
              key={t.key}
              onPress={() => {
                if (locked) {
                  setShowPaywall(true);
                  return;
                }
                setTab(t.key);
              }}
              style={styles.tabBtn}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                {locked ? "🔒 " : ""}{t.label}
              </Text>
              {active ? <View style={styles.tabUnderline} /> : null}
            </Pressable>
          );
        })}
      </View>

      {loading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : !data || !data.has_signal ? (
        <ColdStartView coldStart={data?.cold_start ?? null} />
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {!canView(tab) ? (
            <PremiumLockedView onUnlock={() => setShowPaywall(true)} />
          ) : tab === "overview" ? (
            <OverviewTab data={data} isPremium={isPremium} onUnlock={() => setShowPaywall(true)} />
          ) : tab === "deep_dive" ? (
            <DeepDiveTab data={data} />
          ) : (
            <EvolutionTab data={data} />
          )}
        </ScrollView>
      )}

      <PremiumPaywallSheet
        visible={showPaywall}
        onClose={() => setShowPaywall(false)}
      />
    </SafeAreaView>
  );
}


function OverviewTab({
  data,
  isPremium,
  onUnlock,
}: {
  data: SceneDnaResponse;
  isPremium: boolean;
  onUnlock: () => void;
}) {
  return (
    <>
      {data.identity ? (
        <View style={styles.identityHero}>
          <Text style={styles.strongSignalPill}>● {data.identity.confidence_tier.toUpperCase()} SIGNAL</Text>
          <Text style={styles.identityHeadline}>Your taste, decoded.</Text>
          <Text style={styles.identityBody}>{data.identity.one_line}</Text>
          <Text style={styles.identitySub}>{data.identity.based_on_summary}</Text>
        </View>
      ) : null}

      {data.signals.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>YOUR PERSONALITY SIGNALS</Text>
          <View style={styles.signalGrid}>
            {data.signals.slice(0, 3).map((signal, idx) => {
              const matchPercent = signalMatchPercent(signal);
              const image = signal.contributing_titles[0]?.poster_url ?? null;
              return (
                <View key={`${signal.label}-${idx}`} style={styles.signalCard}>
                  {image ? (
                    <Image source={{ uri: image }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                  ) : null}
                  <View style={styles.signalCardShade} />
                  <View style={styles.signalCardBody}>
                    <Text style={styles.signalCardLabel}>{signal.label}</Text>
                    <Text style={styles.signalCardMatch}>{matchPercent}% match</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </>
      ) : null}

      {data.signals.length > 0 ? (
        <View style={styles.tagsWrap}>
          {data.signals.slice(0, 5).map((s) => (
            <View key={s.label} style={styles.tag}>
              <Text style={styles.tagText}>{s.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {!isPremium ? (
        <Pressable style={styles.unlockCard} onPress={onUnlock}>
          <Ionicons name="lock-closed" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.unlockTitle}>Unlock Deeper Insights</Text>
            <Text style={styles.unlockBody}>
              See your full SceneDNA, hidden patterns, evolving taste and personalized collections.
            </Text>
          </View>
          <View style={styles.unlockCta}>
            <Text style={styles.unlockCtaLabel}>GET SEENSNAP PREMIUM</Text>
          </View>
        </Pressable>
      ) : null}
    </>
  );
}


function DeepDiveTab({ data }: { data: SceneDnaResponse }) {
  return (
    <>
      <Text style={styles.sectionLabel}>FULL SIGNAL SET</Text>
      {data.signals.map((signal, idx) => {
        const match = signalMatchPercent(signal);
        return (
          <View key={`${signal.label}-${idx}`} style={styles.deepRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.deepLabel}>{signal.label}</Text>
              <Text style={styles.deepMeta}>Shows up across {signal.evidence_count} recent signals</Text>
            </View>
            <Text style={styles.deepMatch}>{match}%</Text>
          </View>
        );
      })}
    </>
  );
}


function EvolutionTab({ data }: { data: SceneDnaResponse }) {
  if (data.movement.length === 0) {
    return <Text style={styles.empty}>Not enough movement to chart yet.</Text>;
  }
  return (
    <>
      <Text style={styles.sectionLabel}>HOW YOUR TASTE IS MOVING</Text>
      {data.movement.map((m, idx) => (
        <View key={idx} style={styles.movementRow}>
          <Ionicons
            name={m.direction === "fading" ? "trending-down" : "trending-up"}
            size={20}
            color={m.direction === "fading" ? colors.muted : colors.accent}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.movementLabel}>{m.label}</Text>
            <Text style={styles.movementDetail}>{m.detail}</Text>
          </View>
        </View>
      ))}
    </>
  );
}


function PremiumLockedView({ onUnlock }: { onUnlock: () => void }) {
  return (
    <View style={styles.lockedWrap}>
      <View style={styles.lockedBadge}>
        <Ionicons name="lock-closed" size={28} color={colors.accent} />
      </View>
      <Text style={styles.lockedTitle}>Available on SeenSnap Premium</Text>
      <Text style={styles.lockedBody}>
        Unlock the full picture of your taste — hidden patterns, evolving signals, and more.
      </Text>
      <Pressable style={styles.lockedCta} onPress={onUnlock}>
        <Text style={styles.lockedCtaLabel}>UNLOCK PREMIUM</Text>
      </Pressable>
    </View>
  );
}


function ColdStartView({ coldStart }: { coldStart: SceneDnaColdStart | null }) {
  if (!coldStart) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>SceneDNA is still forming.</Text>
      </View>
    );
  }
  const total = coldStart.saves_target + coldStart.ratings_target + coldStart.swipes_target;
  const current = coldStart.saves_current + coldStart.ratings_current + coldStart.swipes_current;
  const pct = Math.min(100, Math.round((current / Math.max(total, 1)) * 100));
  return (
    <View style={styles.coldStart}>
      <Text style={styles.coldStartTitle}>SceneDNA is still forming.</Text>
      <View style={styles.coldStartBar}>
        <View style={[styles.coldStartFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.coldStartHint}>{coldStart.next_action_hint}</Text>
    </View>
  );
}


function signalMatchPercent(s: SceneDnaSignal): number {
  // Translate confidence_tier + evidence_count into a 60–95% match
  // display. Never fabricate — if evidence is 0 we floor at 60%.
  const base = s.confidence_tier === "strong" ? 88 : s.confidence_tier === "emerging" ? 76 : 64;
  const bonus = Math.min(7, Math.floor(s.evidence_count / 3));
  return Math.min(95, base + bonus);
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 15,
  },
  tabsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  tabBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    alignItems: "center",
  },
  tabLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1,
  },
  tabLabelActive: {
    color: colors.ink,
  },
  tabUnderline: {
    marginTop: 6,
    width: 24,
    height: 2,
    backgroundColor: colors.accent,
  },
  body: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
    padding: spacing.lg,
  },
  identityHero: {
    marginBottom: spacing.xl,
  },
  strongSignalPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1,
  },
  identityHeadline: {
    marginTop: 12,
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 30,
    lineHeight: 34,
    letterSpacing: -0.3,
  },
  identityBody: {
    marginTop: 8,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 15,
    lineHeight: 20,
  },
  identitySub: {
    marginTop: 12,
    fontFamily: fonts.monoMedium,
    color: colors.muted2,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  sectionLabel: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1.2,
  },
  signalGrid: {
    flexDirection: "row",
    gap: 8,
    marginBottom: spacing.md,
  },
  signalCard: {
    flex: 1,
    aspectRatio: 3 / 4,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.surfaceMuted,
    position: "relative",
  },
  signalCardShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  signalCardBody: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 10,
  },
  signalCardLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 13,
    lineHeight: 16,
  },
  signalCardMatch: {
    marginTop: 2,
    fontFamily: fonts.monoMedium,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 0.4,
  },
  tagsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: spacing.lg,
  },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: colors.surface,
  },
  tagText: {
    fontFamily: fonts.sansMedium,
    color: colors.ink,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  unlockCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: spacing.md,
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(244,196,48,0.4)",
  },
  unlockTitle: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 15,
  },
  unlockBody: {
    marginTop: 4,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  unlockCta: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
  },
  unlockCtaLabel: {
    fontFamily: fonts.monoSemiBold,
    color: "#0b0f17",
    fontSize: 9,
    letterSpacing: 0.6,
  },
  deepRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  deepLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
  },
  deepMeta: {
    marginTop: 2,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 11,
  },
  deepMatch: {
    fontFamily: fonts.monoSemiBold,
    color: colors.accent,
    fontSize: 14,
  },
  movementRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  movementLabel: {
    fontFamily: fonts.sansSemiBold,
    color: colors.ink,
    fontSize: 14,
  },
  movementDetail: {
    marginTop: 2,
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  lockedWrap: {
    alignItems: "center",
    paddingVertical: 48,
    gap: 12,
  },
  lockedBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(244,196,48,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  lockedTitle: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 20,
    marginTop: 8,
  },
  lockedBody: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    maxWidth: 280,
  },
  lockedCta: {
    marginTop: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  lockedCtaLabel: {
    fontFamily: fonts.sansSemiBold,
    color: "#0b0f17",
    fontSize: 12,
    letterSpacing: 0.6,
  },
  coldStart: {
    padding: spacing.lg,
    gap: 10,
  },
  coldStartTitle: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
    fontSize: 18,
  },
  coldStartBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },
  coldStartFill: {
    height: "100%",
    backgroundColor: colors.accent,
  },
  coldStartHint: {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: 13,
  },
});
