import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AddToTeamSheet } from "@/components/add-to-team-sheet";
import { SaveToListSheet } from "@/components/save-to-list-sheet";
import { TasteSignal } from "@/components/taste-signal";
import { shareTitle } from "@/lib/share";
import { ShareComposerSheet } from "@/components/share-composer-sheet";
import { SendToUserSheet } from "@/components/send-to-user-sheet";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import {
  fetchPersonDetails,
  fetchUniversalTitle,
  type PersonProfile,
  type UniversalTitle,
} from "@/lib/universal-title";

type WatchAction = {
  intent: string;
  label: string;
  destination_quality: string;
  outbound_url: string | null;
};

type WatchProvider = {
  provider_id: number | null;
  provider_code: string;
  provider_name: string;
  logo_url: string | null;
  logo_path: string | null;
  availability_types: string[];
  subscription_cta_allowed: boolean;
  actions: WatchAction[];
};

type WatchOptionsGroups = {
  my_services: WatchProvider[];
  free: WatchProvider[];
  rent_buy: WatchProvider[];
  other_subscriptions: WatchProvider[];
};

type WatchOptionsResponse = {
  content_id: string;
  region: string;
  source: string;
  source_attribution: string;
  fetched_at: string | null;
  groups: WatchOptionsGroups;
};

const WATCH_GROUP_CONFIG: Array<{ key: keyof WatchOptionsGroups; label: string }> = [
  { key: "my_services", label: "On Your Services" },
  { key: "free", label: "Free" },
  { key: "rent_buy", label: "Rent or Buy" },
  { key: "other_subscriptions", label: "Other Subscriptions" },
];

type Props = {
  visible: boolean;
  loading: boolean;
  title: UniversalTitle | null;
  isSaved?: boolean;
  onClose: () => void;
  onSaveTitle?: ((title: UniversalTitle) => void) | null;
  onSave?: () => void;
  onAddToTeam?: ((title: UniversalTitle) => void) | null;
};

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
const HERO_HEIGHT = Math.min(480, Math.max(380, screenHeight * 0.5));

