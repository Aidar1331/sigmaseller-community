'use client';

import { useEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/cn';
import { Plus, MessageSquare, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { useAiChatStore, type AiConversation } from '@/store/aiChat';
import { getAiConversations, archiveAiConversation } from '@/lib/aiApi';

interface AiChatSidebarProps {
  onSelectConversation: (id: number | null) => void;
  onNewChat: () => void;
}

/**
 * Sidebar with conversations list.
 */
export function AiChatSidebar({ onSelectConversation, onNewChat }: AiChatSidebarProps) {
  const {
    conversations,
    conversationsLoading,
    currentConversationId,
    setConversations,
    setConversationsLoading,
  } = useAiChatStore();
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    setConversationsLoading(true);
    setLoadError(null);
    try {
      const convs = await getAiConversations();
      setConversations(convs);
    } catch (err) {
      console.error('Failed to load conversations:', err);
      setLoadError('Не удалось загрузить беседы');
    } finally {
      setConversationsLoading(false);
    }
  }, [setConversations, setConversationsLoading]);

  // Load on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Reload when a new conversation is created (ID not in current list)
  useEffect(() => {
    if (currentConversationId && !conversations.find(c => c.conversationId === currentConversationId)) {
      loadConversations();
    }
  }, [currentConversationId, conversations, loadConversations]);

  const handleArchive = async (e: React.MouseEvent, convId: number) => {
    e.stopPropagation();
    try {
      await archiveAiConversation(convId);
      setConversations(conversations.filter((c) => c.conversationId !== convId));
      if (currentConversationId === convId) {
        onSelectConversation(null);
      }
    } catch (err) {
      console.error('Failed to archive conversation:', err);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <button
          onClick={onNewChat}
          className={cn(
            'w-full flex items-center gap-2 px-4 py-2.5 rounded-xl',
            'bg-violet-600 text-white',
            'hover:bg-violet-700',
            'transition-colors'
          )}
        >
          <Plus className="w-4 h-4" />
          <span className="font-medium">Новый чат</span>
        </button>
      </div>

      {/* Conversations list */}
      <div className="flex-1 overflow-y-auto p-2">
        {loadError ? (
          <div className="flex flex-col items-center gap-2 py-8 px-4 text-center">
            <AlertCircle className="w-5 h-5 text-red-400" />
            <p className="text-sm text-red-500">{loadError}</p>
            <button
              onClick={loadConversations}
              className="text-xs text-violet-600 hover:underline"
            >
              Повторить
            </button>
          </div>
        ) : conversationsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center py-8 text-sm text-gray-500">
            Нет бесед
          </div>
        ) : (
          <div className="space-y-1">
            {conversations.map((conv) => (
              <ConversationItem
                key={conv.conversationId}
                conversation={conv}
                isActive={conv.conversationId === currentConversationId}
                onClick={() => onSelectConversation(conv.conversationId)}
                onArchive={(e) => handleArchive(e, conv.conversationId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ConversationItemProps {
  conversation: AiConversation;
  isActive: boolean;
  onClick: () => void;
  onArchive: (e: React.MouseEvent) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onClick,
  onArchive,
}: ConversationItemProps) {
  const [confirming, setConfirming] = useState(false);

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(true);
  };

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
    onArchive(e);
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
  };

  return (
    <div
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer',
        'transition-colors',
        isActive
          ? 'bg-violet-100 text-violet-900'
          : 'hover:bg-gray-100 text-gray-700'
      )}
    >
      <MessageSquare className="w-4 h-4 flex-shrink-0 opacity-60" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {conversation.title || 'Новая беседа'}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 truncate">
            {formatDate(conversation.updatedAt)}
          </span>
          {conversation.shopName && (
            <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium bg-violet-100 text-violet-700 whitespace-nowrap">
              {conversation.shopName}
            </span>
          )}
          {conversation.meta?.source === 'telegram' && (
            <span
              className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium bg-sky-100 text-sky-700 whitespace-nowrap"
              title="Чат начат в Telegram-боте"
            >
              📱 Из Telegram
            </span>
          )}
        </div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleConfirm}
            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
          >
            Да
          </button>
          <button
            onClick={handleCancel}
            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
          >
            Нет
          </button>
        </div>
      ) : (
        <button
          onClick={handleDeleteClick}
          className={cn(
            'p-1 rounded opacity-0 group-hover:opacity-100',
            'hover:bg-gray-200 text-gray-500 hover:text-red-500',
            'transition-all'
          )}
          title="Удалить"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'только что';
  if (diffMins < 60) return `${diffMins} мин назад`;
  if (diffHours < 24) return `${diffHours} ч назад`;
  if (diffDays < 7) return `${diffDays} дн назад`;

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  });
}
