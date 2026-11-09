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

export async function fetchStoriesFeed(
  token: string,
): Promise<StoriesFeedResponse> {
  return apiRequest<StoriesFeedResponse>("/social/stories", { token });
}

export async function postStory(
  token: string,
  titleId: string,
  caption?: string | null,
): Promise<StoryTitleCard> {
  const story = await apiRequest<StoryTitleCard>("/me/stories", {
    method: "POST",
    token,
    body: JSON.stringify({ title_id: titleId, caption: caption ?? null }),
  });
  notifyStories(token, { kind: "saved", story, created: true });
  return story;
}

export async function deleteStory(
  token: string,
  storyId: string,
): Promise<void> {
  await apiRequest(`/me/stories/${storyId}`, { method: "DELETE", token });
  notifyStories(token, { kind: "deleted", storyId });
}

export async function editStory(
  token: string,
  storyId: string,
  changes: { title_id?: string | null; caption?: string | null },
): Promise<StoryTitleCard> {
  const body: Record<string, unknown> = {};
  if (changes.title_id !== undefined) body.title_id = changes.title_id;
  if (changes.caption !== undefined) body.caption = changes.caption;
  const story = await apiRequest<StoryTitleCard>(`/me/stories/${storyId}`, {
    method: "PATCH",
    token,
    body: JSON.stringify(body),
  });
  notifyStories(token, { kind: "saved", story });
  return story;
}

export type StoryHistory = {
  items: StoryTitleCard[];
  next_cursor: string | null;
  total: number;
};
type StoryChange =
  | { kind: "deleted"; storyId: string }
  | { kind: "saved"; story: StoryTitleCard; created?: boolean };
const storyListeners = new Set<(token: string, change: StoryChange) => void>();
export function subscribeStoryChanges(
  listener: (token: string, change: StoryChange) => void,
) {
  storyListeners.add(listener);
  return () => {
    storyListeners.delete(listener);
  };
}
function notifyStories(token: string, change: StoryChange) {
  storyListeners.forEach((listener) => {
    try {
      listener(token, change);
    } catch {
      /* Consumer errors cannot fail a saved change. */
    }
  });
}
export function fetchStoryHistory(
  token: string,
  state: "all" | "active" | "archived",
  cursor?: string | null,
) {
  return apiRequest<StoryHistory>(
    `/me/stories?state=${state}&limit=24${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    { token },
  );
}
export function fetchMyStory(token: string, id: string) {
  return apiRequest<StoryTitleCard>(`/me/stories/${encodeURIComponent(id)}`, {
    token,
  });
}