export function UniversalTitleModal({
  visible,
  loading,
  title,
  isSaved = false,
  onClose,
  onSaveTitle,
  onSave,
  onAddToTeam,
}: Props) {
  const { sessionToken, user } = useAuth();
  const insets = useSafeAreaInsets();
  const [watchOptions, setWatchOptions] = useState<WatchOptionsResponse | null>(null);
  const [watchOptionsLoading, setWatchOptionsLoading] = useState(false);
  const [expandedDescription, setExpandedDescription] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [rendered, setRendered] = useState(visible);
  const [showSaveSheet, setShowSaveSheet] = useState(false);
  const [showAddToTeam, setShowAddToTeam] = useState(false);
  // Share-to-Feed composer state — Social brief §8.
  const [showShareToFeed, setShowShareToFeed] = useState(false);
  const [showSendSheet, setShowSendSheet] = useState(false);
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [activeTitle, setActiveTitle] = useState<UniversalTitle | null>(title);
  const [internalLoading, setInternalLoading] = useState(false);
  const [savedState, setSavedState] = useState(isSaved);
  const [savedTitleIds, setSavedTitleIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<{
    name: string;
    role: string;
    headshotUrl: string | null;
    tmdbPersonId: number | null;
  } | null>(null);
  const [personProfile, setPersonProfile] = useState<PersonProfile | null>(null);
  const [personLoading, setPersonLoading] = useState(false);
  const [trailerKey, setTrailerKey] = useState<string | null>(null);
  const [trailerLoading, setTrailerLoading] = useState(false);
  const [trailerFetched, setTrailerFetched] = useState(false);

  const heroScrollRef = useRef<ScrollView | null>(null);
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const sheetTranslateY = useRef(new Animated.Value(screenHeight)).current;
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentTranslateY = useRef(new Animated.Value(22)).current;
  const actionsOpacity = useRef(new Animated.Value(0)).current;
  const actionsTranslateY = useRef(new Animated.Value(26)).current;
  const saveScale = useRef(new Animated.Value(1)).current;
  const toastTranslateY = useRef(new Animated.Value(30)).current;
  const toastOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setActiveTitle(title);
    setExpandedDescription(false);
    setActiveImageIndex(0);
    setTrailerKey(null);
    setTrailerFetched(false);
    setWatchOptions(null);
  }, [title]);

  useEffect(() => {
    setSavedState(Boolean(activeTitle?.id && savedTitleIds.has(activeTitle.id)) || isSaved);
  }, [activeTitle?.id, isSaved, savedTitleIds]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    toastOpacity.setValue(0);
    toastTranslateY.setValue(24);
    Animated.parallel([
      Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(toastTranslateY, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
    const timeout = setTimeout(() => {
      Animated.parallel([
        Animated.timing(toastOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(toastTranslateY, { toValue: 24, duration: 180, useNativeDriver: true }),
      ]).start(() => setToast(null));
    }, 1800);
    return () => clearTimeout(timeout);
  }, [toast, toastOpacity, toastTranslateY]);

  useEffect(() => {
    let isMounted = true;
    async function loadWatchOptions() {
      if (!sessionToken || !visible || !activeTitle?.id) {
        if (isMounted) setWatchOptions(null);
        return;
      }
      if (isMounted) setWatchOptionsLoading(true);
      try {
        const data = await apiRequest<WatchOptionsResponse>(
          `/titles/${activeTitle.id}/watch-options?region=US`,
          { token: sessionToken }
        );
        if (isMounted) setWatchOptions(data);
      } catch {
        if (isMounted) setWatchOptions(null);
      } finally {
        if (isMounted) setWatchOptionsLoading(false);
      }
    }
    void loadWatchOptions();
    return () => { isMounted = false; };
  }, [sessionToken, visible, activeTitle?.id]);

  useEffect(() => {
    let isMounted = true;
    async function loadSavedTitles() {
      if (!sessionToken || !visible) return;
      try {
        const ids = await apiRequest<string[]>("/me/watchlist/title-ids", { token: sessionToken });
        if (isMounted) setSavedTitleIds(new Set(ids));
      } catch {
        if (isMounted) setSavedTitleIds(new Set());
      }
    }
    void loadSavedTitles();
    return () => { isMounted = false; };
  }, [sessionToken, visible]);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      overlayOpacity.setValue(0);
      sheetTranslateY.setValue(screenHeight);
      heroOpacity.setValue(0);
      contentOpacity.setValue(0);
      contentTranslateY.setValue(22);
      actionsOpacity.setValue(0);
      actionsTranslateY.setValue(26);

      Animated.parallel([
        Animated.timing(overlayOpacity, { toValue: 1, duration: 260, useNativeDriver: true }),
        Animated.spring(sheetTranslateY, { toValue: 0, damping: 20, mass: 0.95, stiffness: 170, useNativeDriver: true }),
      ]).start(() => {
        Animated.sequence([
          Animated.timing(heroOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
          Animated.parallel([
            Animated.timing(contentOpacity, { toValue: 1, duration: 260, useNativeDriver: true }),
            Animated.timing(contentTranslateY, { toValue: 0, duration: 260, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(actionsOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
            Animated.timing(actionsTranslateY, { toValue: 0, duration: 220, useNativeDriver: true }),
          ]),
        ]).start();
      });
      return;
    }

    Animated.parallel([
      Animated.timing(actionsOpacity, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(contentOpacity, { toValue: 0, duration: 140, useNativeDriver: true }),
      Animated.timing(heroOpacity, { toValue: 0, duration: 140, useNativeDriver: true }),
      Animated.timing(overlayOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(sheetTranslateY, { toValue: screenHeight, duration: 240, useNativeDriver: true }),
    ]).start(() => setRendered(false));
  }, [
    actionsOpacity, actionsTranslateY, contentOpacity, contentTranslateY,
    heroOpacity, overlayOpacity, sheetTranslateY, visible,
  ]);

  const currentTitle = activeTitle;
  const isBusy = loading || internalLoading;

  const galleryImages = useMemo(() => {
    const entries = currentTitle?.imageGallery ?? [];
    const deduped = entries.reduce<Array<{ url: string; kind: string }>>((acc, item) => {
      const resolved = resolveMediaUrl(item.url);
      if (!resolved || acc.some((entry) => entry.url === resolved)) return acc;
      acc.push({ url: resolved, kind: item.kind });
      return acc;
    }, []);
    if (!deduped.length) {
      const fallback = [
        currentTitle?.backdropUrl ? { url: resolveMediaUrl(currentTitle.backdropUrl), kind: "backdrop" } : null,
        currentTitle?.posterUrl ? { url: resolveMediaUrl(currentTitle.posterUrl), kind: "poster" } : null,
      ].filter((entry): entry is { url: string; kind: string } => Boolean(entry?.url));
      return fallback;
    }
    return deduped;
  }, [currentTitle?.backdropUrl, currentTitle?.imageGallery, currentTitle?.posterUrl]);

  const posterImage = resolveMediaUrl(currentTitle?.posterUrl ?? null);

  const metadataChips = useMemo(() => {
    const entries: Array<{ icon: keyof typeof Ionicons.glyphMap; label: string }> = [];
    if (typeof currentTitle?.ratingTmdb === "number") {
      entries.push({ icon: "star", label: `${currentTitle.ratingTmdb.toFixed(1)} TMDB` });
    }
    if (currentTitle?.mediaType === "movie" && typeof currentTitle.runtimeMinutes === "number") {
      entries.push({ icon: "time", label: `${currentTitle.runtimeMinutes}m` });
    }
    if (currentTitle?.mediaType === "tv" && typeof currentTitle.seasons === "number") {
      entries.push({ icon: "tv", label: `${currentTitle.seasons} Seasons` });
    }
    if (currentTitle?.genres?.length) {
      entries.push({ icon: "pricetag", label: currentTitle.genres.slice(0, 3).join(", ") });
    }
    if (currentTitle?.language) {
      entries.push({ icon: "globe-outline", label: currentTitle.language });
    }
    return entries;
  }, [currentTitle?.genres, currentTitle?.language, currentTitle?.mediaType, currentTitle?.ratingTmdb, currentTitle?.runtimeMinutes, currentTitle?.seasons]);

  const hasLongDescription = Boolean((currentTitle?.description ?? "").length > 160);

  const allPeople = useMemo(() => [
    ...(currentTitle?.creators ?? []).slice(0, 4),
    ...(currentTitle?.cast ?? []).slice(0, 8),
  ], [currentTitle?.cast, currentTitle?.creators]);

  function handleImageScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const nextIndex = Math.round(event.nativeEvent.contentOffset.x / Math.max(screenWidth, 1));
    if (nextIndex !== activeImageIndex) setActiveImageIndex(nextIndex);
  }

  async function openWatchAction(provider: WatchProvider, action: WatchAction) {
    const url = action.outbound_url;
    if (!url) return;
    const isDeepLink = !url.startsWith("http");
    if (isDeepLink) {
      const supported = await Linking.canOpenURL(url).catch(() => false);
      if (supported) {
        await Linking.openURL(url);
        trackEvent("watch_now_clicked", { titleId: currentTitle?.id ?? null, provider: provider.provider_code, intent: action.intent, userId: user?.user_id ?? null, destination: "app" });
        return;
      }
    }
    await WebBrowser.openBrowserAsync(url, {
      toolbarColor: colors.background,
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
    });
    trackEvent("watch_now_clicked", { titleId: currentTitle?.id ?? null, provider: provider.provider_code, intent: action.intent, userId: user?.user_id ?? null, destination: "web" });
  }

  function openSaveFlow() {
    if (!sessionToken || !currentTitle?.id) { setToast("Sign in to save titles"); return; }
    Animated.sequence([
      Animated.timing(saveScale, { toValue: 1.08, duration: 120, useNativeDriver: true }),
      Animated.spring(saveScale, { toValue: 1, useNativeDriver: true }),
    ]).start();
    setShowSaveSheet(true);
  }

  function openAddToTeamFlow() {
    if (!sessionToken) { setToast("Sign in to add to team"); return; }
    if (currentTitle && onAddToTeam) { onAddToTeam(currentTitle); return; }
    setShowAddToTeam(true);
  }

  async function openRelatedTitle(titleId: string) {
    if (!sessionToken || !titleId || currentTitle?.id === titleId) return;
    setInternalLoading(true);
    setExpandedDescription(false);
    setActiveImageIndex(0);
    setWatchOptions(null);
    try {
      const nextTitle = await fetchUniversalTitle(sessionToken, titleId);
      setActiveTitle(nextTitle);
      heroScrollRef.current?.scrollTo({ x: 0, animated: false });
    } catch {
      setToast("Unable to open title");
    } finally {
      setInternalLoading(false);
    }
  }

  async function openPersonDetail(person: { name: string; role: string; headshotUrl: string | null; tmdbPersonId: number | null }) {
    // Canonical Person Detail lives at /person/[tmdbId]. If we have a TMDB id, route there.
    if (person.tmdbPersonId) {
      onClose();
      router.push(`/person/${person.tmdbPersonId}` as never);
      return;
    }
    // Fallback: no TMDB id — show the inline sheet with the local data we have.
    setSelectedPerson(person);
    setPersonProfile(null);
  }

  async function openTrailer() {
    if (!sessionToken || !currentTitle?.id) {
      return;
    }
    if (trailerKey) {
      await WebBrowser.openBrowserAsync(`https://www.youtube.com/watch?v=${trailerKey}`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        toolbarColor: colors.background,
      });
      return;
    }
    if (trailerFetched) {
      return;
    }
    setTrailerLoading(true);
    try {
      const videos = await apiRequest<Array<{ key: string; site: string; type: string; name: string }>>(
        `/titles/${currentTitle.id}/videos`,
        { token: sessionToken }
      );
      const first = videos[0] ?? null;
      setTrailerFetched(true);
      if (first?.key) {
        setTrailerKey(first.key);
        await WebBrowser.openBrowserAsync(`https://www.youtube.com/watch?v=${first.key}`, {
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
          toolbarColor: colors.background,
        });
      } else {
        setToast("No trailer available for this title");
      }
    } catch {
      setToast("Could not load trailer");
    } finally {
      setTrailerLoading(false);
    }
  }

  if (!rendered) return null;

  return (
    <>
      <Modal transparent animationType="none" visible={rendered} onRequestClose={onClose} statusBarTranslucent>
        <View style={styles.root}>
          <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]} />
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

          <Animated.View style={[styles.shell, { transform: [{ translateY: sheetTranslateY }] }]}>
            <View style={styles.handleWrap}>
              <View style={styles.handle} />
            </View>

            <Pressable style={[styles.closeButton, { top: Math.max(insets.top + 8, 18) }]} onPress={onClose}>
              <Ionicons name="close" size={18} color={colors.ink} />
            </Pressable>

            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
              {/* Hero image carousel */}
              <Animated.View style={[styles.heroCard, { opacity: heroOpacity }]}>
                <ScrollView
                  ref={heroScrollRef}
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  onMomentumScrollEnd={handleImageScroll}
                  scrollEventThrottle={16}
                >
                  {(galleryImages.length ? galleryImages : [{ url: "", kind: "backdrop" }]).map((image, index) => (
                    <View key={`${image.url}-${index}`} style={styles.heroSlide}>
                      {image.url
                        ? <Image source={{ uri: image.url }} style={styles.heroImage} resizeMode="cover" />
                        : <View style={styles.heroFallback} />
                      }
                      <View style={styles.heroShade} />
                      <View style={styles.heroGradient} />
                    </View>
                  ))}
                </ScrollView>

                <View style={styles.heroContent}>
                  <View style={styles.heroTopRow}>
                    <Pressable
                      style={[styles.trailerButton, (trailerFetched && !trailerKey) && styles.trailerButtonDim]}
                      onPress={() => void openTrailer()}
                      disabled={trailerLoading || (trailerFetched && !trailerKey)}
                    >
                      {trailerLoading
                        ? <Text style={styles.trailerButtonText}>Loading…</Text>
                        : (trailerFetched && !trailerKey)
                          ? null
                          : (
                            <>
                              <Ionicons name="play-circle" size={15} color={colors.background} />
                              <Text style={styles.trailerButtonText}>Trailer</Text>
                            </>
                          )
                      }
                    </Pressable>
                    {galleryImages.length > 1
                      ? <Text style={styles.galleryCount}>{activeImageIndex + 1}/{galleryImages.length}</Text>
                      : null
                    }
                  </View>
                  <View style={styles.heroBottomRow}>
                    <View style={styles.posterWrap}>
                      {posterImage
                        ? <Image source={{ uri: posterImage }} style={styles.poster} resizeMode="cover" />
                        : <View style={styles.posterFallback}><Ionicons name="film-outline" size={28} color={colors.ink} /></View>
                      }
                    </View>
                    <View style={styles.heroCopy}>
                      <Text style={styles.heroTitle}>{currentTitle?.title ?? "Title"}</Text>
                      <Text style={styles.heroFacts}>
                        {[
                          currentTitle?.year ?? "Unknown",
                          currentTitle?.mediaType === "movie" ? "Film" : "Series",
                        ].join("  ·  ")}
                      </Text>
                      {/* Editorial supporting line — pick the right credit for the medium.
                          Movies → "A film by {director}". Series → "Created by {creator}"
                          (falls back to director if TMDB has no creator listed). */}
                      {(() => {
                        const isMovie = currentTitle?.mediaType === "movie";
                        const director = currentTitle?.credits.director[0];
                        const creator = currentTitle?.credits.creator[0];
                        let credit: string | null = null;
                        if (isMovie && director) {
                          credit = `A film by ${director}`;
                        } else if (!isMovie && creator) {
                          credit = `Created by ${creator}`;
                        } else if (!isMovie && director) {
                          credit = `Directed by ${director}`;
                        } else if (director) {
                          credit = `A film by ${director}`;
                        }
                        return credit ? (
                          <Text style={styles.heroCredit} numberOfLines={1}>{credit}</Text>
                        ) : null;
                      })()}
                      <View style={styles.paginationRow}>
                        {galleryImages.slice(0, 8).map((image, index) => (
                          <View key={`dot-${index}`} style={[styles.paginationDot, index === activeImageIndex && styles.paginationDotActive]} />
                        ))}
                      </View>
                    </View>
                  </View>
                </View>
              </Animated.View>

              <Animated.View style={[styles.bodyWrap, { opacity: contentOpacity, transform: [{ translateY: contentTranslateY }] }]}>
                {/* Metadata chips — canonical TasteSignal component for consistency
                    across taste labels, genres, and title metadata everywhere. */}
                <View style={styles.section}>
                  <View style={styles.metaWrap}>
                    {metadataChips.map((item) => (
                      <TasteSignal
                        key={`${item.icon}-${item.label}`}
                        icon={item.icon}
                        label={item.label}
                      />
                    ))}
                  </View>
                </View>

                {/* Compact action toolbar — Mobile Title Detail spec §6.1.
                    Replaces the old five-card stack. Four equal targets
                    (Save · Watch Team · Send · More) placed BEFORE Overview
                    so decisions are one tap without displacing content. */}
                <View style={[styles.section, styles.actionToolbar]}>
                  <Pressable
                    style={({ pressed }) => [styles.toolbarBtn, pressed && styles.toolbarBtnPressed, savedState && styles.toolbarBtnActive]}
                    onPress={openSaveFlow}
                    accessibilityRole="button"
                    accessibilityState={{ selected: savedState }}
                    accessibilityLabel={savedState ? `Saved: ${currentTitle?.title ?? ""}` : `Save ${currentTitle?.title ?? ""}`}
                  >
                    <Ionicons
                      name={savedState ? "bookmark" : "bookmark-outline"}
                      size={20}
                      color={colors.background}
                    />
                    <Text style={styles.toolbarBtnLabel}>
                      {savedState ? "Saved" : "Save"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.toolbarBtn, pressed && styles.toolbarBtnPressed]}
                    onPress={openAddToTeamFlow}
                    accessibilityRole="button"
                    accessibilityLabel="Add to a Watch Team"
                  >
                    <Ionicons name="people-outline" size={20} color={colors.background} />
                    <Text style={styles.toolbarBtnLabel}>Team</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.toolbarBtn, pressed && styles.toolbarBtnPressed]}
                    onPress={() => {
                      if (!currentTitle) return;
                      setShowSendSheet(true);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Send this title to a SeenSnap user"
                  >
                    <Ionicons name="paper-plane-outline" size={20} color={colors.background} />
                    <Text style={styles.toolbarBtnLabel}>Send</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.toolbarBtn, pressed && styles.toolbarBtnPressed]}
                    onPress={() => setShowMoreSheet(true)}
                    accessibilityRole="button"
                    accessibilityLabel="More actions"
                  >
                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.background} />
                    <Text style={styles.toolbarBtnLabel}>More</Text>
                  </Pressable>
                </View>

                {/* Overview */}
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Overview</Text>
                  <Text style={styles.description} numberOfLines={expandedDescription ? 0 : 5}>
                    {currentTitle?.description ?? "Full details are unavailable right now."}
                  </Text>
                  {hasLongDescription ? (
                    <Pressable onPress={() => setExpandedDescription((current) => !current)} style={styles.readMore}>
                      <Text style={styles.readMoreText}>{expandedDescription ? "Show less" : "Read more"}</Text>
                    </Pressable>
                  ) : null}
                </View>

                {/* Where to Watch — moved above Cast & Creators per spec §5. */}
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Where to Watch</Text>
                  {watchOptionsLoading ? (
                    <Text style={styles.emptyText}>Loading…</Text>
                  ) : watchOptions ? (
                    <>
                      {WATCH_GROUP_CONFIG.map(({ key, label }) => {
                        const providers = watchOptions.groups[key] ?? [];
                        if (!providers.length) return null;
                        return (
                          <View key={key} style={styles.watchGroup}>
                            <Text style={styles.watchGroupLabel}>{label}</Text>
                            {providers.map((provider) => (
                              <WatchProviderCard
                                key={provider.provider_code}
                                provider={provider}
                                onAction={(action) => void openWatchAction(provider, action)}
                              />
                            ))}
                          </View>
                        );
                      })}
                      {!WATCH_GROUP_CONFIG.some(({ key }) => (watchOptions.groups[key] ?? []).length > 0) ? (
                        <Text style={styles.emptyText}>Streaming availability isn't available for this title right now.</Text>
                      ) : null}
                      <Text style={styles.justWatchAttrib}>Streaming data provided by JustWatch</Text>
                    </>
                  ) : (
                    <Text style={styles.emptyText}>Streaming availability isn't available for this title right now.</Text>
                  )}
                </View>

                {/* Cast & Creators */}
                {allPeople.length > 0 ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Cast & Creators</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.peopleRail}>
                      {allPeople.map((person, index) => (
                        <PersonCard
                          key={`${person.name}-${index}`}
                          name={person.name}
                          role={person.role}
                          headshotUrl={person.headshotUrl}
                          onPress={() => void openPersonDetail(person)}
                        />
                      ))}
                    </ScrollView>
                  </View>
                ) : null}

                {/* More Like This — comes AFTER core informational sections per §7.4. */}
                {(currentTitle?.relatedTitles ?? []).length > 0 ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>More Like This</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedRail}>
                      {(currentTitle?.relatedTitles ?? []).map((related) => (
                        <Pressable key={related.id} style={styles.relatedCard} onPress={() => void openRelatedTitle(related.id)}>
                          {related.posterUrl ? (
                            <Image source={{ uri: resolveMediaUrl(related.posterUrl) ?? related.posterUrl }} style={styles.relatedPoster} />
                          ) : (
                            <View style={styles.relatedPosterFallback}>
                              <Ionicons name="film" size={18} color={colors.muted} />
                            </View>
                          )}
                          <Text style={styles.relatedTitle} numberOfLines={2}>{related.title}</Text>
                          <Text style={styles.relatedMeta}>{[related.year ?? "—", related.mediaType === "movie" ? "Movie" : "TV"].join(" • ")}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                ) : null}
              </Animated.View>
            </ScrollView>

            {/* Toast */}
            {toast ? (
              <Animated.View style={[styles.toast, { opacity: toastOpacity, transform: [{ translateY: toastTranslateY }] }]}>
                <Text style={styles.toastText}>{toast}</Text>
              </Animated.View>
            ) : null}
          </Animated.View>

          {/* Secondary sheets — nested inside main modal so iOS stacks them correctly */}
          <SaveToListSheet
            visible={showSaveSheet}
            token={sessionToken}
            titleId={currentTitle?.id ?? null}
            source="details"
            onClose={() => setShowSaveSheet(false)}
            onSaved={(listName, alreadySaved) => {
              if (currentTitle?.id) setSavedTitleIds((current) => new Set(current).add(currentTitle.id));
              setToast(alreadySaved ? `Already in ${listName}` : `Saved to ${listName}`);
              onSave?.();
            }}
            onError={(message) => setToast(message)}
          />

          <AddToTeamSheet
            visible={showAddToTeam}
            token={sessionToken}
            title={currentTitle ? { id: currentTitle.id, title: currentTitle.title } : null}
            onClose={() => setShowAddToTeam(false)}
            onAdded={(teamName) => setToast(`Added to ${teamName}`)}
            onError={(message) => setToast(message)}
          />

          {currentTitle ? (
            <ShareComposerSheet
              visible={showShareToFeed}
              token={sessionToken}
              sourceSurface="title_detail"
              entityType="title"
              titleId={currentTitle.id}
              titleName={currentTitle.title}
              posterUrl={currentTitle.posterUrl}
              contentType={currentTitle.mediaType}
              onClose={() => setShowShareToFeed(false)}
              onPosted={() => setToast(`Shared ${currentTitle.title} to your feed`)}
            />
          ) : null}

          {currentTitle ? (
            <SendToUserSheet
              visible={showSendSheet}
              token={sessionToken}
              contentType="title"
              contentId={currentTitle.id}
              sourceSurface="title_detail"
              preview={{
                headline: currentTitle.title,
                subline: currentTitle.mediaType === "movie" ? "FILM" : "SERIES",
                thumbnailUrl: currentTitle.posterUrl ?? null,
              }}
              onClose={() => setShowSendSheet(false)}
              onSent={(_msg, recipient) =>
                setToast(`Sent to ${recipient.display_name ?? "them"}`)
              }
              onError={(msg) => setToast(msg)}
            />
          ) : null}

          {selectedPerson ? (
            <PersonDetailSheet
              person={selectedPerson}
              profile={personProfile}
              loading={personLoading}
              onClose={() => { setSelectedPerson(null); setPersonProfile(null); }}
              onOpenTitle={(titleId) => {
                setSelectedPerson(null);
                setPersonProfile(null);
                void openRelatedTitle(titleId);
              }}
              sessionToken={sessionToken}
            />
          ) : null}

          {/* More action sheet — Mobile Title Detail spec §6.2. Holds the
              lower-frequency share actions so they don't compete with
              Save/Team/Send for viewport space. */}
          <Modal
            visible={showMoreSheet}
            transparent
            animationType="slide"
            onRequestClose={() => setShowMoreSheet(false)}
          >
            <Pressable style={styles.moreSheetBackdrop} onPress={() => setShowMoreSheet(false)}>
              <Pressable style={styles.moreSheet} onPress={(e) => e.stopPropagation()}>
                <View style={styles.moreSheetHeader}>
                  <Text style={styles.moreSheetTitle}>More actions</Text>
                  <Pressable onPress={() => setShowMoreSheet(false)} hitSlop={10}>
                    <Ionicons name="close" size={22} color={colors.muted} />
                  </Pressable>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.moreSheetRow, pressed && { opacity: 0.7 }]}
                  onPress={() => {
                    if (!currentTitle) return;
                    setShowMoreSheet(false);
                    setShowShareToFeed(true);
                  }}
                  accessibilityRole="button"
                >
                  <View style={styles.moreSheetIcon}>
                    <Ionicons name="megaphone-outline" size={20} color={colors.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.moreSheetRowTitle}>Share to Feed</Text>
                    <Text style={styles.moreSheetRowBody}>Post this title to your SeenSnap followers.</Text>
                  </View>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.moreSheetRow, pressed && { opacity: 0.7 }]}
                  onPress={() => {
                    if (!currentTitle) return;
                    setShowMoreSheet(false);
                    void shareTitle({
                      titleId: currentTitle.id,
                      tmdbId: currentTitle.tmdbId ?? 0,
                      mediaType: currentTitle.mediaType === "movie" ? "movie" : "series",
                      displayTitle: currentTitle.title,
                      entryPoint: "title_detail_more_sheet",
                    });
                  }}
                  accessibilityRole="button"
                >
                  <View style={styles.moreSheetIcon}>
                    <Ionicons name="share-outline" size={20} color={colors.muted} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.moreSheetRowTitle}>Share Link</Text>
                    <Text style={styles.moreSheetRowBody}>Share a SeenSnap link outside the app.</Text>
                  </View>
                </Pressable>
              </Pressable>
            </Pressable>
          </Modal>
        </View>
      </Modal>
    </>
  );
}

