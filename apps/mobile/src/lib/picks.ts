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
};

export type PicksCollections = {
  ranked_favorites: PickTitle[];
  my_next_watch: PickTitle[];
  favorites: PickTitle[];
  watched: PickTitle[];
  my_lists: PickList[];
};

export async function fetchPicksCollections(token: string): Promise<PicksCollections> {
  return apiRequest<PicksCollections>("/me/picks/collections", { token });
}
