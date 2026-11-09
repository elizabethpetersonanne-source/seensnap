import { apiRequest } from "./api";
export type SectionKey =
  | "top_picks"
  | "recently_added"
  | "both_want_to_watch"
  | "watched";
export type TeamHomeTitle = {
  id: string;
  title: string;
  poster_url: string | null;
  backdrop_url: string | null;
  year: number | null;
  media_type: string;
  rank_label: string | null;
  context_label: string | null;
  added_at: string | null;
  members: {
    user_id: string;
    name: string;
    state: string;
    rating: number | null;
  }[];
  my_state: "unknown" | "want_to_watch" | "watched";
  my_state_version: number;
  my_shared_rating: number | null;
  member_average: number | null;
  rating_count: number;
  liked_by_me: boolean;
  like_count: number;
};
export type TeamPage = {
  items: TeamHomeTitle[];
  total: number;
  next_offset: number | null;
};
export type TeamHomeSections = Record<SectionKey, TeamHomeTitle[]> & {
  team_id: string;
  team_name: string;
  member_count: number;
  can_manage: boolean;
  totals: Record<SectionKey, number>;
  next_offsets: Record<SectionKey, number | null>;
};
export function fetchTeamHome(token: string, teamId: string) {
  return apiRequest<TeamHomeSections>(`/teams/${teamId}/home`, { token });
}
export function fetchTeamPage(
  token: string,
  teamId: string,
  section: SectionKey,
  offset: number,
) {
  return apiRequest<TeamPage>(
    `/teams/${teamId}/home/${section}?offset=${offset}&limit=40`,
    { token },
  );
}
