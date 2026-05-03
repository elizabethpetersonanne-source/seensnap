import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";

import { AddToTeamSheet } from "@/components/add-to-team-sheet";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { FeedSkeleton } from "@/components/shimmer";
import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, radii, spacing } from "@/constants/theme";
import { pressIn, pressOut, toastIn, toastOut } from "@/lib/motion";
import { apiRequest, resolveMediaUrl, resolvedApiBaseUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fetchUniversalTitle, type UniversalTitle } from "@/lib/universal-title";

type FeedSegment = "for-you" | "watch-teams" | "discover";
type ReactionKey = "fire" | "heart" | "thumbs_down" | "tomato";

type Title = {
  id: string;
  tmdb_id: number;
  content_type: string;
  title: string;
  overview?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  genres: string[];
  release_date?: string | null;
  runtime_minutes?: number | null;
  season_count?: number | null;
  tmdb_rating?: number | null;
  language?: string | null;
  director?: string | null;
  top_cast?: string[];
  wikipedia_url?: string | null;
  metadata_source?: string;
};

type FeedEvent = {
  id: string;
  team_id?: string | null;
  event_type: string;
  source_type: string;
  source_id?: string | null;
  actor: {
    user_id: string;
    display_name?: string | null;
    avatar_url?: string | null;
    is_following?: boolean;
  };
  title?: {
    id: string;
    content_type: string;
    title: string;
    poster_url?: string | null;
    backdrop_url?: string | null;
  } | null;
  payload: Record<string, unknown>;
  reaction_counts: Record<string, number>;
  comment_count: number;
  my_reaction?: string | null;
  can_delete?: boolean;
  created_at: string;
};

type FeedComment = {
  id: string;
  event_id: string;
  user_id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  body: string;
  parent_comment_id?: string | null;
  can_delete?: boolean;
  created_at: string;
};

const reactionOptions: Array<{ key: ReactionKey; icon: string; label: string }> = [
  { key: "fire", icon: "🔥", label: "Fire" },
  { key: "heart", icon: "❤️", label: "Heart" },
  { key: "thumbs_down", icon: "👎", label: "Thumbs Down" },
  { key: "tomato", icon: "🍅", label: "Tomato" },
];

// Demo seed data — shown when the real feed returns empty
const D_ACTORS = {
  maya: { user_id: "demo-u1", display_name: "Maya Chen", avatar_url: "https://i.pravatar.cc/150?u=maya.chen" },
  jordan: { user_id: "demo-u2", display_name: "Jordan Williams", avatar_url: "https://i.pravatar.cc/150?u=jordan.williams" },
  alex: { user_id: "demo-u3", display_name: "Alex Rivera", avatar_url: "https://i.pravatar.cc/150?u=alex.rivera" },
  sam: { user_id: "demo-u4", display_name: "Sam Torres", avatar_url: "https://i.pravatar.cc/150?u=sam.torres" },
  priya: { user_id: "demo-u5", display_name: "Priya Patel", avatar_url: "https://i.pravatar.cc/150?u=priya.patel" },
  marco: { user_id: "demo-u6", display_name: "Marco Rossi", avatar_url: "https://i.pravatar.cc/150?u=marco.rossi" },
  riley: { user_id: "demo-u7", display_name: "Riley Johnson", avatar_url: "https://i.pravatar.cc/150?u=riley.johnson" },
  zoe: { user_id: "demo-u8", display_name: "Zoe Kim", avatar_url: "https://i.pravatar.cc/150?u=zoe.kim" },
  dev: { user_id: "demo-u9", display_name: "Dev Sharma", avatar_url: "https://i.pravatar.cc/150?u=dev.sharma" },
  cleo: { user_id: "demo-u10", display_name: "Cleo Martinez", avatar_url: "https://i.pravatar.cc/150?u=cleo.martinez" },
  nate: { user_id: "demo-u11", display_name: "Nate Okonkwo", avatar_url: "https://i.pravatar.cc/150?u=nate.okonkwo" },
  hana: { user_id: "demo-u12", display_name: "Hana Mizuki", avatar_url: "https://i.pravatar.cc/150?u=hana.mizuki" },
  felix: { user_id: "demo-u13", display_name: "Felix Dubois", avatar_url: "https://i.pravatar.cc/150?u=felix.dubois" },
  lena: { user_id: "demo-u14", display_name: "Lena Vasquez", avatar_url: "https://i.pravatar.cc/150?u=lena.vasquez" },
  omar: { user_id: "demo-u15", display_name: "Omar Hassan", avatar_url: "https://i.pravatar.cc/150?u=omar.hassan" },
  sienna: { user_id: "demo-u16", display_name: "Sienna Park", avatar_url: "https://i.pravatar.cc/150?u=sienna.park" },
  tobias: { user_id: "demo-u17", display_name: "Tobias Müller", avatar_url: "https://i.pravatar.cc/150?u=tobias.muller" },
  amara: { user_id: "demo-u18", display_name: "Amara Osei", avatar_url: "https://i.pravatar.cc/150?u=amara.osei" },
  kieran: { user_id: "demo-u19", display_name: "Kieran Walsh", avatar_url: "https://i.pravatar.cc/150?u=kieran.walsh" },
  nova: { user_id: "demo-u20", display_name: "Nova Sterling", avatar_url: "https://i.pravatar.cc/150?u=nova.sterling" },
};

const DEMO_FEED_EVENTS: FeedEvent[] = [
  {
    id: "demo-e1",
    event_type: "friend_rating",
    source_type: "user",
    actor: { ...D_ACTORS.maya, is_following: true },
    title: { id: "demo-t1", content_type: "series", title: "Succession", poster_url: null, backdrop_url: null },
    payload: { rating: 10, caption: "The finale. I'm not okay. Ten seasons of this and they stuck the landing — the Roy family is genuinely one of the greatest ensembles ever put to screen.", action_label: "rated a series" },
    reaction_counts: { fire: 18, heart: 24, thumbs_down: 0, tomato: 1 },
    comment_count: 6,
    my_reaction: null,
    created_at: "2026-05-02T12:00:00Z",
  },
  {
    id: "demo-e2",
    event_type: "wall_post",
    source_type: "user",
    actor: { ...D_ACTORS.jordan, is_following: false },
    title: { id: "demo-t2", content_type: "series", title: "The Bear", poster_url: null, backdrop_url: null },
    payload: { caption: "Season 3 just dropped and the kitchen scenes are more intense than ever. Carmy has lost his mind in the best possible way. Cannot stop watching.", action_label: "posted to Social Wall" },
    reaction_counts: { fire: 31, heart: 12, thumbs_down: 2, tomato: 0 },
    comment_count: 8,
    my_reaction: null,
    created_at: "2026-05-02T11:00:00Z",
  },
  {
    id: "demo-e3",
    event_type: "friend_rating",
    source_type: "user",
    actor: { ...D_ACTORS.priya, is_following: true },
    title: { id: "demo-t3", content_type: "movie", title: "Killers of the Flower Moon", poster_url: null, backdrop_url: null },
    payload: { rating: 9, caption: "Scorsese at 80 making a 3.5-hour film that doesn't waste a single frame. Lily Gladstone is devastating. This is the one they'll study in 50 years.", action_label: "rated a movie" },
    reaction_counts: { fire: 44, heart: 37, thumbs_down: 0, tomato: 3 },
    comment_count: 11,
    my_reaction: null,
    created_at: "2026-05-01T20:00:00Z",
  },
  {
    id: "demo-e4",
    event_type: "wall_post",
    source_type: "user",
    actor: { ...D_ACTORS.alex, is_following: false },
    title: { id: "demo-t4", content_type: "movie", title: "Dune: Part Two", poster_url: null, backdrop_url: null },
    payload: { caption: "Villeneuve just does not miss. The sandworm riding sequence is the most cinematic thing I've seen in a theater in years. Zendaya's arc hit different than I expected.", action_label: "posted to Social Wall" },
    reaction_counts: { fire: 52, heart: 28, thumbs_down: 1, tomato: 0 },
    comment_count: 9,
    my_reaction: null,
    created_at: "2026-05-01T14:00:00Z",
  },
  {
    id: "demo-e5",
    event_type: "watch_team_alert",
    source_type: "team",
    team_id: "demo-team1",
    actor: { ...D_ACTORS.marco, is_following: false },
    title: { id: "demo-t5", content_type: "series", title: "Shōgun", poster_url: null, backdrop_url: null },
    payload: { caption: "Cinema Club is watching Shōgun this week. Hiroyuki Sanada produced and stars in this and it absolutely shows — the cultural detail is meticulous. Join us for a live watch Thursday.", action_label: "added to Watch Team", cta: "View Details" },
    reaction_counts: { fire: 14, heart: 9, thumbs_down: 0, tomato: 0 },
    comment_count: 4,
    my_reaction: null,
    created_at: "2026-05-01T09:00:00Z",
  },
];

