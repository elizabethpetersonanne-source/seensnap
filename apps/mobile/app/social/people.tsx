/**
 * People discovery screen — People Discovery spec §6.2.
 *
 * Browse-first: sections load first, search is available but not the
 * only entry. Sections with zero candidates simply don't render (spec
 * §5 "don't render five empty headings").
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import {
  dismissPerson,
  fetchAllPeopleSections,
  followPerson,
  PeopleSection,
  PersonCandidate,
  unfollowPerson,
} from "@/lib/people-discovery";

type UserSearchResult = {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
};

export default function PeopleScreen() {
  const { sessionToken } = useAuth();
  const [sections, setSections] = useState<PeopleSection[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // Follow state overlay so tapping Follow updates immediately across
  // sections without a full refetch. user_id → true (following) / false
  // (explicit unfollow) / undefined (use server state).
  const [followingOverride, setFollowingOverride] = useState<Record<string, boolean>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!sessionToken) return;
    try {
      setError(null);
      const s = await fetchAllPeopleSections(sessionToken);
      setSections(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load suggestions");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionToken]);

  useFocusEffect(
    useCallback(() => {
      trackEvent("social_people_opened", { source: "direct" });
      void load();
    }, [load]),
  );

  const runSearch = useCallback(
    async (q: string) => {
      if (!sessionToken) return;
      const normalized = q.trim().replace(/^@/, "");
      if (normalized.length < 2) {
        setSearchResults([]);
        return;
      }
      setSearching(true);
      try {
        const rows = await apiRequest<UserSearchResult[]>(
          `/social/users/search?q=${encodeURIComponent(normalized)}`,
          { token: sessionToken },
        );
        setSearchResults(rows ?? []);
        trackEvent("people_search_submitted", {
          normalized_query_length: normalized.length,
          result_count: rows?.length ?? 0,
        });
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [sessionToken],
  );

  async function handleFollowToggle(candidate: PersonCandidate) {
    if (!sessionToken) return;
    const currentlyFollowing = followingOverride[candidate.user_id] === true;
    // Optimistic
    setFollowingOverride((prev) => ({
      ...prev,
      [candidate.user_id]: !currentlyFollowing,
    }));
    try {
      if (currentlyFollowing) {
        await unfollowPerson(sessionToken, candidate.user_id);
        trackEvent("person_unfollowed", {
          candidate_id: candidate.user_id,
          source: "people_screen",
        });
      } else {
        await followPerson(sessionToken, candidate.user_id);
        trackEvent("person_followed", {
          candidate_id: candidate.user_id,
          source: "people_screen",
          reason_code: candidate.reason.code,
        });
      }
    } catch (e) {
      // Rollback
      setFollowingOverride((prev) => ({
        ...prev,
        [candidate.user_id]: currentlyFollowing,
      }));
      setError(e instanceof Error ? e.message : "Couldn't update follow");
    }
  }

  async function handleDismiss(candidate: PersonCandidate) {
    if (!sessionToken) return;
    setDismissed((prev) => new Set(prev).add(candidate.user_id));
    trackEvent("person_suggestion_dismissed", {
      candidate_id: candidate.user_id,
      reason_code: candidate.reason.code,
    });
    try {
      await dismissPerson(sessionToken, candidate.user_id);
    } catch {
      // Silent — the local dismissed set still hides them for the session
    }
  }

  const showingSearch = query.trim().length >= 2;

  const filteredSections = useMemo(
    () =>
      (sections ?? []).map((s) => ({
        ...s,
        items: s.items.filter((c) => !dismissed.has(c.user_id)),
      })).filter((s) => s.items.length > 0),
    [sections, dismissed],
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>People</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.muted} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={(v) => {
            setQuery(v);
            void runSearch(v);
          }}
          placeholder="Search by name or @username"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable
            onPress={() => {
              setQuery("");
              setSearchResults([]);
            }}
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={16} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.accent}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
        >
          {error ? <Text style={styles.error}>{error}</Text> : null}

          {showingSearch ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Search results</Text>
              {searching ? (
                <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
              ) : searchResults.length === 0 ? (
                <Text style={styles.emptyBody}>No people found.</Text>
              ) : (
                searchResults.map((u) => (
                  <PersonRow
                    key={u.user_id}
                    candidate={{
                      user_id: u.user_id,
                      display_name: u.display_name,
                      username: u.username,
                      avatar_url: u.avatar_url,
                      bio: u.bio,
                      reason: { code: "search_result", label: "Matches your search" },
                      mutuals: [],
                    }}
                    following={Boolean(followingOverride[u.user_id])}
                    onFollow={() =>
                      void handleFollowToggle({
                        user_id: u.user_id,
                        display_name: u.display_name,
                        username: u.username,
                        avatar_url: u.avatar_url,
                        bio: u.bio,
                        reason: { code: "search_result", label: "" },
                        mutuals: [],
                      })
                    }
                    onOpen={() => router.push(`/profile/${u.user_id}`)}
                    onDismiss={null}
                  />
                ))
              )}
            </View>
          ) : filteredSections.length === 0 ? (
            <View style={styles.centerState}>
              <View style={styles.emptyIcon}>
                <Ionicons name="people-outline" size={38} color={colors.accent} />
              </View>
              <Text style={styles.emptyTitle}>Follow a few people to shape your Social feed.</Text>
              <Text style={styles.emptyBody}>
                Suggestions will appear here as taste + Watch Team overlap grows.
              </Text>
            </View>
          ) : (
            filteredSections.map((section) => (
              <View key={section.id} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.items.map((c) => (
                  <PersonRow
                    key={c.user_id}
                    candidate={c}
                    following={Boolean(followingOverride[c.user_id])}
                    onFollow={() => void handleFollowToggle(c)}
                    onOpen={() => {
                      trackEvent("person_profile_opened", {
                        candidate_id: c.user_id,
                        source: "people_screen",
                        section: section.id,
                      });
                      router.push(`/profile/${c.user_id}`);
                    }}
                    onDismiss={() => handleDismiss(c)}
                  />
                ))}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────

function PersonRow({
  candidate,
  following,
  onFollow,
  onOpen,
  onDismiss,
}: {
  candidate: PersonCandidate;
  following: boolean;
  onFollow: () => void;
  onOpen: () => void;
  onDismiss: (() => void) | null;
}) {
  const display = candidate.display_name ?? candidate.username ?? "SeenSnap user";
  return (
    <Pressable style={styles.row} onPress={onOpen}>
      <Avatar uri={candidate.avatar_url} label={display} size={48} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName} numberOfLines={1}>
          {display}
        </Text>
        {candidate.username ? (
          <Text style={styles.rowHandle} numberOfLines={1}>@{candidate.username}</Text>
        ) : null}
        {candidate.reason.label ? (
          <Text style={styles.rowReason} numberOfLines={1}>{candidate.reason.label}</Text>
        ) : null}
      </View>
      <View style={styles.rowActions}>
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            onFollow();
          }}
          accessibilityRole="button"
          accessibilityLabel={following ? `Unfollow ${display}` : `Follow ${display}`}
          accessibilityState={{ selected: following }}
          style={({ pressed }) => [
            styles.followBtn,
            following && styles.followBtnActive,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={[styles.followBtnText, following && styles.followBtnTextActive]}>
            {following ? "Following" : "Follow"}
          </Text>
        </Pressable>
        {onDismiss ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Not interested in ${display}`}
          >
            <Ionicons name="close" size={16} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerTitle: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 22 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: spacing.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surfaceSoft,
    marginBottom: spacing.md,
  },
  searchInput: {
    flex: 1,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  centerState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  emptyIcon: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 18,
    textAlign: "center",
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  section: {
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.accent,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: radii.sm,
  },
  rowName: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
  },
  rowHandle: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 1,
  },
  rowReason: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 3,
    letterSpacing: 0.3,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  followBtn: {
    minHeight: 32,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  followBtnActive: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: rules.default,
  },
  followBtnText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.background,
    textTransform: "uppercase",
  },
  followBtnTextActive: {
    color: colors.muted,
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
});