function PersonDetailSheet({
  person,
  profile,
  loading,
  onClose,
  onOpenTitle,
  sessionToken,
}: {
  person: { name: string; role: string; headshotUrl: string | null; tmdbPersonId: number | null };
  profile: PersonProfile | null;
  loading: boolean;
  onClose: () => void;
  onOpenTitle: (titleId: string) => void;
  sessionToken: string | null;
}) {
  const translateY = useRef(new Animated.Value(screenHeight)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, damping: 22, stiffness: 200, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY]);

  function close() {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: screenHeight, duration: 220, useNativeDriver: true }),
    ]).start(onClose);
  }

  const profileUrl = profile?.profileUrl ?? person.headshotUrl;
  const resolvedProfile = resolveMediaUrl(profileUrl) ?? profileUrl;
  const bio = profile?.biography;
  const dept = profile?.knownForDepartment ?? person.role;
  const birthInfo = [profile?.birthday, profile?.placeOfBirth].filter(Boolean).join(" · ");

  const [imgFailed, setImgFailed] = useState(false);

  return (
    <Modal transparent animationType="none" visible onRequestClose={close} statusBarTranslucent>
      <View style={styles.root}>
        <Animated.View style={[styles.overlay, { opacity }]} />
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        <Animated.View style={[styles.personSheet, { transform: [{ translateY }] }]}>
          <View style={styles.handleWrap}><View style={styles.handle} /></View>
          <Pressable style={styles.closeButton} onPress={close}>
            <Ionicons name="close" size={18} color={colors.ink} />
          </Pressable>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.personSheetContent}>
            {/* Profile header */}
            <View style={styles.personSheetHeader}>
              <View style={styles.personSheetImageWrap}>
                {resolvedProfile && !imgFailed ? (
                  <Image
                    source={{ uri: resolvedProfile }}
                    style={styles.personSheetImage}
                    resizeMode="cover"
                    onError={() => setImgFailed(true)}
                  />
                ) : (
                  <View style={styles.personSheetImageFallback}>
                    <Ionicons name="person" size={44} color={colors.ink} />
                  </View>
                )}
              </View>
              <View style={styles.personSheetMeta}>
                <Text style={styles.personSheetName}>{profile?.name ?? person.name}</Text>
                <Text style={styles.personSheetDept}>{dept}</Text>
                {birthInfo ? <Text style={styles.personSheetBirth}>{birthInfo}</Text> : null}
              </View>
            </View>

            {/* Bio */}
            {loading ? (
              <View style={[styles.section, { alignItems: "center", padding: 24 }]}>
                <Text style={styles.emptyText}>Loading profile…</Text>
              </View>
            ) : null}

            {!loading && bio ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Biography</Text>
                <Text style={styles.description} numberOfLines={6}>{bio}</Text>
              </View>
            ) : null}

            {/* Known for / Credits carousel */}
            {!loading && (profile?.credits ?? []).length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Known For</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedRail}>
                  {(profile?.credits ?? []).slice(0, 16).map((credit, index) => (
                    <Pressable
                      key={`${credit.tmdbId}-${index}`}
                      style={styles.relatedCard}
                      onPress={() => {
                        // We need the internal title id — for now search by tmdb_id
                        // For v1, tap just shows what we have (can't deep-link without SeenSnap ID)
                      }}
                    >
                      {credit.posterUrl ? (
                        <Image source={{ uri: credit.posterUrl }} style={styles.relatedPoster} />
                      ) : (
                        <View style={styles.relatedPosterFallback}>
                          <Ionicons name="film" size={18} color={colors.muted} />
                        </View>
                      )}
                      <Text style={styles.relatedTitle} numberOfLines={2}>{credit.title}</Text>
                      {credit.character ? (
                        <Text style={styles.relatedMeta} numberOfLines={1}>{credit.character}</Text>
                      ) : credit.job ? (
                        <Text style={styles.relatedMeta} numberOfLines={1}>{credit.job}</Text>
                      ) : null}
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {!loading && !profile ? (
              <View style={styles.section}>
                <Text style={styles.emptyText}>Detailed profile not available.</Text>
              </View>
            ) : null}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function ActionCard({
  icon,
  title,
  subtitle,
  accent,
  onPress,
  highlighted = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  accent: string;
  onPress: () => void;
  highlighted?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, bounciness: 0 }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 10 }).start()}
    >
      <Animated.View style={[styles.actionCard, highlighted && styles.actionCardHighlighted, { transform: [{ scale }] }]}>
        <View style={[styles.actionIconWrap, { backgroundColor: `${accent}22` }]}>
          <Ionicons name={icon} size={18} color={accent} />
        </View>
        <View style={styles.actionCopy}>
          <Text style={styles.actionTitle}>{title}</Text>
          <Text style={styles.actionSubtitle}>{subtitle}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
      </Animated.View>
    </Pressable>
  );
}

