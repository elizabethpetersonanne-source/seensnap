import { apiRequest } from "./api";

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
};

export type TeamHomeSections = {
  team_id: string;
  team_name: string;
  member_count: number;
  top_picks: TeamHomeTitle[];
  recently_added: TeamHomeTitle[];
  both_want_to_watch: TeamHomeTitle[];
  watched: TeamHomeTitle[];
};

export async function fetchTeamHome(token: string, teamId: string): Promise<TeamHomeSections> {
  return apiRequest<TeamHomeSections>(`/teams/${teamId}/home`, { token });
}
