'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useShopChange } from '@/hooks/useShopChange';
import {
  AlertTriangle, Bell, Check, ChevronDown, ChevronRight, Clock, Eye,
  Filter, HelpCircle, RefreshCw, Shield, ShoppingCart, TrendingDown,
  Package, FileText, Zap, Sparkles, X,
} from 'lucide-react';

const PLAN_MAX_NM = 10;

type AgentEvent = {
  eventId: number;
  workspaceId: number;
  eventType: string;
  nmId: number | null;
  severity: string;
  title: string;
  description: string | null;
  suggestedAction: string | null;
  actionArgs: Record<string, any> | null;
  status: string;
  snoozedUntil: string | null;
  appliedAt: string | null;
  createdAt: string;
  meta: { triggerId?: string; [key: string]: unknown } | null;
};

type StatusFilter = 'pending' | 'applied' | 'dismissed' | 'snoozed' | 'all';

const categoryIcons: Record<string, any> = {
  stocks: Package,
  sales: ShoppingCart,
  advertising: Zap,
  pricing: TrendingDown,
  content: FileText,
};

const severityConfig: Record<string, { variant: 'danger' | 'warning' | 'info'; label: string }> = {
  critical: { variant: 'danger', label: 'Критично' },
  high: { variant: 'warning', label: 'Высокий' },
  medium: { variant: 'info', label: 'Средний' },
};

const actionLabels: Record<string, string> = {
  restock: 'Пополнить запас',
  reprice: 'Изменить цену',
  pause_ads: 'Приостановить рекламу',
  reply_review: 'Ответить на отзыв',
};

/**
 * Превращает action + args в человеческое описание с конкретными цифрами.
 * Например, для reprice показывает «Цена 1490 → 1267 ₽ (−15%)».
 */
function formatRecommendation(action: string, args: any): string {
  const base = actionLabels[action] ?? action;
  if (!args || typeof args !== 'object') return base;
  if (action === 'reprice') {
    const cur = args.currentPriceRub;
    const tgt = args.targetPriceRub;
    const pct = args.discountPct;
    if (cur && tgt && pct) return `Цена ${cur} → ${tgt} ₽ (−${pct}%)`;
    if (tgt) return `Цена → ${tgt} ₽`;
    if (pct) return `Цена −${pct}%`;
  }
  return base;
}

// Human-readable group titles for the trigger taxonomy. Synced with
// pulse-api/src/services/taskMonitor/triggers.ts (24 entries). When the
// backend taxonomy gains a new trigger, add the label here too; missing
// entries fall back to the raw triggerId string.
const triggerLabels: Record<string, string> = {
  stock_zero: 'Нулевой остаток',
  stock_critical: 'Критически мало',
  stock_low: 'Мало товара',
  stock_excess: 'Избыток на WB (FBO)',
  stock_forecast_oos: 'Прогноз OOS',
  stock_warehouse_imbalance: 'Дисбаланс складов',
  stock_new_arrival: 'Поступление товара',
  sales_drop_daily: 'Падение заказов (день)',
  sales_drop_weekly: 'Падение заказов (неделя)',
  sales_spike: 'Всплеск заказов',
  buyout_drop: 'Падение выкупа',
  returns_spike: 'Всплеск возвратов',
  adv_drr_high: 'ДРР выше нормы',
  adv_zero_orders: 'Реклама без заказов',
  adv_budget_exhausted: 'Бюджет исчерпан',
  adv_ctr_drop: 'Падение CTR',
  adv_cpc_spike: 'Рост CPC',
  price_competitor_lower: 'Конкурент снизил цену',
  price_margin_negative: 'Отрицательная маржа',
  price_spp_change: 'Изменение СПП',
  price_commission_change: 'Изменение комиссии',
  content_negative_review: 'Негативный отзыв',
  content_rating_drop: 'Падение рейтинга',
  content_seo_position_drop: 'Падение SEO позиций',
};

// Optional tooltip text per trigger — when the term in the label is ambiguous
// and a seller may not find a 1:1 match in the WB cabinet.
const triggerHints: Record<string, string> = {
  returns_spike:
    'Здесь «возврат» = заказ, который покупатель не выкупил (отказ при доставке или отмена). '
    + 'Считаем как разницу между заказами и выкупами за 7 дней. '
    + 'В разделе «Возвраты» личного кабинета WB этого может не быть — там показывают только возвраты после выкупа.',
};

