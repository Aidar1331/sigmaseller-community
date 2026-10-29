'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useIsMobile } from '@/hooks/useMediaQuery';

import { useWorkspaceStore } from '@/store/workspace';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { EventEditModal, type EventEditData } from '@/components/pulse/EventEditModal';
import { CardChangeTimelineWidget } from '@/components/kanban/CardChangeTimelineWidget';
import { NmIdLink, nmIdHref } from '@/components/ui/NmIdLink';
import {
  Plus, Calendar, CheckSquare, Bell, AlertTriangle, FileText,
  Clock, User, Tag, ChevronRight, Check, X, MoreHorizontal,
  ListTodo, Columns, CalendarDays, BarChart3, Send, Pencil,
  ExternalLink
} from 'lucide-react';
import { AiAnalyzeButton } from '@/components/ai';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

type EventRow = {
  eventId: number;
  nmId?: number | null;
  date: string;
  time?: string | null;
  type: string;
  category?: string | null;
  severity?: string | null;
  priority?: string | null;
  status: string;
  title: string;
  description?: string | null;
  tags?: string[];
  assigneeId?: number | null;
  dueAt?: string | null;
  reminderAt?: string | null;
  parentEventId?: number | null;
  source?: string | null;
  shopId?: number | null;
  evidence?: { changes?: string[]; date?: string } | null;
};

type CountRow = { alerts: number; logs: number; tasks: number; reminders: number };

type ViewMode = 'calendar' | 'tasks' | 'list' | 'timeline' | 'summary';

function ymd(d: Date) {
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0"); return `${y}-${m}-${day}`;
}

function monthLabel(d: Date) {
  return d.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
}

const priorityColors: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  low: 'bg-green-100 text-green-700 border-green-200',
};

const typeIcons: Record<string, any> = {
  task: CheckSquare,
  alert: AlertTriangle,
  reminder: Bell,
  log: FileText,
  note: FileText,
};

