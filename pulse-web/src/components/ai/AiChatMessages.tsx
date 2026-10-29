'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { Bot, Loader2, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { AiChatMessage } from './AiChatMessage';
import { useAiChatStore, type AiMessage, type AiInterrupt, type AiStreamStatus } from '@/store/aiChat';

interface AiChatMessagesProps {
  messages: AiMessage[];
  streamingText: string;
  statusText: string;
  streamStatus: AiStreamStatus;
  interrupt: AiInterrupt | null;
  error: string | null;
  onApprove?: () => void;
  onReject?: () => void;
  onQuickPrompt?: (text: string) => void;
}

/**
 * Messages list with streaming support.
 */
export function AiChatMessages({
  messages,
  streamingText,
  statusText,
  streamStatus,
  interrupt,
  error,
  onApprove,
  onReject,
  onQuickPrompt,
}: AiChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMessageCount = useRef(0);
  const isHistoryLoad = useRef(false);

  const isStreaming = streamStatus === 'streaming' || streamStatus === 'connecting';
  const messagesLoading = useAiChatStore((s) => s.messagesLoading);

  useEffect(() => {
    const prev = prevMessageCount.current;
    const curr = messages.length;
    prevMessageCount.current = curr;

    if (curr === 0) {
      isHistoryLoad.current = true;
      return;
    }

    // History loaded (conversation opened/switched: 0 → N) — scroll to top
    if (isHistoryLoad.current && curr > 0) {
      isHistoryLoad.current = false;
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: 0 });
      });
      return;
    }

    // New message in active conversation — scroll to bottom
    if (curr > prev) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [messages]);

  // During streaming, keep scrolled to bottom
  useEffect(() => {
    if (isStreaming && streamingText) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [streamingText, isStreaming]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto min-h-0">
      {/* Empty state */}
      {messages.length === 0 && !isStreaming && !messagesLoading && (
        <div className="flex flex-col items-center justify-center h-full text-center px-8">
          <div className="w-16 h-16 rounded-2xl bg-violet-100 flex items-center justify-center mb-4">
            <Bot className="w-8 h-8 text-violet-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            AI Агент Sigma Seller
          </h3>
          <p className="text-sm text-gray-500 max-w-md">
            Задайте вопрос о вашем бизнесе: выручка, остатки, заказы, отзывы.
            Агент проанализирует данные и поможет принять решения.
          </p>
          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            {QUICK_PROMPTS.map((prompt, i) => (
              <button
                key={i}
                onClick={() => onQuickPrompt?.(prompt)}
                className={cn(
                  'px-4 py-2 rounded-full text-sm cursor-pointer',
                  'bg-gray-100 text-gray-700',
                  'hover:bg-violet-100 hover:text-violet-700',
                  'transition-colors'
                )}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      {messages.map((msg) => (
        <AiChatMessage
          key={msg.id}
          message={msg}
          isStreaming={false}
        />
      ))}

      {/* Streaming text */}
      {streamingText && (
        <AiChatMessage
          message={{
            id: -1,
            role: 'assistant',
            content: streamingText,
            createdAt: new Date().toISOString(),
          }}
          isStreaming={true}
        />
      )}

      {/* Status indicator */}
      {statusText && (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{statusText}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-4 my-3 p-4 rounded-xl bg-red-50 border border-red-200">
          <div className="flex items-center gap-2 text-red-700">
            <AlertCircle className="w-4 h-4" />
            <span className="font-medium">Ошибка</span>
          </div>
          <p className="mt-1 text-sm text-red-600">{error}</p>
        </div>
      )}

      {/* Interrupt (confirmation required) */}
      {interrupt && (
        <div className="mx-4 my-3 p-4 rounded-xl bg-amber-50 border border-amber-200">
          <div className="flex items-center gap-2 text-amber-700 mb-2">
            <AlertCircle className="w-4 h-4" />
            <span className="font-medium">Требуется подтверждение</span>
          </div>
          <p className="text-sm text-gray-700 mb-1">
            <strong>Действие:</strong> {interrupt.action}
          </p>
          {interrupt.rationale && (
            <p className="text-sm text-gray-600 mb-3">{interrupt.rationale}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={onApprove}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium',
                'bg-green-600 text-white hover:bg-green-700',
                'transition-colors'
              )}
            >
              <CheckCircle className="w-4 h-4" />
              Подтвердить
            </button>
            <button
              onClick={onReject}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium',
                'bg-gray-200 text-gray-700 hover:bg-gray-300',
                'transition-colors'
              )}
            >
              <XCircle className="w-4 h-4" />
              Отменить
            </button>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

const QUICK_PROMPTS = [
  '📊 Какая выручка за неделю?',
  '📦 Какие товары заканчиваются?',
  '⭐ Покажи последние отзывы',
  '📈 Анализ продаж за месяц',
];
