import { create } from 'zustand';

// ── Types ──────────────────────────────────────────────────

export type AiConversation = {
  conversationId: number;
  shopId: number | null;
  shopName: string | null;
  title: string | null;
  agentType: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  // rev 27M.1: conversations that originated in the Telegram bot carry
  // `meta.source = 'telegram'` so the UI can render a badge.
  meta?: { source?: string; tgChatId?: string } | null;
};

export type AiAttachment = {
  url: string;
  fileName: string;
  mime: string;
  sizeBytes?: number;
};

export type AiMessage = {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  widgetType?: string | null;
  widgetProps?: Record<string, unknown> | null;
  toolCalls?: Array<{ id: string; name: string; args: unknown }> | null;
  attachments?: AiAttachment[] | null;
  createdAt: string;
};

export type AiWidget = {
  type: string;
  props: Record<string, unknown>;
};

export type AiInterrupt = {
  action: string;
  args: Record<string, unknown>;
  rationale?: string;
  resumeToken: string;
};

export type AiStreamStatus = 'idle' | 'connecting' | 'streaming' | 'interrupted' | 'error';

// ── Store ──────────────────────────────────────────────────

interface AiChatState {
  // Conversations list
  conversations: AiConversation[];
  conversationsLoading: boolean;

  // Current conversation
  currentConversationId: number | null;
  messages: AiMessage[];
  messagesLoading: boolean;

  // Streaming state
  streamStatus: AiStreamStatus;
  streamingText: string;
  statusText: string;
  pendingWidget: AiWidget | null;
  interrupt: AiInterrupt | null;
  error: string | null;

  // Actions
  setConversations: (convs: AiConversation[]) => void;
  setConversationsLoading: (loading: boolean) => void;
  setCurrentConversation: (id: number | null) => void;
  setMessages: (msgs: AiMessage[]) => void;
  addMessage: (msg: AiMessage) => void;
  setMessagesLoading: (loading: boolean) => void;

  // Streaming actions
  setStreamStatus: (status: AiStreamStatus) => void;
  appendStreamingText: (text: string) => void;
  clearStreamingText: () => void;
  setStatusText: (text: string) => void;
  setPendingWidget: (widget: AiWidget | null) => void;
  setInterrupt: (interrupt: AiInterrupt | null) => void;
  setError: (error: string | null) => void;

  // Reset
  reset: () => void;
}

const initialState = {
  conversations: [],
  conversationsLoading: false,
  currentConversationId: null,
  messages: [],
  messagesLoading: false,
  streamStatus: 'idle' as AiStreamStatus,
  streamingText: '',
  statusText: '',
  pendingWidget: null,
  interrupt: null,
  error: null,
};

export const useAiChatStore = create<AiChatState>((set) => ({
  ...initialState,

  // Conversations
  setConversations: (conversations) => set({ conversations }),
  setConversationsLoading: (conversationsLoading) => set({ conversationsLoading }),

  // Current conversation
  setCurrentConversation: (id) =>
    set((s) => ({
      currentConversationId: id,
      // Only clear messages when switching to a different conversation
      messages: id === s.currentConversationId ? s.messages : [],
      streamingText: '',
      error: null,
    })),
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setMessagesLoading: (messagesLoading) => set({ messagesLoading }),

  // Streaming
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  appendStreamingText: (text) => set((s) => ({ streamingText: s.streamingText + text })),
  clearStreamingText: () => set({ streamingText: '' }),
  setStatusText: (statusText) => set({ statusText }),
  setPendingWidget: (pendingWidget) => set({ pendingWidget }),
  setInterrupt: (interrupt) =>
    set({ interrupt, streamStatus: interrupt ? 'interrupted' : 'idle' }),
  setError: (error) => set({ error, streamStatus: error ? 'error' : 'idle' }),

  // Reset
  reset: () => set(initialState),
}));
