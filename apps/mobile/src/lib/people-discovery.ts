/**
 * People Discovery client — thin wrappers around /social/people endpoints.
 * Every candidate carries a server-provided `reason.label` — client MUST
 * render that verbatim per People Discovery spec §11 (don't infer copy
 * from raw signal IDs).
 */
import { apiRequest } from "@/lib/api";

export type PersonReason = {
  code:
    | "shared_watch_team"
    | "mutual_follows"
    | "similar_taste"
    | "active_new"
    | string;
  label: string;
};

export type PersonCandidate = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  reason: PersonReason;
  mutuals: string[];
};

export type PeopleSection = {
  id: string;
  title: string;
  items: PersonCandidate[];
};

export async function fetchAllPeopleSections(token: string): Promise<PeopleSection[]> {
  const r = await apiRequest<{ sections: PeopleSection[] }>(
    "/social/people?limit=12",
    { token },
  );
  return r.sections;
}

export async function dismissPerson(token: string, candidateUserId: string): Promise<void> {
  await apiRequest(`/social/people/${candidateUserId}/dismiss`, {
    method: "POST",
    token,
  });
}

export async function followPerson(token: string, userId: string): Promise<void> {
  await apiRequest(`/profiles/${userId}/follow`, { method: "POST", token });
}

export async function unfollowPerson(token: string, userId: string): Promise<void> {
  await apiRequest(`/profiles/${userId}/follow`, { method: "DELETE", token });
}
