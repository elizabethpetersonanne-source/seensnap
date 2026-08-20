import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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

import { UniversalTitleModal } from "@/components/universal-title-modal";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  fetchPersonDetails,
  fetchUniversalTitleByTmdbId,
  type PersonProfile,
  type UniversalTitle,
} from "@/lib/universal-title";

const BIO_PREVIEW_CHARS = 320;

export default function PersonDetailScreen() {
  const { tmdbId } = useLocalSearchParams<{ tmdbId: string }>();
  const { sessionToken } = useAuth();
  const [person, setPerson] = useState<PersonProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bioExpanded, setBioExpanded] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalTitle, setModalTitle] = useState<UniversalTitle | null>(null);

  useEffect(() => {
    if (!sessionToken || !tmdbId) return;
    const parsed = Number(tmdbId);
    if (!Number.isFinite(parsed)) {
      setError("Invalid person id");
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchPersonDetails(sessionToken, parsed)
      .then(setPerson)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load person"))
      .finally(() => setLoading(false));
  }, [sessionToken, tmdbId]);

  async function openCredit(mediaType: string, tmdb: number) {
    if (!sessionToken) return;
    setModalVisible(true);
    setModalLoading(true);
    setModalTitle(null);
    try {
      const t = await fetchUniversalTitleByTmdbId(sessionToken, mediaType, tmdb);
      setModalTitle(t);
    } catch {
      setModalVisible(false);
    } finally {
      setModalLoading(false);
    }
  }

  const bio = person?.biography ?? null;
  const bioIsLong = (bio?.length ?? 0) > BIO_PREVIEW_CHARS;
  const displayedBio = useMemo(() => {
    if (!bio) return null;
    if (bioExpanded || !bioIsLong) return bio;
    return bio.slice(0, BIO_PREVIEW_CHARS).trimEnd() + "…";
  }, [bio, bioExpanded, bioIsLong]);

  // Sort credits: newest first, then by whether they have poster art
  const credits = useMemo(() => {
    if (!person) return [];
    return [...person.credits]
      .filter((c) => c.title)
      .sort((a, b) => {
        const ya = a.releaseDate ? Number(a.releaseDate.slice(0, 4)) : 0;
        const yb = b.releaseDate ? Number(b.releaseDate.slice(0, 4)) : 0;
        if (yb !== ya) return yb - ya;
        return (b.posterUrl ? 1 : 0) - (a.posterUrl ? 1 : 0);
      });
  }, [person]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerLabel}>Person</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : person ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            {person.profileUrl ? (
              <Image source={{ uri: person.profileUrl }} style={styles.portrait} resizeMode="cover" />
            ) : (
              <View style={[styles.portrait, styles.portraitFallback]}>
                <Ionicons name="person" size={44} color={colors.muted2} />
              </View>
            )}
            <View style={styles.heroMeta}>
              <Text style={styles.name}>{person.name}</Text>
              {person.knownForDepartment ? (
                <Text style={styles.roleLine}>{person.knownForDepartment}</Text>
              ) : null}
              {(person.birthday || person.placeOfBirth) ? (
                <>
                  <View style={styles.rule} />
                  <Text style={styles.factLine}>
                    {[
                      person.birthday ? `Born ${person.birthday}` : null,
                      person.placeOfBirth,
                    ]
                      .filter(Boolean)
                      .join("  ·  ")}
                  </Text>
                </>
              ) : null}
            </View>
          </View>

          {displayedBio ? (
            <View style={styles.bioSection}>
              <Text style={styles.sectionLabel}>BIOGRAPHY</Text>
              <View style={styles.sectionRule} />
              <Text style={styles.bio}>{displayedBio}</Text>
              {bioIsLong ? (
                <Pressable onPress={() => setBioExpanded((v) => !v)} hitSlop={8}>
                  <Text style={styles.bioToggle}>
                    {bioExpanded ? "Show less" : "Read more"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <View style={styles.filmographySection}>
            <View style={styles.filmoHead}>
              <Text style={styles.sectionLabel}>FILMOGRAPHY</Text>
              <View style={styles.sectionRule} />
              <Text style={styles.sectionCount}>{credits.length}</Text>
            </View>
            {credits.length === 0 ? (
              <Text style={styles.emptyText}>No filmography data available.</Text>
            ) : (
              <View style={styles.grid}>
                {credits.map((c) => (
                  <Pressable
                    key={`${c.mediaType}-${c.tmdbId}`}
                    style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                    onPress={() => void openCredit(c.mediaType, c.tmdbId)}
                  >
                    {c.posterUrl ? (
                      <Image
                        source={{ uri: c.posterUrl }}
                        style={styles.poster}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={[styles.poster, styles.posterFallback]}>
                        <Ionicons name="film" size={20} color={colors.muted2} />
                      </View>
                    )}
                    <View style={styles.cardMeta}>
                      <Text style={styles.cardTitle} numberOfLines={2}>{c.title}</Text>
                      <Text style={styles.cardSubtitle} numberOfLines={1}>
                        {[
                          c.mediaType === "movie" ? "FILM" : "SERIES",
                          c.releaseDate ? c.releaseDate.slice(0, 4) : null,
                        ]
                          .filter(Boolean)
                          .join("  ·  ")}
                      </Text>
                      {c.character || c.job ? (
                        <Text style={styles.role} numberOfLines={1}>
                          {c.character ? `as ${c.character}` : c.job}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          <View style={{ height: spacing.xl }} />
        </ScrollView>
      ) : null}

      <UniversalTitleModal
        visible={modalVisible}
        loading={modalLoading}
        title={modalTitle}
        onClose={() => {
          setModalVisible(false);
          setModalTitle(null);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: rules.default,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    color: colors.muted,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  hero: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  portrait: {
    width: 116,
    height: 156,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
  },
  portraitFallback: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: rules.default,
  },
  heroMeta: {
    flex: 1,
    gap: spacing.xs,
  },
  name: {
    fontFamily: fonts.serifBold,
    fontSize: 28,
    lineHeight: 32,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  roleLine: {
    fontFamily: fonts.serif,
    fontStyle: "italic",
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    marginTop: 2,
  },
  rule: {
    height: 1,
    width: 40,
    backgroundColor: rules.gold,
    marginVertical: 4,
  },
  factLine: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
    letterSpacing: 0.3,
  },
  bioSection: {
    marginBottom: spacing.xl,
    gap: spacing.sm,
  },
  sectionLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: colors.accent,
  },
  sectionRule: {
    height: 1,
    width: 40,
    backgroundColor: rules.gold,
  },
  bio: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 24,
    color: colors.muted,
  },
  bioToggle: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: colors.accent,
    marginTop: 4,
    textTransform: "uppercase",
  },
  filmographySection: {
    marginBottom: spacing.xl,
    gap: spacing.md,
  },
  filmoHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sectionCount: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted2,
    marginLeft: "auto",
  },
  emptyText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted2,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  card: {
    width: "32%",
    borderRadius: radii.sm,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: rules.default,
    backgroundColor: colors.surface,
  },
  cardPressed: { opacity: 0.7 },
  poster: {
    width: "100%",
    aspectRatio: 2 / 3,
    backgroundColor: colors.backgroundElevated,
  },
  posterFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  cardMeta: {
    padding: 6,
    gap: 2,
  },
  cardTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 11,
    lineHeight: 15,
    color: colors.ink,
  },
  cardSubtitle: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.3,
    color: colors.muted2,
  },
  role: {
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 13,
    color: colors.muted,
    marginTop: 2,
  },
  error: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.danger,
    textAlign: "center",
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
});
