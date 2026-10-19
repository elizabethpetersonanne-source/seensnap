import { apiRequest } from "./api";

export type StoryTitleCard = {
  story_id: string;
  title_id: string;
  title: string;
  poster_url: string | null;
  backdrop_url: string | null;
  caption: string | null;
  created_at: string;
  expires_at: string;
};

export type StoryActorGroup = {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  stories: StoryTitleCard[];
};

export type StoriesFeedResponse = {
  me: StoryActorGroup | null;
  others: StoryActorGroup[];
};

export async function fetchStoriesFeed(token: string): Promise<StoriesFeedResponse> {
  return apiRequest<StoriesFeedResponse>("/social/stories", { token });
}

export async function postStory(token: string, titleId: string, caption?: string | null): Promise<StoryTitleCard> {
  return apiRequest<StoryTitleCard>("/me/stories", {
    method: "POST",
    token,
    body: JSON.stringify({ title_id: titleId, caption: caption ?? null }),
  });
}

export async function deleteStory(token: string, storyId: string): Promise<void> {
  await apiRequest(`/me/stories/${storyId}`, { method: "DELETE", token });
}
