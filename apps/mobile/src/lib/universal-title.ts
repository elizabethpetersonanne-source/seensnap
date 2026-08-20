import { apiRequest } from "@/lib/api";
import type { StreamingAvailability } from "@/lib/streaming";

export type TitleSeed = {
  id: string;
  title: string;
  content_type?: string;
  poster_url?: string | null;
  backdrop_url?: string | null;
  overview?: string | null;
};

type TitleResponse = {
  id: string;
  tmdb_id: number;
  content_type: string;
  title: string;
  overview?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  genres?: string[];
  release_date?: string | null;
  runtime_minutes?: number | null;
  season_count?: number | null;
  episode_count?: number | null;
  tmdb_rating?: number | null;
  language?: string | null;
  country?: string | null;
  creator?: string | null;
  director?: string | null;
  top_cast?: string[];
  wikipedia_url?: string | null;
  metadata_source?: string;
  streaming_availability?: Array<{
    service: string;
    service_name: string;
    app_url?: string | null;
    web_url?: string | null;
  }>;
  image_gallery?: Array<{
    url: string;
    kind: string;
    width?: number | null;
    height?: number | null;
  }>;
  cast?: Array<{
    name: string;
    role: string;
    headshot_url?: string | null;
    tmdb_person_id?: number | null;
  }>;
  creators?: Array<{
    name: string;
    role: string;
    headshot_url?: string | null;
    tmdb_person_id?: number | null;
  }>;
  related_titles?: Array<{
    id: string;
    title: string;
    content_type: string;
    poster_url?: string | null;
    release_date?: string | null;
  }>;
};

export type UniversalTitle = {
  id: string;
  tmdbId: number;
  title: string;
  mediaType: "movie" | "tv";
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  description: string;
  genres: string[];
  runtimeMinutes: number | null;
  episodeRuntimeMinutes: number | null;
  seasons: number | null;
  episodes: number | null;
  language: string | null;
  country: string | null;
  ratingTmdb: number | null;
  wikipediaUrl: string | null;
  credits: {
    creator: string[];
    director: string[];
    cast: string[];
  };
  metadataSource: string;
  streamingAvailability: StreamingAvailability[];
  imageGallery: Array<{
    url: string;
    kind: string;
    width: number | null;
    height: number | null;
  }>;
  cast: Array<{
    name: string;
    role: string;
    headshotUrl: string | null;
    tmdbPersonId: number | null;
  }>;
  creators: Array<{
    name: string;
    role: string;
    headshotUrl: string | null;
    tmdbPersonId: number | null;
  }>;
  relatedTitles: Array<{
    id: string;
    title: string;
    mediaType: "movie" | "tv";
    posterUrl: string | null;
    year: number | null;
  }>;
};

function normalizeFromApi(data: TitleResponse): UniversalTitle {
  const mediaType = data.content_type === "movie" ? "movie" : "tv";
  const year = data.release_date ? Number(String(data.release_date).slice(0, 4)) : null;
  return {
    id: data.id,
    tmdbId: data.tmdb_id,
    title: data.title,
    mediaType,
    year: Number.isFinite(year) ? year : null,
    posterUrl: data.poster_url ?? null,
    backdropUrl: data.backdrop_url ?? data.poster_url ?? null,
    description: data.overview || "Full details are unavailable right now.",
    genres: data.genres ?? [],
    runtimeMinutes: mediaType === "movie" ? data.runtime_minutes ?? null : null,
    episodeRuntimeMinutes: mediaType === "tv" ? data.runtime_minutes ?? null : null,
    seasons: mediaType === "tv" ? data.season_count ?? null : null,
    episodes: mediaType === "tv" ? data.episode_count ?? null : null,
    language: data.language ?? null,
    country: data.country ?? null,
    ratingTmdb: data.tmdb_rating ?? null,
    wikipediaUrl: data.wikipedia_url ?? null,
    credits: {
      creator: data.creator ? [data.creator] : [],
      director: data.director ? [data.director] : [],
      cast: data.top_cast ?? [],
    },
    metadataSource: data.metadata_source ?? "tmdb_fallback",
    streamingAvailability: (data.streaming_availability ?? []).map((entry) => ({
      service: entry.service,
      serviceName: entry.service_name,
      appUrl: entry.app_url ?? null,
      webUrl: entry.web_url ?? null,
    })),
    imageGallery: (data.image_gallery ?? []).map((entry) => ({
      url: entry.url,
      kind: entry.kind,
      width: typeof entry.width === "number" ? entry.width : null,
      height: typeof entry.height === "number" ? entry.height : null,
    })),
    cast: (data.cast ?? []).map((entry) => ({
      name: entry.name,
      role: entry.role,
      headshotUrl: entry.headshot_url ?? null,
      tmdbPersonId: entry.tmdb_person_id ?? null,
    })),
    creators: (data.creators ?? []).map((entry) => ({
      name: entry.name,
      role: entry.role,
      headshotUrl: entry.headshot_url ?? null,
      tmdbPersonId: entry.tmdb_person_id ?? null,
    })),
    relatedTitles: (data.related_titles ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      mediaType: entry.content_type === "movie" ? "movie" : "tv",
      posterUrl: entry.poster_url ?? null,
      year: entry.release_date ? Number(String(entry.release_date).slice(0, 4)) : null,
    })),
  };
}