const DEMO_FEED_COMMENTS: Record<string, FeedComment[]> = {
  "demo-e1": [
    { id: "demo-c1a", event_id: "demo-e1", user_id: D_ACTORS.sam.user_id, display_name: D_ACTORS.sam.display_name, avatar_url: D_ACTORS.sam.avatar_url, body: "The 'living+ dead' line in the last episode is going to haunt me forever.", parent_comment_id: null, created_at: "2026-05-02T12:14:00Z" },
    { id: "demo-c1b", event_id: "demo-e1", user_id: D_ACTORS.zoe.user_id, display_name: D_ACTORS.zoe.display_name, avatar_url: D_ACTORS.zoe.avatar_url, body: "Agreed. Kendall's face when he hears the board decision... Matthew Macfadyen deserved every award.", parent_comment_id: "demo-c1a", created_at: "2026-05-02T12:22:00Z" },
    { id: "demo-c1c", event_id: "demo-e1", user_id: D_ACTORS.nate.user_id, display_name: D_ACTORS.nate.display_name, avatar_url: D_ACTORS.nate.avatar_url, body: "Team Siobhan here but I respect this take. Show was firing on all cylinders.", parent_comment_id: "demo-c1a", created_at: "2026-05-02T12:38:00Z" },
    { id: "demo-c1d", event_id: "demo-e1", user_id: D_ACTORS.hana.user_id, display_name: D_ACTORS.hana.display_name, avatar_url: D_ACTORS.hana.avatar_url, body: "The score alone is worth the 10/10. Nicholas Britell is a genius.", parent_comment_id: null, created_at: "2026-05-02T13:05:00Z" },
    { id: "demo-c1e", event_id: "demo-e1", user_id: D_ACTORS.riley.user_id, display_name: D_ACTORS.riley.display_name, avatar_url: D_ACTORS.riley.avatar_url, body: "Rewatching from season 1 after this. The callbacks in the finale are everywhere once you know.", parent_comment_id: null, created_at: "2026-05-02T13:20:00Z" },
    { id: "demo-c1f", event_id: "demo-e1", user_id: D_ACTORS.felix.user_id, display_name: D_ACTORS.felix.display_name, avatar_url: D_ACTORS.felix.avatar_url, body: "100% agree, the rewatch hits even harder when you know where everyone ends up.", parent_comment_id: "demo-c1e", created_at: "2026-05-02T13:45:00Z" },
  ],
  "demo-e2": [
    { id: "demo-c2a", event_id: "demo-e2", user_id: D_ACTORS.lena.user_id, display_name: D_ACTORS.lena.display_name, avatar_url: D_ACTORS.lena.avatar_url, body: "The episode where it's just one continuous shot through service — I've never felt such anxiety watching TV.", parent_comment_id: null, created_at: "2026-05-02T11:18:00Z" },
    { id: "demo-c2b", event_id: "demo-e2", user_id: D_ACTORS.omar.user_id, display_name: D_ACTORS.omar.display_name, avatar_url: D_ACTORS.omar.avatar_url, body: "That oner is genuinely one of the best pieces of television ever made. Season 2's 'Fishes' is peak though.", parent_comment_id: "demo-c2a", created_at: "2026-05-02T11:33:00Z" },
    { id: "demo-c2c", event_id: "demo-e2", user_id: D_ACTORS.priya.user_id, display_name: D_ACTORS.priya.display_name, avatar_url: D_ACTORS.priya.avatar_url, body: "Ayo Edebiri went from unknown to everywhere so fast and she earned every bit of it.", parent_comment_id: null, created_at: "2026-05-02T11:50:00Z" },
    { id: "demo-c2d", event_id: "demo-e2", user_id: D_ACTORS.sienna.user_id, display_name: D_ACTORS.sienna.display_name, avatar_url: D_ACTORS.sienna.avatar_url, body: "Yes the casting on this whole show is immaculate. Richie's arc in season 2 made me cry.", parent_comment_id: "demo-c2c", created_at: "2026-05-02T12:08:00Z" },
    { id: "demo-c2e", event_id: "demo-e2", user_id: D_ACTORS.maya.user_id, display_name: D_ACTORS.maya.display_name, avatar_url: D_ACTORS.maya.avatar_url, body: "Adding to my rewatch list immediately. Need to be ready for whenever s4 drops.", parent_comment_id: null, created_at: "2026-05-02T12:25:00Z" },
  ],
  "demo-e3": [
    { id: "demo-c3a", event_id: "demo-e3", user_id: D_ACTORS.tobias.user_id, display_name: D_ACTORS.tobias.display_name, avatar_url: D_ACTORS.tobias.avatar_url, body: "Lily Gladstone in every scene she's in made me forget I was watching a film. Just devastating.", parent_comment_id: null, created_at: "2026-05-01T20:30:00Z" },
    { id: "demo-c3b", event_id: "demo-e3", user_id: D_ACTORS.amara.user_id, display_name: D_ACTORS.amara.display_name, avatar_url: D_ACTORS.amara.avatar_url, body: "De Niro's performance in this is criminally underseen. His final act is chilling.", parent_comment_id: "demo-c3a", created_at: "2026-05-01T20:48:00Z" },
    { id: "demo-c3c", event_id: "demo-e3", user_id: D_ACTORS.kieran.user_id, display_name: D_ACTORS.kieran.display_name, avatar_url: D_ACTORS.kieran.avatar_url, body: "The fact that this is based on actual events makes every moment hit twice as hard.", parent_comment_id: null, created_at: "2026-05-01T21:15:00Z" },
    { id: "demo-c3d", event_id: "demo-e3", user_id: D_ACTORS.nova.user_id, display_name: D_ACTORS.nova.display_name, avatar_url: D_ACTORS.nova.avatar_url, body: "Agreed. I went in knowing the history and was still floored. Scorsese does not flinch.", parent_comment_id: "demo-c3c", created_at: "2026-05-01T21:40:00Z" },
    { id: "demo-c3e", event_id: "demo-e3", user_id: D_ACTORS.dev.user_id, display_name: D_ACTORS.dev.display_name, avatar_url: D_ACTORS.dev.avatar_url, body: "Robbie Robertson's score is the missing piece everyone forgets to mention. So good.", parent_comment_id: null, created_at: "2026-05-01T22:00:00Z" },
  ],
  "demo-e4": [
    { id: "demo-c4a", event_id: "demo-e4", user_id: D_ACTORS.cleo.user_id, display_name: D_ACTORS.cleo.display_name, avatar_url: D_ACTORS.cleo.avatar_url, body: "The Harkonnen arena sequence had my entire theater holding its breath. Villeneuve doesn't do slow.", parent_comment_id: null, created_at: "2026-05-01T14:20:00Z" },
    { id: "demo-c4b", event_id: "demo-e4", user_id: D_ACTORS.sam.user_id, display_name: D_ACTORS.sam.display_name, avatar_url: D_ACTORS.sam.avatar_url, body: "Austin Butler barely said 20 words and was terrifying the entire time. That casting was bold.", parent_comment_id: "demo-c4a", created_at: "2026-05-01T14:45:00Z" },
    { id: "demo-c4c", event_id: "demo-e4", user_id: D_ACTORS.jordan.user_id, display_name: D_ACTORS.jordan.display_name, avatar_url: D_ACTORS.jordan.avatar_url, body: "Timothée and Zendaya have such a charged energy — the scene at the sietch in part 2 is their best work.", parent_comment_id: null, created_at: "2026-05-01T15:10:00Z" },
    { id: "demo-c4d", event_id: "demo-e4", user_id: D_ACTORS.hana.user_id, display_name: D_ACTORS.hana.display_name, avatar_url: D_ACTORS.hana.avatar_url, body: "Hans Zimmer's score for this duology is otherworldly. The soundtrack alone is an experience.", parent_comment_id: null, created_at: "2026-05-01T15:30:00Z" },
  ],
  "demo-e5": [
    { id: "demo-c5a", event_id: "demo-e5", user_id: D_ACTORS.sienna.user_id, display_name: D_ACTORS.sienna.display_name, avatar_url: D_ACTORS.sienna.avatar_url, body: "Shōgun is so good it makes most prestige TV look rushed. Every episode is a masterclass in restraint.", parent_comment_id: null, created_at: "2026-05-01T09:30:00Z" },
    { id: "demo-c5b", event_id: "demo-e5", user_id: D_ACTORS.felix.user_id, display_name: D_ACTORS.felix.display_name, avatar_url: D_ACTORS.felix.avatar_url, body: "Hiroyuki Sanada didn't just act in this — he fought for the cultural authenticity and it shows in every frame.", parent_comment_id: "demo-c5a", created_at: "2026-05-01T09:52:00Z" },
    { id: "demo-c5c", event_id: "demo-e5", user_id: D_ACTORS.alex.user_id, display_name: D_ACTORS.alex.display_name, avatar_url: D_ACTORS.alex.avatar_url, body: "Thursday live watch sounds perfect. I'll be in!", parent_comment_id: null, created_at: "2026-05-01T10:15:00Z" },
    { id: "demo-c5d", event_id: "demo-e5", user_id: D_ACTORS.dev.user_id, display_name: D_ACTORS.dev.display_name, avatar_url: D_ACTORS.dev.avatar_url, body: "Count me in. Rewatching ep 4 beforehand.", parent_comment_id: "demo-c5c", created_at: "2026-05-01T10:35:00Z" },
  ],
};

