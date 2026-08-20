import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/components/avatar";
import { RatingCircle, RatingPicker } from "@/components/rating";
import { SSMotionBackdrop } from "@/components/ss-motion-backdrop";
import { SeenSnapHeader } from "@/components/headers/seensnap-header";
import { useCyclingBackdrop, useFallbackBackdrop } from "@/lib/backdrop-pool";
import { relativeTime as sharedRelativeTime } from "@/lib/format";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest, resolveMediaUrl, resolvedApiBaseUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";
import {
  fetchNotifications,
  getNotificationPermissionStatus,
  registerPushToken,
  requestNotificationPermission,
} from "@/lib/notifications";

type TeamTab = "titles" | "feed" | "members" | "top10";
type TitleSort = "recent" | "ranked" | "discussed" | "alpha";
type ReactionKey = "fire" | "heart" | "thumbsDown" | "tomato";

type TeamSummary = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  visibility: string;
  icon?: string | null;
  cover_image?: string | null;
  owner_user_id: string;
  invite_code: string;
  max_members: number;
  member_count: number;
  last_activity_at?: string | null;
  latest_activity?: string | null;
  recent_member_avatars: string[];
  // Watch Teams overhaul (brief §6, §8): drives the inbox-of-momentum row.
  unread_activity_count?: number;
  active_member_count_24h?: number;
  team_status?: "active" | "quiet" | "dormant";
  top10_updated_at?: string | null;
};

type TeamMember = {
  user_id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  role: string;
  status: string;
  joined_at: string;
};

type TeamResponse = TeamSummary & {
  members: TeamMember[];
};

type TeamUserSearchResult = {
  user_id: string;
  display_name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
};