function WatchProviderCard({
  provider,
  onAction,
}: {
  provider: WatchProvider;
  onAction: (action: WatchAction) => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = Boolean(provider.logo_url && !logoFailed);

  return (
    <View style={styles.providerCard}>
      <View style={styles.providerLogoWrap}>
        {showLogo ? (
          <Image
            source={{ uri: provider.logo_url! }}
            style={styles.providerLogoImg}
            resizeMode="contain"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <View style={styles.providerLogoFallback}>
            <Text style={styles.providerLogoFallbackText} numberOfLines={1}>
              {provider.provider_name.slice(0, 4).toUpperCase()}
            </Text>
          </View>
        )}
      </View>
      <Text style={[styles.providerName, styles.providerCardName]}>{provider.provider_name}</Text>
      <View style={styles.providerCardActions}>
        {provider.actions.map((action) => (
          <Pressable
            key={action.intent}
            style={[styles.watchAction, action.intent === "watch" && styles.watchActionPrimary]}
            onPress={() => onAction(action)}
          >
            <Text style={[styles.watchActionLabel, action.intent === "watch" && styles.watchActionLabelPrimary]}>
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function PersonCard({
  name,
  role,
  headshotUrl,
  onPress,
}: {
  name: string;
  role: string;
  headshotUrl: string | null;
  onPress: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const resolved = resolveMediaUrl(headshotUrl) ?? headshotUrl;
  const showImage = Boolean(resolved && !failed);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.94, useNativeDriver: true, bounciness: 0 }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 12 }).start()}
    >
      <Animated.View style={[styles.personCard, { transform: [{ scale }] }]}>
        <View style={styles.personImageWrap}>
          {showImage ? (
            <Image
              source={{ uri: resolved ?? undefined }}
              style={[styles.personHeadshot, !loaded && styles.personHeadshotHidden]}
              onError={() => setFailed(true)}
              onLoad={() => setLoaded(true)}
            />
          ) : null}
          {!showImage || !loaded ? (
            <View style={styles.personFallback}>
              <Ionicons name="person" size={22} color={colors.ink} />
            </View>
          ) : null}
        </View>
        <Text style={styles.personName} numberOfLines={1}>{name}</Text>
        <Text style={styles.personRole} numberOfLines={2}>{role}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(4, 10, 18, 0.82)" },
  shell: {
    height: screenHeight,
    backgroundColor: colors.background,
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: rules.default,
  },
  handleWrap: { position: "absolute", top: 10, width: "100%", alignItems: "center", zIndex: 30 },
  handle: { width: 44, height: 5, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.25)" },
  closeButton: {
    position: "absolute",
    right: 16,
    zIndex: 40,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(6, 16, 29, 0.62)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { flex: 1 },
  // paddingBottom was 260 to make room for the removed floating actionTray.
  // With the toolbar now in-flow, only safe-area buffer is needed.
  scrollContent: { paddingBottom: 40 },
  heroCard: { height: HERO_HEIGHT, backgroundColor: colors.surfaceMuted },
  heroSlide: { width: screenWidth, height: HERO_HEIGHT, backgroundColor: colors.surfaceMuted },
  heroImage: { width: "100%", height: "100%" },
  heroFallback: { width: "100%", height: "100%", backgroundColor: colors.surfaceMuted },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(5, 11, 20, 0.14)" },
  heroGradient: { position: "absolute", left: 0, right: 0, bottom: 0, height: 240, backgroundColor: "rgba(9,17,32,0.78)" },
  heroContent: {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
    paddingTop: 54, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg,
    justifyContent: "space-between",
  },
  heroTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  trailerButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
    backgroundColor: "rgba(244, 196, 48, 0.9)",
    paddingHorizontal: 13,
    paddingVertical: 8,
    shadowColor: "#f4c430",
    shadowOpacity: 0.45,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  trailerButtonDim: { opacity: 0 },
  trailerButtonText: {
    color: colors.background,
    fontFamily: fonts.monoSemiBold,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  galleryCount: {
    color: colors.ink, fontFamily: fonts.mono, fontSize: 12,
    backgroundColor: "rgba(6,16,29,0.52)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
  },
  heroBottomRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.md },
  posterWrap: {
    borderRadius: radii.xxl, padding: 4,
    backgroundColor: "rgba(7, 15, 28, 0.52)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.14)",
  },
  poster: { width: 116, height: 174, borderRadius: 16, backgroundColor: colors.surface },
  posterFallback: { width: 116, height: 174, borderRadius: 16, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  heroCopy: { flex: 1, gap: spacing.sm, paddingBottom: 8 },
  heroTitle: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 34, lineHeight: 40, letterSpacing: -0.3 },
  heroFacts: {
    color: "rgba(242,244,248,0.9)",
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  heroCredit: {
    color: "rgba(242,244,248,0.78)",
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  heroSubtitle: { color: "rgba(242,244,248,0.9)", fontFamily: fonts.sansSemiBold, fontSize: 15 },
  paginationRow: { flexDirection: "row", gap: 6, marginTop: 2 },
  paginationDot: { width: 8, height: 8, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.24)" },
  paginationDotActive: { width: 20, backgroundColor: colors.accent },
  bodyWrap: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  section: {
    borderRadius: radii.xxl, borderWidth: 1, borderColor: rules.default,
    backgroundColor: colors.backgroundElevated,
    padding: spacing.lg, gap: spacing.sm,
  },
  sectionTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 17 },
  metaWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metaChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    borderRadius: radii.pill, borderWidth: 1, borderColor: rules.default,
    backgroundColor: "rgba(7, 15, 28, 0.42)", paddingHorizontal: 12, paddingVertical: 9,
  },
  metaChipText: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 12 },
  description: { color: colors.ink, fontFamily: fonts.sans, fontSize: 15, lineHeight: 24 },
  readMore: { alignSelf: "flex-start", paddingTop: 2 },
  readMoreText: { color: colors.accent, fontFamily: fonts.sansBold, fontSize: 13 },
  peopleRail: { gap: spacing.sm, paddingRight: spacing.lg },
  personCard: {
    width: 118, borderRadius: radii.xxl, borderWidth: 1, borderColor: rules.default,
    backgroundColor: "rgba(7, 15, 28, 0.55)", padding: spacing.sm, gap: spacing.sm,
  },
  personImageWrap: { width: "100%", height: 128 },
  personHeadshot: { width: "100%", height: 128, borderRadius: 16, backgroundColor: colors.surfaceMuted },
  personHeadshotHidden: { opacity: 0 },
  personFallback: {
    ...StyleSheet.absoluteFillObject, borderRadius: 16,
    backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center",
  },
  personName: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13 },
  personRole: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  watchGroup: { gap: 8 },
  watchGroupLabel: {
    color: colors.muted, fontFamily: fonts.monoSemiBold, fontSize: 10,
    letterSpacing: 1.4, textTransform: "uppercase",
  },
  providerCard: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    borderRadius: radii.xl, borderWidth: 1, borderColor: rules.default,
    backgroundColor: "rgba(7, 15, 28, 0.42)", paddingHorizontal: spacing.sm, paddingVertical: 10,
  },
  providerLogoWrap: {
    width: 52, height: 52, borderRadius: radii.xl, overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center", justifyContent: "center",
  },
  providerLogoImg: { width: "100%", height: "100%", borderRadius: radii.xl },
  providerLogoFallback: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  providerLogoFallbackText: { color: colors.ink, fontFamily: fonts.monoSemiBold, fontSize: 11, letterSpacing: 0.3 },
  providerName: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 14 },
  providerCardName: { flex: 1 },
  providerCardActions: { flexDirection: "row", gap: 6, alignItems: "center", flexShrink: 0 },
  watchAction: {
    borderRadius: radii.pill, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.08)", paddingHorizontal: 10, paddingVertical: 7,
  },
  watchActionPrimary: { borderColor: colors.accent, backgroundColor: "rgba(244,196,48,0.14)" },
  watchActionLabel: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 12 },
  watchActionLabelPrimary: { color: colors.accent },
  justWatchAttrib: {
    color: colors.muted, fontFamily: fonts.mono, fontSize: 11, textAlign: "center", marginTop: 4, letterSpacing: 0.2,
  },
  emptyText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 22 },
  relatedRail: { gap: spacing.sm, paddingRight: spacing.lg },
  relatedCard: {
    width: 132, borderRadius: radii.xxl, borderWidth: 1, borderColor: rules.default,
    backgroundColor: "rgba(7, 15, 28, 0.42)", padding: spacing.sm, gap: 8,
  },
  relatedPoster: { width: "100%", height: 180, borderRadius: radii.xl, backgroundColor: colors.surfaceMuted },
  relatedPosterFallback: { width: "100%", height: 180, borderRadius: radii.xl, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  relatedTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13, lineHeight: 18 },
  relatedMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11 },
  actionTray: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: Platform.OS === "ios" ? 36 : spacing.xl,
    gap: 8,
    backgroundColor: "rgba(9,17,32,0.96)",
    borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.07)",
  },
  actionCard: {
    borderRadius: radii.xxl, borderWidth: 1, borderColor: rules.default,
    backgroundColor: colors.backgroundElevated,
    paddingHorizontal: spacing.md, paddingVertical: 13,
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  actionCardHighlighted: {
    borderColor: "rgba(244,196,48,0.22)",
    backgroundColor: "rgba(244,196,48,0.06)",
  },
  actionIconWrap: { width: 40, height: 40, borderRadius: radii.xl, alignItems: "center", justifyContent: "center" },
  actionCopy: { flex: 1, gap: 2 },
  actionTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  actionSubtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  toast: {
    position: "absolute", left: spacing.lg, right: spacing.lg, bottom: 220,
    borderRadius: radii.xxl, backgroundColor: "rgba(15, 31, 49, 0.96)",
    borderWidth: 1, borderColor: rules.default,
    paddingHorizontal: spacing.md, paddingVertical: 12, alignItems: "center",
  },
  toastText: { color: colors.ink, fontFamily: fonts.sansSemiBold, fontSize: 13 },
  // Person detail sheet
  personSheet: {
    height: screenHeight * 0.88,
    backgroundColor: colors.background,
    borderTopLeftRadius: radii.xxl, borderTopRightRadius: radii.xxl,
    overflow: "hidden",
    borderWidth: 1, borderColor: rules.default,
  },
  personSheetContent: { paddingBottom: 60 },
  personSheetHeader: {
    flexDirection: "row", gap: spacing.lg,
    padding: spacing.lg, paddingTop: 54,
    borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.07)",
  },
  personSheetImageWrap: {
    width: 120, height: 160, borderRadius: radii.xxl, overflow: "hidden",
    borderWidth: 1, borderColor: rules.default,
    backgroundColor: colors.surfaceMuted,
  },
  personSheetImage: { width: "100%", height: "100%" },
  personSheetImageFallback: {
    width: "100%", height: "100%", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surfaceMuted,
  },
  personSheetMeta: { flex: 1, justifyContent: "flex-end", gap: 6, paddingBottom: 4 },
  personSheetName: { color: colors.ink, fontFamily: fonts.serifBold, fontSize: 26, lineHeight: 30 },
  personSheetDept: { color: colors.accent, fontFamily: fonts.sansSemiBold, fontSize: 14 },
  personSheetBirth: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },

  // ─── Redesigned title-detail action toolbar + More sheet ───────────
  actionToolbar: {
    flexDirection: "row",
    gap: 6,
    marginBottom: spacing.md,
  },
  toolbarBtn: {
    // Solid SeenSnap yellow fill per product decision: the title-card
    // action bar (Save · Team · Send · More) is the primary action
    // affordance on every title surface, so it gets the accent color
    // rather than the subtle low-contrast treatment. Ink text on
    // accent background is WCAG-compliant (contrast ratio > 12:1).
    flex: 1,
    flexBasis: 0,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
  },
  toolbarBtnPressed: { opacity: 0.8 },
  toolbarBtnActive: {
    // Deeper amber when the action is already committed (e.g. Saved).
    // Same hue, +darkening + a hairline outline so users can tell at a
    // glance that the state is on without breaking the yellow theme.
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: colors.ink,
  },
  toolbarBtnLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 0.8,
    color: colors.background,
    textTransform: "uppercase",
  },
  moreSheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  moreSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    paddingBottom: 32,
    gap: spacing.sm,
    maxHeight: 480,
  },
  moreSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  moreSheetTitle: {
    color: colors.ink,
    fontFamily: fonts.serifBold,
    fontSize: 20,
  },
  moreSheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: radii.sm,
  },
  moreSheetIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSoft,
  },
  moreSheetRowTitle: {
    color: colors.ink,
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
  },
  moreSheetRowBody: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
});