export default function FeedScreen() {
  const { sessionToken, user } = useAuth();
  const router = useRouter();
  const [segment, setSegment] = useState<FeedSegment>("for-you");
  const [items, setItems] = useState<FeedEvent[]>([]);
  const [commentsByEvent, setCommentsByEvent] = useState<Record<string, FeedComment[]>>({});
  const [replyDraftByEvent, setReplyDraftByEvent] = useState<Record<string, string>>({});
  const [expandedCommentsByEvent, setExpandedCommentsByEvent] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [detailSource, setDetailSource] = useState<FeedEvent | null>(null);
  const [detailTitle, setDetailTitle] = useState<UniversalTitle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [saveTitleId, setSaveTitleId] = useState<string | null>(null);
  const [savedTitleIds, setSavedTitleIds] = useState<Set<string>>(new Set());

  const [attachedTitle, setAttachedTitle] = useState<Title | null>(null);
  const [showAddToTeam, setShowAddToTeam] = useState(false);
  const [addToTeamTitle, setAddToTeamTitle] = useState<{ id: string; title: string } | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [composeCaption, setComposeCaption] = useState("");
  const [composeRating, setComposeRating] = useState("");
  const [attachSearch, setAttachSearch] = useState("");
  const [attachResults, setAttachResults] = useState<Title[]>([]);
  const [isPosting, setIsPosting] = useState(false);
  const [composerViewportHeight, setComposerViewportHeight] = useState<number | null>(null);
  const [segmentWidth, setSegmentWidth] = useState(0);

  const gradientDrift = useRef(new Animated.Value(0)).current;
  const tabSlide = useRef(new Animated.Value(0)).current;
  const listFade = useRef(new Animated.Value(1)).current;
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTranslateY = useRef(new Animated.Value(12)).current;
  const [visibleToast, setVisibleToast] = useState<string | null>(null);
  const activeTabIndex = segment === "for-you" ? 0 : segment === "watch-teams" ? 1 : 2;

  useEffect(() => {
    if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(gradientDrift, { toValue: 1, duration: 16000, useNativeDriver: true }),
        Animated.timing(gradientDrift, { toValue: 0, duration: 16000, useNativeDriver: true }),
      ])
    ).start();
  }, [gradientDrift]);

  useEffect(() => {
    if (toast) {
      setVisibleToast(toast);
      toastIn(toastOpacity, toastTranslateY);
      const timer = setTimeout(() => {
        toastOut(toastOpacity, toastTranslateY, () => setToast(null));
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [toast, toastOpacity, toastTranslateY]);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }
    const win = globalThis as any;
    const vv = win.visualViewport;
    if (!vv) {
      return;
    }
    const handleResize = () => setComposerViewportHeight(vv.height);
    setComposerViewportHeight(vv.height);
    vv.addEventListener("resize", handleResize);
    return () => vv.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    async function loadFeed() {
      if (!sessionToken) {
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const data = await apiRequest<FeedEvent[]>(`/feed/${segment}?limit=100`, { token: sessionToken });
        setItems(data);
        const commentPayloads = await Promise.all(
          data.slice(0, 15).map(async (item) => {
            const comments = await apiRequest<FeedComment[]>(`/feed/${item.id}/comments`, { token: sessionToken });
            return { eventId: item.id, comments };
          })
        );
        setCommentsByEvent(
          commentPayloads.reduce<Record<string, FeedComment[]>>((acc, entry) => {
            acc[entry.eventId] = entry.comments;
            return acc;
          }, {})
        );
      } catch (feedError) {
        setError(feedError instanceof Error ? feedError.message : "Failed to load feed");
      } finally {
        setIsLoading(false);
      }
    }
    void loadFeed();
  }, [segment, sessionToken]);

  useEffect(() => {
    async function loadSaved() {
      if (!sessionToken) {
        return;
      }
      try {
        const titleIds = await apiRequest<string[]>("/me/watchlist/title-ids", { token: sessionToken });
        setSavedTitleIds(new Set(titleIds));
      } catch {
        setSavedTitleIds(new Set());
      }
    }
    void loadSaved();
  }, [sessionToken]);

  useEffect(() => {
    Animated.timing(tabSlide, {
      toValue: activeTabIndex,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    listFade.setValue(0.55);
    Animated.timing(listFade, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [activeTabIndex, tabSlide]);

  useEffect(() => {
    if (!sessionToken || !showComposer) {
      return;
    }
    if (attachSearch.trim().length < 3) {
      setAttachResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await apiRequest<Title[]>(`/titles/search?q=${encodeURIComponent(attachSearch.trim())}`, {
          token: sessionToken,
        });
        setAttachResults(data.slice(0, 6));
      } catch {
        setAttachResults([]);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [attachSearch, sessionToken, showComposer]);

  async function react(item: FeedEvent, reaction: ReactionKey) {
    if (!sessionToken) {
      return;
    }
    try {
      const updated =
        item.my_reaction === reaction
          ? await apiRequest<FeedEvent>(`/feed/${item.id}/reactions/me`, {
              method: "DELETE",
              token: sessionToken,
            })
          : await apiRequest<FeedEvent>(`/feed/${item.id}/reactions`, {
              method: "POST",
              token: sessionToken,
              body: JSON.stringify({ reaction }),
            });
      setItems((current) => current.map((event) => (event.id === updated.id ? updated : event)));
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : "Reaction failed");
    }
  }

  async function postComment(eventId: string) {
    if (!sessionToken) {
      return;
    }
    const text = (replyDraftByEvent[eventId] ?? "").trim();
    if (!text) {
      return;
    }
    try {
      const newComment = await apiRequest<FeedComment>(`/feed/${eventId}/comments`, {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({ body: text }),
      });
      setReplyDraftByEvent((current) => ({ ...current, [eventId]: "" }));
      setCommentsByEvent((current) => ({
        ...current,
        [eventId]: [...(current[eventId] ?? []), newComment],
      }));
      setItems((current) =>
        current.map((item) => (item.id === eventId ? { ...item, comment_count: item.comment_count + 1 } : item))
      );
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : "Comment failed");
    }
  }

  async function openDetails(item: FeedEvent) {
    if (!item.title?.id) {
      return;
    }
    setDetailSource(item);
    setShowDetails(true);
    setDetailLoading(true);
    try {
      if (!sessionToken) {
        return;
      }
      const data = await fetchUniversalTitle(sessionToken, item.title.id, {
        id: item.title.id,
        title: item.title.title,
        content_type: item.title.content_type,
        poster_url: item.title.poster_url,
        backdrop_url: item.title.backdrop_url,
        overview: typeof item.payload.body === "string" ? item.payload.body : null,
      });
      setDetailTitle(data);
    } catch (detailError) {
      setDetailTitle(null);
      setError(detailError instanceof Error ? detailError.message : "Could not load details");
    } finally {
      setDetailLoading(false);
    }
  }

  function openComposer(item: FeedEvent | null, seed: "snap" | "share" | "rate" | "card" = "card") {
    const source = item ?? null;
    setAttachedTitle(
      source?.title
        ? {
            id: source.title.id,
            tmdb_id: 0,
            content_type: source.title.content_type,
            title: source.title.title,
            poster_url: source.title.poster_url,
            backdrop_url: source.title.backdrop_url,
            genres: [],
          }
        : null
    );
    setComposeCaption(seed === "share" ? "Sharing this one with the feed." : "");
    setComposeRating("");
    setAttachSearch("");
    setAttachResults([]);
    setShowComposer(true);
  }

  function openAddToTeam(target: { id: string; title: string } | null) {
    if (!target) {
      setToast("Attach a title first");
      return;
    }
    setAddToTeamTitle(target);
    setShowAddToTeam(true);
  }

  async function submitPost() {
    if (!sessionToken || isPosting) {
      return;
    }
    if (!attachedTitle?.id && !composeCaption.trim()) {
      setToast("Write something or attach a title");
      return;
    }
    setIsPosting(true);
    try {
      const created = await apiRequest<FeedEvent>("/feed/wall-posts", {
        method: "POST",
        token: sessionToken,
        body: JSON.stringify({
          content_title_id: attachedTitle?.id ?? null,
          caption: composeCaption.trim() || null,
          rating: composeRating ? Number(composeRating) : null,
          share_to_team_id: null,
        }),
      });
      setShowComposer(false);
      setComposeCaption("");
      setComposeRating("");
      setAttachedTitle(null);
      setToast("Posted to your Social Wall");
      if (segment === "for-you") {
        setItems((prev) => [created, ...prev]);
      }
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "Post failed");
    } finally {
      setIsPosting(false);
    }
  }

  async function deletePost(eventId: string) {
    if (!sessionToken) {
      return;
    }
    try {
      await apiRequest<void>(`/feed/${eventId}`, { method: "DELETE", token: sessionToken });
      setItems((current) => current.filter((event) => event.id !== eventId));
      setCommentsByEvent((current) => {
        const next = { ...current };
        delete next[eventId];
        return next;
      });
      setToast("Post deleted");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete post");
    }
  }

  async function deleteComment(comment: FeedComment) {
    if (!sessionToken) {
      return;
    }
    try {
      await apiRequest<void>(`/feed/comments/${comment.id}`, { method: "DELETE", token: sessionToken });
      const removedCount =
        1 + (commentsByEvent[comment.event_id] ?? []).filter((entry) => entry.parent_comment_id === comment.id).length;
      setCommentsByEvent((current) => ({
        ...current,
        [comment.event_id]: (current[comment.event_id] ?? []).filter(
          (entry) => entry.id !== comment.id && entry.parent_comment_id !== comment.id
        ),
      }));
      setItems((current) =>
        current.map((item) =>
          item.id === comment.event_id
            ? { ...item, comment_count: Math.max(item.comment_count - removedCount, 0) }
            : item
        )
      );
      setToast("Comment deleted");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete comment");
    }
  }

  async function toggleFollow(item: FeedEvent) {
    if (!sessionToken || item.can_delete) {
      return;
    }
    const currentlyFollowing = Boolean(item.actor.is_following);
    try {
      await apiRequest<void>(`/profiles/${item.actor.user_id}/follow`, {
        method: currentlyFollowing ? "DELETE" : "POST",
        token: sessionToken,
      });
      setItems((current) =>
        current.map((event) =>
          event.actor.user_id === item.actor.user_id
            ? { ...event, actor: { ...event.actor, is_following: !currentlyFollowing } }
            : event
        )
      );
    } catch (followError) {
      setError(followError instanceof Error ? followError.message : "Failed to update follow state");
    }
  }

  function animateLayout() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }

  function onCta(item: FeedEvent, label: string) {
    const normalized = label.toLowerCase();
    if (normalized.includes("details") || normalized.includes("watch") || normalized.includes("poster")) {
      void openDetails(item);
      return;
    }
    if (normalized.includes("comment") || normalized.includes("thread")) {
      setExpandedCommentsByEvent((current) => ({ ...current, [item.id]: true }));
      return;
    }
    setToast(label);
  }

  const displayItems = useMemo(
    () => (items.length === 0 && !isLoading ? DEMO_FEED_EVENTS : items),
    [items, isLoading]
  );
  const displayComments = useMemo(
    () => (items.length === 0 && !isLoading ? DEMO_FEED_COMMENTS : commentsByEvent),
    [items, isLoading, commentsByEvent]
  );

  const headerShift = gradientDrift.interpolate({
    inputRange: [0, 1],
    outputRange: [-24, 24],
  });

  const composerMaxHeight = composerViewportHeight ? Math.floor(composerViewportHeight * 0.88) : undefined;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.pageGlowTop} />
      <View style={styles.pageGlowBottom} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.headerWrap}>
            <Animated.View style={[styles.headerGradient, { transform: [{ translateX: headerShift }] }]} />
            <Image source={require("../../assets/branding/seensnap-logo.png")} style={styles.logo} resizeMode="contain" />
            <Text style={styles.headerKicker}>Your World Is Watching</Text>
            <Text style={styles.headerTitle}>Social Feed</Text>
            <Text style={styles.headerSubtitle}>See what your world is watching.</Text>
            <Text style={styles.headerSubcopy}>
              Real-time reactions, rankings, and conversations from friends and teams.
            </Text>
          </View>

          <View style={styles.segmented}>
            <View
              style={styles.segmentedRail}
              onLayout={(event) => setSegmentWidth(event.nativeEvent.layout.width)}
            >
              <Animated.View
                style={[
                  styles.segmentActivePill,
                  {
                    width: segmentWidth > 0 ? segmentWidth / 3 - 8 : 0,
                    transform: [
                      {
                        translateX: tabSlide.interpolate({
                          inputRange: [0, 1, 2],
                          outputRange: [
                            4,
                            segmentWidth > 0 ? segmentWidth / 3 + 2 : 4,
                            segmentWidth > 0 ? (segmentWidth * 2) / 3 : 4,
                          ],
                        }),
                      },
                    ],
                  },
                ]}
              />
              <SegmentButton active={segment === "for-you"} label="For You" onPress={() => setSegment("for-you")} />
            <SegmentButton
              active={segment === "watch-teams"}
              label="Watch Teams"
              onPress={() => setSegment("watch-teams")}
            />
            <SegmentButton active={segment === "discover"} label="Discover" onPress={() => setSegment("discover")} />
            </View>
          </View>

          <View style={styles.composeCard}>
            <View style={styles.composeHead}>
              <Avatar uri={user?.avatar_url ?? null} label={user?.display_name ?? "U"} size={34} />
              <Pressable onPress={() => openComposer(null, "card")} style={styles.composePromptTap}>
                <Text style={styles.composePrompt}>What&apos;s worth watching?</Text>
              </Pressable>
            </View>
            <View style={styles.composeActions}>
              <Pressable style={styles.composeAction} onPress={() => openComposer(null, "rate")}>
                <Text style={styles.composeActionText}>Rate Title</Text>
              </Pressable>
            </View>
          </View>

          {error ? <Text style={styles.error}>{error} ({resolvedApiBaseUrl})</Text> : null}
          {isLoading ? <FeedSkeleton /> : null}

          {!isLoading && displayItems.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="film" color={colors.muted} size={20} />
              <Text style={styles.emptyText}>No activity yet for this segment.</Text>
            </View>
          ) : null}

          <Animated.View style={{ opacity: listFade }}>
          {displayItems.map((item, index) => (
            <StaggerCard key={item.id} index={index}>
              <FeedCard
                item={item}
                segment={segment}
                comments={displayComments[item.id] ?? []}
                expanded={Boolean(expandedCommentsByEvent[item.id])}
                followed={Boolean(item.actor.is_following)}
                draft={replyDraftByEvent[item.id] ?? ""}
                onToggleExpand={() => {
                  animateLayout();
                  setExpandedCommentsByEvent((current) => ({ ...current, [item.id]: !current[item.id] }));
                }}
                onChangeDraft={(value) =>
                  setReplyDraftByEvent((current) => ({ ...current, [item.id]: value }))
                }
                onSubmitComment={() => void postComment(item.id)}
                onReact={(reaction) => void react(item, reaction)}
                onToggleFollow={() => void toggleFollow(item)}
                onOpenActor={() => router.push(`/profile/${item.actor.user_id}`)}
                onOpenDetails={() => void openDetails(item)}
                onOpenComposer={() => openComposer(item, "card")}
                onCta={(label) => onCta(item, label)}
                currentUserAvatar={user?.avatar_url ?? null}
                onDeletePost={() => {
                  Alert.alert("Delete this post?", "This can’t be undone.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Delete", style: "destructive", onPress: () => void deletePost(item.id) },
                  ]);
                }}
                onDeleteComment={(comment) => {
                  Alert.alert("Delete this comment?", "This action cannot be undone.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Delete", style: "destructive", onPress: () => void deleteComment(comment) },
                  ]);
                }}
              />
            </StaggerCard>
          ))}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <UniversalTitleModal
        visible={showDetails}
        loading={detailLoading}
        title={detailTitle}
        isSaved={Boolean(detailTitle?.id && savedTitleIds.has(detailTitle.id))}
        onClose={() => setShowDetails(false)}
        onSaveTitle={(detail) => {
          setSaveTitleId(detail.id);
          setShowSaveSheet(true);
        }}
        onPost={(detail) =>
          openComposer(
            {
              ...detailSource,
              title: {
                id: detail.id,
                title: detail.title,
                content_type: detail.mediaType === "movie" ? "movie" : "series",
                poster_url: detail.posterUrl ?? undefined,
                backdrop_url: detail.backdropUrl ?? undefined,
              },
            } as FeedEvent,
            "card"
          )
        }
        onAddToTeam={(detail) =>
          openAddToTeam(
            { id: detail.id, title: detail.title }
          )
        }
      />

      <Modal transparent animationType="slide" visible={showComposer} onRequestClose={() => setShowComposer(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowComposer(false)} />
          <View style={[styles.composerSheet, composerMaxHeight ? { maxHeight: composerMaxHeight } : null]}>
            <Text style={styles.composerTitle}>Post to Social Wall</Text>
            <Text style={styles.composerSub}>Share a thought, with or without a title attached.</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.composerBody}>
              <TextInput
                style={styles.composerInput}
                placeholder="Search for a title to attach"
                placeholderTextColor={colors.muted}
                value={attachSearch}
                onChangeText={setAttachSearch}
              />
              {attachedTitle ? (
                <View style={styles.attachedChip}>
                  <PosterThumb
                    uri={attachedTitle.poster_url}
                    secondaryUri={attachedTitle.backdrop_url}
                    style={styles.attachedPoster}
                    fallbackStyle={styles.attachResultPosterFallback}
                    iconSize={12}
                  />
                  <Text style={styles.attachedText}>{attachedTitle.title}</Text>
                  <Pressable onPress={() => setAttachedTitle(null)}>
                    <Ionicons name="close-circle" size={18} color={colors.muted} />
                  </Pressable>
                </View>
              ) : null}
              {!attachedTitle && attachResults.map((candidate) => (
                <Pressable
                  key={candidate.id}
                  style={styles.attachResult}
                  onPress={() => {
                    setAttachedTitle(candidate);
                    setAttachSearch("");
                    setAttachResults([]);
                  }}
                >
                  <PosterThumb
                    uri={candidate.poster_url}
                    secondaryUri={candidate.backdrop_url}
                    style={styles.attachResultPoster}
                    fallbackStyle={styles.attachResultPosterFallback}
                    iconSize={14}
                  />
                  <View style={styles.attachResultCopy}>
                    <Text style={styles.attachResultTitle}>{candidate.title}</Text>
                    <Text style={styles.attachResultText}>
                      {(candidate.release_date ? `${String(candidate.release_date).slice(0, 4)} • ` : "") +
                        (candidate.content_type === "movie" ? "Movie" : "TV Series")}
                    </Text>
                  </View>
                </Pressable>
              ))}
              <TextInput
                style={styles.composerInput}
                placeholder={attachedTitle ? "Share your comment" : "What’s worth watching?"}
                placeholderTextColor={colors.muted}
                value={composeCaption}
                onChangeText={setComposeCaption}
                multiline
                autoFocus
              />
              <TextInput
                style={styles.composerInput}
                placeholder="Share your rating (optional)"
                placeholderTextColor={colors.muted}
                value={composeRating}
                onChangeText={setComposeRating}
                keyboardType="numeric"
              />
            </ScrollView>
            <View style={styles.composerFooter}>
              <Pressable style={styles.composerCancel} onPress={() => setShowComposer(false)}>
                <Text style={styles.composerCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.composerCancel}
                onPress={() => openAddToTeam(attachedTitle ? { id: attachedTitle.id, title: attachedTitle.title } : null)}
              >
                <Text style={styles.composerCancelText}>Add to Team</Text>
              </Pressable>
              <Pressable style={styles.composerPost} onPress={() => void submitPost()}>
                <Text style={styles.composerPostText}>{isPosting ? "Posting..." : "Post"}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <AddToTeamSheet
        visible={showAddToTeam}
        token={sessionToken}
        title={addToTeamTitle}
        onClose={() => setShowAddToTeam(false)}
        onAdded={(teamName) => setToast(`Added to ${teamName}`)}
        onError={(message) => setError(message)}
      />

      <SaveToListSheet
        visible={showSaveSheet}
        token={sessionToken}
        titleId={saveTitleId}
        source="social_feed"
        onClose={() => {
          setShowSaveSheet(false);
          setSaveTitleId(null);
        }}
        onSaved={(listName, alreadySaved) => {
          if (saveTitleId) {
            setSavedTitleIds((current) => new Set(current).add(saveTitleId));
          }
          setToast(alreadySaved ? `Already in ${listName}` : `Saved to ${listName}`);
        }}
        onError={(message) => setError(message)}
      />

      <Animated.View
        pointerEvents="none"
        style={[
          styles.toast,
          { opacity: toastOpacity, transform: [{ translateY: toastTranslateY }] },
        ]}
      >
        <Text style={styles.toastText}>{visibleToast ?? ""}</Text>
      </Animated.View>
    </SafeAreaView>
  );
}

