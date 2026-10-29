import { apiFetch } from './api';
import type { AiConversation, AiMessage } from '@/store/aiChat';

/**
 * AI Chat API helpers.
 */

/**
 * Get list of conversations for current workspace.
 * shopId is auto-injected by apiFetch from workspace store.
 */
export async function getAiConversations(): Promise<AiConversation[]> {
  const res = await apiFetch<{ conversations: AiConversation[] }>('/ai/conversations');
  return res.conversations ?? [];
}

/**
 * Get a single conversation with messages.
 */
export async function getAiConversation(conversationId: number): Promise<{
  conversation: AiConversation;
  messages: AiMessage[];
}> {
  const res = await apiFetch<{
    conversation: AiConversation;
    messages: AiMessage[];
  }>(`/ai/conversations/${conversationId}`);
  return res;
}

/**
 * Archive (soft delete) a conversation.
 */
export async function archiveAiConversation(conversationId: number): Promise<void> {
  await apiFetch(`/ai/conversations/${conversationId}`, {
    method: 'DELETE',
  });
}

/**
 * Create a new conversation (without sending message).
 * Usually conversations are created implicitly via /ai/chat.
 */
export async function createAiConversation(title?: string): Promise<AiConversation> {
  const res = await apiFetch<{ conversation: AiConversation }>('/ai/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return res.conversation;
}
