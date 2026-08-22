/**
 * Messaging client — thin wrappers around the /messages API. Every
 * surface that sends a message (Title Detail, Snip, Social feed, etc.)
 * goes through these helpers so the request shape stays consistent and
 * analytics wiring lives in one place.
 */
import { apiRequest } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";

export type MessageContentType = "title" | "list";

export type MessageAuthorSlice = {
  user_id: string | null;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
};

export type ConversationSummary = {
  conversation_id: string;
  other_user: MessageAuthorSlice;
  last_message: MessageDto | null;
  unread_count: number;
  muted: boolean;
  updated_at: string;
};

export type MessageDto = {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  message_type: "text" | "content" | "text_with_content" | "system";
  text_body: string | null;
  content_type: MessageContentType | null;
  content_id: string | null;
  snapshot?: Record<string, unknown> | null;
  title?: {
    id: string;
    tmdb_id: number;
    title: string;
    content_type: string;
    poster_url: string | null;
    backdrop_url: string | null;
    year: number | null;
  } | null;
  list?: {
    id: string;
    name: string;
    description: string | null;
    owner_user_id: string;
    share_token: string | null;
  } | null;
  created_at: string;
};

export async function fetchInbox(token: string, limit = 25): Promise<ConversationSummary[]> {
  const r = await apiRequest<{ items: ConversationSummary[] }>(
    `/messages/conversations?limit=${limit}`,
    { token },
  );
  return r.items;
}

export async function fetchUnreadCount(token: string): Promise<number> {
  try {
    const r = await apiRequest<{ count: number }>("/messages/conversations/unread-count", { token });
    return r.count;
  } catch {
    return 0;
  }
}

export async function startDirectConversation(token: string, recipientUserId: string): Promise<string> {
  const r = await apiRequest<{ conversation_id: string }>(
    "/messages/conversations/direct",
    { method: "POST", token, body: JSON.stringify({ recipient_user_id: recipientUserId }) },
  );
  return r.conversation_id;
}

export async function fetchMessages(
  token: string,
  conversationId: string,
  before?: string,
): Promise<MessageDto[]> {
  const qs = new URLSearchParams();
  if (before) qs.set("before", before);
  const path = `/messages/conversations/${conversationId}/messages${
    qs.toString() ? `?${qs.toString()}` : ""
  }`;
  const r = await apiRequest<{ items: MessageDto[] }>(path, { token });
  return r.items;
}

export type SendPayload = {
  textBody?: string;
  contentType?: MessageContentType;
  contentId?: string;
  clientMessageId: string;
  sourceSurface: string;
};

export async function sendMessage(
  token: string,
  conversationId: string,
  payload: SendPayload,
): Promise<MessageDto> {
  const msg = await apiRequest<MessageDto>(
    `/messages/conversations/${conversationId}/messages`,
    {
      method: "POST",
      token,
      body: JSON.stringify({
        text_body: payload.textBody,
        content_type: payload.contentType,
        content_id: payload.contentId,
        client_message_id: payload.clientMessageId,
      }),
    },
  );
  trackEvent(payload.contentType ? `${payload.contentType}_sent` : "message_sent", {
    conversation_id: conversationId,
    message_type: msg.message_type,
    source_surface: payload.sourceSurface,
  });
  return msg;
}

export async function markConversationRead(token: string, conversationId: string): Promise<void> {
  await apiRequest(`/messages/conversations/${conversationId}/read`, { method: "POST", token });
}

export async function toggleMute(token: string, conversationId: string, muted: boolean): Promise<void> {
  await apiRequest(`/messages/conversations/${conversationId}/mute`, {
    method: "POST",
    token,
    body: JSON.stringify({ muted }),
  });
}

export async function hideConversation(token: string, conversationId: string): Promise<void> {
  await apiRequest(`/messages/conversations/${conversationId}/hide`, { method: "POST", token });
}