type TeamActivity = {
  id: string;
  activity_type: string;
  actor_user_id: string;
  actor_display_name?: string | null;
  actor_avatar_url?: string | null;
  content_title_id?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

type TeamFeedComment = {
  id: string;
  author_id: string;
  author_name: string;
  author_avatar?: string | null;
  text: string;
  created_at: string;
};

type TeamFeedInteraction = {
  reactions: Record<ReactionKey, number>;
  viewerReaction: ReactionKey | null;
  comments: TeamFeedComment[];
  draft: string;
  expanded: boolean;
  // §7 density rule — comment input stays collapsed until viewer taps Comment.
  composerOpen: boolean;
};

type TeamTitle = {
  id: string;
  team_id: string;
  content_title_id: string;
  added_by_user_id: string;
  added_by_name?: string | null;
  note?: string | null;
  added_at: string;
  title_name: string;
  content_type: string;
  poster_url?: string | null;
  year?: number | null;
};

type TeamRanking = {
  id: string;
  team_id: string;
  content_title_id: string;
  rank: number;
  score: number;
  movement: string;
  weeks_on_list: number;
  title_name: string;
  poster_url?: string | null;
};

type TitleSearchResult = {
  id: string;
  title: string;
  content_type: string;
  poster_url?: string | null;
  release_date?: string | null;
};

export default function TeamsScreen() {
  const { sessionToken, user, isExpoGo } = useAuth();
  const [isFocused, setIsFocused] = useState(true);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<TeamResponse | null>(null);
  const [teamTab, setTeamTab] = useState<TeamTab>("feed");
  const [titleSort, setTitleSort] = useState<TitleSort>("recent");

  const [titles, setTitles] = useState<TeamTitle[]>([]);
  const [feed, setFeed] = useState<TeamActivity[]>([]);
  const [rankings, setRankings] = useState<TeamRanking[]>([]);

  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createIcon, setCreateIcon] = useState("🍿");
  const [joinCode, setJoinCode] = useState("");
  const [joinSearch, setJoinSearch] = useState("");
  const [joinSearchResults, setJoinSearchResults] = useState<TeamSummary[]>([]);

  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showAddTitle, setShowAddTitle] = useState(false);
  // Watch Teams brief §5 — single composer entry that expands into the three
  // participation actions. State drives an action-picker sheet.
  const [showComposerPicker, setShowComposerPicker] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [showEditTeam, setShowEditTeam] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);

  const [titleQuery, setTitleQuery] = useState("");
  const [titleResults, setTitleResults] = useState<TitleSearchResult[]>([]);
  const [selectedTitle, setSelectedTitle] = useState<TitleSearchResult | null>(null);
  const [titleNote, setTitleNote] = useState("");
  const [titleRank, setTitleRank] = useState("");
  const [alsoPost, setAlsoPost] = useState(true);

  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [editVisibility, setEditVisibility] = useState("private");
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<TeamUserSearchResult[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  const [postText, setPostText] = useState("");
  const [postRating, setPostRating] = useState<number | null>(null);
  const [postAttachedTitle, setPostAttachedTitle] = useState<TitleSearchResult | null>(null);

  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [feedInteractions, setFeedInteractions] = useState<Record<string, TeamFeedInteraction>>({});
  // Which post has its reaction tray expanded (Watch Teams brief §7 density rule
  // — full 4-reaction tray only appears on demand).
  const [openReactionTray, setOpenReactionTray] = useState<string | null>(null);

  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [showPushPrompt, setShowPushPrompt] = useState(false);

  const pulseAnim = useRef(new Animated.Value(1)).current;

  const selectedTeamSummary = useMemo(() => teams.find((team) => team.id === selectedTeamId) ?? null, [teams, selectedTeamId]);
  const myMembership = useMemo(
    () => selectedTeam?.members.find((member) => member.user_id === user?.user_id) ?? null,
    [selectedTeam, user?.user_id]
  );
  const canManageTeam = myMembership?.role === "owner" || myMembership?.role === "admin";
  const titleById = useMemo(() => Object.fromEntries(titles.map((entry) => [entry.content_title_id, entry])), [titles]);

  const detailBackdropUri = useMemo(() => {
    const coverUri = resolveMediaUrl(selectedTeam?.cover_image);
    if (coverUri) return coverUri;
    const firstPoster = titles[0]?.poster_url;
    return firstPoster ? resolveMediaUrl(firstPoster) : null;
  }, [selectedTeam, titles]);

  const teamDna = useMemo(() => {
    if (!selectedTeam) return [];
    const labels: string[] = [];
    if (feed.some((f) => f.activity_type === "ranking_updated")) labels.push("Ranking Obsessed");
    if (titles.length >= 8) labels.push("Deep Catalog");
    else if (titles.length >= 4) labels.push("Curated Picks");
    if (selectedTeam.member_count >= 5) labels.push("Full Squad");
    if (feed.filter((f) => f.activity_type === "team_post").length >= 3) labels.push("Active Discussion");
    if (feed.some((f) => typeof f.payload.rating === "number" && (f.payload.rating as number) >= 9)) labels.push("High Standards");
    return labels.length > 0 ? labels.slice(0, 3) : ["Just Getting Started"];
  }, [selectedTeam, feed, titles]);

  // Pulse feed — Watch Teams brief §7. Filters redundant event types out of
  // the primary stream so reactions/comments live under their parent post
  // (aggregated, not duplicated) and low-value system events (member added,
  // ownership transferred, metadata changed) are suppressed. Also groups
  // consecutive title_added events by the same actor within 10 minutes into
  // a single "added N titles" event so demo seed bursts don't spam the feed.
  const pulseFeed = useMemo(() => {
    const HIDDEN = new Set([
      "activity_reacted",
      "activity_commented",
      "team_created",
      "team_archived",
      "ownership_transferred",
      "member_added",
      "member_removed",
      "team_metadata_changed",
    ]);
    const filtered = feed.filter((f) => !HIDDEN.has(f.activity_type));
    // Burst grouping — collapse a run of same-actor title_added events.
    const BURST_WINDOW_MS = 10 * 60 * 1000;
    const grouped: (TeamActivity & { _burst?: TeamActivity[] })[] = [];
    for (const item of filtered) {
      const prev = grouped[grouped.length - 1];
      if (
        prev &&
        prev.activity_type === "title_added" &&
        item.activity_type === "title_added" &&
        prev.actor_user_id === item.actor_user_id &&
        Math.abs(new Date(prev.created_at).getTime() - new Date(item.created_at).getTime()) < BURST_WINDOW_MS
      ) {
        prev._burst = prev._burst ? [...prev._burst, item] : [item];
        continue;
      }
      grouped.push({ ...item });
    }
    return grouped;
  }, [feed]);

  // Tonight's Energy — Watch Teams brief §5. Functional group-convergence
  // summary, not decoration. Derives (a) how many distinct members are active
  // right now, (b) what title they're circling around, (c) a mood label based
  // on the recent reaction pattern (fire = hyped, tomato = roasting, etc.).
  const tonightEnergy = useMemo(() => {
    if (!selectedTeam || feed.length === 0) return null;
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recent = feed.filter((f) => now - new Date(f.created_at).getTime() < dayMs);
    if (recent.length === 0) return null;

    const distinctActors = new Set(recent.map((f) => f.actor_user_id));
    const titleFreq: Record<string, { name: string; count: number }> = {};
    for (const item of recent) {
      if (!item.content_title_id) continue;
      const name =
        typeof item.payload.title_name === "string"
          ? (item.payload.title_name as string)
          : titleById[item.content_title_id]?.title_name ?? "";
      if (!name) continue;
      const bucket = titleFreq[item.content_title_id] ?? { name, count: 0 };
      bucket.count += 1;
      titleFreq[item.content_title_id] = bucket;
    }
    const topTitle = Object.values(titleFreq).sort((a, b) => b.count - a.count)[0] ?? null;

    // Aggregate reactions across all posts (viewer's own visible counts) to pick
    // the dominant emoji. Uses feedInteractions since that's where we track
    // live reaction totals; falls back to zero when interactions aren't hydrated.
    const totals = { fire: 0, heart: 0, thumbsDown: 0, tomato: 0 };
    for (const item of recent) {
      const state = feedInteractions[item.id];
      if (!state) continue;
      totals.fire += state.reactions.fire ?? 0;
      totals.heart += state.reactions.heart ?? 0;
      totals.thumbsDown += state.reactions.thumbsDown ?? 0;
      totals.tomato += state.reactions.tomato ?? 0;
    }
    const totalReactions = totals.fire + totals.heart + totals.thumbsDown + totals.tomato;
    let mood: string;
    if (totalReactions === 0) {
      mood = distinctActors.size >= 3 ? "Group building momentum" : "Warming up";
    } else if (totals.fire >= totals.heart && totals.fire >= totals.tomato && totals.fire >= totals.thumbsDown) {
      mood = "Hyped, one-more-episode energy";
    } else if (totals.heart > totals.fire && totals.heart >= totals.tomato) {
      mood = "Soft, comfort-rewatch energy";
    } else if (totals.thumbsDown >= totals.fire && totals.thumbsDown >= totals.tomato) {
      mood = "Spirited disagreement in the room";
    } else if (totals.tomato > 0) {
      mood = "Roasting mood tonight";
    } else {
      mood = "Warming up";
    }

    return {
      teamName: selectedTeam.name,
      mood,
      topTitle: topTitle?.name ?? null,
      recentCount: recent.length,
      distinctActors: distinctActors.size,
    };
  }, [selectedTeam, feed, titleById, feedInteractions]);

  useEffect(() => {
    if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!selectedTeam) return;
    setEditName(selectedTeam.name);
    setEditDescription(selectedTeam.description || "");
    setEditIcon(selectedTeam.icon || "🍿");
    setEditVisibility(selectedTeam.visibility);
  }, [selectedTeam]);

  useEffect(() => {
    setFeedInteractions((current) => {
      const next: Record<string, TeamFeedInteraction> = {};
      for (const item of feed) {
        next[item.id] = current[item.id] ?? {
          reactions: {
            fire: Number(item.payload.fire_count ?? 0),
            heart: Number(item.payload.heart_count ?? 0),
            thumbsDown: Number(item.payload.thumbs_down_count ?? 0),
            tomato: Number(item.payload.tomato_count ?? 0),
          },
          viewerReaction: null,
          comments: [],
          draft: "",
          expanded: false,
          composerOpen: false,
        };
      }
      return next;
    });
  }, [feed]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.55, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  const loadTeams = useCallback(async () => {
    if (!sessionToken) return;
    const data = await apiRequest<TeamSummary[]>("/teams", { token: sessionToken });
    setTeams(data);
    setSelectedTeamId((current) => (current && data.some((team) => team.id === current) ? current : data[0]?.id ?? null));
  }, [sessionToken]);

  const loadSelectedTeam = useCallback(
    async (teamId: string) => {
      if (!sessionToken) return;
      const [team, teamTitles, teamFeed, top10] = await Promise.all([
        apiRequest<TeamResponse>(`/teams/${teamId}`, { token: sessionToken }),
        apiRequest<TeamTitle[]>(`/teams/${teamId}/titles`, { token: sessionToken }),
        apiRequest<TeamActivity[]>(`/teams/${teamId}/activity`, { token: sessionToken }),
        apiRequest<TeamRanking[]>(`/teams/${teamId}/top-10`, { token: sessionToken }),
      ]);
      setSelectedTeam(team);
      setTitles(teamTitles);
      setFeed(teamFeed);
      setRankings(top10);
      // Stamp the viewer's read cursor so unread_activity_count resets on the
      // next Teams Home refresh. Fire-and-forget — a network hiccup here just
      // means the badge lingers one refresh longer.
      apiRequest(`/teams/${teamId}/view`, {
        method: "POST",
        token: sessionToken,
      }).catch(() => {});
    },
    [sessionToken]
  );

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      async function load() {
        if (!sessionToken) return;
        setError(null);
        try {
          await loadTeams();
          // Refresh unread notification count
          const result = await fetchNotifications(sessionToken);
          setUnreadNotifCount(result.unread_count);
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load teams");
        }
      }
      void load();
      return () => setIsFocused(false);
    }, [loadTeams, sessionToken])
  );

  useEffect(() => {
    async function loadTeamData() {
      if (!selectedTeamId || !sessionToken) {
        setSelectedTeam(null);
        setTitles([]);
        setFeed([]);
        setRankings([]);
        return;
      }
      setError(null);
      try {
        await loadSelectedTeam(selectedTeamId);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load team");
      }
    }
    void loadTeamData();
  }, [loadSelectedTeam, selectedTeamId, sessionToken]);

  useEffect(() => {
    async function searchJoinable() {
      if (!sessionToken || joinSearch.trim().length < 2 || !showJoin) {
        setJoinSearchResults([]);
        return;
      }
      try {
        const results = await apiRequest<TeamSummary[]>(`/teams/search?q=${encodeURIComponent(joinSearch.trim())}`, {
          token: sessionToken,
        });
        setJoinSearchResults(results);
      } catch {
        setJoinSearchResults([]);
      }
    }
    const timer = setTimeout(() => void searchJoinable(), 240);
    return () => clearTimeout(timer);
  }, [joinSearch, sessionToken, showJoin]);

  useEffect(() => {
    async function searchTitles() {
      if (!sessionToken || titleQuery.trim().length < 2 || (!showAddTitle && !showCompose)) {
        setTitleResults([]);
        return;
      }
      try {
        const results = await apiRequest<TitleSearchResult[]>(`/titles/search?q=${encodeURIComponent(titleQuery.trim())}`, {
          token: sessionToken,
        });
        setTitleResults(results.slice(0, 8));
      } catch {
        setTitleResults([]);
      }
    }
    const timer = setTimeout(() => void searchTitles(), 240);
    return () => clearTimeout(timer);
  }, [titleQuery, sessionToken, showAddTitle, showCompose]);

  useEffect(() => {
    async function searchMembers() {
      if (!sessionToken || !selectedTeam || !showAddMember || memberSearch.trim().length < 2) {
        setMemberResults([]);
        return;
      }
      try {
        const results = await apiRequest<TeamUserSearchResult[]>(
          `/teams/${selectedTeam.id}/users/search?q=${encodeURIComponent(memberSearch.trim())}`,
          { token: sessionToken }
        );
        setMemberResults(results);
      } catch {
        setMemberResults([]);
      }
    }
    const timer = setTimeout(() => void searchMembers(), 250);
    return () => clearTimeout(timer);
  }, [memberSearch, selectedTeam, sessionToken, showAddMember]);

  const sortedTitles = useMemo(() => {
    if (titleSort === "alpha") {
      return [...titles].sort((a, b) => a.title_name.localeCompare(b.title_name));
    }
    if (titleSort === "ranked") {
      const rankMap = new Map(rankings.map((rank) => [rank.content_title_id, rank.rank]));
      return [...titles].sort((a, b) => (rankMap.get(a.content_title_id) ?? 999) - (rankMap.get(b.content_title_id) ?? 999));
    }
    if (titleSort === "discussed") {
      return [...titles].sort((a, b) => {
        const aCount = feed.filter((item) => item.content_title_id === a.content_title_id).length;
        const bCount = feed.filter((item) => item.content_title_id === b.content_title_id).length;
        return bCount - aCount;
      });
    }
    return [...titles].sort((a, b) => new Date(b.added_at).getTime() - new Date(a.added_at).getTime());
  }, [feed, rankings, titleSort, titles]);

  async function _maybePromptPushPermission() {
    if (isExpoGo) return;
    const status = await getNotificationPermissionStatus();
    if (status === "undetermined") {
      setShowPushPrompt(true);
    } else if (status === "granted" && sessionToken) {
      await registerPushToken(sessionToken).catch(() => {});
    }
  }

  async function createTeam() {
    if (!sessionToken || !createName.trim()) return;
    setIsBusy(true);
    try {
      const created = await apiRequest<TeamResponse>("/teams", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({
          name: createName.trim(),
          description: createDescription.trim() || null,
          visibility: "private",
          icon: createIcon.trim() || "🍿",
          max_members: 8,
        }),
      });
      setShowCreate(false);
      setCreateName("");
      setCreateDescription("");
      setCreateIcon("🍿");
      await loadTeams();
      setSelectedTeamId(created.id);
      setToast("Team created");
      void _maybePromptPushPermission();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create team");
    } finally {
      setIsBusy(false);
    }
  }

  async function joinByCode(code: string) {
    if (!sessionToken || !code.trim()) return;
    setIsBusy(true);
    try {
      const joined = await apiRequest<TeamResponse>("/teams/join", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ invite_code: code.trim() }),
      });
      setShowJoin(false);
      setJoinCode("");
      setJoinSearch("");
      await loadTeams();
      setSelectedTeamId(joined.id);
      setToast(`Joined ${joined.name}`);
      void _maybePromptPushPermission();
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "Failed to join team");
    } finally {
      setIsBusy(false);
    }
  }

  async function shareTeamInvite() {
    if (!selectedTeam) return;
    const code = selectedTeam.invite_code;
    const deepLink = `seensnap://teams/join?code=${code}`;
    try {
      await Share.share({
        title: `Join ${selectedTeam.name} on SeenSnap`,
        message: `Join my Watch Team "${selectedTeam.name}" on SeenSnap!\n\nUse invite code: ${code}\n\nOr tap: ${deepLink}`,
      });
    } catch {
      // User dismissed the share sheet
    }
  }

  async function addTitleToTeam() {
    if (!sessionToken || !selectedTeam || !selectedTitle) return;
    setIsBusy(true);
    try {
      await apiRequest(`/teams/${selectedTeam.id}/titles`, {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({
          content_title_id: selectedTitle.id,
          note: titleNote.trim() || null,
          suggested_rank: titleRank ? Number(titleRank) : null,
          also_post_to_feed: alsoPost,
        }),
      });
      setShowAddTitle(false);
      setSelectedTitle(null);
      setTitleQuery("");
      setTitleNote("");
      setTitleRank("");
      setAlsoPost(true);
      await loadSelectedTeam(selectedTeam.id);
      setToast(`Added to ${selectedTeam.name}`);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add title");
    } finally {
      setIsBusy(false);
    }
  }

  async function postToTeamFeed() {
    if (!sessionToken || !selectedTeam) return;
    setIsBusy(true);
    try {
      await apiRequest(`/teams/${selectedTeam.id}/feed-posts`, {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({
          text: postText.trim() || null,
          content_title_id: postAttachedTitle?.id ?? null,
          rating: postRating,
        }),
      });
      setShowCompose(false);
      setPostText("");
      setPostRating(null);
      setPostAttachedTitle(null);
      setTitleQuery("");
      await loadSelectedTeam(selectedTeam.id);
      setToast(`Posted to ${selectedTeam.name}`);
      setTeamTab("feed");
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "Failed to post");
    } finally {
      setIsBusy(false);
    }
  }

  async function saveTeamEdits() {
    if (!sessionToken || !selectedTeam || !canManageTeam) return;
    setIsBusy(true);
    try {
      await apiRequest<TeamResponse>(`/teams/${selectedTeam.id}`, {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
          icon: editIcon.trim() || null,
          visibility: editVisibility,
        }),
      });
      setShowEditTeam(false);
      await loadTeams();
      await loadSelectedTeam(selectedTeam.id);
      setToast("Team updated");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to update team");
    } finally {
      setIsBusy(false);
    }
  }

  async function removeMember(memberId: string) {
    if (!sessionToken || !selectedTeam || !canManageTeam) return;
    setIsBusy(true);
    try {
      await apiRequest<TeamResponse>(`/teams/${selectedTeam.id}/members/${memberId}`, {
        method: "DELETE",
        token: sessionToken,
      });
      await loadSelectedTeam(selectedTeam.id);
      await loadTeams();
      setToast("Member removed");
    } catch (memberError) {
      setError(memberError instanceof Error ? memberError.message : "Failed to remove member");
    } finally {
      setIsBusy(false);
    }
  }

  async function addSelectedMembers() {
    if (!sessionToken || !selectedTeam || !canManageTeam || selectedMemberIds.size === 0) return;
    setIsBusy(true);
    try {
      for (const userId of selectedMemberIds) {
        await apiRequest<TeamResponse>(`/teams/${selectedTeam.id}/members`, {
          method: "POST",
          token: sessionToken,
          body: JSON.stringify({ user_id: userId, role: "member" }),
        });
      }
      setSelectedMemberIds(new Set());
      setMemberSearch("");
      setMemberResults([]);
      setShowAddMember(false);
      await loadSelectedTeam(selectedTeam.id);
      await loadTeams();
      setToast(`Added to ${selectedTeam.name}`);
    } catch (memberError) {
      setError(memberError instanceof Error ? memberError.message : "Failed to add members");
    } finally {
      setIsBusy(false);
    }
  }

  async function openTitleDetails(
    titleId: string,
    fallback: { id: string; title: string; content_type?: string; poster_url?: string | null }
  ) {
    if (!sessionToken) return;
    setShowDetails(true);
    setDetailLoading(true);
    try {
      const details = await fetchUniversalTitle(sessionToken, titleId, fallback);
      setDetailTitle(details);
    } catch (detailError) {
      setDetailTitle(null);
      setError(detailError instanceof Error ? detailError.message : "Failed to load title details");
    } finally {
      setDetailLoading(false);
    }
  }

  function toggleTeamReaction(activityId: string, reaction: ReactionKey) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setFeedInteractions((current) => {
      const state = current[activityId];
      if (!state) return current;
      const reactions = { ...state.reactions };
      let viewerReaction: ReactionKey | null = state.viewerReaction;
      if (state.viewerReaction === reaction) {
        reactions[reaction] = Math.max(0, reactions[reaction] - 1);
        viewerReaction = null;
      } else {
        if (state.viewerReaction) {
          reactions[state.viewerReaction] = Math.max(0, reactions[state.viewerReaction] - 1);
        }
        reactions[reaction] += 1;
        viewerReaction = reaction;
      }
      return { ...current, [activityId]: { ...state, reactions, viewerReaction } };
    });
  }

  function submitTeamComment(activityId: string) {
    const draft = (feedInteractions[activityId]?.draft ?? "").trim();
    if (!draft) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setFeedInteractions((current) => {
      const state = current[activityId];
      if (!state) return current;
      const comment: TeamFeedComment = {
        id: `comment_${Date.now()}`,
        author_id: user?.user_id ?? "local-user",
        author_name: user?.display_name ?? "You",
        author_avatar: user?.avatar_url ?? null,
        text: draft,
        created_at: new Date().toISOString(),
      };
      return {
        ...current,
        [activityId]: { ...state, comments: [...state.comments, comment], draft: "", expanded: true },
      };
    });
  }

  // Cold-start Teams fallback — pull trending backdrop at offset 5 for variety.
  const teamsFallbackBackdrop = useFallbackBackdrop(5);
  // Cycle through the top 3 team covers each time the tab regains focus.
  const teamsPrimaryBackdrop = useCyclingBackdrop([
    teams[0]?.cover_image,
    teams[1]?.cover_image,
    teams[2]?.cover_image,
  ]);

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      <ScrollView contentContainerStyle={styles.content}>

        {/* Unified Header §7 + §14 — H1 "Watch Teams" (overview page).
             Team-name subtitle removed from the global hero; team names
             appear when the user opens a specific team. Contextual '+'
             action sits in the reserved slot before Search/Bell. */}
        <SeenSnapHeader
          title="Watch Teams"
          subtitle="Find something everyone wants to watch."
          artworkSource={teamsPrimaryBackdrop ?? teamsFallbackBackdrop}
          fallbackSeed={5}
          contextualAction={
            <Pressable
              onPress={() => setShowCreate(true)}
              hitSlop={10}
              style={styles.iconBtn}
            >
              <Ionicons name="add" size={20} color={colors.ink} />
            </Pressable>
          }
        />
        {/* Old-header container kept for the join-code button + energy row below the hero. */}
        <View style={styles.headerWrap}>
          <View style={styles.header}>
            <View />
            <View style={styles.headerActions}>
              <Pressable style={styles.iconBtn} onPress={() => setShowJoin(true)}>
                <Ionicons name="people-outline" size={18} color={colors.ink} />
              </Pressable>
            </View>
          </View>
        </View>

        {/* Tonight's Energy — Watch Teams brief §5. Two-line summary: mood
            (derived from recent reactions) + concrete activity attribution so
            the strip is informative, not decorative. */}
        {tonightEnergy ? (
          <View style={styles.energyStrip}>
            <Animated.View style={[styles.energyPulse, { opacity: pulseAnim }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.energyStripText} numberOfLines={1}>
                <Text style={styles.energyStripTeam}>{tonightEnergy.teamName}</Text>
                <Text style={styles.energyStripBody}>{"  ·  " + tonightEnergy.mood}</Text>
              </Text>
              <Text style={styles.energyStripDetail} numberOfLines={1}>
                {tonightEnergy.topTitle
                  ? `${tonightEnergy.distinctActors} ${tonightEnergy.distinctActors === 1 ? "person" : "people"} circling ${tonightEnergy.topTitle}`
                  : `${tonightEnergy.recentCount} moves in the last 24h`}
              </Text>
            </View>
          </View>
        ) : null}

        {/* ── Team cards ─────────────────────────────────────── */}
        {teams.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No teams yet</Text>
            <Text style={styles.emptyBody}>
              Create your first Watch Team or join one to start building shared lists, rankings, and conversations.
            </Text>
            <View style={styles.emptyActions}>
              <Pressable style={styles.primaryCta} onPress={() => setShowCreate(true)}>
                <Text style={styles.primaryCtaText}>Create a Team</Text>
              </Pressable>
              <Pressable style={styles.secondaryCta} onPress={() => setShowJoin(true)}>
                <Text style={styles.secondaryCtaText}>Join a Team</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.teamsList}>
            {/* Watch Teams brief §6 — compact "inbox of momentum" rows: team
                name, member count + unread badge, latest event with time, and
                a state indicator. Sorted server-side by last_activity_at so
                the noisiest teams float up. Selected row still gets the accent
                treatment; a live/active dot pulses when team_status === 'active'. */}
            {teams.map((team) => {
              const isActive = selectedTeamSummary?.id === team.id;
              const coverUri = resolveMediaUrl(team.cover_image);
              const unread = team.unread_activity_count ?? 0;
              const status = team.team_status ?? "quiet";
              return (
                <Pressable
                  key={team.id}
                  style={[styles.teamCard, isActive && styles.teamCardActive]}
                  onPress={() => setSelectedTeamId(team.id)}
                >
                  <View style={styles.teamRow}>
                    <View style={styles.teamRowThumb}>
                      {coverUri ? (
                        <Image source={{ uri: coverUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                      ) : null}
                      <View style={[StyleSheet.absoluteFill, styles.teamCardTint]} />
                      <Text style={styles.teamRowThumbEmoji}>{team.icon || "🍿"}</Text>
                    </View>
                    <View style={styles.teamRowBody}>
                      <View style={styles.teamRowHeader}>
                        <Text numberOfLines={1} style={styles.teamCardName}>{team.name}</Text>
                        {unread > 0 ? (
                          <View style={styles.teamUnreadPill}>
                            <Text style={styles.teamUnreadPillText}>
                              {unread > 9 ? "9+" : String(unread)} new
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.teamRowMemberLine}>
                        {team.member_count} member{team.member_count === 1 ? "" : "s"}
                        {team.recent_member_avatars.length > 0 ? "  ·  " : ""}
                      </Text>
                      {team.latest_activity ? (
                        <Text numberOfLines={1} style={styles.teamRowActivity}>
                          {team.latest_activity}
                          {team.last_activity_at ? `  ·  ${relativeTime(team.last_activity_at)}` : ""}
                        </Text>
                      ) : (
                        <Text numberOfLines={1} style={styles.teamRowActivityMuted}>
                          {team.description || "No activity yet"}
                        </Text>
                      )}
                      {status === "active" ? (
                        <View style={styles.teamRowStatusRow}>
                          <Animated.View style={[styles.activeDot, { opacity: pulseAnim }]} />
                          <Text style={styles.teamRowActiveText}>Active tonight</Text>
                        </View>
                      ) : status === "dormant" ? (
                        <View style={styles.teamRowStatusRow}>
                          <View style={styles.dormantDot} />
                          <Text style={styles.teamRowDormantText}>Quiet lately</Text>
                        </View>
                      ) : null}
                    </View>
                    {isActive && canManageTeam ? (
                      <Pressable onPress={() => setShowEditTeam(true)} style={styles.editPill}>
                        <Text style={styles.editPillText}>Edit</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* ── Selected Team Detail — activity-first per Watch Teams brief §5 ───
             Compact identity block (no oversized empty artwork) so Pulse feed
             is visible in the first viewport. Admin (Edit/Invite) moved out of
             the primary action row into a subordinate row that lives with the
             Members tab affordance. Composer + Add Title are the primary
             participation actions; Top 10 stays in the tab bar rather than
             competing as a button. */}
        {selectedTeam ? (
          <View style={styles.detailCard}>
            <View style={styles.detailHeaderCompact}>
              {detailBackdropUri ? (
                <Image
                  source={{ uri: detailBackdropUri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                  blurRadius={16}
                />
              ) : null}
              <View style={[StyleSheet.absoluteFill, styles.detailHeaderTint]} />
              <View style={styles.detailHeaderCompactRow}>
                <View style={styles.detailIconBadge}>
                  <Text style={styles.detailIconBadgeText}>{selectedTeam.icon || "🍿"}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={styles.detailHeaderName}>{selectedTeam.name}</Text>
                  <Text numberOfLines={1} style={styles.detailHeaderMetaText}>
                    {selectedTeam.description
                      ? `${selectedTeam.description} · ${selectedTeam.member_count} members`
                      : `${selectedTeam.member_count}/${selectedTeam.max_members} members · ${selectedTeam.visibility}`}
                  </Text>
                </View>
                {canManageTeam ? (
                  <Pressable
                    onPress={() => setShowEditTeam(true)}
                    hitSlop={8}
                    style={styles.detailHeaderOverflow}
                  >
                    <Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} />
                  </Pressable>
                ) : null}
              </View>
            </View>

            {(selectedTeamSummary?.unread_activity_count ?? 0) > 0 ? (
              <View style={styles.unreadStrip}>
                <Text style={styles.unreadStripText}>
                  {selectedTeamSummary?.unread_activity_count} new since your last visit
                </Text>
              </View>
            ) : null}

            {/* Quick composer — Watch Teams brief §5. One obvious entry that
                expands into Add Title / Post / (Invite). Replaces the row of
                equal-weight buttons that used to compete with navigation. */}
            <Pressable
              onPress={() => setShowComposerPicker(true)}
              style={styles.composerBar}
            >
              <View style={styles.composerBarPlus}>
                <Ionicons name="add" size={18} color={colors.accent} />
              </View>
              <Text style={styles.composerBarPlaceholder} numberOfLines={1}>
                Add a title, post a thought, or ask for a pick…
              </Text>
            </Pressable>

            {/* Tabs — Pulse first per Watch Teams brief §5 (activity is the
                destination; identity supports it). "Feed" internally, "Pulse"
                to the user so the label matches the mental model. */}
            <View style={styles.tabRow}>
              <TabPill label="Pulse" active={teamTab === "feed"} onPress={() => setTeamTab("feed")} />
              <TabPill label="Titles" active={teamTab === "titles"} onPress={() => setTeamTab("titles")} />
              <TabPill label="Top 10" active={teamTab === "top10"} onPress={() => setTeamTab("top10")} />
              <TabPill label="Members" active={teamTab === "members"} onPress={() => setTeamTab("members")} />
            </View>

            {/* ── Pulse tab ── */}
            {teamTab === "feed" ? (
              <View style={styles.tabPanel}>
                {pulseFeed.length === 0 ? (
                  // Watch Teams brief §9 P2 empty state: clear primary action
                  // (add first title) with an invite fallback for teams that
                  // need more members to generate activity in the first place.
                  <View style={styles.pulseEmpty}>
                    <Text style={styles.pulseEmptyTitle}>No moves yet in this team.</Text>
                    <Text style={styles.pulseEmptyBody}>
                      Add the first title, or invite a couple more people who share your taste — activity picks up once someone else can react.
                    </Text>
                    <View style={styles.pulseEmptyActions}>
                      <Pressable style={styles.primaryCta} onPress={() => setShowAddTitle(true)}>
                        <Text style={styles.primaryCtaText}>Add first title</Text>
                      </Pressable>
                      {canManageTeam ? (
                        <Pressable style={styles.secondaryCta} onPress={() => setShowAddMember(true)}>
                          <Text style={styles.secondaryCtaText}>Invite members</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                ) : null}
                {pulseFeed.map((item) => {
                  const ratingVal = typeof item.payload.rating === "number" ? (item.payload.rating as number) : null;
                  const linkedTitle = item.content_title_id ? titleById[item.content_title_id] : null;
                  const posterUri = linkedTitle ? resolveMediaUrl(linkedTitle.poster_url) : null;
                  return (
                    <View key={item.id} style={styles.feedCard}>
                      {/* Poster hero */}
                      {linkedTitle ? (
                        <Pressable
                          style={styles.feedHero}
                          onPress={() =>
                            void openTitleDetails(item.content_title_id!, {
                              id: item.content_title_id!,
                              title: linkedTitle.title_name,
                              content_type: linkedTitle.content_type,
                              poster_url: linkedTitle.poster_url,
                            })
                          }
                        >
                          {posterUri ? (
                            <Image source={{ uri: posterUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                          ) : null}
                          <View style={styles.feedHeroShade} />
                          <Text style={styles.feedHeroTitle}>{linkedTitle.title_name}</Text>
                          {ratingVal !== null ? (
                            <RatingCircle score={ratingVal} size={36} style={styles.feedHeroRating} />
                          ) : null}
                        </Pressable>
                      ) : null}

                      {/* Author row — includes burst copy per brief §7 density
                          ("added 3 titles" instead of 3 separate events). Also
                          renders rich Top-10 movement copy when payload has
                          previous/new rank on a ranking_updated event. */}
                      <View style={styles.feedAuthorRow}>
                        <Avatar uri={item.actor_avatar_url} label={item.actor_display_name || "U"} size={28} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.feedAuthorName}>{item.actor_display_name || "Member"}</Text>
                          <Text style={styles.feedAuthorAction}>
                            {item._burst && item._burst.length > 0
                              ? `added ${item._burst.length + 1} titles`
                              : item.activity_type === "ranking_updated" &&
                                  typeof item.payload.previous_rank === "number" &&
                                  typeof item.payload.new_rank === "number"
                                ? `moved ${item.payload.title_name ?? "a title"} from #${item.payload.previous_rank} → #${item.payload.new_rank}`
                                : readableFeedType(item.activity_type)}
                          </Text>
                        </View>
                        <Text style={styles.feedTime}>{relativeTime(item.created_at)}</Text>
                      </View>

                      {/* Body text */}
                      {String(item.payload.text || item.payload.comment || "").trim() ? (
                        <Text style={styles.feedBody}>{String(item.payload.text || item.payload.comment)}</Text>
                      ) : null}

                      {/* Reactions — Watch Teams brief §7: never show four
                          zero-count buttons. Show only reactions that already
                          exist, plus a single "react" affordance that opens
                          the tray. If the viewer has reacted, their choice is
                          shown regardless of count so they can toggle it off. */}
                      {(() => {
                        const state = feedInteractions[item.id];
                        const counts = state?.reactions ?? { fire: 0, heart: 0, thumbsDown: 0, tomato: 0 };
                        const viewerReaction = state?.viewerReaction ?? null;
                        const trayOpen = openReactionTray === item.id;
                        const REACTIONS = [
                          { key: "fire" as const, icon: "🔥" },
                          { key: "heart" as const, icon: "❤️" },
                          { key: "thumbsDown" as const, icon: "👎" },
                          { key: "tomato" as const, icon: "🍅" },
                        ] as const;
                        const visible = REACTIONS.filter(
                          (r) => (counts[r.key] ?? 0) > 0 || viewerReaction === r.key,
                        );
                        return (
                          <View style={styles.reactionStrip}>
                            {visible.map((r) => (
                              <Pressable
                                key={r.key}
                                onPress={() => toggleTeamReaction(item.id, r.key)}
                                style={[
                                  styles.reactionChip,
                                  viewerReaction === r.key && styles.reactionChipActive,
                                ]}
                              >
                                <Text style={styles.reactionChipText}>
                                  {r.icon} {counts[r.key] ?? 0}
                                </Text>
                              </Pressable>
                            ))}
                            {trayOpen
                              ? REACTIONS.filter((r) => !visible.some((v) => v.key === r.key)).map((r) => (
                                  <Pressable
                                    key={r.key}
                                    onPress={() => {
                                      toggleTeamReaction(item.id, r.key);
                                      setOpenReactionTray(null);
                                    }}
                                    style={styles.reactionChip}
                                  >
                                    <Text style={styles.reactionChipText}>{r.icon}</Text>
                                  </Pressable>
                                ))
                              : (
                                <Pressable
                                  onPress={() => setOpenReactionTray(item.id)}
                                  style={styles.reactionAddChip}
                                >
                                  <Ionicons name="happy-outline" size={14} color={colors.muted} />
                                  <Text style={styles.reactionAddText}>React</Text>
                                </Pressable>
                              )}
                            <View style={{ flex: 1 }} />
                            <Pressable
                              onPress={() =>
                                setFeedInteractions((current) => {
                                  const s = current[item.id];
                                  if (!s) return current;
                                  return { ...current, [item.id]: { ...s, composerOpen: !s.composerOpen } };
                                })
                              }
                              style={styles.reactionAddChip}
                            >
                              <Ionicons name="chatbubble-outline" size={13} color={colors.muted} />
                              <Text style={styles.reactionAddText}>
                                {state?.comments.length ? String(state.comments.length) : "Comment"}
                              </Text>
                            </Pressable>
                          </View>
                        );
                      })()}

                      {/* Comment thread — collapsed until composerOpen or the
                          viewer expands existing comments. Density rule §7. */}
                      {(feedInteractions[item.id]?.comments.length ?? 0) > 0 &&
                      (feedInteractions[item.id]?.composerOpen || feedInteractions[item.id]?.expanded) ? (
                        <Pressable
                          onPress={() =>
                            setFeedInteractions((current) => {
                              const state = current[item.id];
                              if (!state) return current;
                              return { ...current, [item.id]: { ...state, expanded: !state.expanded } };
                            })
                          }
                        >
                          <Text style={styles.feedCommentToggle}>
                            {feedInteractions[item.id]?.expanded
                              ? "Hide comments"
                              : `View all ${feedInteractions[item.id]?.comments.length ?? 0} comments`}
                          </Text>
                        </Pressable>
                      ) : null}
                      {feedInteractions[item.id]?.composerOpen || feedInteractions[item.id]?.expanded
                        ? (feedInteractions[item.id]?.expanded
                            ? feedInteractions[item.id]?.comments
                            : (feedInteractions[item.id]?.comments ?? []).slice(0, 2)
                          )?.map((comment) => (
                            <View key={comment.id} style={styles.commentRow}>
                              <Avatar uri={comment.author_avatar} label={comment.author_name} size={20} />
                              <Text style={styles.commentText}>
                                <Text style={styles.commentAuthor}>{comment.author_name}: </Text>
                                {comment.text}
                              </Text>
                            </View>
                          ))
                        : null}
                      {feedInteractions[item.id]?.composerOpen ? (
                        <View style={styles.commentComposer}>
                          <TextInput
                            value={feedInteractions[item.id]?.draft ?? ""}
                            onChangeText={(value) =>
                              setFeedInteractions((current) => {
                                const state = current[item.id];
                                if (!state) return current;
                                return { ...current, [item.id]: { ...state, draft: value } };
                              })
                            }
                            placeholder="Add a comment..."
                            placeholderTextColor={colors.muted}
                            style={styles.commentInput}
                            autoFocus
                          />
                          <Pressable
                            onPress={() => submitTeamComment(item.id)}
                            style={[styles.commentSend, !(feedInteractions[item.id]?.draft ?? "").trim() && styles.commentSendDisabled]}
                            disabled={!(feedInteractions[item.id]?.draft ?? "").trim()}
                          >
                            <Text style={styles.commentSendText}>Send</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/* ── Titles tab ── */}
            {teamTab === "titles" ? (
              <View style={styles.tabPanel}>
                <View style={styles.sortRow}>
                  <TabPill label="Recent" active={titleSort === "recent"} onPress={() => setTitleSort("recent")} />
                  <TabPill label="Top Ranked" active={titleSort === "ranked"} onPress={() => setTitleSort("ranked")} />
                  <TabPill label="Most Discussed" active={titleSort === "discussed"} onPress={() => setTitleSort("discussed")} />
                  <TabPill label="A–Z" active={titleSort === "alpha"} onPress={() => setTitleSort("alpha")} />
                </View>
                {sortedTitles.length === 0 ? (
                  <Text style={styles.emptyBody}>No titles added yet. Search for a movie or show and add it to this team.</Text>
                ) : null}
                {sortedTitles.map((entry) => (
                  <Pressable
                    key={entry.id}
                    style={styles.titleRow}
                    onPress={() =>
                      void openTitleDetails(entry.content_title_id, {
                        id: entry.content_title_id,
                        title: entry.title_name,
                        content_type: entry.content_type,
                        poster_url: entry.poster_url,
                      })
                    }
                  >
                    <PosterThumb uri={entry.poster_url} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.titleName}>{entry.title_name}</Text>
                      <Text style={styles.titleMeta}>{entry.year ?? "—"} · {entry.content_type === "movie" ? "Movie" : "TV"}</Text>
                      <Text style={styles.titleMeta}>Added by {entry.added_by_name || "member"}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {/* ── Members tab ── */}
            {teamTab === "members" ? (
              <View style={styles.tabPanel}>
                {selectedTeam.members.map((member) => (
                  <View key={member.user_id} style={styles.memberRow}>
                    <Avatar uri={member.avatar_url} label={member.display_name || "U"} size={32} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>{member.display_name || "Member"}</Text>
                      <Text style={styles.memberRole}>{member.role}</Text>
                    </View>
                    {canManageTeam && member.user_id !== user?.user_id && member.role !== "owner" ? (
                      <Pressable style={styles.memberDangerPill} onPress={() => void removeMember(member.user_id)}>
                        <Text style={styles.memberDangerPillText}>Remove</Text>
                      </Pressable>
                    ) : (
                      <Pressable style={styles.followPill}>
                        <Text style={styles.followPillText}>Follow</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
                {canManageTeam ? (
                  <Pressable style={styles.addMemberBtn} onPress={() => setShowAddMember(true)}>
                    <Ionicons name="person-add-outline" size={14} color={colors.accent} />
                    <Text style={styles.addMemberBtnText}>Invite a member</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* ── Top 10 tab ── */}
            {teamTab === "top10" ? (
              <View style={styles.tabPanel}>
                {rankings.length === 0 ? (
                  <Text style={styles.emptyBody}>No rankings yet. Add titles to the team to start building the leaderboard.</Text>
                ) : null}
                {rankings.map((row) => {
                  const isUp = row.movement === "up";
                  const isDown = row.movement === "down";
                  const posterUri = resolveMediaUrl(row.poster_url);
                  return (
                    <Pressable
                      key={row.id}
                      style={styles.rankRow}
                      onPress={() =>
                        void openTitleDetails(row.content_title_id, {
                          id: row.content_title_id,
                          title: row.title_name,
                          poster_url: row.poster_url,
                        })
                      }
                    >
                      <Text style={styles.rankNum}>#{row.rank}</Text>
                      {posterUri ? (
                        <Image source={{ uri: posterUri }} style={styles.rankPoster} resizeMode="cover" />
                      ) : (
                        <View style={[styles.rankPoster, styles.rankPosterEmpty]}>
                          <Ionicons name="film" size={14} color={colors.muted} />
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rankTitle}>{row.title_name}</Text>
                        <Text style={styles.rankMeta}>{row.weeks_on_list}w on list</Text>
                      </View>
                      <View style={styles.rankRight}>
                        <Text style={styles.rankScore}>{row.score.toFixed(1)}</Text>
                        <Text style={[styles.rankMovement, isUp ? styles.rankUp : isDown ? styles.rankDown : styles.rankSame]}>
                          {isUp ? "↑" : isDown ? "↓" : "—"}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      {/* ── Sheets ─────────────────────────────────────────── */}
      <KeyboardSheet visible={showCreate} onClose={() => setShowCreate(false)}>
        <Text style={styles.modalTitle}>Create Team</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput value={createName} onChangeText={setCreateName} placeholder="Team name" placeholderTextColor={colors.muted} style={styles.input} />
          <TextInput value={createDescription} onChangeText={setCreateDescription} placeholder="Team description" placeholderTextColor={colors.muted} style={styles.input} multiline />
          <TextInput value={createIcon} onChangeText={setCreateIcon} placeholder="Icon / emoji" placeholderTextColor={colors.muted} style={styles.input} />
        </ScrollView>
        <View style={styles.sheetFooterRow}>
          <Pressable style={styles.sheetCancel} onPress={() => setShowCreate(false)}>
            <Text style={styles.sheetCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryCta, (!createName.trim() || isBusy) && styles.primaryCtaDisabled]}
            onPress={() => void createTeam()}
            disabled={isBusy || !createName.trim()}
          >
            <Text style={styles.primaryCtaText}>{isBusy ? "Saving..." : "Create Team"}</Text>
          </Pressable>
        </View>
      </KeyboardSheet>

      <KeyboardSheet visible={showJoin} onClose={() => setShowJoin(false)}>
        <Text style={styles.modalTitle}>Join Team</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput value={joinCode} onChangeText={setJoinCode} placeholder="Invite code" placeholderTextColor={colors.muted} style={styles.input} autoCapitalize="characters" />
          <Pressable style={styles.secondaryCta} onPress={() => void joinByCode(joinCode)} disabled={isBusy}>
            <Text style={styles.secondaryCtaText}>Join by Code</Text>
          </Pressable>
          <TextInput value={joinSearch} onChangeText={setJoinSearch} placeholder="Search by team name" placeholderTextColor={colors.muted} style={styles.input} />
          <ScrollView style={{ maxHeight: 220 }}>
            {joinSearchResults.map((team) => (
              <Pressable key={team.id} style={styles.searchRow} onPress={() => void joinByCode(team.invite_code)}>
                <Text style={styles.searchName}>{team.name}</Text>
                <Text style={styles.searchMeta}>{team.member_count} members</Text>
              </Pressable>
            ))}
          </ScrollView>
        </ScrollView>
      </KeyboardSheet>

      {/* Composer picker — Watch Teams brief §5 unified entry. Shows the three
          participation choices behind the single composer bar so the top of
          the detail page isn't a row of competing buttons. */}
      <KeyboardSheet visible={showComposerPicker} onClose={() => setShowComposerPicker(false)}>
        <Text style={styles.modalTitle}>What do you want to do?</Text>
        <View style={styles.sheetBody}>
          <Pressable
            style={styles.composerAction}
            onPress={() => {
              setShowComposerPicker(false);
              setShowAddTitle(true);
            }}
          >
            <View style={styles.composerActionIcon}>
              <Ionicons name="add-circle-outline" size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.composerActionTitle}>Add a title</Text>
              <Text style={styles.composerActionBody}>Search a movie or show and pin it to this team.</Text>
            </View>
          </Pressable>
          <Pressable
            style={styles.composerAction}
            onPress={() => {
              setShowComposerPicker(false);
              setShowCompose(true);
            }}
          >
            <View style={styles.composerActionIcon}>
              <Ionicons name="create-outline" size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.composerActionTitle}>Post a thought</Text>
              <Text style={styles.composerActionBody}>Share a rating, a reaction, or start a group discussion.</Text>
            </View>
          </Pressable>
          <Pressable
            style={styles.composerAction}
            onPress={() => {
              setShowComposerPicker(false);
              setShowCompose(true);
              setPostText("Anyone want to pick tonight? What are we in the mood for?");
            }}
          >
            <View style={styles.composerActionIcon}>
              <Ionicons name="help-circle-outline" size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.composerActionTitle}>Ask for a pick</Text>
              <Text style={styles.composerActionBody}>Start a decision — get the team to weigh in on what's next.</Text>
            </View>
          </Pressable>
        </View>
      </KeyboardSheet>

      <KeyboardSheet visible={showAddTitle} onClose={() => setShowAddTitle(false)}>
        <Text style={styles.modalTitle}>Add to Watch Team</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput value={titleQuery} onChangeText={setTitleQuery} placeholder="Search title" placeholderTextColor={colors.muted} style={styles.input} />
          <ScrollView style={{ maxHeight: 220 }}>
            {titleResults.map((entry) => (
              <Pressable key={entry.id} style={styles.searchRow} onPress={() => setSelectedTitle(entry)}>
                <PosterThumb uri={entry.poster_url} small />
                <View style={{ flex: 1 }}>
                  <Text style={styles.searchName}>{entry.title}</Text>
                  <Text style={styles.searchMeta}>{entry.release_date?.slice(0, 4) || "—"} · {entry.content_type === "movie" ? "Movie" : "TV"}</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
          {selectedTitle ? <Text style={styles.selectedHint}>Selected: {selectedTitle.title}</Text> : null}
          <TextInput value={titleNote} onChangeText={setTitleNote} placeholder="Why are you adding this? (optional)" placeholderTextColor={colors.muted} style={styles.input} />
          <TextInput value={titleRank} onChangeText={setTitleRank} placeholder="Suggested rank 1–10 (optional)" placeholderTextColor={colors.muted} style={styles.input} keyboardType="numeric" />
          <View style={styles.switchRow}>
            <Text style={styles.searchMeta}>Also post to team feed</Text>
            <Switch value={alsoPost} onValueChange={setAlsoPost} trackColor={{ true: colors.accent }} />
          </View>
        </ScrollView>
        <View style={styles.sheetFooter}>
          <View style={styles.sheetFooterRow}>
            <Pressable style={styles.sheetCancel} onPress={() => setShowAddTitle(false)}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryCta, (isBusy || !selectedTitle) && styles.primaryCtaDisabled]}
              onPress={() => void addTitleToTeam()}
              disabled={isBusy || !selectedTitle}
            >
              <Text style={styles.primaryCtaText}>Add to Team</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardSheet>

      <KeyboardSheet visible={showCompose} onClose={() => setShowCompose(false)}>
        <Text style={styles.modalTitle}>Post to {selectedTeam?.name}</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput
            value={postText}
            onChangeText={setPostText}
            placeholder={`Post to ${selectedTeam?.name || "team"}`}
            placeholderTextColor={colors.muted}
            style={styles.input}
            multiline
          />
          <TextInput value={titleQuery} onChangeText={setTitleQuery} placeholder="Attach a title (optional)" placeholderTextColor={colors.muted} style={styles.input} />
          <ScrollView style={{ maxHeight: 170 }}>
            {titleResults.map((entry) => (
              <Pressable key={entry.id} style={styles.searchRow} onPress={() => setPostAttachedTitle(entry)}>
                <PosterThumb uri={entry.poster_url} small />
                <Text style={styles.searchName}>{entry.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {postAttachedTitle ? <Text style={styles.selectedHint}>Attached: {postAttachedTitle.title}</Text> : null}
          <RatingPicker value={postRating} onChange={setPostRating} />
        </ScrollView>
        <View style={styles.sheetFooter}>
          <Pressable style={styles.primaryCta} onPress={() => void postToTeamFeed()} disabled={isBusy}>
            <Text style={styles.primaryCtaText}>{isBusy ? "Posting..." : "Post"}</Text>
          </Pressable>
        </View>
      </KeyboardSheet>

      <KeyboardSheet visible={showEditTeam} onClose={() => setShowEditTeam(false)}>
        <Text style={styles.modalTitle}>Edit Team</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput value={editIcon} onChangeText={setEditIcon} placeholder="Team emoji" placeholderTextColor={colors.muted} style={styles.input} />
          <TextInput value={editName} onChangeText={setEditName} placeholder="Team name" placeholderTextColor={colors.muted} style={styles.input} />
          <TextInput value={editDescription} onChangeText={setEditDescription} placeholder="Description" placeholderTextColor={colors.muted} style={styles.input} multiline />
          <TextInput value={editVisibility} onChangeText={setEditVisibility} placeholder="Visibility (private/invite_only/public)" placeholderTextColor={colors.muted} style={styles.input} />
          <Pressable
            style={styles.sheetCancel}
            onPress={() => { setShowEditTeam(false); setShowAddMember(true); }}
          >
            <Text style={styles.sheetCancelText}>Add Member</Text>
          </Pressable>
        </ScrollView>
        <View style={styles.sheetFooter}>
          <Pressable style={styles.primaryCta} onPress={() => void saveTeamEdits()} disabled={isBusy || !canManageTeam}>
            <Text style={styles.primaryCtaText}>Save Team</Text>
          </Pressable>
        </View>
      </KeyboardSheet>

      <KeyboardSheet visible={showAddMember} onClose={() => setShowAddMember(false)}>
        <Text style={styles.modalTitle}>Invite to Team</Text>
        {selectedTeam ? (
          <Pressable style={styles.shareInviteRow} onPress={() => void shareTeamInvite()}>
            <Ionicons name="share-outline" size={18} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.shareInviteLabel}>Share invite link</Text>
              <Text style={styles.shareInviteCode}>{selectedTeam.invite_code}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>
        ) : null}
        <Text style={styles.sheetSectionLabel}>Or add existing members</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput value={memberSearch} onChangeText={setMemberSearch} placeholder="Search users by name or username" placeholderTextColor={colors.muted} style={styles.input} />
          <ScrollView style={{ maxHeight: 260 }}>
            {memberResults.map((entry) => (
              <Pressable
                key={entry.user_id}
                style={styles.memberSearchRow}
                onPress={() =>
                  setSelectedMemberIds((current) => {
                    const next = new Set(current);
                    if (next.has(entry.user_id)) next.delete(entry.user_id);
                    else next.add(entry.user_id);
                    return next;
                  })
                }
              >
                <Avatar uri={entry.avatar_url} label={entry.display_name || "U"} size={28} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.searchName}>{entry.display_name || "User"}</Text>
                  <Text style={styles.searchMeta}>@{entry.username || "user"}</Text>
                </View>
                <Ionicons
                  name={selectedMemberIds.has(entry.user_id) ? "checkmark-circle" : "ellipse-outline"}
                  size={20}
                  color={selectedMemberIds.has(entry.user_id) ? colors.accent : colors.muted}
                />
              </Pressable>
            ))}
          </ScrollView>
        </ScrollView>
        <View style={styles.sheetFooterRow}>
          <Pressable style={styles.sheetCancel} onPress={() => setShowAddMember(false)}>
            <Text style={styles.sheetCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryCta, (isBusy || selectedMemberIds.size === 0) && styles.primaryCtaDisabled]}
            onPress={() => void addSelectedMembers()}
            disabled={isBusy || selectedMemberIds.size === 0}
          >
            <Text style={styles.primaryCtaText}>
              Add {selectedMemberIds.size > 0 ? `${selectedMemberIds.size} ` : ""}Member{selectedMemberIds.size !== 1 ? "s" : ""}
            </Text>
          </Pressable>
        </View>
      </KeyboardSheet>

      <UniversalTitleModal
        visible={showDetails}
        loading={detailLoading}
        title={detailTitle}
        onClose={() => setShowDetails(false)}
        onSaveTitle={(detail) => {
          setSaveTitleId(detail.id);
          setShowSaveSheet(true);
        }}
      />

      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="watch_team"
        onClose={() => { setShowSaveSheet(false); setSaveTitleId(null); }}
        onSaved={(listName, alreadySaved) => setToast(alreadySaved ? `Already in ${listName}` : `Saved to ${listName}`)}
        onError={(message) => setError(message)}
      />

      {toast ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {/* Push notification permission pre-prompt */}
      <Modal visible={showPushPrompt} transparent animationType="fade" onRequestClose={() => setShowPushPrompt(false)}>
        <View style={styles.pushPromptOverlay}>
          <View style={styles.pushPromptSheet}>
            <Text style={styles.pushPromptEyebrow}>NOTIFICATIONS</Text>
            <View style={styles.pushPromptRule} />
            <Text style={styles.pushPromptTitle}>Stay in the loop{"\n"}with your Watch Team.</Text>
            <Text style={styles.pushPromptBody}>
              SeenSnap will notify you when your team gets new members, replies, or invites.
              No noise — only what matters.
            </Text>
            <View style={styles.pushPromptActions}>
              <Pressable
                style={styles.pushPromptEnable}
                onPress={async () => {
                  setShowPushPrompt(false);
                  const granted = await requestNotificationPermission();
                  if (granted && sessionToken) {
                    await registerPushToken(sessionToken).catch(() => {});
                  }
                }}
              >
                <Text style={styles.pushPromptEnableLabel}>ENABLE NOTIFICATIONS</Text>
              </Pressable>
              <Pressable onPress={() => setShowPushPrompt(false)} hitSlop={8}>
                <Text style={styles.pushPromptSkip}>Not now</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Helper components ──────────────────────────────────────────────────────────

function KeyboardSheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modalSheet}>{children}</View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function TabPill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tabPill, active && styles.tabPillActive]} onPress={onPress}>
      <Text style={[styles.tabPillText, active && styles.tabPillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function PosterThumb({ uri, small = false }: { uri?: string | null; small?: boolean }) {
  const width = small ? 26 : 40;
  const height = small ? 38 : 58;
  const [failed, setFailed] = useState(false);
  const resolved = resolveMediaUrl(uri);
  const placeholder = resolveMediaUrl("/media/brand/title_placeholder.png");
  if (!failed && (resolved || placeholder)) {
    return (
      <Image
        source={{ uri: resolved ?? placeholder! }}
        style={{ width, height, borderRadius: 6, backgroundColor: colors.backgroundElevated }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View style={{ width, height, borderRadius: 6, backgroundColor: colors.backgroundElevated, alignItems: "center", justifyContent: "center" }}>
      <Ionicons name="film" size={small ? 12 : 16} color={colors.muted} />
    </View>
  );
}

// Delegate to the shared formatter — guards against NaN when the timestamp is
// null / undefined / malformed (root cause of the "NaNd ago" defect).
const relativeTime = (input: string | Date | number | null | undefined): string =>
  sharedRelativeTime(input);

function readableFeedType(type: string) {
  switch (type) {
    case "title_added": return "added a title";
    case "team_post": return "posted to the team";
    case "watchlist_item_added": return "added to Watchlist";
    case "activity_reacted": return "reacted to a post";
    case "activity_commented": return "commented on a post";
    case "member_joined": return "joined the team";
    case "ranking_updated": return "updated rankings";
    case "poll_started": return "started a poll";
    case "friend_rating": return "shared a rating";
    default: return type.replaceAll("_", " ");
  }
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { gap: spacing.md, paddingBottom: spacing.xl },

  // Header
  backdropShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(7,11,18,0.60)" },
  headerWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: 4 },
  logo: { width: 110, height: 30 },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  headerKicker: { color: colors.accent, fontFamily: fonts.monoSemiBold, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.4 },
  headerTitle: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 30, letterSpacing: -0.5, marginTop: 2 },
  headerActions: { flexDirection: "row", gap: 8, paddingBottom: 4 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  notifBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    backgroundColor: colors.accent,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  notifBadgeText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 8,
    color: colors.paperInk,
    letterSpacing: 0,
  },
  // Push permission prompt modal
  pushPromptOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
    paddingHorizontal: spacing.lg,
    paddingBottom: 48,
  },
  pushPromptSheet: {
    backgroundColor: colors.backgroundElevated,
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.md,
    padding: spacing.xl,
    gap: spacing.md,
  },
  pushPromptEyebrow: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: "uppercase",
  },
  pushPromptRule: {
    height: 1,
    width: 32,
    backgroundColor: rules.gold,
  },
  pushPromptTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 26,
    lineHeight: 28,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  pushPromptBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
  },
  pushPromptActions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  pushPromptEnable: {
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingVertical: 14,
    alignItems: "center",
  },
  pushPromptEnableLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.paperInk,
    textTransform: "uppercase",
  },
  pushPromptSkip: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted2,
    textAlign: "center",
    paddingVertical: spacing.xs,
  },

  // Tonight's Energy
  energyCard: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.22)",
    padding: spacing.md,
    gap: 5,
  },
  energyLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  energyPulse: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.success,
    shadowColor: colors.success,
    shadowOpacity: 0.8,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  energyKicker: { color: colors.accent, fontFamily: fonts.monoSemiBold, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.2 },
  energyTeam: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  energyBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  energyMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11 },
  // Editorial replacement for the boxed energy card — single flowing line.
  energyStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginHorizontal: 0,
  },
  energyStripText: {
    flex: 1,
    fontFamily: fonts.serif,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
  },
  energyStripTeam: {
    fontFamily: fonts.serifBold,
    color: colors.ink,
  },
  energyStripBody: {
    fontStyle: "italic",
    color: colors.muted,
  },
  energyStripDetail: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.4,
    color: colors.muted,
    marginTop: 2,
  },

  // Team cards — compact row layout per Watch Teams brief §6.
  teamsList: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  teamCard: {
    borderRadius: radii.lg,
    overflow: "hidden",
    backgroundColor: colors.velvet,
    borderWidth: 1,
    borderColor: colors.border,
  },
  teamCardActive: {
    borderColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  teamCardTint: { backgroundColor: "rgba(7,11,19,0.30)" },
  teamRow: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  teamRowThumb: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: "rgba(244,196,48,0.10)",
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.24)",
    alignItems: "center",
    justifyContent: "center",
  },
  teamRowThumbEmoji: { fontSize: 26 },
  teamRowBody: { flex: 1, gap: 3 },
  teamRowHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  teamCardName: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 16, letterSpacing: -0.2, flexShrink: 1 },
  teamRowMemberLine: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.4 },
  teamRowActivity: { color: colors.ink, fontFamily: fonts.sans, fontSize: 12, marginTop: 1 },
  teamRowActivityMuted: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, fontStyle: "italic" },
  teamRowStatusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  teamRowActiveText: { color: colors.success, fontFamily: fonts.monoSemiBold, fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase" },
  teamRowDormantText: { color: colors.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase" },
  dormantDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.muted, opacity: 0.5 },
  teamUnreadPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  teamUnreadPillText: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    color: colors.paperInk ?? "#0b1220",
    letterSpacing: 0.4,
  },
  // Legacy card-mode style keys kept as unused so removals don't cascade —
  // teamCardDesc / teamCardMeta / teamCardAvatars / miniAvatarWrap / teamCardMetaText
  // are no longer applied to the new row markup.
  teamCardAvatars: { flexDirection: "row" },
  miniAvatarWrap: { borderWidth: 1.5, borderColor: colors.background, borderRadius: radii.pill },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
    shadowColor: colors.success,
    shadowOpacity: 0.9,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  editPill: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(27,42,68,0.85)",
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  editPillText: { color: colors.accent, fontFamily: fonts.sansSemiBold, fontSize: 11 },

  // Detail card
  detailCard: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
    gap: spacing.sm,
  },
  // Compact identity block per Watch Teams brief §5 — activity is the
  // destination, so identity gets one horizontal row and Pulse content lands
  // in the first viewport instead of below a 210px cinematic header.
  detailHeaderCompact: {
    minHeight: 92,
    backgroundColor: colors.velvet,
    justifyContent: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  detailHeaderCompactRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  detailIconBadge: {
    width: 46,
    height: 46,
    borderRadius: radii.md,
    backgroundColor: "rgba(244,196,48,0.14)",
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.28)",
    alignItems: "center",
    justifyContent: "center",
  },
  detailIconBadgeText: { fontSize: 22 },
  detailHeaderOverflow: { padding: 6 },
  detailHeaderTint: { backgroundColor: "rgba(6,10,18,0.62)" },
  detailHeaderName: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 20,
    letterSpacing: -0.3,
  },
  detailHeaderDesc: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  unreadStrip: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: "rgba(244,196,48,0.12)",
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.30)",
  },
  unreadStripText: {
    color: colors.accent,
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  dnaRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "center", marginTop: 4 },
  dnaChip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: "rgba(46,196,182,0.35)",
    backgroundColor: "rgba(46,196,182,0.1)",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dnaChipText: { color: colors.success, fontFamily: fonts.monoSemiBold, fontSize: 11, letterSpacing: 0.3 },
  detailHeaderMeta: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  detailHeaderMetaText: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12 },
  inviteChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(244,196,48,0.1)",
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.28)",
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  inviteChipText: { color: colors.accent, fontFamily: fonts.monoSemiBold, fontSize: 11, letterSpacing: 0.5 },

  shareInviteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radii.lg,
    backgroundColor: "rgba(255,210,31,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,210,31,0.24)",
  },
  shareInviteLabel: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
  },
  shareInviteCode: {
    color: colors.accent,
    fontFamily: fonts.monoSemiBold,
    fontSize: 12,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  sheetSectionLabel: {
    color: colors.muted,
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },

  // Quick actions
  quickActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: spacing.md,
  },
  quickAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  quickActionText: { color: colors.accent, fontFamily: fonts.sansSemiBold, fontSize: 12 },

  // Quick composer bar — brief §5 one obvious entry point.
  composerBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
  },
  composerBarPlus: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(244,196,48,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  composerBarPlaceholder: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, flex: 1 },
  composerAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  composerActionIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(244,196,48,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  composerActionTitle: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 15 },
  composerActionBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, marginTop: 2 },

  // Tabs
  tabRow: { flexDirection: "row", gap: 6, flexWrap: "wrap", paddingHorizontal: spacing.md },
  tabPill: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  tabPillActive: { borderColor: colors.accent, backgroundColor: "rgba(244,196,48,0.12)" },
  tabPillText: { color: colors.muted, fontFamily: fonts.sansSemiBold, fontSize: 12 },
  tabPillTextActive: { color: colors.accent },
  sortRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 4 },
  tabPanel: { gap: 8, marginTop: 2, paddingHorizontal: spacing.md, paddingBottom: spacing.md },

  // Feed cards
  feedCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    backgroundColor: colors.backgroundElevated,
    overflow: "hidden",
    gap: 8,
  },
  feedHero: {
    height: 155,
    backgroundColor: colors.surface,
    justifyContent: "flex-end",
    padding: 12,
  },
  feedHeroShade: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 90,
    backgroundColor: "rgba(6,10,18,0.82)",
  },
  feedHeroTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 16, letterSpacing: -0.2 },
  feedHeroRating: { position: "absolute", bottom: -8, right: 12 },
  feedAuthorRow: { flexDirection: "row", gap: 8, alignItems: "center", paddingHorizontal: 12 },
  feedAuthorName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 13 },
  feedAuthorAction: { color: colors.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 1 },
  feedTime: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11 },
  feedBody: { color: colors.ink, fontFamily: fonts.sans, lineHeight: 20, fontSize: 13, paddingHorizontal: 12 },
  reactionStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    paddingHorizontal: 12,
  },
  reactionChip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  reactionChipActive: { borderColor: colors.accent, backgroundColor: "rgba(244,196,48,0.14)" },
  reactionChipText: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 12 },
  reactionAddChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: "transparent",
  },
  reactionAddText: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.4 },
  feedCommentToggle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, paddingHorizontal: 12 },
  commentRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingHorizontal: 12 },
  commentText: { color: colors.ink, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, flex: 1 },
  commentAuthor: { color: colors.ink, fontFamily: fonts.sansSemiBold },
  commentComposer: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, paddingTop: 4 },
  commentInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    color: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
  },
  commentSend: {
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  commentSendDisabled: { opacity: 0.4 },
  commentSendText: { color: colors.background, fontFamily: fonts.monoSemiBold, fontSize: 12 },

  // Titles tab
  titleRow: {
    flexDirection: "row",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    borderRadius: radii.xl,
    padding: 8,
  },
  titleName: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 },
  titleMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, marginTop: 1 },

  // Members tab
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.xl,
    padding: 10,
    backgroundColor: colors.backgroundElevated,
  },
  memberName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 13 },
  memberRole: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, marginTop: 1, textTransform: "capitalize" },
  followPill: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  followPillText: { color: colors.muted, fontFamily: fonts.sansSemiBold, fontSize: 11 },
  memberDangerPill: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: "rgba(255,77,77,0.1)",
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  memberDangerPillText: { color: colors.danger, fontFamily: fonts.sansSemiBold, fontSize: 11 },
  addMemberBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: "rgba(244,196,48,0.3)",
    backgroundColor: "rgba(244,196,48,0.08)",
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  addMemberBtnText: { color: colors.accent, fontFamily: fonts.sansSemiBold, fontSize: 13 },

  // Top 10 / Rankings
  rankRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.xl,
    backgroundColor: colors.backgroundElevated,
    padding: 10,
  },
  rankNum: {
    color: colors.accent,
    fontFamily: fonts.monoSemiBold,
    fontSize: 16,
    width: 32,
    textAlign: "center",
    letterSpacing: -0.5,
  },
  rankPoster: { width: 38, height: 55, borderRadius: radii.lg },
  rankPosterEmpty: { backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  rankTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14, letterSpacing: -0.1 },
  rankMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  rankRight: { alignItems: "flex-end", gap: 3 },
  rankScore: { color: colors.ink, fontFamily: fonts.monoSemiBold, fontSize: 15, letterSpacing: -0.3 },
  rankMovement: { fontFamily: fonts.monoSemiBold, fontSize: 13 },
  rankUp: { color: colors.success },
  rankDown: { color: colors.danger },
  rankSame: { color: colors.muted },

  // Empty state
  emptyCard: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 17 },
  emptyBody: { color: colors.muted, fontFamily: fonts.sans, lineHeight: 20, fontSize: 13 },
  emptyActions: { flexDirection: "row", gap: 8, marginTop: 4 },
  // Team Detail Pulse empty state — brief §9 P2.
  pulseEmpty: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  pulseEmptyTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 18,
    letterSpacing: -0.2,
  },
  pulseEmptyBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  pulseEmptyActions: { flexDirection: "row", gap: 8, marginTop: 8 },

  // CTAs
  primaryCta: {
    flex: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingVertical: 11,
    alignItems: "center",
  },
  primaryCtaDisabled: { opacity: 0.45 },
  primaryCtaText: { color: colors.background, fontFamily: fonts.monoSemiBold, fontSize: 13 },
  secondaryCta: {
    flex: 1,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryCtaText: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 13 },

  // Modals / Sheets
  modalBackdrop: { flex: 1, backgroundColor: "rgba(6,12,20,0.72)", justifyContent: "flex-end" },
  modalSheet: {
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.sm,
    maxHeight: "88%",
  },
  modalTitle: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 20 },
  sheetBody: { gap: spacing.sm, paddingBottom: spacing.sm },
  sheetFooterRow: { flexDirection: "row", gap: spacing.sm, paddingBottom: Platform.OS === "ios" ? 8 : 0 },
  sheetFooter: { paddingBottom: Platform.OS === "ios" ? 8 : 0 },
  sheetCancel: {
    flex: 1,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: 11,
    alignItems: "center",
  },
  sheetCancelText: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 12 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.xl,
    backgroundColor: colors.backgroundElevated,
    color: colors.ink,
    fontFamily: fonts.sans,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.backgroundElevated,
    padding: 8,
    marginBottom: 6,
  },
  memberSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.backgroundElevated,
    padding: 8,
    marginBottom: 6,
  },
  searchName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 13 },
  searchMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11 },
  selectedHint: { color: colors.accent, fontFamily: fonts.sansSemiBold, fontSize: 12 },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },

  // Feedback
  error: { color: colors.danger, paddingHorizontal: spacing.lg, fontSize: 12 },
  toast: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    paddingVertical: 10,
  },
  toastText: { color: colors.success, fontFamily: fonts.monoSemiBold, fontSize: 12 },
});