function normalizeFromSeed(seed: TitleSeed): UniversalTitle {
  const mediaType = seed.content_type === "movie" ? "movie" : "tv";
  return {
    id: seed.id,
    tmdbId: 0, // seed titles don't carry tmdb_id; sharing falls back to internal id fallback
    title: seed.title,
    mediaType,
    year: null,
    posterUrl: seed.poster_url ?? null,
    backdropUrl: seed.backdrop_url ?? seed.poster_url ?? null,
    description: seed.overview || "Full details are unavailable right now.",
    genres: [],
    runtimeMinutes: null,
    episodeRuntimeMinutes: null,
    seasons: null,
    episodes: null,
    language: null,
    country: null,
    ratingTmdb: null,
    wikipediaUrl: null,
    credits: {
      creator: [],
      director: [],
      cast: [],
    },
    metadataSource: "fallback",
    streamingAvailability: [],
    imageGallery: [
      ...(seed.backdrop_url ? [{ url: seed.backdrop_url, kind: "backdrop", width: null, height: null }] : []),
      ...(seed.poster_url ? [{ url: seed.poster_url, kind: "poster", width: null, height: null }] : []),
    ],
    cast: [],
    creators: [],
    relatedTitles: [],
  };
}

export type PersonCredit = {
  tmdbId: number;
  title: string;
  mediaType: string;
  posterUrl: string | null;
  releaseDate: string | null;
  character: string | null;
  job: string | null;
};

export type PersonProfile = {
  tmdbPersonId: number;
  name: string;
  profileUrl: string | null;
  biography: string | null;
  knownForDepartment: string | null;
  birthday: string | null;
  placeOfBirth: string | null;
  credits: PersonCredit[];
};

export async function fetchPersonDetails(token: string, tmdbPersonId: number): Promise<PersonProfile> {
  const data = await apiRequest<{
    tmdb_person_id: number;
    name: string;
    profile_url: string | null;
    biography: string | null;
    known_for_department: string | null;
    birthday: string | null;
    place_of_birth: string | null;
    credits: Array<{
      tmdb_id: number;
      title: string;
      media_type: string;
      poster_url: string | null;
      release_date: string | null;
      character: string | null;
      job: string | null;
    }>;
  }>(`/titles/person/${tmdbPersonId}`, { token });

  return {
    tmdbPersonId: data.tmdb_person_id,
    name: data.name,
    profileUrl: data.profile_url ?? null,
    biography: data.biography ?? null,
    knownForDepartment: data.known_for_department ?? null,
    birthday: data.birthday ?? null,
    placeOfBirth: data.place_of_birth ?? null,
    credits: (data.credits ?? []).map((c) => ({
      tmdbId: c.tmdb_id,
      title: c.title,
      mediaType: c.media_type,
      posterUrl: c.poster_url ?? null,
      releaseDate: c.release_date ?? null,
      character: c.character ?? null,
      job: c.job ?? null,
    })),
  };
}

export async function fetchUniversalTitle(
  token: string,
  titleId: string,
  seed?: TitleSeed | null
): Promise<UniversalTitle> {
  try {
    const data = await apiRequest<TitleResponse>(`/titles/${titleId}`, { token });
    return normalizeFromApi(data);
  } catch {
    if (seed) {
      return normalizeFromSeed(seed);
    }
    throw new Error("Unable to load title details");
  }
}

export async function fetchUniversalTitleByTmdbId(
  token: string,
  mediaType: string,
  tmdbId: number
): Promise<UniversalTitle> {
  // media_type: TMDB uses "movie" or "tv"; server accepts "movie" | "series" | "tv"
  const data = await apiRequest<TitleResponse>(
    `/titles/by-tmdb/${encodeURIComponent(mediaType)}/${tmdbId}`,
    { token }
  );
  return normalizeFromApi(data);
}
