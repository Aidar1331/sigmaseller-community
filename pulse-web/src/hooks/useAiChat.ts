import { useCallback, useRef, useEffect } from 'react';
import { useAuthStore } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';
import { useAiChatStore, type AiMessage, type AiWidget, type AiInterrupt, type AiAttachment } from '@/store/aiChat';
import { csrfHeaders, fetchWithRefresh } from '@/lib/api';

type SseEvent = {
  type: string;
  data: unknown;
};

/**
 * Hook for AI chat with SSE streaming.
 *
 * Handles:
 * - Sending messages via POST /ai/chat
 * - Streaming responses via SSE
 * - Human-in-the-loop interrupts
 * - Widget rendering
 */
export function useAiChat() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const token = useAuthStore((s) => s.token);
  const abortRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef('');
  const streamConvIdRef = useRef<number | null>(null); // tracks which conversation the active stream belongs to

  const {
    currentConversationId,
    messages,
    streamStatus,
    streamingText,
    statusText,
    pendingWidget,
    interrupt,
    error,
    setCurrentConversation,
    setMessages,
    addMessage,
    setStreamStatus,
    appendStreamingText,
    clearStreamingText,
    setStatusText,
    setPendingWidget,
    setInterrupt,
    setError,
    setConversations,
  } = useAiChatStore();

  /**
   * Send a message and stream the response.
   */
  const sendMessage = useCallback(
    async (text: string, conversationId?: number, files?: File[]) => {
      if (!workspaceId) {
        setError('Workspace not selected');
        return;
      }

      // Abort any existing stream
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      // Reset state
      clearStreamingText();
      setError(null);
      setInterrupt(null);
      setPendingWidget(null);
      setStreamStatus('connecting');
      setStatusText(files && files.length > 0 ? 'Загружаю файлы...' : 'Отправка запроса...');

      // Add user message optimistically (with placeholder attachments — replaced
      // by real S3 URLs from the 'attachments' SSE event)
      const optimisticAttachments = files?.map((f) => ({
        url: '',
        fileName: f.name,
        mime: f.type || 'application/octet-stream',
        sizeBytes: f.size,
      })) ?? [];
      const userMsg: AiMessage = {
        id: Date.now(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
        attachments: optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
      };
      addMessage(userMsg);

      try {
        // Read shopId DIRECTLY from store at send time (not stale closure)
        const currentShopId = useWorkspaceStore.getState().shopId;
        const currentShopName = useWorkspaceStore.getState().shopName;
        const convId = conversationId ?? currentConversationId;
        const safeConvId = convId && convId > 0 ? convId : undefined;

        // Optimistic: add to sidebar immediately for new chats
        const tempId = -(Date.now() % 1000000); // unique negative temp ID
        if (!safeConvId) {
          const store = useAiChatStore.getState();
          store.setConversations([{
            conversationId: tempId,
            shopId: currentShopId,
            shopName: currentShopName,
            title: (text || files?.[0]?.name || 'Новый чат').slice(0, 80),
            agentType: 'assistant',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }, ...store.conversations]);
        }

        const shopParam = currentShopId ? `&shopId=${currentShopId}` : '';
        const url = `/api/proxy/ai/chat?workspaceId=${workspaceId}${shopParam}`;

        // Wrap raw fetch in fetchWithRefresh so a cookie that expires right
        // before the first byte triggers single-flight /auth/refresh + one
        // retry, instead of bubbling 401 up to the chat UI as an error.
        // Builder constructs a fresh FormData/JSON each call — Request bodies
        // can't be replayed once consumed.
        const signal = abortRef.current.signal;
        let res: Response;
        if (files && files.length > 0) {
          // Multimodal turn — multipart form. Backend dispatches to
          // multimodalRunner (raw @anthropic-ai/sdk, native vision/PDF).
          res = await fetchWithRefresh(() => {
            const fd = new FormData();
            fd.append('message', text);
            if (safeConvId) fd.append('conversationId', String(safeConvId));
            if (currentShopId) fd.append('shopId', String(currentShopId));
            for (const f of files) fd.append('files', f, f.name);
            return fetch(url, {
              method: 'POST',
              headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...csrfHeaders(),
                // NO Content-Type — browser sets multipart boundary automatically
              },
              body: fd,
              signal,
            });
          });
        } else {
          const jsonBody = JSON.stringify({
            conversationId: safeConvId,
            message: text,
            ...(currentShopId ? { shopId: currentShopId } : {}),
          });
          res = await fetchWithRefresh(() =>
            fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...csrfHeaders(),
              },
              body: jsonBody,
              signal,
            }),
          );
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
        }

        if (!res.body) {
          throw new Error('No response body');
        }

        setStreamStatus('streaming');

        // Process SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            // Guard against runaway streams (server bug, malicious payload):
            // a normal AI response fits in tens of KB; 10 MB is far past any
            // legit cap and bounds client memory.
            if (buffer.length > 10_000_000) {
              throw new Error('SSE buffer overflow (>10MB) — aborting stream');
            }
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            // Parse SSE events using index-based iteration (not indexOf)
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.startsWith('event:')) {
                const eventType = line.slice(6).trim();
                // Next line should be data:
                const nextLine = lines[i + 1];
                if (nextLine?.startsWith('data:')) {
                  try {
                    const data = JSON.parse(nextLine.slice(5).trim());
                    handleSseEvent({ type: eventType, data });
                  } catch (e) {
                    console.error('SSE JSON parse error:', e);
                  }
                  i++; // Skip the data line we just consumed
                }
              } else if (line.startsWith('data:')) {
                // Fallback for data-only format
                try {
                  const data = JSON.parse(line.slice(5).trim());
                  if (data.type) {
                    handleSseEvent({ type: data.type, data });
                  }
                } catch (e) {
                  console.error('SSE fallback parse error:', e);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Stream complete — only update UI if user is still on this conversation
        const stillOnSameConv = !streamConvIdRef.current || useAiChatStore.getState().currentConversationId === streamConvIdRef.current;
        if (streamingTextRef.current && stillOnSameConv) {
          const assistantMsg: AiMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            content: streamingTextRef.current,
            createdAt: new Date().toISOString(),
          };
          addMessage(assistantMsg);
          clearStreamingText();
        }
        streamingTextRef.current = '';
        streamConvIdRef.current = null;

        if (stillOnSameConv) {
          setStreamStatus('idle');
          setStatusText('');
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setStreamStatus('idle');
          return;
        }
        setError((err as Error).message);
      }
    },
    // Note: handleSseEvent intentionally excluded — its deps (store actions) are stable references
    [
      workspaceId,
      shopId,
      token,
      currentConversationId,
      addMessage,
      clearStreamingText,
      setError,
      setInterrupt,
      setPendingWidget,
      setStatusText,
      setStreamStatus,
    ]
  );

  /**
   * Handle SSE events from the stream.
   */
  const handleSseEvent = useCallback(
    (event: SseEvent) => {
      const { type, data } = event;

      switch (type) {
        case 'conversation': {
          const { conversationId } = data as { conversationId: number };
          streamConvIdRef.current = conversationId;
          // Replace placeholder (id=0) with real ID in sidebar
          const store = useAiChatStore.getState();
          const idx = store.conversations.findIndex(c => c.conversationId < 0);
          if (idx >= 0) {
            const updated = [...store.conversations];
            updated[idx] = { ...updated[idx], conversationId };
            store.setConversations(updated);
          }
          // Set as current if user hasn't switched away
          const currentId = store.currentConversationId;
          if (currentId === null || currentId < 0 || currentId === conversationId) {
            setCurrentConversation(conversationId);
          }
          break;
        }

        case 'status': {
          // Ignore if user switched to a different conversation
          if (streamConvIdRef.current && useAiChatStore.getState().currentConversationId !== streamConvIdRef.current) break;
          const { text } = data as { text: string };
          setStatusText(text);
          break;
        }

        case 'text': {
          if (streamConvIdRef.current && useAiChatStore.getState().currentConversationId !== streamConvIdRef.current) break;
          const { content } = data as { content: string };
          appendStreamingText(content);
          streamingTextRef.current += content;
          setStatusText('');
          break;
        }

        case 'widget': {
          if (streamConvIdRef.current && useAiChatStore.getState().currentConversationId !== streamConvIdRef.current) break;
          const widget = data as AiWidget;
          setPendingWidget(widget);

          const widgetMsg: AiMessage = {
            id: Date.now(),
            role: 'assistant',
            content: null,
            widgetType: widget.type,
            widgetProps: widget.props,
            createdAt: new Date().toISOString(),
          };
          addMessage(widgetMsg);
          break;
        }

        case 'interrupt': {
          if (streamConvIdRef.current && useAiChatStore.getState().currentConversationId !== streamConvIdRef.current) break;
          const interruptData = data as AiInterrupt;
          setInterrupt(interruptData);
          break;
        }

        case 'attachment': {
          if (streamConvIdRef.current && useAiChatStore.getState().currentConversationId !== streamConvIdRef.current) break;
          const { attachments } = data as { attachments: AiAttachment[] };
          if (!attachments || attachments.length === 0) break;
          const attachmentMsg: AiMessage = {
            id: Date.now(),
            role: 'assistant',
            content: null,
            attachments,
            createdAt: new Date().toISOString(),
          };
          addMessage(attachmentMsg);
          break;
        }

        case 'attachments': {
          // Multimodal turn: backend uploaded user files to S3 → patch the
          // optimistic user message in-place with real URLs so previews work.
          if (streamConvIdRef.current && useAiChatStore.getState().currentConversationId !== streamConvIdRef.current) break;
          const { attachments } = data as { attachments: AiAttachment[] };
          if (!attachments || attachments.length === 0) break;
          const store = useAiChatStore.getState();
          const msgs = [...store.messages];
          // Find the most recent user message without real URLs and replace its attachments.
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user' && msgs[i].attachments && msgs[i].attachments?.[0]?.url === '') {
              msgs[i] = { ...msgs[i], attachments };
              store.setMessages(msgs);
              break;
            }
          }
          break;
        }

        case 'usage':
          // Multimodal billing telemetry — no UI action needed; balance refresh
          // is triggered by message count change in the page component.
          break;

        case 'error': {
          if (streamConvIdRef.current && useAiChatStore.getState().currentConversationId !== streamConvIdRef.current) break;
          const { message } = data as { message: string };
          setError(message);
          break;
        }

        case 'done': {
          streamConvIdRef.current = null;
          setStreamStatus('idle');
          setStatusText('');
          break;
        }
      }
    },
    [addMessage, appendStreamingText, setCurrentConversation, setError, setInterrupt, setPendingWidget, setStatusText, setStreamStatus]
  );

  /**
   * Resume after interrupt (approve/reject action).
   */
  const resumeConversation = useCallback(
    async (decision: 'approve' | 'reject', note?: string) => {
      if (!workspaceId || !interrupt || !currentConversationId) return;

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setInterrupt(null);
      setStreamStatus('connecting');
      setStatusText(decision === 'approve' ? 'Выполняю...' : 'Отменяю...');

      try {
        const resumeUrl = `/api/proxy/ai/chat/resume?workspaceId=${workspaceId}`;
        const resumeSignal = abortRef.current.signal;
        const resumeBody = JSON.stringify({
          threadId: interrupt.resumeToken,
          conversationId: currentConversationId,
          decision,
          note,
        });
        // Same single-flight refresh wrap as send() above — see comment there.
        const res = await fetchWithRefresh(() =>
          fetch(resumeUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...csrfHeaders(),
            },
            body: resumeBody,
            signal: resumeSignal,
          }),
        );

        if (!res.ok) {
          throw new Error(`Resume failed: ${res.status}`);
        }

        // Process SSE stream (same as sendMessage)
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        setStreamStatus('streaming');

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            // Guard against runaway streams (server bug, malicious payload):
            // a normal AI response fits in tens of KB; 10 MB is far past any
            // legit cap and bounds client memory.
            if (buffer.length > 10_000_000) {
              throw new Error('SSE buffer overflow (>10MB) — aborting stream');
            }
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const data = JSON.parse(line.slice(5).trim());
                  if (data.content) {
                    appendStreamingText(data.content);
                    streamingTextRef.current += data.content;
                  }
                } catch (e) {
                  console.error('SSE stream parse error:', e);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Finalize
        if (streamingTextRef.current) {
          addMessage({
            id: Date.now(),
            role: 'assistant',
            content: streamingTextRef.current,
            createdAt: new Date().toISOString(),
          });
          clearStreamingText();
          streamingTextRef.current = '';
        }

        setStreamStatus('idle');
        setStatusText('');
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [
      workspaceId,
      token,
      interrupt,
      currentConversationId,
      addMessage,
      appendStreamingText,
      clearStreamingText,
      setError,
      setInterrupt,
      setStatusText,
      setStreamStatus,
    ]
  );

  /**
   * Cancel current stream.
   */
  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    setStreamStatus('idle');
    setStatusText('');
    clearStreamingText();
  }, [clearStreamingText, setStatusText, setStreamStatus]);

  return {
    // State
    currentConversationId,
    messages,
    streamStatus,
    streamingText,
    statusText,
    pendingWidget,
    interrupt,
    error,

    // Actions
    sendMessage,
    resumeConversation,
    cancelStream,
    setCurrentConversation,
    setMessages,
  };
}
