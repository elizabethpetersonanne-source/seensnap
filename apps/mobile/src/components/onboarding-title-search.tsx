import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "@/lib/auth";
import { apiRequest, ApiError } from "@/lib/api";
import { colors } from "@/constants/theme";
import { ConfirmDialog } from "@/components/confirm-dialog";
type Title = {
  id: string;
  title: string;
  poster_url: string | null;
  content_type: string;
};
export function OnboardingTitleSearch({
  onRate,
}: {
  onRate: (title: Title) => void;
}) {
  const { sessionToken } = useAuth();
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<Title[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null),
    [chosen, setChosen] = useState<Title | null>(null),
    [saved, setSaved] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  const lock = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    let active = true;
    const version = ++generation.current;
    setItems([]);
    setError(null);
    setLoading(false);
    if (!sessionToken || query.trim().length < 2) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void apiRequest<Title[]>(
        `/titles/search?q=${encodeURIComponent(query.trim())}`,
        { token: sessionToken, timeoutMs: 30000 },
      )
        .then((next) => {
          if (active && version === generation.current) setItems(next);
        })
        .catch(() => {
          if (active) setError("Search could not load. Please try again.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sessionToken, query, retry]);
  async function chooseFirst() {
    if (!sessionToken || !chosen || lock.current) return;
    lock.current = true;
    setSaving(true);
    setSaveError(null);
    const version = generation.current;
    try {
      try {
        await apiRequest("/me/favorites/ranked", {
          token: sessionToken,
          method: "POST",
          body: JSON.stringify({ title_id: chosen.id, position: 1 }),
        });
      } catch (e) {
        if (
          !(e instanceof ApiError) ||
          e.status !== 409 ||
          e.detail !== "Already in ranked favorites"
        )
          throw e;
        await apiRequest(`/me/favorites/ranked/${chosen.id}/move`, {
          token: sessionToken,
          method: "POST",
          body: JSON.stringify({ to_position: 1 }),
        });
      }
      if (version === generation.current) {
        setSaved(chosen.title);
        setChosen(null);
      }
    } catch {
      if (version === generation.current)
        setSaveError("Could not save your #1. Please try again.");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <View style={{ paddingVertical: 16, gap: 10, width: "100%" }}>
      <Text style={{ color: colors.ink, fontSize: 16 }}>
        Know what you love? Search and rate it.
      </Text>
      <TextInput
        accessibilityLabel="Search films and series to rate"
        value={query}
        onChangeText={setQuery}
        placeholder="Find a film or series"
        placeholderTextColor={colors.muted}
        style={{
          fontSize: 16,
          color: colors.ink,
          minHeight: 48,
          padding: 12,
          borderWidth: 1,
          borderColor: colors.muted2,
          borderRadius: 8,
        }}
      />
      {loading ? <ActivityIndicator color={colors.accent} /> : null}
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.accent, fontSize: 15 }}
        >
          {error}
        </Text>
      ) : null}
      {error ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setRetry((n) => n + 1)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={{ color: colors.ink }}>Retry search</Text>
        </Pressable>
      ) : null}
      {saved ? (
        <Text style={{ color: colors.accent, fontSize: 15 }}>
          Your #1: {saved}
        </Text>
      ) : null}
      {query.trim().length >= 2 && !loading && !items.length && !error ? (
        <Text style={{ color: colors.muted }}>
          No matches yet. Try the full title.
        </Text>
      ) : null}
      <ScrollView
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: 280 }}
      >
        {items.map((t) => (
          <View
            key={t.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingVertical: 8,
            }}
          >
            {t.poster_url ? (
              <Image
                source={{ uri: t.poster_url }}
                style={{ width: 36, height: 54, borderRadius: 4 }}
              />
            ) : null}
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.ink, fontSize: 15 }}>{t.title}</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>
                {t.content_type === "movie" ? "Film" : "Series"}
              </Text>
            </View>
            <Pressable
              accessibilityLabel={`Rate ${t.title}`}
              style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
              onPress={() => onRate(t)}
            >
              <Text style={{ color: colors.accent }}>Rate</Text>
            </Pressable>
            <Pressable
              disabled={saving}
              accessibilityLabel={`Choose ${t.title} as your number one`}
              style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
              onPress={() => {
                setSaveError(null);
                setChosen(t);
              }}
            >
              <Text style={{ color: colors.ink }}>#1</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      <ConfirmDialog
        visible={!!chosen}
        title="Choose your #1?"
        message={`${chosen?.title ?? "This title"} will be first in Ranked Favorites and on your profile. Your numeric ratings will stay the same. You can change the order later.${saveError ? "\n\n" + saveError : ""}`}
        busy={saving}
        onCancel={() => setChosen(null)}
        onConfirm={() => void chooseFirst()}
        confirmLabel="Make my #1"
      />
    </View>
  );
}
