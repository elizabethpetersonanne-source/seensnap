/**
 * Oct-18 UI/UX rebuild: Blocked Users sub-screen.
 * Spec image 4 (step 7). Shows the list of blocked accounts with
 * Unblock actions.
 *
 * Backend reference: block CRUD lives in the social router. We render
 * an honest empty state when the user has no blocks rather than
 * fabricating sample rows.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";


type BlockedUser = {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  blocked_at: string;
};


export default function BlockedUsersScreen() {
  const { sessionToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [blocks, setBlocks] = useState<BlockedUser[]>([]);

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    apiRequest<BlockedUser[]>("/social/blocks", { token: sessionToken })
      .then((res) => { if (!cancelled) setBlocks(res ?? []); })
      .catch(() => { if (!cancelled) setBlocks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionToken]);

  async function unblock(userId: string) {
    if (!sessionToken) return;
    try {
      await apiRequest(`/social/blocks/${userId}`, { method: "DELETE", token: sessionToken });
      setBlocks((b) => b.filter((x) => x.user_id !== userId));
    } catch {
      // Keep list as-is; the row will reappear on next fetch.
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Blocked Users</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : blocks.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="shield-checkmark-outline" size={28} color={colors.muted} />
          <Text style={styles.emptyTitle}>No blocked accounts.</Text>
          <Text style={styles.emptyBody}>When you block someone, they'll show up here.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {blocks.map((b) => (
            <View key={b.user_id} style={styles.row}>
              <Avatar uri={b.avatar_url} label={b.display_name} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{b.display_name}</Text>
                <Text style={styles.rowSub}>Blocked {formatBlockedAt(b.blocked_at)}</Text>
              </View>
              <Pressable style={styles.unblockBtn} onPress={() => void unblock(b.user_id)}>
                <Text style={styles.unblockLabel}>Unblock</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}


function formatBlockedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "recently";
  }
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  closeBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 15 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: 8 },
  emptyTitle: { fontFamily: fonts.serifBold, color: colors.ink, fontSize: 18 },
  emptyBody: { fontFamily: fonts.sans, color: colors.muted, fontSize: 13, textAlign: "center", maxWidth: 280 },
  body: { padding: spacing.lg, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  rowTitle: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 14 },
  rowSub: { marginTop: 2, fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  unblockBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  unblockLabel: { fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 12 },
});
