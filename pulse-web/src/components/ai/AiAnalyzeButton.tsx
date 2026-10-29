'use client';

import { useState, useCallback } from 'react';
import { Bot, X, Send, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAiChat } from '@/hooks/useAiChat';
import { AiChatMessages } from './AiChatMessages';

interface AiAnalyzeButtonProps {
  /** Context to pass to the agent (filters, selected items, etc.) */
  context?: Record<string, unknown>;
  /** Pre-filled prompt suggestion */
  prompt?: string;
  /** Button label */
  label?: string;
  /** Button size */
  size?: 'sm' | 'md';
  /** Custom class */
  className?: string;
}

/**
 * Floating button that opens an AI chat modal with context.
 * Add to any page for contextual AI analysis.
 */
export function AiAnalyzeButton({
  context,
  prompt,
  label = 'AI анализ',
  size = 'md',
  className,
}: AiAnalyzeButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputText, setInputText] = useState(prompt ?? '');

  const {
    messages,
    streamStatus,
    streamingText,
    statusText,
    interrupt,
    error,
    sendMessage,
    resumeConversation,
    cancelStream,
  } = useAiChat();

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setInputText(prompt ?? '');
  }, [prompt]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    cancelStream();
  }, [cancelStream]);

  const handleSend = useCallback(() => {
    if (!inputText.trim()) return;

    // Build message with context
    let fullMessage = inputText;
    if (context && Object.keys(context).length > 0) {
      fullMessage += `\n\n[Контекст: ${JSON.stringify(context)}]`;
    }

    sendMessage(fullMessage);
    setInputText('');
  }, [inputText, context, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isStreaming = streamStatus === 'streaming' || streamStatus === 'connecting';

  return (
    <>
      {/* Floating button */}
      <button
        onClick={handleOpen}
        className={cn(
          'inline-flex items-center gap-2 rounded-xl font-medium',
          'bg-violet-600 text-white',
          'hover:bg-violet-700 active:bg-violet-800',
          'shadow-lg shadow-violet-500/25',
          'transition-all',
          size === 'sm' ? 'px-3 py-2 text-sm' : 'px-4 py-2.5',
          className
        )}
      >
        <Bot className={size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} />
        <span>{label}</span>
      </button>

      {/* Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={handleClose}
          />

          {/* Modal content */}
          <div className="relative w-full max-w-2xl max-h-[80vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center">
                  <Bot className="w-5 h-5 text-violet-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">AI Агент</h3>
                  <p className="text-xs text-gray-500">Анализ данных</p>
                </div>
              </div>
              <button
                onClick={handleClose}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto min-h-[300px]">
              <AiChatMessages
                messages={messages}
                streamingText={streamingText}
                statusText={statusText}
                streamStatus={streamStatus}
                interrupt={interrupt}
                error={error}
                onApprove={() => resumeConversation('approve')}
                onReject={() => resumeConversation('reject')}
              />
            </div>

            {/* Input */}
            <div className="border-t border-gray-200 p-4">
              <div className="flex items-end gap-2">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Задайте вопрос..."
                  disabled={isStreaming}
                  rows={2}
                  className={cn(
                    'flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50',
                    'px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400',
                    'focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500',
                    'disabled:opacity-50'
                  )}
                />
                <button
                  onClick={isStreaming ? cancelStream : handleSend}
                  disabled={!inputText.trim() && !isStreaming}
                  className={cn(
                    'p-3 rounded-xl transition-colors',
                    isStreaming
                      ? 'bg-red-500 hover:bg-red-600 text-white'
                      : 'bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50'
                  )}
                >
                  {isStreaming ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                </button>
              </div>

              {/* Quick prompts */}
              {messages.length === 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {QUICK_PROMPTS.map((p, i) => (
                    <button
                      key={i}
                      onClick={() => setInputText(p)}
                      className="px-3 py-1.5 text-xs rounded-full bg-gray-100 text-gray-600 hover:bg-violet-100 hover:text-violet-700 transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const QUICK_PROMPTS = [
  'Найди аномалии и проблемы',
  'Какие товары требуют внимания?',
  'Дай рекомендации по улучшению',
  'Что влияет на прибыль?',
  'Сравни с прошлым периодом',
  'Топ-3 инсайта',
];