export default function EventsPage() {
  const storeWorkspaceId = useWorkspaceStore((s) => s.workspaceId);
  const activeShopId = useWorkspaceStore((s) => s.shopId);
  const workspaceId = storeWorkspaceId ?? 0;
  const [viewMode, setViewMode] = useState<ViewMode>('tasks');
  const [kanbanMobileTab, setKanbanMobileTab] = useState<'open' | 'ack' | 'done'>('open');
  const isMobile = useIsMobile();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const [countsByDate, setCountsByDate] = useState<Record<string, CountRow>>({});
  const [selectedDate, setSelectedDate] = useState<string>(() => ymd(new Date()));
  const [events, setEvents] = useState<EventRow[]>([]);
  const [tasks, setTasks] = useState<{ open: EventRow[]; ack: EventRow[]; done: EventRow[] }>({ open: [], ack: [], done: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedNmId, setSelectedNmId] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterPriority, setFilterPriority] = useState('');

  // Summary tab data
  const [summaryData, setSummaryData] = useState<{
    kpis: { ordersCount: number; salesRub: number; advSpendRub: number; drrPercent: number; marginRub: number } | null;
    openTasks: EventRow[];
    overdueTasks: EventRow[];
  }>({ kpis: null, openTasks: [], overdueTasks: [] });
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryTelegramId, setSummaryTelegramId] = useState('');
  const [sendingReport, setSendingReport] = useState(false);

  // Create event modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newEvent, setNewEvent] = useState({
    title: '',
    description: '',
    type: 'task',
    priority: 'medium',
    date: ymd(new Date()),
    time: '',
    dueAt: '',
    reminderAt: '',
    nmId: '',
    tags: '',
  });
  const [creating, setCreating] = useState(false);

  // Edit event modal
  const [editData, setEditData] = useState<EventEditData | null>(null);

  // Timeline drill-down: which (date, category) cell is currently expanded
  const [timelineDrill, setTimelineDrill] = useState<{ date: string; category: string; label: string; color: string } | null>(null);

  const { startDate, endDate, days } = useMemo(() => {
    const year = month.getUTCFullYear();
    const mon = month.getUTCMonth();
    const start = new Date(Date.UTC(year, mon, 1));
    const end = new Date(Date.UTC(year, mon + 1, 0));
    const totalDays = end.getUTCDate();
    return {
      startDate: ymd(start),
      endDate: ymd(end),
      days: totalDays,
    };
  }, [month]);

  const firstDow = useMemo(() => {
    const d = new Date(`${startDate}T00:00:00Z`);
    return (d.getUTCDay() + 6) % 7;
  }, [startDate]);

  // Build &shopId= suffix when a specific shop is selected; the backend
  // `buildShopFilter` already handles shopId=undefined as "all shops" so we
  // simply omit the param when activeShopId is null.
  const shopParam = activeShopId ? `&shopId=${activeShopId}` : '';

  // Load calendar counts
  useEffect(() => {
    async function loadCounts() {
      try {
        const res = (await apiFetch(
          `/events/${workspaceId}/counts?start=${startDate}&end=${endDate}${shopParam}`
        )) as { byDate: Record<string, CountRow> };
        setCountsByDate(res.byDate ?? {});
      } catch (e) {
        console.error('Failed to load event counts:', e);
        setCountsByDate({});
      }
    }
    loadCounts();
  }, [workspaceId, startDate, endDate, shopParam]);

  // Load events for selected date
  const loadEvents = useCallback(async () => {
    if (viewMode !== 'calendar' && viewMode !== 'list' && viewMode !== 'timeline') return;
    setLoading(true);
    try {
      let url: string;
      if (viewMode === 'timeline') {
        const from = new Date(); from.setDate(from.getDate() - 30);
        const to = new Date(); to.setDate(to.getDate() + 30);
        url = `/events/${workspaceId}?from=${ymd(from)}&to=${ymd(to)}&limit=500${shopParam}`;
      } else {
        url = `/events/${workspaceId}?date=${selectedDate}${shopParam}`;
        if (filterType) url += `&types=${filterType}`;
      }
      const res = (await apiFetch(url)) as { rows: EventRow[] };
      setEvents(res.rows ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedDate, filterType, viewMode, shopParam]);

  // Load tasks for kanban
  const loadTasks = useCallback(async () => {
    if (viewMode !== 'tasks') return;
    setLoading(true);
    try {
      let url = `/events/${workspaceId}/tasks?includeDone=1${shopParam}`;
      if (filterPriority) url += `&priority=${filterPriority}`;
      const res = (await apiFetch(url)) as { byStatus: typeof tasks };
      setTasks(res.byStatus ?? { open: [], ack: [], done: [] });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filterPriority, viewMode, shopParam]);

  // Load summary data
  const loadSummary = useCallback(async () => {
    if (viewMode !== 'summary') return;
    setSummaryLoading(true);
    try {
      const today = ymd(new Date());
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 6);
      const from = ymd(weekAgo);
      
      // Load morning report data
      const reportRes = await apiFetch(`/reports/${workspaceId}/morning?date=${today}`) as any;
      
      // Load pulse KPIs
      let kpis = null;
      try {
        const pulseRes = await apiFetch(`/pulse/${workspaceId}/overview?from=${from}&to=${today}`) as any;
        kpis = pulseRes.kpis || null;
      } catch (e) { console.error('Pulse KPIs unavailable:', e); }
      
      setSummaryData({
        kpis,
        openTasks: reportRes.openItems?.filter((i: any) => i.type === 'task' && i.status === 'open') ?? [],
        // AUDIT-04 fix: exclude completed tasks (status='done'/'resolved') even
        // if their dueAt has passed — they're not "просрочены", they're done.
        overdueTasks: reportRes.openItems?.filter(
          (i: any) =>
            i.dueAt &&
            new Date(i.dueAt) < new Date() &&
            i.status !== 'done' &&
            i.status !== 'resolved',
        ) ?? [],
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSummaryLoading(false);
    }
  }, [workspaceId, viewMode]);

  // Send report to Telegram
  const sendReportToTelegram = async () => {
    if (!summaryTelegramId.trim()) return;
    setSendingReport(true);
    try {
      await apiFetch(`/reports/${workspaceId}/morning/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: summaryTelegramId }),
      });
      alert('Отчёт отправлен!');
    } catch (e: any) {
      alert(`Ошибка: ${e.message}`);
    } finally {
      setSendingReport(false);
    }
  };

  useEffect(() => {
    loadEvents();
    loadTasks();
    loadSummary();
  }, [loadEvents, loadTasks, loadSummary]);
  useShopChange(loadEvents);

  const onCreate = async () => {
    if (!newEvent.title.trim()) return;
    setCreating(true);
    try {
      const body: any = {
        title: newEvent.title,
        description: newEvent.description || undefined,
        type: newEvent.type,
        priority: newEvent.priority,
        date: newEvent.date,
        time: newEvent.time || undefined,
        dueAt: newEvent.dueAt || undefined,
        reminderAt: newEvent.reminderAt || undefined,
        tags: newEvent.tags ? newEvent.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      };
      // shopId привязывает событие/задачу к текущему магазину — иначе GET tasks?shopId=N
      // не покажет её обратно (фильтр строгий на shop_id).
      if (activeShopId) body.shopId = activeShopId;
      const nmIdNum = Number.parseInt(newEvent.nmId, 10);
      if (Number.isFinite(nmIdNum) && nmIdNum > 0) body.nmId = nmIdNum;

      const qs = activeShopId ? `?shopId=${activeShopId}` : '';
      await apiFetch(`/events/${workspaceId}${qs}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });

      setShowCreateModal(false);
      setNewEvent({
        title: '', description: '', type: 'task', priority: 'medium',
        date: ymd(new Date()), time: '', dueAt: '', reminderAt: '', nmId: '', tags: '',
      });
      loadEvents();
      loadTasks();
    } catch (e: any) {
      // Без catch'а раньше при 4xx модалка не закрывалась и юзер думал «не сохранилось»
      // молча. Теперь показываем явное сообщение.
      // eslint-disable-next-line no-alert
      alert(`Не удалось создать задачу: ${e?.message ?? e}`);
    } finally {
      setCreating(false);
    }
  };

  const onStatusChange = async (eventId: number, status: string) => {
    try {
      await apiFetch(`/events/${workspaceId}/${eventId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось обновить статус');
      return;
    }
    await Promise.all([loadEvents(), loadTasks(), loadSummary()]);
  };

  const openEditModal = (event: EventRow) => {
    setEditData({
      eventId: event.eventId,
      date: event.date,
      time: event.time ?? '',
      category: event.category ?? '',
      severity: event.severity ?? '',
      title: event.title,
      description: event.description ?? '',
      dueAt: event.dueAt ? event.dueAt.slice(0, 16) : '',
      nmId: event.nmId ?? null,
      evidence: (event.evidence as Record<string, unknown> | null) ?? null,
    });
  };

  const onSaveEdit = async () => {
    if (!editData) return;
    try {
      await apiFetch(`/events/${workspaceId}/${editData.eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: editData.title,
          description: editData.description || undefined,
          date: editData.date,
          time: editData.time || undefined,
          category: editData.category || undefined,
          severity: editData.severity || undefined,
          dueAt: editData.dueAt || undefined,
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      setEditData(null);
      await Promise.all([loadEvents(), loadTasks()]);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось сохранить');
    }
  };

  const renderCalendarDay = (day: number) => {
    const dateStr = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const counts = countsByDate[dateStr];
    const isSelected = dateStr === selectedDate;
    const isToday = dateStr === ymd(new Date());

    const handleDateClick = () => {
      setSelectedDate(dateStr);
    };

    const handleDateDoubleClick = () => {
      // Double click — open create modal with this date
      setNewEvent((n) => ({ ...n, date: dateStr }));
      setShowCreateModal(true);
    };

    return (
      <button
        key={day}
        onClick={handleDateClick}
        onDoubleClick={handleDateDoubleClick}
        className={cn(
          'h-12 sm:h-16 p-1 text-left border border-gray-100 hover:bg-gray-50 transition-colors relative',
          isSelected && 'bg-indigo-50 border-indigo-200',
          isToday && !isSelected && 'bg-yellow-50'
        )}
      >
        <div className={cn(
          'text-xs font-medium',
          isToday && 'text-indigo-600',
          isSelected && 'text-indigo-700'
        )}>
          {day}
        </div>
        {counts && (
          <div className="absolute bottom-1 left-1 right-1 flex gap-0.5">
            {counts.tasks > 0 && (
              <div className="w-2 h-2 rounded-full bg-blue-500" title={`${counts.tasks} задач`} />
            )}
            {counts.alerts > 0 && (
              <div className="w-2 h-2 rounded-full bg-red-500" title={`${counts.alerts} алертов`} />
            )}
            {counts.logs > 0 && (
              <div className="w-2 h-2 rounded-full bg-gray-400" title={`${counts.logs} логов`} />
            )}
          </div>
        )}
      </button>
    );
  };

  const renderEventCard = (event: EventRow, compact = false) => {
    const Icon = typeIcons[event.type] || FileText;
    const priorityClass = priorityColors[event.priority ?? 'medium'];

    // Изменения карточки — отдельный богатый виджет с diff-view
    if (event.category === 'card_change') {
      return (
        <div key={event.eventId} className={compact ? '' : 'mb-2'}>
          <CardChangeTimelineWidget
            event={{
              eventId: event.eventId,
              workspaceId,
              shopId: event.shopId ?? null,
              nmId: event.nmId ?? null,
              title: event.title,
              description: event.description ?? null,
              severity: event.severity ?? 'minor',
              evidence: event.evidence ?? null,
            }}
          />
        </div>
      );
    }

    return (
      <div
        key={event.eventId}
        className={cn(
          'rounded-lg border p-3 bg-white shadow-sm cursor-pointer hover:ring-1 hover:ring-indigo-300 transition-shadow',
          priorityClass,
          compact && 'p-2'
        )}
        onClick={() => openEditModal(event)}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <Icon className={cn('h-4 w-4 mt-0.5 flex-shrink-0',
              event.type === 'alert' && 'text-red-500',
              event.type === 'task' && 'text-blue-500',
              event.type === 'reminder' && 'text-purple-500'
            )} />
            <div className="min-w-0">
              <div className={cn('font-medium text-gray-900', compact ? 'text-xs' : 'text-sm')}>
                {event.title}
              </div>
              {!compact && event.description && (
                <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                  {event.description}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {event.dueAt && (
                  <span className="text-xs text-gray-500 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(event.dueAt).toLocaleDateString()}
                  </span>
                )}
                {event.tags && event.tags.length > 0 && (
                  <div className="flex gap-1">
                    {event.tags.slice(0, 2).map((tag, i) => (
                      <Badge key={i} variant="neutral" size="sm">{tag}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-1">
            {event.nmId ? (
              <a
                href={nmIdHref(event.nmId)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="p-1 rounded hover:bg-blue-100 text-blue-600"
                title={`Открыть карточку ${event.nmId} на WB`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
            {event.type === 'task' && event.status !== 'done' && (
              <button
                onClick={(e) => { e.stopPropagation(); onStatusChange(event.eventId, 'done'); }}
                className="p-1 rounded hover:bg-green-100 text-green-700"
                title="Выполнено"
              >
                <Check className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); openEditModal(event); }}
              className="p-1 rounded hover:bg-gray-100 text-gray-500"
              title="Редактировать"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderTaskColumn = (title: string, items: EventRow[], status: string) => (
    <div className="flex-1 min-w-[280px] bg-gray-50 rounded-lg p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-gray-700 text-sm">{title}</h3>
        <Badge variant="neutral" size="sm">{items.length}</Badge>
      </div>
      <div className="space-y-2">
        {items.map((event) => renderEventCard(event, true))}
        {items.length === 0 && (
          <div className="text-xs text-gray-500 text-center py-4">
            Нет задач
          </div>
        )}
      </div>
    </div>
  );

  return (
    <AppShell title="Канбан">
      <div className="space-y-4">
        {/* Header */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setViewMode('tasks')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  viewMode === 'tasks' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
                )}
              >
                <Columns className="h-4 w-4" />
                Kanban
              </button>
              <button
                onClick={() => setViewMode('calendar')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  viewMode === 'calendar' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
                )}
              >
                <CalendarDays className="h-4 w-4" />
                Календарь
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  viewMode === 'list' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
                )}
              >
                <ListTodo className="h-4 w-4" />
                Список
              </button>
              <button
                onClick={() => setViewMode('timeline')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  viewMode === 'timeline' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
                )}
              >
                <Columns className="h-4 w-4" />
                Календарь событий
              </button>
              <button
                onClick={() => setViewMode('summary')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  viewMode === 'summary' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
                )}
              >
                <BarChart3 className="h-4 w-4" />
                Сводка
              </button>
            </div>

            <div className="flex items-center gap-2">
              {viewMode === 'tasks' && (
                <select
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  value={filterPriority}
                  onChange={(e) => setFilterPriority(e.target.value)}
                >
                  <option value="">Все приоритеты</option>
                  <option value="urgent">🔴 Срочно</option>
                  <option value="high">🟠 Высокий</option>
                  <option value="medium">🟡 Средний</option>
                  <option value="low">🟢 Низкий</option>
                </select>
              )}
              <Button variant="primary" size="sm" onClick={() => {
                setNewEvent(n => ({ ...n, date: selectedDate }));
                setShowCreateModal(true);
              }}>
                <Plus className="h-4 w-4" />
                Создать
              </Button>
            </div>
          </div>
        </Card>

        {/* Calendar View */}
        {viewMode === 'calendar' && (
          <div className="grid md:grid-cols-[1fr,300px] gap-4">
            <Card className="p-4">
              <div className="flex items-center justify-between mb-4 gap-2">
                <button
                  className="h-10 w-10 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 active:bg-gray-100 flex items-center justify-center text-lg"
                  onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))}
                  aria-label="Предыдущий месяц"
                >
                  ←
                </button>
                <select
                  className="flex-1 h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm font-medium text-gray-900 focus:border-indigo-500 focus:outline-none text-center"
                  value={`${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`}
                  onChange={(e) => {
                    const [y, m] = e.target.value.split('-').map(Number);
                    setMonth(new Date(Date.UTC(y, (m ?? 1) - 1, 1)));
                  }}
                >
                  {(() => {
                    const opts: { val: string; label: string }[] = [];
                    const now = new Date();
                    for (let i = 12; i >= -3; i--) {
                      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
                      const val = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
                      const label = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                      opts.push({ val, label });
                    }
                    return opts.map((o) => <option key={o.val} value={o.val}>{o.label}</option>);
                  })()}
                </select>
                <button
                  className="h-10 w-10 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 active:bg-gray-100 flex items-center justify-center text-lg"
                  onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))}
                  aria-label="Следующий месяц"
                >
                  →
                </button>
              </div>
              <div className="overflow-x-auto">
                <div className="grid grid-cols-7 gap-0 min-w-[420px]">
                  {WEEKDAYS.map((d) => (
                    <div key={d} className="text-xs font-medium text-gray-500 text-center py-2">
                      {d}
                    </div>
                  ))}
                  {Array.from({ length: firstDow }).map((_, i) => (
                    <div key={`empty-${i}`} className="h-12 sm:h-16 border border-gray-50" />
                  ))}
                  {Array.from({ length: days }, (_, i) => renderCalendarDay(i + 1))}
                </div>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-medium text-gray-900 mb-3">
                {new Date(selectedDate).toLocaleDateString('ru-RU', { 
                  day: 'numeric', month: 'long', year: 'numeric' 
                })}
              </h3>
              <div className="space-y-2">
                {loading && <div className="text-sm text-gray-500">Загрузка...</div>}
                {!loading && events.map((event) => renderEventCard(event))}
                {!loading && events.length === 0 && (
                  <div className="text-sm text-gray-500 text-center py-4">
                    Нет событий
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}

        {/* Tasks Kanban View */}
        {viewMode === 'tasks' && (
          <>
            {/* На mobile: tabs + одна колонка (3 в ряд не помещаются на 390px).
                На desktop: все 3 колонки horizontal flex. */}
            {isMobile ? (
              <div className="space-y-3">
                <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1">
                  {[
                    { key: 'open' as const, label: '📋 Открытые', count: tasks.open.length },
                    { key: 'ack' as const, label: '🔄 В работе', count: tasks.ack.length },
                    { key: 'done' as const, label: '✅ Готово', count: tasks.done.length },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setKanbanMobileTab(t.key)}
                      className={cn(
                        'flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors min-h-[44px]',
                        kanbanMobileTab === t.key
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-gray-500 hover:bg-gray-50',
                      )}
                    >
                      {t.label}
                      <span className="ml-1 text-[10px] opacity-70">{t.count}</span>
                    </button>
                  ))}
                </div>
                {kanbanMobileTab === 'open' && renderTaskColumn('📋 Открытые', tasks.open, 'open')}
                {kanbanMobileTab === 'ack' && renderTaskColumn('🔄 В работе', tasks.ack, 'ack')}
                {kanbanMobileTab === 'done' && renderTaskColumn('✅ Выполнено', tasks.done, 'done')}
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-4">
                {renderTaskColumn('📋 Открытые', tasks.open, 'open')}
                {renderTaskColumn('🔄 В работе', tasks.ack, 'ack')}
                {renderTaskColumn('✅ Выполнено', tasks.done, 'done')}
              </div>
            )}
          </>
        )}

        {/* List View */}
        {viewMode === 'list' && (
          <Card className="p-4">
            <div className="flex items-center gap-3 mb-4">
              <select
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
              >
                <option value="">Все типы</option>
                <option value="task">📋 Задачи</option>
                <option value="log">📝 События</option>
                <option value="reminder">🔔 Напоминания</option>
              </select>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-auto"
              />
            </div>
            <div className="space-y-2">
              {loading && <div className="text-sm text-gray-500">Загрузка...</div>}
              {!loading && events.map((event) => renderEventCard(event))}
              {!loading && events.length === 0 && (
                <div className="text-sm text-gray-500 text-center py-8">
                  Нет событий за выбранную дату
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Timeline View (Gantt-like) */}
        {viewMode === 'timeline' && (() => {
          const today = new Date();
          const start = new Date(today);
          start.setDate(start.getDate() - 30);
          const end = new Date(today);
          end.setDate(end.getDate() + 30);
          const totalDays = Math.ceil((end.getTime() - start.getTime()) / 86400000);
          const days: string[] = [];
          for (let i = 0; i < totalDays; i++) {
            const d = new Date(start);
            d.setDate(d.getDate() + i);
            days.push(ymd(d));
          }

          const categories = [
            { key: 'price', label: 'Изменение цены', color: '#f59e0b' },
            { key: 'card', label: 'Карточка товара', color: '#8b5cf6' },
            { key: 'promo', label: 'Акции', color: '#10b981' },
            { key: 'review', label: 'Отзывы', color: '#3b82f6' },
            { key: 'stock', label: 'Остатки', color: '#ef4444' },
            { key: 'ads', label: 'Реклама', color: '#f97316' },
            { key: 'sales', label: 'Продажи / Маржа', color: '#0ea5e9' },
            { key: 'other', label: 'Другое', color: '#6b7280' },
          ];

          // Map legacy / aliased category values from backend to the UI keys above.
          // `card_change` is the legacy form used by CardChangeTimelineWidget rows.
          const CATEGORY_ALIAS: Record<string, string> = {
            card_change: 'card',
          };

          const eventsByCategory = new Map<string, Map<string, EventRow[]>>();
          categories.forEach(c => eventsByCategory.set(c.key, new Map()));
          events.forEach(ev => {
            const rawCat = ev.category ?? ev.type ?? 'other';
            const cat = CATEGORY_ALIAS[rawCat] ?? rawCat;
            // Unknown categories → dedicated "Другое" bucket (AUDIT-02 fix)
            const map = eventsByCategory.get(cat) ?? eventsByCategory.get('other')!;
            const dateKey = ev.date;
            if (!map.has(dateKey)) map.set(dateKey, []);
            map.get(dateKey)!.push(ev);
          });

          const todayStr = ymd(today);
          const dayWidth = 32;

          // Per-category totals + max intensity for heatmap opacity scaling
          const categoryStats = categories.map(cat => {
            const dayMap = eventsByCategory.get(cat.key)!;
            let total = 0;
            let max = 0;
            for (const evs of dayMap.values()) {
              total += evs.length;
              if (evs.length > max) max = evs.length;
            }
            return { ...cat, total, max };
          });

          // Heatmap opacity: linear scale from 0.3 (1 event) to 1.0 (max). Empty = 0.
          const cellOpacity = (count: number, maxInRow: number): number => {
            if (count <= 0) return 0;
            if (maxInRow <= 1) return 0.8;
            return 0.3 + 0.7 * Math.min(1, (count - 1) / (maxInRow - 1));
          };

          const grandTotal = categoryStats.reduce((s, c) => s + c.total, 0);
          const drillEvents = timelineDrill
            ? (eventsByCategory.get(timelineDrill.category)?.get(timelineDrill.date) ?? [])
            : [];

          return (
            <div className="space-y-3">
              <Card className="p-4 overflow-x-auto">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-sm">Календарь событий</h3>
                    <Badge variant="neutral" size="sm">всего за окно: {grandTotal}</Badge>
                  </div>
                  <span className="text-xs text-[var(--content-muted)]">
                    {start.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' })} — {end.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <div style={{ minWidth: totalDays * dayWidth + 200 }}>
                  {/* Date header */}
                  <div className="flex border-b border-[var(--table-border)]">
                    <div className="w-[200px] shrink-0 text-xs font-medium text-[var(--content-muted)] p-2">Событие</div>
                    {days.map(d => {
                      const date = new Date(d + 'T00:00:00');
                      const isToday = d === todayStr;
                      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                      return (
                        <div
                          key={d}
                          className={cn(
                            'text-center text-[10px] p-1 shrink-0',
                            isToday ? 'bg-indigo-100 font-bold text-indigo-700 rounded' : isWeekend ? 'text-gray-300' : 'text-gray-500'
                          )}
                          style={{ width: dayWidth }}
                        >
                          {date.getDate()}
                        </div>
                      );
                    })}
                  </div>

                  {/* Category rows */}
                  {categoryStats.map(cat => {
                    const dayMap = eventsByCategory.get(cat.key)!;
                    return (
                      <div key={cat.key} className="flex border-b border-[var(--table-border)] hover:bg-[var(--bg-subtle)]">
                        <div className="w-[200px] shrink-0 text-xs text-[var(--content-text)] p-2 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: cat.color }} />
                            <span className="truncate">{cat.label}</span>
                          </div>
                          <span className="text-[10px] text-[var(--content-muted)] tabular-nums shrink-0">
                            {cat.total}
                          </span>
                        </div>
                        {days.map(d => {
                          const evts = dayMap.get(d);
                          const cnt = evts?.length ?? 0;
                          const isOpen = timelineDrill?.date === d && timelineDrill?.category === cat.key;
                          return (
                            <div
                              key={d}
                              className="shrink-0 flex items-center justify-center"
                              style={{ width: dayWidth, minHeight: 28 }}
                              title={evts ? evts.map(e => e.title).slice(0, 5).join('\n') + (evts.length > 5 ? `\n... и ещё ${evts.length - 5}` : '') : undefined}
                            >
                              {cnt > 0 && (
                                <button
                                  type="button"
                                  className={cn(
                                    'w-6 h-6 rounded text-[10px] font-semibold flex items-center justify-center text-white cursor-pointer transition-all',
                                    isOpen && 'ring-2 ring-offset-1 ring-indigo-500'
                                  )}
                                  style={{
                                    background: cat.color,
                                    opacity: cellOpacity(cnt, cat.max),
                                  }}
                                  onClick={() => {
                                    if (isOpen) {
                                      setTimelineDrill(null);
                                    } else {
                                      setTimelineDrill({ date: d, category: cat.key, label: cat.label, color: cat.color });
                                    }
                                  }}
                                >
                                  {cnt}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* Drill-down for selected (date, category) cell */}
              {timelineDrill && (
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ background: timelineDrill.color }} />
                      <h4 className="font-medium text-sm">
                        {timelineDrill.label} · {new Date(timelineDrill.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </h4>
                      <Badge variant="neutral" size="sm">{drillEvents.length}</Badge>
                    </div>
                    <button
                      onClick={() => setTimelineDrill(null)}
                      className="p-1 rounded hover:bg-gray-100 text-gray-500"
                      title="Закрыть"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {drillEvents.length === 0 ? (
                      <div className="text-sm text-gray-500 text-center py-4">
                        Нет событий в этой ячейке
                      </div>
                    ) : (
                      drillEvents.map((event) => renderEventCard(event))
                    )}
                  </div>
                </Card>
              )}
            </div>
          );
        })()}

        {/* Summary View */}
        {viewMode === 'summary' && (
          <div className="space-y-4">
            {/* Header with Telegram send */}
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Telegram chat id или @username"
                  value={summaryTelegramId}
                  onChange={(e) => setSummaryTelegramId(e.target.value)}
                  className="max-w-[280px]"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={sendReportToTelegram}
                  loading={sendingReport}
                  disabled={!summaryTelegramId.trim()}
                >
                  <Send className="h-4 w-4 mr-1" />
                  Отправить в Telegram
                </Button>
              </div>
            </Card>

            {/* KPI Cards */}
            {summaryLoading ? (
              <div className="text-sm text-gray-500">Загрузка...</div>
            ) : summaryData.kpis ? (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <Card className="p-3">
                  <div className="text-xs text-gray-500">Заказы (7 дней)</div>
                  <div className="text-lg font-semibold">{summaryData.kpis.ordersCount?.toLocaleString('ru-RU') ?? '—'}</div>
                </Card>
                <Card className="p-3">
                  <div className="text-xs text-gray-500">Продажи</div>
                  <div className="text-lg font-semibold">{summaryData.kpis.salesRub?.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) ?? '—'} ₽</div>
                </Card>
                <Card className="p-3">
                  <div className="text-xs text-gray-500">Расход на рекламу</div>
                  <div className="text-lg font-semibold">{summaryData.kpis.advSpendRub?.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) ?? '—'} ₽</div>
                </Card>
                <Card className="p-3">
                  <div className="text-xs text-gray-500">ДРР</div>
                  <div className="text-lg font-semibold">{summaryData.kpis.drrPercent?.toFixed(1) ?? '—'}%</div>
                </Card>
                <Card className="p-3">
                  <div className="text-xs text-gray-500">Маржа</div>
                  <div className="text-lg font-semibold">{summaryData.kpis.marginRub?.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) ?? '—'} ₽</div>
                </Card>
              </div>
            ) : (
              <Card className="p-4 text-center text-sm text-gray-500">
                Нет данных о метриках
              </Card>
            )}

            {/* Open Tasks */}
            <Card className="p-4">
              <div className="text-sm font-semibold mb-3">📋 Открытые задачи ({summaryData.openTasks.length})</div>
              {summaryData.openTasks.length === 0 ? (
                <div className="text-sm text-gray-500">Нет открытых задач</div>
              ) : (
                <div className="space-y-2">
                  {summaryData.openTasks.slice(0, 10).map((task) => (
                    <div key={task.eventId} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-gray-100">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{task.title}</div>
                        {task.dueAt && <div className="text-xs text-gray-500">Срок: {task.dueAt}</div>}
                        {task.nmId && (
                          <div className="text-xs mt-0.5">
                            <NmIdLink nmId={task.nmId} className="text-blue-600 hover:underline">
                              Открыть {task.nmId} на WB ↗
                            </NmIdLink>
                          </div>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="neutral"
                        onClick={() => onStatusChange(task.eventId, 'done')}
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  {summaryData.openTasks.length > 10 && (
                    <div className="text-xs text-gray-500 text-center">
                      ... и ещё {summaryData.openTasks.length - 10}
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* Overdue Tasks */}
            {summaryData.overdueTasks.length > 0 && (
              <Card className="p-4 border-red-200 bg-red-50">
                <div className="text-sm font-semibold text-red-700 mb-3">⚠️ Просроченные задачи ({summaryData.overdueTasks.length})</div>
                <div className="space-y-2">
                  {summaryData.overdueTasks.map((task) => (
                    <div key={task.eventId} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-red-200 bg-white">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{task.title}</div>
                        {task.dueAt && <div className="text-xs text-red-600">Просрочено: {task.dueAt}</div>}
                        {task.nmId && (
                          <div className="text-xs mt-0.5">
                            <NmIdLink nmId={task.nmId} className="text-blue-600 hover:underline">
                              Открыть {task.nmId} на WB ↗
                            </NmIdLink>
                          </div>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="neutral"
                        onClick={() => onStatusChange(task.eventId, 'done')}
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* Create Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <Card className="w-full max-w-lg p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium">Создать событие</h2>
                <button onClick={() => setShowCreateModal(false)} className="text-gray-500 hover:text-gray-600">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-sm text-gray-600">Заголовок *</label>
                  <Input
                    value={newEvent.title}
                    onChange={(e) => setNewEvent(n => ({ ...n, title: e.target.value }))}
                    placeholder="Что нужно сделать?"
                    className="mt-1"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-gray-600">Тип</label>
                    <select
                      className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      value={newEvent.type}
                      onChange={(e) => setNewEvent(n => ({ ...n, type: e.target.value }))}
                    >
                      <option value="task">📋 Задача</option>
                      <option value="log">📝 Событие</option>
                      <option value="reminder">🔔 Напоминание</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-600">Приоритет</label>
                    <select
                      className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      value={newEvent.priority}
                      onChange={(e) => setNewEvent(n => ({ ...n, priority: e.target.value }))}
                    >
                      <option value="low">🟢 Низкий</option>
                      <option value="medium">🟡 Средний</option>
                      <option value="high">🟠 Высокий</option>
                      <option value="urgent">🔴 Срочно</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-gray-600">Дата</label>
                    <Input
                      type="date"
                      value={newEvent.date}
                      onChange={(e) => setNewEvent(n => ({ ...n, date: e.target.value }))}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-gray-600">Дедлайн</label>
                    <Input
                      type="datetime-local"
                      value={newEvent.dueAt}
                      onChange={(e) => setNewEvent(n => ({ ...n, dueAt: e.target.value }))}
                      className="mt-1"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm text-gray-600">Напомнить</label>
                  <Input
                    type="datetime-local"
                    value={newEvent.reminderAt}
                    onChange={(e) => setNewEvent(n => ({ ...n, reminderAt: e.target.value }))}
                    className="mt-1"
                    placeholder="Когда напомнить?"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600">Описание</label>
                  <Textarea
                    rows={3}
                    value={newEvent.description}
                    onChange={(e) => setNewEvent(n => ({ ...n, description: e.target.value }))}
                    placeholder="Подробности..."
                    className="mt-1"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600">Теги (через запятую)</label>
                  <Input
                    value={newEvent.tags}
                    onChange={(e) => setNewEvent(n => ({ ...n, tags: e.target.value }))}
                    placeholder="важное, срочно, склад"
                    className="mt-1"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600">Привязка к товару</label>
                  <ProductSearchInput
                    workspaceId={workspaceId}
                    value={newEvent.nmId}
                    onChange={(v) => setNewEvent(n => ({ ...n, nmId: v }))}
                    placeholder="Поиск товара..."
                    single
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="neutral" onClick={() => setShowCreateModal(false)}>
                  Отмена
                </Button>
                <Button variant="primary" onClick={onCreate} loading={creating}>
                  Создать
                </Button>
              </div>
            </Card>
          </div>
        )}
        {/* Edit Modal */}
        <EventEditModal
          open={!!editData}
          data={editData}
          onChange={(update) => setEditData((prev) => prev ? { ...prev, ...update } : prev)}
          onSave={onSaveEdit}
          onClose={() => setEditData(null)}
        />

        {/* AI Analyze Button */}
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-30">
          <AiAnalyzeButton
            context={{ page: 'events', month: ymd(month) }}
            prompt="Проанализируй события и задачи"
          />
        </div>
      </div>
    </AppShell>
  );
}