function FeedCard({
  item,
  segment,
  comments,
  expanded,
  followed,
  draft,
  onToggleExpand,
  onChangeDraft,
  onSubmitComment,
  onReact,
  onToggleFollow,
  onOpenActor,
  onOpenDetails,
  onOpenComposer,
  onCta,
  currentUserAvatar,
  onDeletePost,
  onDeleteComment,
}: {
  item: FeedEvent;
  segment: FeedSegment;
  comments: FeedComment[];
  expanded: boolean;
  followed: boolean;
  draft: string;
  onToggleExpand: () => void;
  onChangeDraft: (value: string) => void;
  onSubmitComment: () => void;
  onReact: (reaction: ReactionKey) => void;
  onToggleFollow: () => void;
  onOpenActor: () => void;
  onOpenDetails: () => void;
  onOpenComposer: () => void;
  onCta: (label: string) => void;
  currentUserAvatar: string | null;
  onDeletePost: () => void;
  onDeleteComment: (comment: FeedComment) => void;
}) {
  const actorName =
    segment === "discover" ? "Scene Snap Trending" : item.actor.display_name ?? "SeenSnap user";
  const isVerified = Boolean((item.payload.verified as boolean | undefined) ?? (segment === "discover"));
  const activityLabel =
    (typeof item.payload.action_label === "string" && item.payload.action_label) || typeLabel(item.event_type);
  const ctaLabel = normalizeCta(typeof item.payload.cta === "string" ? item.payload.cta : null);
  const contentBody =
    (typeof item.payload.caption === "string" ? item.payload.caption : null) ??
    (typeof item.payload.body === "string" ? item.payload.body : null);
  const ratingValue = typeof item.payload.rating === "number" ? item.payload.rating : null;
  const isOwnPost = Boolean(item.can_delete);

  const topLevel = useMemo(() => comments.filter((comment) => !comment.parent_comment_id), [comments]);
  const visibleTop = expanded ? topLevel : topLevel.slice(0, 2);

  const byParent = useMemo(
    () =>
      comments.reduce<Record<string, FeedComment[]>>((acc, comment) => {
        if (!comment.parent_comment_id) {
          return acc;
        }
        acc[comment.parent_comment_id] = [...(acc[comment.parent_comment_id] ?? []), comment];
        return acc;
      }, {}),
    [comments]
  );
  const followScale = useRef(new Animated.Value(1)).current;

  function pulseFollow() {
    Animated.sequence([
      Animated.spring(followScale, { toValue: 1.08, useNativeDriver: true, bounciness: 10 }),
      Animated.spring(followScale, { toValue: 1, useNativeDriver: true, bounciness: 8 }),
    ]).start();
    onToggleFollow();
  }

  return (
    <View style={styles.card}>
      <View pointerEvents="none" style={styles.cardInnerGlow} />
      <View style={styles.headerRow}>
        <Pressable onPress={onOpenActor} style={styles.actorTap}>
          <Avatar uri={item.actor.avatar_url} label={actorName} size={40} />
        </Pressable>
        <Pressable onPress={onOpenActor} style={styles.userBlock}>
          <View style={styles.userNameRow}>
            <Text style={styles.userName}>{actorName}</Text>
            {isVerified ? <Ionicons name="checkmark-circle" size={14} color={colors.accent} style={styles.verifiedIcon} /> : null}
          </View>
          <Text style={styles.activityLabel}>{activityLabel}</Text>
        </Pressable>
        <Text style={styles.timeText}>{relativeTime(item.created_at)}</Text>
        {!isOwnPost ? (
          <Animated.View style={{ transform: [{ scale: followScale }] }}>
            <Pressable onPress={pulseFollow} style={[styles.followPill, followed && styles.followPillActive]}>
              <Text style={[styles.followText, followed && styles.followTextActive]}>{followed ? "Following" : "+ Follow"}</Text>
            </Pressable>
          </Animated.View>
        ) : (
          <Pressable onPress={onDeletePost} style={styles.postMenuButton}>
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} />
          </Pressable>
        )}
      </View>

      {(segment === "watch-teams" || item.team_id) && (
        <View style={styles.teamBadge}>
          <Ionicons name="people" size={12} color={colors.accent} />
          <Text style={styles.teamBadgeText}>Watch Team Activity</Text>
        </View>
      )}

      {item.title ? (
        <Pressable onPress={onOpenDetails} style={styles.mediaHero}>
          <Image
            source={{ uri: resolveMediaUrl(item.title.backdrop_url ?? item.title.poster_url) ?? undefined }}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
            resizeMode="cover"
          />
          <View style={styles.mediaHeroGrade} />
          <View style={styles.mediaHeroContent}>
            <View style={styles.heroFloatPoster}>
              <PosterThumb
                uri={item.title.poster_url}
                secondaryUri={item.title.backdrop_url}
                style={styles.heroPosterImg}
                fallbackStyle={styles.heroPosterFallback}
                iconSize={14}
              />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.heroTitle} numberOfLines={2}>
                {item.title.title}
              </Text>
              {(item.event_type === "friend_rating" || ratingValue !== null) ? (
                <View style={styles.ratingBadge}>
                  <Text style={styles.ratingBadgeText}>{ratingValue !== null ? `${ratingValue}/10` : "9/10"}</Text>
                </View>
              ) : null}
              {contentBody ? <Text style={styles.caption} numberOfLines={3}>{contentBody}</Text> : null}
              {ctaLabel ? (
                <Pressable style={styles.ctaButton} onPress={() => onCta(ctaLabel)}>
                  <Text style={styles.ctaText}>{ctaLabel}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </Pressable>
      ) : contentBody ? (
        <View style={styles.textOnlyPost}>
          <Text style={styles.textOnlyBody}>{contentBody}</Text>
          {ctaLabel ? (
            <Pressable style={styles.ctaButton} onPress={() => onCta(ctaLabel)}>
              <Text style={styles.ctaText}>{ctaLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={styles.reactionBar}>
        {reactionOptions.map((reaction) => (
          <ReactionPill
            key={reaction.key}
            selected={item.my_reaction === reaction.key}
            icon={reaction.icon}
            count={item.reaction_counts[reaction.key] ?? 0}
            onPress={() => onReact(reaction.key)}
          />
        ))}
      </View>

      <View style={styles.commentSection}>
        {item.comment_count > 0 ? (
          <Pressable onPress={onToggleExpand}>
            <Text style={styles.commentHeader}>{expanded ? "Hide comments" : `View all ${item.comment_count} comments`}</Text>
          </Pressable>
        ) : null}

        {visibleTop.map((comment) => (
          <View key={comment.id} style={styles.commentRowWrap}>
            <CommentRow
              comment={comment}
              isOwnComment={Boolean(comment.can_delete)}
              onDelete={() => onDeleteComment(comment)}
            />
            {(byParent[comment.id] ?? []).slice(0, expanded ? 5 : 1).map((reply) => (
              <View key={reply.id} style={styles.replyRow}>
                <CommentRow
                  comment={reply}
                  compact
                  isOwnComment={Boolean(reply.can_delete)}
                  onDelete={() => onDeleteComment(reply)}
                />
              </View>
            ))}
          </View>
        ))}

        <View style={styles.commentComposer}>
          <Avatar uri={currentUserAvatar} label="Y" size={24} />
          <TextInput
            value={draft}
            onChangeText={onChangeDraft}
            placeholder="Add a comment..."
            placeholderTextColor={colors.muted}
            style={styles.commentInput}
            onFocus={() => {
              if (!expanded) {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                onToggleExpand();
              }
            }}
          />
          <Pressable onPress={onSubmitComment} style={[styles.commentSend, !draft.trim() && styles.commentSendDisabled]} disabled={!draft.trim()}>
            <Ionicons name="send" size={14} color={colors.background} />
          </Pressable>
        </View>
      </View>

      {!isOwnPost ? (
        <Pressable style={styles.secondaryAction} onPress={onOpenComposer}>
          <Text style={styles.secondaryActionText}>Post to Social Wall</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function StaggerCard({ index, children }: { index: number; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(14)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 260,
        delay: Math.min(index * 55, 420),
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 260,
        delay: Math.min(index * 55, 420),
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [index, opacity, translateY]);

  return <Animated.View style={{ opacity, transform: [{ translateY }] }}>{children}</Animated.View>;
}

function ReactionPill({
  selected,
  icon,
  count,
  onPress,
}: {
  selected: boolean;
  icon: string;
  count: number;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const press = () => {
    Animated.sequence([
      Animated.spring(scale, { toValue: 1.12, useNativeDriver: true, bounciness: 12 }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 8 }),
    ]).start();
    onPress();
  };

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable onPress={press} style={[styles.reactionPill, selected && styles.reactionPillActive]}>
        <Text style={styles.reactionPillText}>{icon}</Text>
        <Text style={styles.reactionCount}>{count}</Text>
      </Pressable>
    </Animated.View>
  );
}

function CommentRow({
  comment,
  compact = false,
  isOwnComment = false,
  onDelete,
}: {
  comment: FeedComment;
  compact?: boolean;
  isOwnComment?: boolean;
  onDelete?: () => void;
}) {
  return (
    <View style={styles.commentRow}>
      <Avatar uri={comment.avatar_url} label={comment.display_name ?? "U"} size={compact ? 20 : 24} />
      <Text style={styles.commentText}>
        <Text style={styles.commentAuthor}>{comment.display_name ?? "SeenSnap user"}: </Text>
        {comment.body}
      </Text>
      {isOwnComment ? (
        <Pressable onPress={onDelete} style={styles.commentMenu}>
          <Ionicons name="ellipsis-horizontal" size={14} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Avatar({ uri, label, size }: { uri?: string | null; label: string; size: number }) {
  const resolvedUri = resolveMediaUrl(uri);
  // Auto-generate a deterministic pravatar when no real photo is available
  const pravatarUri = `https://i.pravatar.cc/150?u=${encodeURIComponent(label.toLowerCase().replace(/\s+/g, "."))}`;
  const sources = useMemo(
    () => [resolvedUri, pravatarUri].filter((u): u is string => Boolean(u)),
    [resolvedUri, pravatarUri]
  );
  const [srcIdx, setSrcIdx] = useState(0);
  useEffect(() => { setSrcIdx(0); }, [uri]);
  const activeUri = sources[srcIdx] ?? null;
  if (activeUri) {
    return (
      <Image
        source={{ uri: activeUri }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.backgroundElevated }}
        onError={() => setSrcIdx((i) => i + 1)}
      />
    );
  }
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={styles.avatarFallbackText}>{label.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

function PosterThumb({
  uri,
  secondaryUri,
  style,
  fallbackStyle,
  iconSize,
}: {
  uri?: string | null;
  secondaryUri?: string | null;
  style: any;
  fallbackStyle: any;
  iconSize: number;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const sources = useMemo(
    () =>
      [
        resolveMediaUrl(uri),
        resolveMediaUrl(secondaryUri),
        resolveMediaUrl("/media/brand/seensnap_logo.png"),
      ].filter((entry, idx, arr): entry is string => Boolean(entry) && arr.indexOf(entry) === idx),
    [uri, secondaryUri],
  );
  const sourceKey = sources.join("|");
  useEffect(() => {
    setSourceIndex(0);
  }, [sourceKey]);
  const activeSource = sources[sourceIndex] ?? null;
  if (!activeSource) {
    return (
      <View style={fallbackStyle}>
        <Ionicons name="film" size={iconSize} color={colors.muted} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: activeSource }}
      style={style}
      onError={() => setSourceIndex((current) => Math.min(current + 1, Math.max(0, sources.length - 1)))}
    />
  );
}

function SegmentButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.segmentButton, active && styles.segmentButtonActive]}>
      <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function relativeTime(dateString: string) {
  const now = Date.now();
  const ts = new Date(dateString).getTime();
  if (Number.isNaN(ts)) {
    return dateString;
  }
  const diff = Math.max(now - ts, 0);
  const minutes = Math.floor(diff / (1000 * 60));
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeCta(raw: string | null) {
  if (!raw) {
    return null;
  }
  if (raw === "add_to_watchlist") {
    return "Added to Watchlist";
  }
  return raw;
}

function typeLabel(type: string) {
  switch (type) {
    case "friend_rating":
      return "rated a movie";
    case "poster_share":
      return "shared a poster";
    case "watch_team_alert":
    case "ranking_change":
      return "added to Watch Team";
    case "soundtrack_activity":
    case "music_trend":
    case "team_playlist":
      return "soundtrack activity";
    case "quiz_activity":
    case "quiz_score":
    case "quiz_trend":
    case "poll":
      return "quiz update";
    case "recommendation":
      return "recommended to Watch Team";
    case "wall_post":
      return "posted to Social Feed";
    default:
      return type.replaceAll("_", " ");
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  pageGlowTop: {
    position: "absolute",
    top: -90,
    right: -40,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "#1a3658",
    opacity: 0.45,
  },
  pageGlowBottom: {
    position: "absolute",
    bottom: -120,
    left: -60,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "#0f2238",
    opacity: 0.8,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  headerWrap: {
    borderRadius: 24,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    borderWidth: 1,
    borderColor: "rgba(46, 64, 87, 0.9)",
    backgroundColor: "rgba(15, 31, 52, 0.85)",
    overflow: "hidden",
  },
  headerGradient: {
    position: "absolute",
    top: -60,
    left: -80,
    width: 340,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(244, 196, 48, 0.14)",
  },
  logo: {
    width: 124,
    height: 34,
    alignSelf: "center",
    marginBottom: spacing.sm,
  },
  headerKicker: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.3,
    textAlign: "center",
    marginBottom: 4,
  },
  headerTitle: {
    color: colors.ink,
    fontSize: 38,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    marginTop: 8,
    color: colors.ink,
    opacity: 0.9,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
  },
  headerSubcopy: {
    marginTop: 6,
    color: colors.muted,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
  },
  segmented: {
    position: "relative",
  },
  segmentedRail: {
    flexDirection: "row",
    gap: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 4,
    overflow: "hidden",
  },
  segmentActivePill: {
    position: "absolute",
    top: 4,
    bottom: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  segmentButton: {
    flex: 1,
    borderRadius: radii.pill,
    backgroundColor: "transparent",
    paddingVertical: 10,
    alignItems: "center",
    zIndex: 2,
  },
  segmentButtonActive: {
    backgroundColor: "transparent",
  },
  segmentLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "800",
  },
  segmentLabelActive: {
    color: colors.background,
  },
  composeCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.sm,
  },
  composeHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  composePromptTap: {
    flex: 1,
  },
  composePrompt: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 15,
  },
  composeActions: {
    flexDirection: "row",
    gap: 8,
  },
  composeAction: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  composeActionText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "700",
  },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(46, 64, 87, 0.65)",
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.md,
    shadowColor: colors.shadow,
    shadowOpacity: 0.38,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    overflow: "hidden",
  },
  cardInnerGlow: {
    position: "absolute",
    top: -30,
    right: -30,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(255,255,255,0.032)",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  actorTap: {
    borderRadius: radii.pill,
  },
  userBlock: {
    flex: 1,
  },
  userNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  userName: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 14,
  },
  verifiedIcon: {
    marginTop: 1,
  },
  activityLabel: {
    color: colors.muted,
    fontSize: 12,
  },
  timeText: {
    color: colors.muted,
    fontSize: 11,
    marginRight: 4,
  },
  followPill: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.backgroundElevated,
  },
  followPillActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(244, 196, 48, 0.15)",
  },
  followText: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: "700",
  },
  followTextActive: {
    color: colors.accent,
  },
  postMenuButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.backgroundElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  teamBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  teamBadgeText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  mediaHero: {
    height: 200,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: colors.backgroundElevated,
  },
  mediaHeroGrade: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 140,
    backgroundColor: "rgba(7,11,19,0.80)",
  },
  mediaHeroContent: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 12,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  heroFloatPoster: {
    borderRadius: 10,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.55,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  heroPosterImg: {
    width: 52,
    height: 76,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  heroPosterFallback: {
    width: 52,
    height: 76,
    borderRadius: 10,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroCopy: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    color: colors.ink,
    fontWeight: "900",
    fontSize: 18,
    letterSpacing: -0.3,
  },
  textOnlyPost: {
    backgroundColor: colors.backgroundElevated,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  textOnlyBody: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  ratingBadge: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.pill,
    paddingVertical: 3,
    paddingHorizontal: 9,
    backgroundColor: "rgba(244, 196, 48, 0.12)",
  },
  ratingBadgeText: {
    color: colors.accent,
    fontWeight: "800",
    fontSize: 12,
  },
  caption: {
    color: colors.ink,
    lineHeight: 20,
    fontSize: 14,
  },
  ctaButton: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: "rgba(244, 196, 48, 0.08)",
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  ctaText: {
    color: colors.accent,
    fontWeight: "700",
    fontSize: 12,
  },
  reactionBar: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  reactionPill: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: 7,
    paddingHorizontal: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  reactionPillActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(244, 196, 48, 0.12)",
    shadowColor: colors.accent,
    shadowOpacity: 0.28,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  reactionPillText: {
    fontSize: 14,
  },
  reactionCount: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 12,
  },
  commentSection: {
    gap: 8,
  },
  commentHeader: {
    color: colors.muted,
    fontSize: 12,
  },
  commentRowWrap: {
    gap: 6,
  },
  commentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  replyRow: {
    marginLeft: 22,
    paddingLeft: 8,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  commentText: {
    flex: 1,
    color: colors.ink,
    lineHeight: 18,
    fontSize: 12,
  },
  commentAuthor: {
    fontWeight: "800",
    color: colors.ink,
  },
  commentComposer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  commentInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    borderRadius: radii.pill,
    paddingVertical: 9,
    paddingHorizontal: 12,
    color: colors.ink,
    fontSize: 13,
  },
  commentSend: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
  },
  commentSendDisabled: {
    opacity: 0.45,
  },
  commentMenu: {
    padding: 4,
  },
  secondaryAction: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.backgroundElevated,
  },
  secondaryActionText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  avatarFallback: {
    backgroundColor: colors.backgroundElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarFallbackText: {
    color: colors.muted,
    fontWeight: "800",
    fontSize: 11,
  },
  empty: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  emptyText: {
    color: colors.muted,
  },
  error: {
    color: colors.danger,
  },
  meta: {
    color: colors.muted,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(6, 12, 20, 0.7)",
    justifyContent: "flex-end",
  },
  detailSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    gap: spacing.sm,
    maxHeight: "92%",
  },
  detailBackdrop: {
    width: "100%",
    height: 160,
    borderRadius: 12,
    backgroundColor: colors.backgroundElevated,
  },
  detailTitle: {
    color: colors.ink,
    fontSize: 25,
    fontWeight: "900",
  },
  detailMeta: {
    color: colors.muted,
    fontSize: 13,
  },
  detailOverview: {
    color: colors.ink,
    lineHeight: 21,
    fontSize: 14,
  },
  detailCast: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
  },
  detailButtons: {
    marginTop: 4,
    gap: 8,
  },
  detailPrimary: {
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  detailPrimaryText: {
    color: colors.background,
    fontWeight: "800",
    fontSize: 13,
  },
  detailSecondary: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  detailSecondaryText: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 13,
  },
  detailClose: {
    alignSelf: "center",
    padding: 6,
  },
  detailCloseText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  composerSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  composerTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "900",
  },
  composerSub: {
    color: colors.muted,
    fontSize: 13,
  },
  composerBody: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  composerPoster: {
    width: 92,
    height: 138,
    borderRadius: 12,
    backgroundColor: colors.backgroundElevated,
  },
  attachedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    padding: 8,
  },
  attachedPoster: {
    width: 34,
    height: 50,
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  attachedText: {
    flex: 1,
    color: colors.ink,
    fontWeight: "700",
    fontSize: 13,
  },
  attachResult: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  attachResultPoster: {
    width: 30,
    height: 44,
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  attachResultPosterFallback: {
    width: 30,
    height: 44,
    borderRadius: 6,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  attachResultCopy: {
    flex: 1,
  },
  attachResultTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "700",
  },
  attachResultText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  composerInput: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
    minHeight: 44,
  },
  composerFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  composerCancel: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  composerCancelText: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 13,
  },
  composerPost: {
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  composerPostText: {
    color: colors.background,
    fontWeight: "800",
    fontSize: 13,
  },
  toast: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  toastText: {
    color: colors.success,
    fontWeight: "800",
    fontSize: 13,
  },
});
