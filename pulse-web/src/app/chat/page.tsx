'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';
import {
  MessageSquare, RefreshCw, Send, Paperclip, Image as ImageIcon,
  Check, CheckCheck, Clock, User, AlertCircle, Search, Filter
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

type Chat = {
  chatId: string;
  userName: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  status: 'active' | 'closed';
  nmId?: number;
  productTitle?: string;
};

type Message = {
  messageId: string;
  direction: 'incoming' | 'outgoing';
  text: string | null;
  fileUrl?: string | null;
  fileName?: string | null;
  imageUrl?: string | null;
  createdAt: string;
  read: boolean;
};

export default function ChatPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();
  const [loading, setLoading] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'closed'>('all');
  const [filterUnread, setFilterUnread] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadChats = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterStatus !== 'all') params.set('status', filterStatus);
      if (filterUnread) params.set('unreadOnly', 'true');
      params.set('limit', '100');

      const res = await apiFetch(`/chat/${workspaceId}?${params}${shopParam}`) as { data: Chat[]; total: number };
      setChats(res.data ?? []);

      // Load unread count
      const unread = await apiFetch(`/chat/${workspaceId}/unread-count${shopParam ? `?${shopParam.slice(1)}` : ''}`) as { count: number };
      setUnreadCount(unread.count ?? 0);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить чаты');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filterStatus, filterUnread, shopParam]);

  const loadMessages = useCallback(async (chatId: string) => {
    if (!workspaceId) return;
    setMessagesLoading(true);
    try {
      const res = await apiFetch(`/chat/${workspaceId}/${chatId}/messages?limit=100${shopParam}`) as { data: Message[] };
      setMessages(res.data ?? []);

      // Mark as read
      await apiFetch(`/chat/${workspaceId}/${chatId}/read${shopParam ? `?${shopParam.slice(1)}` : ''}`, { method: 'POST' });
    } catch (e: any) {
      console.error('Failed to load messages:', e);
    } finally {
      setMessagesLoading(false);
    }
  }, [workspaceId, shopParam]);

  const sendTextMessage = async () => {
    if (!workspaceId || !selectedChat || !newMessage.trim()) return;
    setSending(true);
    try {
      await apiFetch(`/chat/${workspaceId}/${selectedChat.chatId}/send${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ text: newMessage.trim() }),
      });
      setNewMessage('');
      await loadMessages(selectedChat.chatId);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось отправить сообщение');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  useShopChange(() => {
    setSelectedChat(null);
    setMessages([]);
    loadChats();
  });

  useEffect(() => {
    if (selectedChat) {
      loadMessages(selectedChat.chatId);
    }
  }, [selectedChat, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const filteredChats = chats.filter((chat) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      chat.userName?.toLowerCase().includes(q) ||
      chat.lastMessage?.toLowerCase().includes(q) ||
      chat.productTitle?.toLowerCase().includes(q)
    );
  });

  if (workspaceId === null) {
    return (
      <AppShell title="Чаты покупателей">
        <Card className="p-8 text-center text-gray-500">
          Выберите магазин для просмотра чатов
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="Чаты покупателей">
      <div className="h-[calc(100vh-180px)] flex flex-col gap-4">
        <ErrorBanner error={error} onRetry={loadChats} onDismiss={() => setError(null)} />

        {/* Stats bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Badge variant="info" className="text-sm">
              <MessageSquare className="h-4 w-4 mr-1" />
              {chats.length} чатов
            </Badge>
            {unreadCount > 0 && (
              <Badge variant="warning" className="text-sm">
                {unreadCount} непрочитанных
              </Badge>
            )}
          </div>
          <Button variant="neutral" size="sm" onClick={loadChats} loading={loading}>
            <RefreshCw className="h-4 w-4" />
            Обновить
          </Button>
        </div>

        {/* Main layout */}
        <div className="flex-1 flex gap-4 min-h-0">
          {/* Chat list */}
          <Card className="w-80 flex flex-col">
            {/* Filters */}
            <div className="p-3 border-b border-gray-100 space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                <Input
                  placeholder="Поиск..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <div className="flex gap-2">
                <select
                  className="flex-1 h-8 rounded-lg border border-gray-300 bg-white px-2 text-sm"
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as any)}
                >
                  <option value="all">Все</option>
                  <option value="active">Активные</option>
                  <option value="closed">Закрытые</option>
                </select>
                <button
                  onClick={() => setFilterUnread(!filterUnread)}
                  className={cn(
                    'px-3 h-8 rounded-lg text-sm font-medium transition-colors',
                    filterUnread
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  )}
                >
                  Непрочитанные
                </button>
              </div>
            </div>

            {/* Chat items */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-4 text-center text-gray-500">Загрузка...</div>
              ) : filteredChats.length === 0 ? (
                <div className="p-4 text-center text-gray-500">Нет чатов</div>
              ) : (
                filteredChats.map((chat) => (
                  <button
                    key={chat.chatId}
                    onClick={() => setSelectedChat(chat)}
                    className={cn(
                      'w-full p-3 text-left border-b border-gray-50 transition-colors',
                      selectedChat?.chatId === chat.chatId
                        ? 'bg-indigo-50'
                        : 'hover:bg-gray-50'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">
                          {chat.userName || 'Покупатель'}
                        </div>
                        {chat.productTitle && (
                          <div className="text-xs text-gray-500 truncate">
                            {chat.productTitle}
                          </div>
                        )}
                        <div className="text-sm text-gray-600 truncate mt-1">
                          {chat.lastMessage || 'Нет сообщений'}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {chat.unreadCount > 0 && (
                          <Badge variant="indigo" size="sm">
                            {chat.unreadCount}
                          </Badge>
                        )}
                        {chat.lastMessageAt && (
                          <span className="text-xs text-gray-500">
                            {new Date(chat.lastMessageAt).toLocaleDateString('ru-RU', {
                              day: 'numeric',
                              month: 'short',
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </Card>

          {/* Chat window */}
          <Card className="flex-1 flex flex-col min-w-0">
            {!selectedChat ? (
              <div className="flex-1 flex items-center justify-center text-gray-500">
                <div className="text-center">
                  <MessageSquare className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                  <p>Выберите чат для просмотра</p>
                </div>
              </div>
            ) : (
              <>
                {/* Chat header */}
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-900">
                      {selectedChat.userName || 'Покупатель'}
                    </div>
                    {selectedChat.productTitle && (
                      <div className="text-sm text-gray-500">
                        {selectedChat.productTitle}
                        {selectedChat.nmId && (
                          <span className="ml-2 text-gray-500">#<NmIdLink nmId={selectedChat.nmId} /></span>
                        )}
                      </div>
                    )}
                  </div>
                  <Badge variant={selectedChat.status === 'active' ? 'success' : 'secondary'}>
                    {selectedChat.status === 'active' ? 'Активный' : 'Закрыт'}
                  </Badge>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messagesLoading ? (
                    <div className="text-center text-gray-500">Загрузка сообщений...</div>
                  ) : messages.length === 0 ? (
                    <div className="text-center text-gray-500">Нет сообщений</div>
                  ) : (
                    messages.map((msg) => (
                      <div
                        key={msg.messageId}
                        className={cn(
                          'flex',
                          msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'
                        )}
                      >
                        <div
                          className={cn(
                            'max-w-[70%] rounded-2xl px-4 py-2',
                            msg.direction === 'outgoing'
                              ? 'bg-indigo-500 text-white'
                              : 'bg-gray-100 text-gray-900'
                          )}
                        >
                          {msg.imageUrl && (
                            <img
                              src={msg.imageUrl}
                              alt="Изображение"
                              className="max-w-full rounded-lg mb-2"
                            />
                          )}
                          {msg.fileUrl && (
                            <a
                              href={msg.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cn(
                                'flex items-center gap-2 mb-2 underline',
                                msg.direction === 'outgoing' ? 'text-indigo-100' : 'text-indigo-600'
                              )}
                            >
                              <Paperclip className="h-4 w-4" />
                              {msg.fileName || 'Файл'}
                            </a>
                          )}
                          {msg.text && <p className="whitespace-pre-wrap">{msg.text}</p>}
                          <div
                            className={cn(
                              'flex items-center justify-end gap-1 mt-1 text-xs',
                              msg.direction === 'outgoing' ? 'text-indigo-200' : 'text-gray-500'
                            )}
                          >
                            <span>
                              {new Date(msg.createdAt).toLocaleTimeString('ru-RU', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                            {msg.direction === 'outgoing' && (
                              msg.read ? (
                                <CheckCheck className="h-3.5 w-3.5" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                {selectedChat.status === 'active' && (
                  <div className="p-4 border-t border-gray-100">
                    <div className="flex gap-2">
                      <Textarea
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Введите сообщение..."
                        rows={2}
                        className="flex-1 resize-none"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendTextMessage();
                          }
                        }}
                      />
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="primary"
                          onClick={sendTextMessage}
                          loading={sending}
                          disabled={!newMessage.trim()}
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