// Severity ordering for sorting groups (most-urgent first).
const severityRank: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  info: 3,
};

function maxSeverity(events: AgentEvent[]): string {
  let best = 'info';
  let bestRank = severityRank.info;
  for (const ev of events) {
    const r = severityRank[ev.severity] ?? 99;
    if (r < bestRank) {
      best = ev.severity;
      bestRank = r;
    }
  }
  return best;
}

type AgentStatus = {
  lastRunAt: string | null;
  itemsAnalyzed: number;
  findingsCount: number;
  nextRunAt: string | null;
  isRunning: boolean;
};

export default function TaskMonitorPage() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [snoozeEventId, setSnoozeEventId] = useState<number | null>(null);
  const [snoozeHours, setSnoozeHours] = useState(24);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const loadAgentStatus = useCallback(async () => {
    try {
      const res = await apiFetch<AgentStatus>('/task-monitor/agent-status');
      setAgentStatus(res);
    } catch {
      // Agent status endpoint may not exist yet — silently ignore
    }
  }, []);

  const runAgentNow = async () => {
    setAgentLoading(true);
    try {
      await apiFetch('/task-monitor/run', { method: 'POST' });
      await loadAgentStatus();
      await loadEvents();
    } catch (err) {
      console.error('Failed to run analysis:', err);
    } finally {
      setAgentLoading(false);
    }
  };

  useEffect(() => {
    loadAgentStatus();
  }, [loadAgentStatus]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ events: AgentEvent[] }>(
        `/task-monitor/events?status=${statusFilter}&limit=100`
      );
      setEvents(res.events ?? []);
    } catch (err) {
      console.error('Failed to load events:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useShopChange(loadEvents);

  const dismissEvent = async (eventId: number) => {
    setActionLoading(eventId);
    try {
      await apiFetch(`/task-monitor/events/${eventId}/dismiss`, { method: 'POST' });
      setEvents((prev) => prev.filter((e) => e.eventId !== eventId));
    } catch (err) {
      console.error('Failed to dismiss:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const snoozeEvent = async (eventId: number, hours: number) => {
    setActionLoading(eventId);
    try {
      await apiFetch(`/task-monitor/events/${eventId}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ hours }),
      });
      setEvents((prev) => prev.filter((e) => e.eventId !== eventId));
      setSnoozeEventId(null);
    } catch (err) {
      console.error('Failed to snooze:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const applyAction = async (eventId: number) => {
    setActionLoading(eventId);
    try {
      // Помечаем event как "взято в работу" — это убирает кнопку, чтобы при
      // повторном заходе пользователь не нажал ещё раз. Само действие (смена
      // цены / пауза / т.д.) подтверждается уже в AI-чате на /pulse.
      await apiFetch(`/task-monitor/events/${eventId}/apply`, { method: 'POST' });
      setEvents((prev) =>
        prev.map((e) =>
          e.eventId === eventId ? { ...e, status: 'applied', appliedAt: new Date().toISOString() } : e
        )
      );
      // Передаём eventId в /pulse через query — там AI откроет нужный сценарий
      // с конкретикой и спросит "Применить?" с одной кнопкой подтверждения.
      const target = `/pulse?event=${eventId}`;
      if (typeof window !== 'undefined') window.location.href = target;
    } catch (err) {
      console.error('Failed to apply:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const getCategoryFromTrigger = (triggerId: string): string => {
    if (triggerId.startsWith('stock_')) return 'stocks';
    if (triggerId.startsWith('sales_') || triggerId.startsWith('buyout_') || triggerId.startsWith('returns_')) return 'sales';
    if (triggerId.startsWith('adv_')) return 'advertising';
    if (triggerId.startsWith('price_')) return 'pricing';
    if (triggerId.startsWith('content_')) return 'content';
    return 'other';
  };

  const pendingCount = events.filter((e) => e.status === 'pending').length;

  // Group events by triggerId so a wall of "26 nm_id'ов с одинаковым нулевым
  // остатком" becomes a single collapsible card. Sort: critical → high →
  // medium → info, then by descending count within severity.
  const groupedEvents = useMemo(() => {
    const map = new Map<string, AgentEvent[]>();
    for (const ev of events) {
      const key = ev.meta?.triggerId ?? ev.eventType ?? 'other';
      const bucket = map.get(key);
      if (bucket) bucket.push(ev);
      else map.set(key, [ev]);
    }
    return Array.from(map.entries())
      .map(([trigger, items]) => ({
        trigger,
        items,
        count: items.length,
        sev: maxSeverity(items),
        category: getCategoryFromTrigger(trigger),
      }))
      .sort((a, b) => {
        const ra = severityRank[a.sev] ?? 99;
        const rb = severityRank[b.sev] ?? 99;
        if (ra !== rb) return ra - rb;
        return b.count - a.count;
      });
  }, [events]);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((trigger: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(trigger)) next.delete(trigger); else next.add(trigger);
      return next;
    });
  }, []);

  // Multiselect for "Сформировать план задач" flow. Keys by nm_id (not
  // event_id) so picking the same product across multiple triggers counts
  // once. Capped at 10 — beyond that the AI loses focus on per-item detail.
  const router = useRouter();
  const [selectedNmIds, setSelectedNmIds] = useState<Set<number>>(new Set());
  const [selectionLimitToast, setSelectionLimitToast] = useState(false);
  const toggleNmSelected = useCallback((nmId: number) => {
    setSelectedNmIds((prev) => {
      const next = new Set(prev);
      if (next.has(nmId)) { next.delete(nmId); return next; }
      if (next.size >= PLAN_MAX_NM) {
        setSelectionLimitToast(true);
        setTimeout(() => setSelectionLimitToast(false), 2500);
        return prev;
      }
      next.add(nmId);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedNmIds(new Set()), []);
  const openManagerPlan = useCallback(() => {
    if (selectedNmIds.size === 0) return;
    const ids = Array.from(selectedNmIds).join(',');
    router.push(`/ai?nmIds=${ids}&template=manager-plan`);
  }, [selectedNmIds, router]);

  return (
    <AppShell title="Мониторинг задач">
      <div className="space-y-4">
        {/* Header */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-violet-600" />
                <h1 className="text-lg font-semibold text-gray-900">Мониторинг</h1>
                {pendingCount > 0 && (
                  <Badge variant="danger" size="sm">{pendingCount} новых</Badge>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Status filter */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                {(['pending', 'applied', 'dismissed', 'snoozed', 'all'] as StatusFilter[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={cn(
                      'px-3 py-1.5 text-xs font-medium transition-colors',
                      statusFilter === s
                        ? 'bg-violet-50 text-violet-700'
                        : 'text-gray-500 hover:bg-gray-50'
                    )}
                  >
                    {s === 'pending' ? 'Ожидают' :
                     s === 'applied' ? 'Применено' :
                     s === 'dismissed' ? 'Отклонено' :
                     s === 'snoozed' ? 'Отложено' : 'Все'}
                  </button>
                ))}
              </div>

              <Button variant="ghost" size="icon-sm" onClick={loadEvents} disabled={loading}>
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </Card>

        {/* AI Agent Activity */}
        <Card className="border-violet-500/20 bg-gradient-to-r from-violet-500/5 to-indigo-500/5 p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10">
                <Zap className="h-4 w-4 text-violet-500" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900">AI-агент анализа</h3>
                <div className="mt-1 space-y-0.5 text-xs text-gray-500">
                  {agentStatus ? (
                    <>
                      <p>Последний анализ: {agentStatus.lastRunAt ? new Date(agentStatus.lastRunAt).toLocaleString('ru-RU') : 'ещё не запускался'}</p>
                      {agentStatus.itemsAnalyzed > 0 && (
                        <p>Проанализировано: {agentStatus.itemsAnalyzed} товаров</p>
                      )}
                      {agentStatus.findingsCount > 0 && (
                        <p className="text-orange-700">Найдено проблем: {agentStatus.findingsCount}</p>
                      )}
                      {agentStatus.nextRunAt && (
                        <p>Следующий запуск: {new Date(agentStatus.nextRunAt).toLocaleString('ru-RU')}</p>
                      )}
                    </>
                  ) : (
                    <p>AI-агент автоматически анализирует товары, остатки, рекламу и цены. Результаты появляются в списке ниже.</p>
                  )}
                </div>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={runAgentNow}
              disabled={agentLoading}
              className="shrink-0"
            >
              {agentLoading ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="mr-1 h-3.5 w-3.5" />
              )}
              {agentLoading ? 'Анализ...' : 'Запустить анализ'}
            </Button>
          </div>
        </Card>

        {/* Events List */}
        {loading && events.length === 0 ? (
          <Card className="p-12 text-center text-gray-500">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
            Загрузка событий...
          </Card>
        ) : events.length === 0 ? (
          <Card className="p-12 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-emerald-100 flex items-center justify-center">
              <Check className="h-8 w-8 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Все чисто</h3>
            <p className="text-sm text-gray-500">
              {statusFilter === 'pending'
                ? 'Нет новых событий, требующих внимания'
                : 'Нет событий с этим статусом'}
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {groupedEvents.map((g) => {
              const GroupIcon = categoryIcons[g.category] || AlertTriangle;
              const groupSev = severityConfig[g.sev] || severityConfig.medium;
              const isExpanded = expandedGroups.has(g.trigger);
              const groupLabel = triggerLabels[g.trigger] ?? g.trigger;
              const groupHint = triggerHints[g.trigger];
              const countNoun = g.count === 1
                ? 'товар'
                : (g.count % 10 >= 2 && g.count % 10 <= 4 && (g.count % 100 < 10 || g.count % 100 >= 20))
                ? 'товара'
                : 'товаров';
              return (
                <Card key={g.trigger} className="overflow-hidden p-0">
                  {/* Group header — clickable */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.trigger)}
                    className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
                  >
                    <div className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
                      g.sev === 'critical' ? 'bg-red-100' :
                      g.sev === 'high' ? 'bg-amber-100' : 'bg-blue-100'
                    )}>
                      <GroupIcon className={cn(
                        'h-5 w-5',
                        g.sev === 'critical' ? 'text-red-600' :
                        g.sev === 'high' ? 'text-amber-700' : 'text-blue-600'
                      )} />
                    </div>
                    <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium text-gray-900 text-sm">{groupLabel}</h3>
                      {groupHint && (
                        <span
                          role="img"
                          aria-label={groupHint}
                          title={groupHint}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center text-gray-400 hover:text-gray-600 cursor-help"
                        >
                          <HelpCircle className="h-4 w-4" />
                        </span>
                      )}
                      <Badge variant={groupSev.variant} size="sm">{g.count} {countNoun}</Badge>
                      <span className="text-xs text-gray-500">{groupSev.label}</span>
                    </div>
                    {isExpanded
                      ? <ChevronDown className="h-5 w-5 text-gray-400 flex-shrink-0" />
                      : <ChevronRight className="h-5 w-5 text-gray-400 flex-shrink-0" />}
                  </button>

                  {/* Expanded list of per-article events */}
                  {isExpanded && (
                    <div className="border-t border-gray-100 divide-y divide-gray-100">
                      {g.items.map((event) => {
                        const severity = severityConfig[event.severity] || severityConfig.medium;
                        const isActioning = actionLoading === event.eventId;
                        const isSelected = event.nmId != null && selectedNmIds.has(event.nmId);
                        return (
                          <div key={event.eventId} className="p-4 pl-14 relative">
                            {event.nmId != null && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleNmSelected(event.nmId!)}
                                className="absolute left-4 top-5 h-4 w-4 cursor-pointer accent-violet-600"
                                title="Добавить в план задач для менеджера"
                              />
                            )}
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <h4 className="font-medium text-gray-900 text-sm">{event.title}</h4>
                                  <Badge variant={severity.variant} size="sm">{severity.label}</Badge>
                                  {event.status !== 'pending' && (
                                    <Badge variant="neutral" size="sm">
                                      {event.status === 'applied' ? 'Применено' :
                                       event.status === 'dismissed' ? 'Отклонено' :
                                       event.status === 'snoozed' ? 'Отложено' : event.status}
                                    </Badge>
                                  )}
                                </div>
                                {event.description && (
                                  <p className="text-sm text-gray-600 mb-2">{event.description}</p>
                                )}
                                {event.nmId && (
                                  <span className="text-xs text-gray-500">Артикул: <NmIdLink nmId={event.nmId} /></span>
                                )}
                              </div>

                              <span className="text-xs text-gray-500 flex-shrink-0">
                                {new Date(event.createdAt).toLocaleString('ru-RU', {
                                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                                })}
                              </span>
                            </div>

                            {/* Suggested Action */}
                            {event.suggestedAction && event.status === 'pending' && (
                              <div className="mt-2 p-2 bg-violet-50 rounded-lg border border-violet-100">
                                <div className="text-xs font-medium text-violet-700 mb-1">Рекомендация:</div>
                                <div className="text-sm text-violet-900">
                                  {formatRecommendation(event.suggestedAction, event.actionArgs)}
                                </div>
                              </div>
                            )}

                            {/* Actions */}
                            {event.status === 'pending' && (
                              <div className="flex items-center gap-2 mt-3 flex-wrap">
                                {event.suggestedAction && (
                                  <Button
                                    variant="primary"
                                    size="xs"
                                    onClick={() => applyAction(event.eventId)}
                                    loading={isActioning}
                                    title="Открыть AI-чат — там подтвердишь и Sigma выполнит"
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                    Открыть в чате →
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => {
                                    if (snoozeEventId === event.eventId) {
                                      setSnoozeEventId(null);
                                    } else {
                                      setSnoozeEventId(event.eventId);
                                      setSnoozeHours(24);
                                    }
                                  }}
                                  title="Скрыть совет — на время или навсегда"
                                >
                                  <Clock className="h-3.5 w-3.5" />
                                  Не сейчас
                                </Button>
                              </div>
                            )}

                            {/* Snooze picker — теперь включает «Навсегда» (вместо отдельной кнопки) */}
                            {snoozeEventId === event.eventId && (
                              <div className="flex items-center gap-2 mt-2 p-2 bg-gray-50 rounded-lg flex-wrap">
                                <span className="text-xs text-gray-600">Скрыть на:</span>
                                {[1, 4, 12, 24, 48, 168].map((h) => (
                                  <button
                                    key={h}
                                    onClick={() => snoozeEvent(event.eventId, h)}
                                    className={cn(
                                      'px-2 py-1 rounded text-xs font-medium transition-colors',
                                      snoozeHours === h
                                        ? 'bg-violet-100 text-violet-700'
                                        : 'text-gray-500 hover:bg-gray-200'
                                    )}
                                  >
                                    {h < 24 ? `${h}ч` : `${h / 24}д`}
                                  </button>
                                ))}
                                <button
                                  onClick={() => dismissEvent(event.eventId)}
                                  disabled={isActioning}
                                  className="px-2 py-1 rounded text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                                  title="Скрыть и больше не показывать этот совет"
                                >
                                  Навсегда
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* Sticky multi-select footer: appears when any event is checked.
            Sends the chosen nm_ids to /ai with template=manager-plan so the
            agent assembles margin/funnel/hypotheses/task-list. Capped at
            PLAN_MAX_NM — beyond that the per-item answer degrades. */}
        {selectedNmIds.size > 0 && (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white shadow-lg">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-3 text-sm">
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                  {selectedNmIds.size} / {PLAN_MAX_NM}
                </span>
                <span className="text-gray-700">
                  выбрано товаров для плана задач
                </span>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800"
                >
                  <X className="h-3.5 w-3.5" /> очистить
                </button>
              </div>
              <Button variant="primary" size="sm" onClick={openManagerPlan}>
                <Sparkles className="h-4 w-4" />
                Сформировать план для менеджера
              </Button>
            </div>
          </div>
        )}

        {selectionLimitToast && (
          <div className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">
            Максимум {PLAN_MAX_NM} товаров за раз — сузь фильтр и запусти ещё один план.
          </div>
        )}
      </div>
    </AppShell>
  );
}
