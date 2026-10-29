'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { NmIdLink } from '@/components/ui/NmIdLink';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';
import { cn } from '@/lib/cn';
import {
  AlertTriangle,
  FileText,
  CheckSquare,
  Plus,
  Search,
  Bell,
  Calendar,
  Clock,
  X,
} from 'lucide-react';

type EventRow = {
  eventId: number;
  workspaceId: number;
  nmId: number | null;
  eventDate: string;
  type: 'alert' | 'log' | 'task';
  severity: 'info' | 'warn' | 'critical';
  title: string;
  description: string | null;
  status: 'open' | 'ack' | 'resolved' | 'done';
  dueAt: string | null;
  createdAt: string;
};

const TYPE_ICONS: Record<string, typeof AlertTriangle> = {
  alert: AlertTriangle,
  log: FileText,
  task: CheckSquare,
};

const TYPE_LABELS: Record<string, string> = {
  alert: 'Уведомление',
  log: 'Событие',
  task: 'Задача',
};

const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-blue-100 text-blue-700',
  warn: 'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Открыто',
  ack: 'Принято',
  resolved: 'Решено',
  done: 'Готово',
};

function isoDate(d: Date): string {
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0"); return `${y}-${m}-${day}`;
}

export default function EventsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const shopParam = useShopParam();

  const today = useMemo(() => new Date(), []);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return isoDate(d);
  });
  const [dateTo, setDateTo] = useState(() => isoDate(today));

  const [tab, setTab] = useState<'all' | 'alert' | 'log' | 'task'>('all');
  const [search, setSearch] = useState('');

  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    type: 'task' as 'alert' | 'log' | 'task',
    title: '',
    description: '',
    nmId: '',
    severity: 'info' as 'info' | 'warn' | 'critical',
    eventDate: isoDate(today),
    dueAt: '',
  });

  async function loadEvents() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('from', dateFrom);
      qs.set('to', dateTo);
      const res = (await apiFetch(`/events/${workspaceId}?${qs.toString()}${shopParam}`)) as { rows: EventRow[] };
      setEvents(res.rows ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, dateFrom, dateTo, shopParam]);

  useShopChange(loadEvents);

  const filtered = useMemo(() => {
    let list = events;
    if (tab !== 'all') list = list.filter((e) => e.type === tab);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.description ?? '').toLowerCase().includes(q) ||
          String(e.nmId ?? '').includes(q)
      );
    }
    return list.sort((a, b) => (b.eventDate ?? '').localeCompare(a.eventDate ?? '') || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }, [events, tab, search]);

  const counts = useMemo(() => {
    const c = { all: events.length, alert: 0, log: 0, task: 0 };
    for (const e of events) {
      if (e.type === 'alert') c.alert++;
      if (e.type === 'log') c.log++;
      if (e.type === 'task') c.task++;
    }
    return c;
  }, [events]);

  async function createEvent() {
    if (!createForm.title.trim()) return;
    setError(null);
    try {
      await apiFetch(`/events/${workspaceId}${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nmId: createForm.nmId.trim() ? Number(createForm.nmId) : null,
          eventDate: createForm.eventDate,
          type: createForm.type,
          severity: createForm.severity,
          title: createForm.title.trim(),
          description: createForm.description.trim() || null,
          dueAt: createForm.dueAt || null,
        }),
      });
      setShowCreate(false);
      setCreateForm({
        type: 'task',
        title: '',
        description: '',
        nmId: '',
        severity: 'info',
        eventDate: isoDate(today),
        dueAt: '',
      });
      await loadEvents();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function toggleStatus(eventId: number, currentStatus: string) {
    const newStatus = currentStatus === 'done' ? 'open' : 'done';
    try {
      await apiFetch(`/events/${workspaceId}/${eventId}/status${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      setEvents((prev) =>
        prev.map((e) => (e.eventId === eventId ? { ...e, status: newStatus as EventRow['status'] } : e))
      );
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  const inputCls =
    'w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30';

  return (
    <AppShell title="События">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo} />
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--content-muted)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск..."
                className={cn(inputCls, 'pl-8 w-52 h-8 text-xs')}
              />
            </div>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> Добавить
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <ToggleGroup
          type="single"
          value={tab}
          onValueChange={(v) => v && setTab(v as typeof tab)}
        >
          <ToggleGroupItem value="all">
            Все <span className="ml-1 text-[10px] text-[var(--content-muted)]">{counts.all}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="alert">
            <AlertTriangle className="h-3 w-3 mr-1" /> Уведомления <span className="ml-1 text-[10px] text-[var(--content-muted)]">{counts.alert}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="log">
            <FileText className="h-3 w-3 mr-1" /> События <span className="ml-1 text-[10px] text-[var(--content-muted)]">{counts.log}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="task">
            <CheckSquare className="h-3 w-3 mr-1" /> Задачи <span className="ml-1 text-[10px] text-[var(--content-muted)]">{counts.task}</span>
          </ToggleGroupItem>
        </ToggleGroup>

        {error && <div className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 p-3 text-xs text-red-600">{error}</div>}

        {/* Create Modal */}
        {showCreate && (
          <>
            <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setShowCreate(false)} />
            <div className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[90vw] rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[var(--card-border)] px-5 py-3">
                <span className="text-sm font-semibold text-[var(--content-text)]">Новое событие</span>
                <button onClick={() => setShowCreate(false)} className="rounded-md p-1 text-[var(--content-muted)] hover:bg-slate-100">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-5 py-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-medium text-[var(--content-muted)]">
                    Тип
                    <select className={cn(inputCls, 'mt-1')} value={createForm.type} onChange={(e) => setCreateForm((p) => ({ ...p, type: e.target.value as any }))}>
                      <option value="task">Задача</option>
                      <option value="log">Событие</option>
                      <option value="alert">Уведомление</option>
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-[var(--content-muted)]">
                    Важность
                    <select className={cn(inputCls, 'mt-1')} value={createForm.severity} onChange={(e) => setCreateForm((p) => ({ ...p, severity: e.target.value as any }))}>
                      <option value="info">Инфо</option>
                      <option value="warn">Предупреждение</option>
                      <option value="critical">Критичный</option>
                    </select>
                  </label>
                </div>
                <label className="block text-xs font-medium text-[var(--content-muted)]">
                  Заголовок
                  <input className={cn(inputCls, 'mt-1')} value={createForm.title} onChange={(e) => setCreateForm((p) => ({ ...p, title: e.target.value }))} placeholder="Например: Проверить остатки" />
                </label>
                <label className="block text-xs font-medium text-[var(--content-muted)]">
                  Описание
                  <textarea className={cn(inputCls, 'mt-1 h-20 resize-none')} value={createForm.description} onChange={(e) => setCreateForm((p) => ({ ...p, description: e.target.value }))} placeholder="Подробное описание..." />
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="block text-xs font-medium text-[var(--content-muted)]">
                    Артикул WB
                    <input className={cn(inputCls, 'mt-1')} value={createForm.nmId} onChange={(e) => setCreateForm((p) => ({ ...p, nmId: e.target.value }))} placeholder="150816751" />
                  </label>
                  <label className="block text-xs font-medium text-[var(--content-muted)]">
                    Дата
                    <input className={cn(inputCls, 'mt-1')} type="date" value={createForm.eventDate} onChange={(e) => setCreateForm((p) => ({ ...p, eventDate: e.target.value }))} />
                  </label>
                  {createForm.type === 'task' && (
                    <label className="block text-xs font-medium text-[var(--content-muted)]">
                      Срок (дедлайн)
                      <input className={cn(inputCls, 'mt-1')} type="date" value={createForm.dueAt} onChange={(e) => setCreateForm((p) => ({ ...p, dueAt: e.target.value }))} />
                    </label>
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--card-border)] px-5 py-3">
                <Button variant="neutral" onClick={() => setShowCreate(false)}>Отмена</Button>
                <Button onClick={createEvent} disabled={!createForm.title.trim()}>Создать</Button>
              </div>
            </div>
          </>
        )}

        {/* Events Timeline */}
        {loading ? (
          <Card className="p-8">
            <div className="flex items-center justify-center gap-3 text-sm text-[var(--content-muted)]">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
              Загрузка событий...
            </div>
          </Card>
        ) : filtered.length === 0 ? (
          <Card className="p-8">
            <div className="flex flex-col items-center justify-center text-center">
              <Bell className="h-10 w-10 text-[var(--content-muted)]" />
              <p className="mt-3 text-sm text-[var(--content-muted)]">
                {events.length === 0 ? 'Нет событий за выбранный период' : 'Ничего не найдено по вашему запросу'}
              </p>
              <Button variant="neutral" size="sm" className="mt-3" onClick={() => setShowCreate(true)}>
                <Plus className="h-3.5 w-3.5" /> Добавить событие
              </Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {filtered.map((ev) => {
              const Icon = TYPE_ICONS[ev.type] ?? FileText;
              const isTask = ev.type === 'task';
              const isDone = ev.status === 'done';
              const isOverdue = isTask && ev.dueAt && ev.dueAt < isoDate(today) && !isDone;

              return (
                <Card key={ev.eventId} className={cn('p-4', isDone && 'opacity-60')}>
                  <div className="flex items-start gap-3">
                    {/* Task checkbox */}
                    {isTask ? (
                      <button
                        type="button"
                        onClick={() => toggleStatus(ev.eventId, ev.status)}
                        className={cn(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors',
                          isDone
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : 'border-[var(--card-border)] hover:border-indigo-400'
                        )}
                      >
                        {isDone && <CheckSquare className="h-3 w-3" />}
                      </button>
                    ) : (
                      <div className={cn(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                        ev.type === 'alert' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
                      )}>
                        <Icon className="h-3 w-3" />
                      </div>
                    )}

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          'text-sm font-medium text-[var(--content-text)]',
                          isDone && 'line-through'
                        )}>
                          {ev.title}
                        </span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', SEVERITY_COLORS[ev.severity])}>
                          {ev.severity}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                          {STATUS_LABELS[ev.status]}
                        </span>
                      </div>
                      {ev.description && (
                        <p className="mt-1 text-xs text-[var(--content-muted)]">{ev.description}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-[var(--content-muted)]">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {ev.eventDate}
                        </span>
                        {ev.nmId && (
                          <span className="font-mono">арт. <NmIdLink nmId={ev.nmId} /></span>
                        )}
                        <span className="rounded bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium">
                          {TYPE_LABELS[ev.type]}
                        </span>
                        {isTask && ev.dueAt && (
                          <span className={cn('flex items-center gap-1', isOverdue && 'text-red-500 font-medium')}>
                            <Clock className="h-3 w-3" />
                            {isOverdue ? 'Просрочено: ' : 'Срок: '}
                            {ev.dueAt}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {/* Placeholder: Notifications settings link */}
        {tab === 'alert' && (
          <Card className="p-4">
            <div className="text-xs text-[var(--content-muted)]">
              Автоматические уведомления настраиваются через пороги и правила ниже.
              Настройте пороги ДРР, остатков и выкупа для автоматического создания уведомлений.
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
