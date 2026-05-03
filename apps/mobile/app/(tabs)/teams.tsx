import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LayoutAnimation,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";

import { SafeAreaView } from "react-native-safe-area-context";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, radii, spacing } from "@/constants/theme";
import { apiRequest, resolveMediaUrl, resolvedApiBaseUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

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
  latest_activity?: string | null;
  recent_member_avatars: string[];
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
  const { sessionToken, user } = useAuth();
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
  const [postRating, setPostRating] = useState("");
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

  const selectedTeamSummary = useMemo(() => teams.find((team) => team.id === selectedTeamId) ?? null, [teams, selectedTeamId]);
  const myMembership = useMemo(
    () => selectedTeam?.members.find((member) => member.user_id === user?.user_id) ?? null,
    [selectedTeam, user?.user_id]
  );
  const canManageTeam = myMembership?.role === "owner" || myMembership?.role === "admin";
  const titleById = useMemo(() => Object.fromEntries(titles.map((entry) => [entry.content_title_id, entry])), [titles]);

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
    if (!selectedTeam) {
      return;
    }
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
        };
      }
      return next;
    });
  }, [feed]);

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
    },
    [sessionToken]
  );

  useFocusEffect(
    useCallback(() => {
      async function load() {
        if (!sessionToken) return;
        setError(null);
        try {
          await loadTeams();
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load teams");
        }
      }
      void load();
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
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "Failed to join team");
    } finally {
      setIsBusy(false);
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
          rating: postRating ? Number(postRating) : null,
        }),
      });
      setShowCompose(false);
      setPostText("");
      setPostRating("");
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

  async function openTitleDetails(titleId: string, fallback: { id: string; title: string; content_type?: string; poster_url?: string | null }) {
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
        [activityId]: {
          ...state,
          comments: [...state.comments, comment],
          draft: "",
          expanded: true,
        },
      };
    });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.pageHeader}>
          <Text style={styles.pageKicker}>Your Crew</Text>
          <Text style={styles.pageTitle}>Watch Teams</Text>
          <Text style={styles.pageSub}>Private spaces for shared watchlists, rankings, hot takes, and team chaos.</Text>
        </View>
        <View style={styles.actionRow}>
          <Pressable style={styles.primaryCta} onPress={() => setShowCreate(true)}>
            <Text style={styles.primaryCtaText}>Create a New Team</Text>
          </Pressable>
          <Pressable style={styles.secondaryCta} onPress={() => setShowJoin(true)}>
            <Text style={styles.secondaryCtaText}>Join a Team</Text>
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>My Watch Teams</Text>
        </View>

        {teams.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No teams yet</Text>
            <Text style={styles.emptyBody}>Create your first Watch Team or join one to start building shared lists, rankings, and conversations.</Text>
          </View>
        ) : (
          teams.map((team) => (
            <Pressable
              key={team.id}
              style={[styles.teamCard, selectedTeamSummary?.id === team.id && styles.teamCardActive]}
              onPress={() => setSelectedTeamId(team.id)}
            >
              <View style={styles.teamCardTop}>
                <View style={styles.teamIconWrap}>
                  <Text style={styles.teamIcon}>{team.icon || "🍿"}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.teamName}>{team.name}</Text>
                  <Text numberOfLines={1} style={styles.teamDesc}>{team.description || "Private watch team"}</Text>
                </View>
                {selectedTeam?.id === team.id && canManageTeam ? (
                  <Pressable onPress={() => setShowEditTeam(true)} style={styles.editPill}>
                    <Text style={styles.editPillText}>Edit</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.teamCardBottom}>
                <View style={styles.avatarRow}>
                  {team.recent_member_avatars.slice(0, 4).map((avatar, idx) => (
                    <View key={avatar + idx} style={[styles.miniAvatarWrap, { marginLeft: idx === 0 ? 0 : -8 }]}>
                      <Avatar uri={avatar} label="U" size={24} />
                    </View>
                  ))}
                </View>
                <Text style={styles.teamMeta}>{team.member_count} members</Text>
              </View>
            </Pressable>
          ))
        )}

        {selectedTeam ? (
          <View style={styles.detailCard}>
            <View style={styles.detailHero}>
              <View style={styles.teamHeroIconWrap}>
                <Text style={styles.teamHeroEmoji}>{selectedTeam.icon || "🍿"}</Text>
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.detailName}>{selectedTeam.name}</Text>
                <Text style={styles.detailMeta}>{selectedTeam.member_count}/{selectedTeam.max_members} · {selectedTeam.visibility}</Text>
                {selectedTeam.description ? <Text style={styles.detailDesc}>{selectedTeam.description}</Text> : null}
              </View>
            </View>
            <View style={styles.inviteCodeRow}>
              <Ionicons name="link-outline" size={12} color={colors.accent} />
              <Text style={styles.inviteCodeText}>Invite: {selectedTeam.invite_code}</Text>
            </View>

            <View style={styles.quickRow}>
              <Pressable style={styles.quickButton} onPress={() => setShowAddTitle(true)}><Text style={styles.quickButtonText}>Add Title</Text></Pressable>
              <Pressable style={styles.quickButton} onPress={() => setShowCompose(true)}><Text style={styles.quickButtonText}>Post to Team Feed</Text></Pressable>
              <Pressable style={styles.quickButton} onPress={() => setTeamTab("top10")}><Text style={styles.quickButtonText}>View Top 10</Text></Pressable>
              {canManageTeam ? (
                <Pressable style={styles.quickButton} onPress={() => setShowEditTeam(true)}><Text style={styles.quickButtonText}>Edit Team</Text></Pressable>
              ) : null}
              {canManageTeam ? (
                <Pressable style={styles.quickButton} onPress={() => setShowAddMember(true)}><Text style={styles.quickButtonText}>Add Member</Text></Pressable>
              ) : null}
            </View>

            <View style={styles.tabRow}>
              <TabPill label="Feed" active={teamTab === "feed"} onPress={() => setTeamTab("feed")} />
              <TabPill label="Titles" active={teamTab === "titles"} onPress={() => setTeamTab("titles")} />
              <TabPill label="Members" active={teamTab === "members"} onPress={() => setTeamTab("members")} />
              <TabPill label="Top 10" active={teamTab === "top10"} onPress={() => setTeamTab("top10")} />
            </View>

            {teamTab === "titles" ? (
              <View style={styles.tabPanel}>
                <View style={styles.sortRow}>
                  <TabPill label="Recently added" active={titleSort === "recent"} onPress={() => setTitleSort("recent")} />
                  <TabPill label="Highest ranked" active={titleSort === "ranked"} onPress={() => setTitleSort("ranked")} />
                  <TabPill label="Most discussed" active={titleSort === "discussed"} onPress={() => setTitleSort("discussed")} />
                  <TabPill label="A-Z" active={titleSort === "alpha"} onPress={() => setTitleSort("alpha")} />
                </View>
                {sortedTitles.length === 0 ? <Text style={styles.emptyBody}>No titles added yet. Search for a movie or show and add it to this team.</Text> : null}
                {sortedTitles.map((entry) => (
                  <Pressable
                    key={entry.id}
                    style={styles.titleRow}
                    onPress={() => void openTitleDetails(entry.content_title_id, { id: entry.content_title_id, title: entry.title_name, content_type: entry.content_type, poster_url: entry.poster_url })}
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

            {teamTab === "feed" ? (
              <View style={styles.tabPanel}>
                {feed.length === 0 ? <Text style={styles.emptyBody}>No posts yet. Start the conversation by recommending a title or sharing a reaction.</Text> : null}
                {feed.map((item) => (
                  <View key={item.id} style={styles.feedCard}>
                    {item.content_title_id && titleById[item.content_title_id] ? (
                      <Pressable
                        style={styles.teamFeedHero}
                        onPress={() =>
                          void openTitleDetails(item.content_title_id!, {
                            id: item.content_title_id!,
                            title: titleById[item.content_title_id!].title_name,
                            content_type: titleById[item.content_title_id!].content_type,
                            poster_url: titleById[item.content_title_id!].poster_url,
                          })
                        }
                      >
                        <Image
                          source={{ uri: resolveMediaUrl(titleById[item.content_title_id].poster_url) ?? undefined }}
                          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
                          resizeMode="cover"
                        />
                        <View style={styles.teamFeedHeroShade} />
                        <Text style={styles.teamFeedHeroTitle}>{titleById[item.content_title_id].title_name}</Text>
                      </Pressable>
                    ) : null}
                    <View style={styles.feedTop}>
                      <Avatar uri={item.actor_avatar_url} label={item.actor_display_name || "U"} size={28} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.feedName}>{item.actor_display_name || "Member"}</Text>
                        <Text style={styles.feedType}>{readableFeedType(item.activity_type)}</Text>
                      </View>
                      <Text style={styles.feedTime}>{relativeTime(item.created_at)}</Text>
                    </View>
                    <Text style={styles.feedBody}>{String(item.payload.text || item.payload.comment || item.payload.title_name || "")}</Text>
                    <View style={styles.reactionStrip}>
                      {[
                        { key: "fire" as const, icon: "🔥", label: "Fire" },
                        { key: "heart" as const, icon: "❤️", label: "Heart" },
                        { key: "thumbsDown" as const, icon: "👎", label: "Thumbs Down" },
                        { key: "tomato" as const, icon: "🍅", label: "Tomato" },
                      ].map((reaction) => (
                        <Pressable
                          key={reaction.key}
                          onPress={() => toggleTeamReaction(item.id, reaction.key)}
                          style={[
                            styles.reactionChip,
                            feedInteractions[item.id]?.viewerReaction === reaction.key && styles.reactionChipActive,
                          ]}
                        >
                          <Text style={styles.reactionChipText}>{reaction.icon} {feedInteractions[item.id]?.reactions[reaction.key] ?? 0}</Text>
                        </Pressable>
                      ))}
                    </View>
                    {(feedInteractions[item.id]?.comments.length ?? 0) > 0 ? (
                      <Pressable
                        onPress={() =>
                          setFeedInteractions((current) => {
                            const state = current[item.id];
                            if (!state) return current;
                            return {
                              ...current,
                              [item.id]: { ...state, expanded: !state.expanded },
                            };
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
                    {(feedInteractions[item.id]?.expanded
                      ? feedInteractions[item.id]?.comments
                      : (feedInteractions[item.id]?.comments ?? []).slice(0, 2)
                    )?.map((comment) => (
                      <View key={comment.id} style={styles.teamCommentRow}>
                        <Avatar uri={comment.author_avatar} label={comment.author_name} size={22} />
                        <Text style={styles.teamCommentText}>
                          <Text style={styles.teamCommentAuthor}>{comment.author_name}: </Text>
                          {comment.text}
                        </Text>
                      </View>
                    ))}
                    <View style={styles.teamCommentComposer}>
                      <TextInput
                        value={feedInteractions[item.id]?.draft ?? ""}
                        onChangeText={(value) =>
                          setFeedInteractions((current) => {
                            const state = current[item.id];
                            if (!state) return current;
                            return {
                              ...current,
                              [item.id]: { ...state, draft: value },
                            };
                          })
                        }
                        placeholder="Add a comment..."
                        placeholderTextColor={colors.muted}
                        style={styles.teamCommentInput}
                      />
                      <Pressable
                        onPress={() => submitTeamComment(item.id)}
                        style={[
                          styles.teamCommentSend,
                          !(feedInteractions[item.id]?.draft ?? "").trim() && styles.teamCommentSendDisabled,
                        ]}
                        disabled={!(feedInteractions[item.id]?.draft ?? "").trim()}
                      >
                        <Text style={styles.teamCommentSendText}>Send</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {teamTab === "members" ? (
              <View style={styles.tabPanel}>
                {selectedTeam.members.map((member) => (
                  <View key={member.user_id} style={styles.memberRow}>
                    <Avatar uri={member.avatar_url} label={member.display_name || "U"} size={30} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>{member.display_name || "Member"}</Text>
                      <Text style={styles.memberRole}>{member.role}</Text>
                    </View>
                    {canManageTeam && member.user_id !== user?.user_id && member.role !== "owner" ? (
                      <Pressable style={styles.memberDangerPill} onPress={() => void removeMember(member.user_id)}>
                        <Text style={styles.memberDangerPillText}>Remove</Text>
                      </Pressable>
                    ) : (
                      <Pressable style={styles.followPill}><Text style={styles.followPillText}>Follow</Text></Pressable>
                    )}
                  </View>
                ))}
                {canManageTeam ? (
                  <Pressable style={styles.quickButton} onPress={() => setShowAddMember(true)}>
                    <Text style={styles.quickButtonText}>Add Member</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {teamTab === "top10" ? (
              <View style={styles.tabPanel}>
                {rankings.length === 0 ? <Text style={styles.emptyBody}>No rankings yet.</Text> : null}
                {rankings.map((row) => (
                  <Pressable
                    key={row.id}
                    style={styles.rankRow}
                    onPress={() => void openTitleDetails(row.content_title_id, { id: row.content_title_id, title: row.title_name, poster_url: row.poster_url })}
                  >
                    <Text style={styles.rankNumber}>#{row.rank}</Text>
                    <PosterThumb uri={row.poster_url} small />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rankTitle}>{row.title_name}</Text>
                      <Text style={styles.rankMeta}>Score {row.score.toFixed(1)} · {row.movement}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

          {error ? <Text style={styles.error}>{error} ({resolvedApiBaseUrl})</Text> : null}
      </ScrollView>

      <KeyboardSheet visible={showCreate} onClose={() => setShowCreate(false)}>
        <Text style={styles.modalTitle}>Create Team</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput value={createName} onChangeText={setCreateName} placeholder="Team name" placeholderTextColor={colors.muted} style={styles.input} />
          <TextInput value={createDescription} onChangeText={setCreateDescription} placeholder="Team description" placeholderTextColor={colors.muted} style={styles.input} multiline />
          <TextInput value={createIcon} onChangeText={setCreateIcon} placeholder="Icon/emoji" placeholderTextColor={colors.muted} style={styles.input} />
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
          <Pressable style={styles.secondaryCta} onPress={() => void joinByCode(joinCode)} disabled={isBusy}><Text style={styles.secondaryCtaText}>Join by Code</Text></Pressable>
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
          <TextInput value={titleRank} onChangeText={setTitleRank} placeholder="Suggested rank (1-10, optional)" placeholderTextColor={colors.muted} style={styles.input} keyboardType="numeric" />
          <View style={styles.switchRow}><Text style={styles.searchMeta}>Also post to team feed</Text><Switch value={alsoPost} onValueChange={setAlsoPost} trackColor={{ true: colors.accent }} /></View>
        </ScrollView>
        <View style={styles.sheetFooter}>
          <View style={styles.sheetFooterRow}>
            <Pressable style={styles.sheetCancel} onPress={() => setShowAddTitle(false)}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.primaryCta, (isBusy || !selectedTitle) && styles.primaryCtaDisabled]} onPress={() => void addTitleToTeam()} disabled={isBusy || !selectedTitle}><Text style={styles.primaryCtaText}>Add to Team</Text></Pressable>
          </View>
        </View>
      </KeyboardSheet>

      <KeyboardSheet visible={showCompose} onClose={() => setShowCompose(false)}>
        <Text style={styles.modalTitle}>Post to {selectedTeam?.name}</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
          <TextInput value={postText} onChangeText={setPostText} placeholder={`Post to ${selectedTeam?.name || "team"}`} placeholderTextColor={colors.muted} style={styles.input} multiline />
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
          <TextInput value={postRating} onChangeText={setPostRating} placeholder="Share your rating (optional)" placeholderTextColor={colors.muted} style={styles.input} keyboardType="numeric" />
        </ScrollView>
        <View style={styles.sheetFooter}>
          <Pressable style={styles.primaryCta} onPress={() => void postToTeamFeed()} disabled={isBusy}><Text style={styles.primaryCtaText}>Post</Text></Pressable>
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
            onPress={() => {
              setShowEditTeam(false);
              setShowAddMember(true);
            }}
          >
            <Text style={styles.sheetCancelText}>Add Member</Text>
          </Pressable>
        </ScrollView>
        <View style={styles.sheetFooter}>
          <Pressable style={styles.primaryCta} onPress={() => void saveTeamEdits()} disabled={isBusy || !canManageTeam}><Text style={styles.primaryCtaText}>Save Team</Text></Pressable>
        </View>
      </KeyboardSheet>

      <KeyboardSheet visible={showAddMember} onClose={() => setShowAddMember(false)}>
        <Text style={styles.modalTitle}>Add Member</Text>
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
            <Text style={styles.primaryCtaText}>Add Member</Text>
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
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onSaved={(listName, alreadySaved) => setToast(alreadySaved ? `Already in ${listName}` : `Saved to ${listName}`)}
        onError={(message) => setError(message)}
      />

      {toast ? <View style={styles.toast}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </SafeAreaView>
  );
}

function KeyboardSheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
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

function Avatar({ uri, label, size }: { uri?: string | null; label: string; size: number }) {
  const resolved = resolveMediaUrl(uri);
  if (resolved) {
    return <Image source={{ uri: resolved }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surface }} />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceSoft, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: colors.muted, fontWeight: "700", fontSize: 11 }}>{label.slice(0, 1).toUpperCase()}</Text>
    </View>
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
    <View style={{ width, height, borderRadius: 6, backgroundColor: colors.backgroundElevated, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
      <Ionicons name="film" size={small ? 12 : 16} color={colors.muted} />
    </View>
  );
}

function relativeTime(dateString: string) {
  const diff = Math.max(Date.now() - new Date(dateString).getTime(), 0);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readableFeedType(type: string) {
  switch (type) {
    case "title_added":
      return "added a title";
    case "team_post":
      return "posted to the team";
    case "watchlist_item_added":
      return "added to Watchlist";
    case "activity_reacted":
      return "reacted to a post";
    case "activity_commented":
      return "commented on a post";
    case "member_joined":
      return "joined the team";
    case "ranking_updated":
      return "updated rankings";
    case "poll_started":
      return "started a poll";
    default:
      return type.replaceAll("_", " ");
  }
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { gap: spacing.md, paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  pageHeader: { gap: 4, paddingTop: spacing.sm },
  pageKicker: { color: colors.accent, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1.3 },
  pageTitle: { color: colors.ink, fontSize: 32, fontWeight: "900", letterSpacing: -0.5 },
  pageSub: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  actionRow: { flexDirection: "row", gap: spacing.sm },
  primaryCta: { flex: 1, borderRadius: radii.pill, backgroundColor: colors.accent, paddingVertical: 11, alignItems: "center" },
  primaryCtaDisabled: { opacity: 0.45 },
  primaryCtaText: { color: colors.background, fontWeight: "800", fontSize: 12 },
  secondaryCta: { flex: 1, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingVertical: 11, alignItems: "center" },
  secondaryCtaText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  sectionHeader: { marginTop: 4 },
  sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  emptyCard: { borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.lg },
  emptyTitle: { color: colors.ink, fontWeight: "800", fontSize: 16 },
  emptyBody: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  teamCard: { borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
  teamCardActive: { borderColor: colors.accent, backgroundColor: "rgba(244,196,48,0.08)" },
  teamCardTop: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  teamCardBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  teamIconWrap: { width: 40, height: 40, borderRadius: 12, backgroundColor: "rgba(244,196,48,0.12)", borderWidth: 1, borderColor: "rgba(244,196,48,0.22)", alignItems: "center", justifyContent: "center" },
  editPill: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundElevated, borderRadius: radii.pill, paddingHorizontal: 10, paddingVertical: 6 },
  editPillText: { color: colors.accent, fontSize: 11, fontWeight: "700" },
  teamIcon: { fontSize: 20 },
  teamName: { color: colors.ink, fontWeight: "900", fontSize: 16 },
  teamDesc: { color: colors.muted, marginTop: 2, fontSize: 12, lineHeight: 17 },
  teamMeta: { color: colors.muted, fontSize: 11 },
  avatarRow: { flexDirection: "row" },
  miniAvatarWrap: { borderWidth: 1, borderColor: colors.background, borderRadius: radii.pill },
  detailCard: { borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.sm },
  detailHero: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  teamHeroIconWrap: { width: 52, height: 52, borderRadius: 16, backgroundColor: "rgba(244,196,48,0.12)", borderWidth: 1, borderColor: "rgba(244,196,48,0.28)", alignItems: "center", justifyContent: "center" },
  teamHeroEmoji: { fontSize: 26 },
  inviteCodeRow: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(244,196,48,0.07)", borderRadius: 10, borderWidth: 1, borderColor: "rgba(244,196,48,0.2)", paddingHorizontal: 10, paddingVertical: 7, alignSelf: "flex-start" },
  inviteCodeText: { color: colors.accent, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  detailName: { color: colors.ink, fontSize: 21, fontWeight: "900" },
  detailMeta: { color: colors.muted, fontSize: 12 },
  detailDesc: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  quickRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  quickButton: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundElevated, paddingVertical: 8, paddingHorizontal: 12 },
  quickButtonText: { color: colors.accent, fontSize: 12, fontWeight: "700" },
  tabRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  tabPill: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundElevated, paddingVertical: 7, paddingHorizontal: 10 },
  tabPillActive: { borderColor: colors.accent, backgroundColor: "rgba(244,196,48,0.14)" },
  tabPillText: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  tabPillTextActive: { color: colors.accent },
  sortRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 4 },
  tabPanel: { gap: 8, marginTop: 2 },
  titleRow: { flexDirection: "row", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundElevated, borderRadius: 12, padding: 8 },
  titleName: { color: colors.ink, fontWeight: "800", fontSize: 14 },
  titleMeta: { color: colors.muted, fontSize: 12, marginTop: 1 },
  feedCard: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.backgroundElevated, padding: 10, gap: 6 },
  feedTop: { flexDirection: "row", gap: 8, alignItems: "center" },
  feedName: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  feedType: { color: colors.muted, fontSize: 11 },
  feedTime: { color: colors.muted, fontSize: 11 },
  feedBody: { color: colors.ink, lineHeight: 20, fontSize: 13 },
  teamFeedHero: { height: 100, borderRadius: 12, overflow: "hidden", backgroundColor: colors.backgroundElevated, justifyContent: "flex-end", padding: 10 },
  teamFeedHeroShade: { position: "absolute", bottom: 0, left: 0, right: 0, height: 70, backgroundColor: "rgba(7,11,19,0.75)" },
  teamFeedHeroTitle: { color: colors.ink, fontWeight: "800", fontSize: 15, letterSpacing: -0.2 },
  reactionStrip: { flexDirection: "row", gap: 8, marginTop: 2, flexWrap: "wrap" },
  reactionChip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 4 },
  reactionChipActive: { borderColor: colors.accent, backgroundColor: "rgba(244,196,48,0.14)" },
  reactionChipText: { color: colors.ink, fontSize: 12, fontWeight: "700" },
  feedCommentToggle: { color: colors.muted, fontSize: 12, marginTop: 2 },
  teamCommentRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 2 },
  teamCommentText: { color: colors.ink, fontSize: 12, lineHeight: 18, flex: 1 },
  teamCommentAuthor: { color: colors.ink, fontWeight: "800" },
  teamCommentComposer: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  teamCommentInput: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, backgroundColor: colors.surface, color: colors.ink, paddingHorizontal: 12, paddingVertical: 8, fontSize: 12 },
  teamCommentSend: { borderRadius: radii.pill, backgroundColor: colors.accent, paddingHorizontal: 12, paddingVertical: 8 },
  teamCommentSendDisabled: { opacity: 0.45 },
  teamCommentSendText: { color: colors.background, fontWeight: "800", fontSize: 12 },
  commentPrompt: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, backgroundColor: colors.surface, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6 },
  commentPromptText: { color: colors.muted, fontSize: 12 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 8, backgroundColor: colors.backgroundElevated },
  memberName: { color: colors.ink, fontWeight: "700", fontSize: 13 },
  memberRole: { color: colors.muted, fontSize: 11 },
  followPill: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingVertical: 6, paddingHorizontal: 10 },
  followPillText: { color: colors.muted, fontWeight: "700", fontSize: 11 },
  memberDangerPill: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.danger, backgroundColor: "rgba(255,77,77,0.12)", paddingVertical: 6, paddingHorizontal: 10 },
  memberDangerPillText: { color: colors.danger, fontWeight: "700", fontSize: 11 },
  rankRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.backgroundElevated, padding: 8 },
  rankNumber: { color: colors.accent, fontWeight: "900", width: 26 },
  rankTitle: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  rankMeta: { color: colors.muted, fontSize: 11 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(6,12,20,0.72)", justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.lg, gap: spacing.sm, maxHeight: "88%" },
  modalTitle: { color: colors.ink, fontWeight: "900", fontSize: 20 },
  sheetBody: { gap: spacing.sm, paddingBottom: spacing.sm },
  sheetFooterRow: { flexDirection: "row", gap: spacing.sm, paddingBottom: Platform.OS === "ios" ? 8 : 0 },
  sheetFooter: { paddingBottom: Platform.OS === "ios" ? 8 : 0 },
  sheetCancel: { flex: 1, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundElevated, paddingVertical: 11, alignItems: "center" },
  sheetCancelText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.backgroundElevated, color: colors.ink, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.backgroundElevated, padding: 8, marginBottom: 6 },
  memberSearchRow: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.backgroundElevated, padding: 8, marginBottom: 6 },
  searchName: { color: colors.ink, fontWeight: "700", fontSize: 13 },
  searchMeta: { color: colors.muted, fontSize: 11 },
  selectedHint: { color: colors.accent, fontSize: 12, fontWeight: "700" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  error: { color: colors.danger },
  toast: { position: "absolute", left: spacing.lg, right: spacing.lg, bottom: spacing.xl, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", paddingVertical: 10 },
  toastText: { color: colors.success, fontWeight: "800", fontSize: 12 },
});
