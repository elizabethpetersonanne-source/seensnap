import { apiRequest } from "./api";

export type PickTitle = {
  id: string;
  title: string;
  poster_url: string | null;
  backdrop_url: string | null;
  year: number | null;
  media_type: string;
  personal_score: number | null;
  rank_label: string | null;
  context_label: string | null;
};

export type PickList = {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  titles: PickTitle[];
  total_count?: number;
};

export type PicksCollections = {
  ranked_favorites: PickTitle[];
  my_next_watch: PickTitle[];
  favorites: PickTitle[];
  watched: PickTitle[];
  my_lists: PickList[];
  ranked_favorites_count?: number;
  rated_unplaced_count?: number;
  my_next_watch_count?: number;
  favorites_count?: number;
  watched_count?: number;
};


// Shapes returned by the legacy /me/watchlist and /me/favorites/ranked
// endpoints — used as a fallback until the new /me/picks/collections
// endpoint is live in production.
type LegacyWatchlistSummary = {
  id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  title_count: number;
  preview_posters: string[];
};
type LegacyWatchlistItem = {
  id: string;
  content_title_id: string;
  title: {
    id: string;
    title: string;
    content_type: string;
    poster_url?: string | null;
    release_date?: string | null;
  };
};
type LegacyWatchlistResponse = {
  id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  items: LegacyWatchlistItem[];
};
type LegacyRankedRow = {
  position: number;
  title_id: string;
  title: string;
  poster_url: string | null;
  year: number | null;
  media_type: string;
  personal_score: number | null;
};
type LegacyRankedResponse = { items: LegacyRankedRow[]; total: number };


export async function fetchPicksCollections(token: string): Promise<PicksCollections> {
  // Preferred path — single call, server-side grouped.
  try {
    return await apiRequest<PicksCollections>("/me/picks/collections", { token });
  } catch (err) {
    // Backend not yet deployed with the unified endpoint. Fall back
    // to the legacy watchlist + ranked endpoints so users still see
    // the lists they've curated.
    return await fetchPicksCollectionsLegacy(token);
  }
}


async function fetchPicksCollectionsLegacy(token: string): Promise<PicksCollections> {
  const [listSummaries, ranked] = await Promise.allSettled([
    apiRequest<LegacyWatchlistSummary[]>("/me/watchlist/lists", { token }),
    apiRequest<LegacyRankedResponse>("/me/favorites/ranked?limit=100", { token }),
  ]);

  const summaries = listSummaries.status === "fulfilled" ? listSummaries.value : [];
  // Hydrate the first few lists in parallel for the My Lists tab preview.
  const detailed = await Promise.all(
    summaries.map((s) =>
      apiRequest<LegacyWatchlistResponse>(`/me/watchlist/lists/${s.id}`, { token })
        .then((res) => ({ summary: s, res }))
        .catch(() => ({ summary: s, res: null as LegacyWatchlistResponse | null })),
    ),
  );

  const my_lists: PickList[] = detailed.map(({ summary, res }) => ({
    id: summary.id,
    name: summary.name,
    description: summary.description ?? null,
    is_default: summary.is_default,
    titles: (res?.items ?? []).map((item) => ({
      id: item.title.id,
      title: item.title.title,
      poster_url: item.title.poster_url ?? null,
      backdrop_url: item.title.poster_url ?? null,
      year: item.title.release_date ? Number(item.title.release_date.slice(0, 4)) : null,
      media_type: item.title.content_type,
      personal_score: null,
      rank_label: null,
      context_label: null,
    })),
  }));

  // Find the "Next Watch" default list and populate the My Next Watch tab.
  const nextWatchList = detailed.find(({ summary }) =>
    summary.is_default && summary.name.toLowerCase().includes("next"),
  );
  const my_next_watch: PickTitle[] = (nextWatchList?.res?.items ?? []).map((item) => ({
    id: item.title.id,
    title: item.title.title,
    poster_url: item.title.poster_url ?? null,
    backdrop_url: item.title.poster_url ?? null,
    year: item.title.release_date ? Number(item.title.release_date.slice(0, 4)) : null,
    media_type: item.title.content_type,
    personal_score: null,
    rank_label: null,
    context_label: null,
  }));

  const ranked_rows = ranked.status === "fulfilled" ? ranked.value.items : [];
  const ranked_favorites: PickTitle[] = ranked_rows.map((r) => ({
    id: r.title_id,
    title: r.title,
    poster_url: r.poster_url,
    backdrop_url: r.poster_url,
    year: r.year,
    media_type: r.media_type,
    personal_score: r.personal_score,
    rank_label: `#${r.position}`,
    context_label: null,
  }));

  // Favorites / Watched aren't derivable from the legacy endpoints
  // without extra calls. Return empty so the user sees honest empty
  // states on those two tabs until the unified endpoint ships.
  return {
    ranked_favorites,
    my_next_watch,
    favorites: [],
    watched: [],
    my_lists,
  };
}
