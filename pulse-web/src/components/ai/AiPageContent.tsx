'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { useAiChat } from '@/hooks/useAiChat';
import { useAiChatStore } from '@/store/aiChat';
import { useWorkspaceStore } from '@/store/workspace';
import { getAiConversation } from '@/lib/aiApi';
import { AiChatSidebar, AiChatMessages, AiChatInput } from '@/components/ai';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Coins } from 'lucide-react';
import { apiFetch } from '@/lib/api';

/**
 * AI Agent page content — chat with the agent.
 *
 * Used by both `/ai` (no specific conversation) and `/ai/[conversationId]`
 * (initialConversationId from URL param) to keep store and URL in sync.
 */
export function AiPageContent({ initialConversationId }: { initialConversationId?: number } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const [aiBalance, setAiBalance] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Guard against double-firing of the template auto-prompt in React 18
  // strict mode / re-renders. Once we send, we strip the query and never
  // re-evaluate even if searchParams object identity changes.
  const templateFiredRef = useRef(false);

  const {
    currentConversationId,
    messages,
    streamStatus,
    streamingText,
    statusText,
    interrupt,
    error,
    sendMessage,
    resumeConversation,
    cancelStream,
    setCurrentConversation,
    setMessages,
  } = useAiChat();

  const { setMessagesLoading } = useAiChatStore();

  // Switch UI when shop changes — DON'T cancel stream (let it finish in background, backend saves to DB)
  // Skip if we're on /ai/[id] route (initialConversationId set) — wrapper-page synchronises store with URL.
  useEffect(() => {
    if (initialConversationId) return;
    setCurrentConversation(null);
    setMessages([]);
  }, [shopId, setCurrentConversation, setMessages, initialConversationId]);

  // Sync store with URL param when component is rendered as /ai/[id]
  useEffect(() => {
    if (initialConversationId && initialConversationId > 0) {
      setCurrentConversation(initialConversationId);
    }
  }, [initialConversationId, setCurrentConversation]);

  // Load AI balance
  const loadBalance = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await apiFetch<{ balanceRub: number }>(`/ai/${workspaceId}/balance`);
      setAiBalance(res.balanceRub);
    } catch {}
  }, [workspaceId]);

  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  // Refresh balance after each message exchange
  useEffect(() => {
    if (messages.length > 0) loadBalance();
  }, [messages.length, loadBalance]);

  // Load messages when conversation changes (skip temp IDs < 0)
  useEffect(() => {
    if (currentConversationId && currentConversationId > 0) {
      loadMessages(currentConversationId);
    }
  }, [currentConversationId]);

  const loadMessages = async (convId: number) => {
    setMessagesLoading(true);
    try {
      const { messages: msgs } = await getAiConversation(convId);
      setMessages(msgs);
      // If last message is from user (no assistant reply yet), show processing indicator
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
        useAiChatStore.getState().setStatusText('Обработка запроса...');
        useAiChatStore.getState().setStreamStatus('streaming');
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleSelectConversation = useCallback(
    (id: number | null) => {
      if (id && id > 0) {
        setMessagesLoading(true);
        router.push(`/ai/${id}`);
      } else {
        router.push('/ai');
      }
      setCurrentConversation(id);
      if (!id) {
        setMessages([]);
      }
    },
    [setCurrentConversation, setMessages, setMessagesLoading, router]
  );

  const handleNewChat = useCallback(() => {
    setCurrentConversation(null);
    setMessages([]);
    router.push('/ai');
    const store = useAiChatStore.getState();
    store.setStreamStatus('idle');
    store.setStatusText('');
    store.clearStreamingText();
    store.setError(null);
  }, [setCurrentConversation, setMessages, router]);

  const handleSend = useCallback(
    (text: string, files?: File[]) => {
      sendMessage(text, currentConversationId ?? undefined, files);
    },
    [sendMessage, currentConversationId]
  );

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ text?: string }>).detail;
      if (detail?.text) {
        sendMessage(detail.text, currentConversationId ?? undefined);
      }
    };
    window.addEventListener('ai-chat-send', handler);
    return () => window.removeEventListener('ai-chat-send', handler);
  }, [sendMessage, currentConversationId]);

  // Template auto-prompt: when launched via /ai?nmIds=A,B,C&template=...,
  // build the canonical prompt for that template and fire it on mount, then
  // strip the query so a refresh doesn't re-send. Only runs on plain /ai
  // (not /ai/[id]) and only after workspace is loaded.
  useEffect(() => {
    if (templateFiredRef.current) return;
    if (initialConversationId) return;
    if (!workspaceId) return;
    const template = searchParams?.get('template');
    const nmIdsRaw = searchParams?.get('nmIds');
    if (!template || !nmIdsRaw) return;
    const nmIds = nmIdsRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (nmIds.length === 0) return;
    let prompt: string | null = null;
    if (template === 'manager-plan') {
      prompt = buildManagerPlanPrompt(nmIds);
    }
    if (!prompt) return;
    templateFiredRef.current = true;
    setCurrentConversation(null);
    setMessages([]);
    sendMessage(prompt);
    // Drop query from URL — keeps refresh-safe + clean share URL.
    router.replace('/ai');
  }, [workspaceId, initialConversationId, searchParams, sendMessage, setCurrentConversation, setMessages, router]);

  const handleApprove = useCallback(() => {
    resumeConversation('approve');
  }, [resumeConversation]);

  const handleReject = useCallback(() => {
    resumeConversation('reject');
  }, [resumeConversation]);

  const isDisabled = streamStatus === 'connecting' || streamStatus === 'streaming';

  return (
    <AppShell fullHeight>
      <div className="flex h-full bg-white">
        {/* Sidebar: drawer on mobile, fixed column on >=md. */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/30 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transform border-r border-gray-200 bg-white transition-transform duration-200 md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          } flex flex-col`}
        >
          <AiChatSidebar
            onSelectConversation={(id) => {
              handleSelectConversation(id);
              setSidebarOpen(false);
            }}
            onNewChat={() => {
              handleNewChat();
              setSidebarOpen(false);
            }}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Mobile-only chat header with hamburger to open conversations drawer. */}
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 md:hidden">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              aria-label="Открыть список диалогов"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 5h14M3 10h14M3 15h14" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleNewChat}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              + Новый чат
            </button>
          </div>
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-600">ИИ работает с вашим ключом. Оплата — провайдеру. <a href="/settings/ai" className="text-indigo-600 underline">Настроить ИИ</a></div>

          {/* M13: a crash inside WidgetRenderer (bad widget JSON, runtime
              error in a chart) used to bubble up and freeze the whole AI
              page. With the boundary the chat scroll area falls back to a
              compact error card while header / input / sidebar remain
              interactive — the user can reload or start a new conversation. */}
          <ErrorBoundary
            fallback={
              <div className="m-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                Ошибка отображения сообщений чата. Попробуй обновить страницу или начать новый диалог.
              </div>
            }
          >
            <AiChatMessages
              messages={messages}
              streamingText={streamingText}
              statusText={statusText}
              streamStatus={streamStatus}
              interrupt={interrupt}
              error={error}
              onApprove={handleApprove}
              onReject={handleReject}
              onQuickPrompt={handleSend}
            />
          </ErrorBoundary>

          <AiChatInput
            onSend={handleSend}
            onCancel={cancelStream}
            disabled={isDisabled && streamStatus !== 'streaming'}
            isStreaming={streamStatus === 'streaming'}
          />
        </div>
      </div>
    </AppShell>
  );
}

function buildManagerPlanPrompt(nmIds: number[]): string {
  const list = nmIds.join(', ');
  return [
    `Собери план задач для менеджера по этим товарам: ${list}.`,
    '',
    'По каждому товару подтяни и покажи компактно:',
    '— Маржу и выручку за последние 30 дней (используй query_finance).',
    '— Воронку: показы → клики → корзина → заказы → выкупы (query_funnel или query_funnel_grouped).',
    '— Открытые алёрты из мониторинга, чтобы было видно главные проблемы (query_alerts).',
    '— Статус A/B-тестов фото/контента: идёт ли тест, какой вариант лидирует, есть ли завершённые с победителем (query_ab_tests).',
    '',
    'Затем сделай два раздела:',
    '1) Гипотезы — 3–5 пунктов, что улучшить, и почему именно это. Если по товару нет активного A/B-теста, а гипотеза касается фото/контента — отметь это в плане.',
    '2) План задач для менеджера — конкретные действия в чек-листе (что сделать, по какому товару, ожидаемый эффект). Если нужен новый A/B-тест — добавь пункт «Запустить A/B-тест: <вариант>».',
    '',
    'Финальный вывод — markdown-таблица «маржа / выручка / выкуп % / A/B статус» и два списка под ней. Без воды.',
  ].join('\n');
}
