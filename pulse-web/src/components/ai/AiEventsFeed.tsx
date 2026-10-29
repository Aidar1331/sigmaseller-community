'use client';

import { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/cn';
import { apiFetch } from '@/lib/api';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  Check,
  X,
  Clock,
  MessageSquare,
  RefreshCw,
  Package,
  TrendingDown,
  Star,
  Loader2,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

type AgentEvent = {
  eventId: number;
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string | null;
  nmId: number | null;
  productTitle: string | null;
  suggestedAction: string | null;
  status: 'pending' | 'applied' | 'dismissed' | 'snoozed';
  createdAt: string;
};

type EventStats = {
  pending: number;
  critical: number;
  byStatus: Record<string, number>;
};

interface AiEventsFeedProps {
  onOpenChat?: (eventId: number) => void;
}

const EVENT_TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  oos_warning: Package,
  order_drop: TrendingDown,
  review_spike: Star,
  margin_drop: AlertTriangle,
  default: AlertCircle,
};

const SEVERITY_STYLES: Record<string, { bg: string; border: string; icon: string }> = {
  critical: { bg: 'bg-red-50', border: 'border-red-200', icon: 'text-red-500' },
  warning: { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500' },
  info: { bg: 'bg-blue-50', border: 'border-blue-200', icon: 'text-blue-500' },
};

export function AiEventsFeed({ onOpenChat }: AiEventsFeedProps) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stats, setStats] = useState<EventStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'critical'>('pending');

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const [eventsResult, statsResult] = await Promise.allSettled([
        apiFetch<{ events: AgentEvent[] }>(`/ai/events?status=${filter === 'all' ? 'all' : filter === 'critical' ? 'pending' : 'pending'}`),
        apiFetch<EventStats>('/ai/events/stats'),
      ]);

      if (eventsResult.status === 'fulfilled') {
        let filtered = eventsResult.value.events ?? [];
        if (filter === 'critical') {
          filtered = filtered.filter(e => e.severity === 'critical');
        }
        setEvents(filtered);
      } else {
        console.error('Failed to load events:', eventsResult.reason);
      }

      if (statsResult.status === 'fulfilled') {
        setStats(statsResult.value);
      } else {
        console.error('Failed to load stats:', statsResult.reason);
      }
    } catch (err) {
      console.error('Failed to load events:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleApply = async (eventId: number) => {
    try {
      await apiFetch(`/ai/events/${eventId}/apply`, { method: 'PATCH' });
      setEvents(events.filter(e => e.eventId !== eventId));
      loadEvents();
    } catch (err) {
      console.error('Failed to apply event:', err);
    }
  };

  const handleDismiss = async (eventId: number) => {
    try {
      await apiFetch(`/ai/events/${eventId}/dismiss`, { method: 'PATCH' });
      setEvents(events.filter(e => e.eventId !== eventId));
      loadEvents();
    } catch (err) {
      console.error('Failed to dismiss event:', err);
    }
  };

  const handleSnooze = async (eventId: number) => {
    try {
      await apiFetch(`/ai/events/${eventId}/snooze`, {
        method: 'PATCH',
        body: JSON.stringify({ hours: 24 }),
      });
      setEvents(events.filter(e => e.eventId !== eventId));
      loadEvents();
    } catch (err) {
      console.error('Failed to snooze event:', err);
    }
  };

  const handleChat = async (eventId: number) => {
    if (onOpenChat) {
      onOpenChat(eventId);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-gray-900">События</h3>
          {stats && stats.pending > 0 && (
            <Badge variant="danger">{stats.pending}</Badge>
          )}
        </div>
        <button
          onClick={loadEvents}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
        >
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 px-4 py-2 border-b border-gray-100">
        {(['pending', 'critical', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'px-3 py-1.5 text-sm rounded-lg transition-colors',
              filter === f
                ? 'bg-violet-100 text-violet-700'
                : 'text-gray-500 hover:bg-gray-100'
            )}
          >
            {f === 'pending' && 'Активные'}
            {f === 'critical' && '🔴 Критичные'}
            {f === 'all' && 'Все'}
          </button>
        ))}
      </div>

      {/* Events list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-green-100 flex items-center justify-center">
              <Check className="w-6 h-6 text-green-700" />
            </div>
            <p className="text-gray-500">Нет активных событий</p>
            <p className="text-sm text-gray-500 mt-1">
              Агент следит за вашим магазином
            </p>
          </div>
        ) : (
          events.map((event) => (
            <EventCard
              key={event.eventId}
              event={event}
              onApply={() => handleApply(event.eventId)}
              onDismiss={() => handleDismiss(event.eventId)}
              onSnooze={() => handleSnooze(event.eventId)}
              onChat={() => handleChat(event.eventId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface EventCardProps {
  event: AgentEvent;
  onApply: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
  onChat: () => void;
}

function EventCard({ event, onApply, onDismiss, onSnooze, onChat }: EventCardProps) {
  const Icon = EVENT_TYPE_ICONS[event.eventType] ?? EVENT_TYPE_ICONS.default;
  const styles = SEVERITY_STYLES[event.severity] ?? SEVERITY_STYLES.info;

  return (
    <Card className={cn('p-4', styles.bg, styles.border, 'border')}>
      <div className="flex gap-3">
        <div className={cn('flex-shrink-0 w-10 h-10 rounded-xl bg-white flex items-center justify-center', styles.icon)}>
          <Icon className="w-5 h-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h4 className="font-medium text-gray-900 text-sm">{event.title}</h4>
            <span className="text-xs text-gray-500 flex-shrink-0">
              {formatTime(event.createdAt)}
            </span>
          </div>

          {event.description && (
            <p className="text-sm text-gray-600 mt-1">{event.description}</p>
          )}

          {event.suggestedAction && (
            <div className="mt-2">
              <Badge variant="secondary" className="text-xs">
                Действие: {formatAction(event.suggestedAction)}
              </Badge>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 mt-3">
            {event.suggestedAction && (
              <Button size="sm" variant="success" onClick={onApply}>
                <Check className="w-3.5 h-3.5 mr-1" />
                Применить
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={onChat}>
              <MessageSquare className="w-3.5 h-3.5 mr-1" />
              Подробнее
            </Button>
            <Button size="sm" variant="neutral" onClick={onSnooze}>
              <Clock className="w-3.5 h-3.5 mr-1" />
              Позже
            </Button>
            <Button size="sm" variant="neutral" onClick={onDismiss}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'сейчас';
  if (diffMins < 60) return `${diffMins}м`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}ч`;
  return `${Math.floor(diffMins / 1440)}д`;
}

function formatAction(action: string): string {
  const actions: Record<string, string> = {
    protect_price: 'Защитить цену',
    reprice: 'Изменить цену',
    pause_ads: 'Пауза рекламы',
    reply_review: 'Ответить на отзыв',
    analyze: 'Анализ',
    restock: 'Пополнить',
  };
  return actions[action] ?? action;
}
