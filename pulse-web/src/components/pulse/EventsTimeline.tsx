'use client';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Plus, X, AlertTriangle, FileText, CheckSquare } from 'lucide-react';

export type EventsTimelineProps = {
  selectedCell: { date: string; nmId: number };
  timeline: any[];
  timelineLoading: boolean;
  selectedEventId: number | null;
  selectedEvent: any | null;
  eventError: string | null;
  eventComments: any[];
  eventCommentsLoading: boolean;
  eventCommentDraft: string;

  // Filters
  eventTypeFilter: { alert: boolean; log: boolean; task: boolean };
  eventStatusFilter: { open: boolean; ack: boolean; resolved: boolean; done: boolean };
  eventSearch: string;
  eventCategoryFilter: string;
  eventSeverityFilter: string;

  // Panel state
  eventsPanelTab: 'alerts' | 'tasks' | 'logs';
  eventsPanelCategory: string;
  eventsPanelSeverity: string;
  eventsPanelShowOverdueOnly: boolean;
  eventsPanelStatus: { open: boolean; ack: boolean; resolved: boolean; done: boolean };
  eventsPanelQuickComment: string;

  // Actions
  onSelectEventId: (id: number | null) => void;
  onSetEventTypeFilter: (fn: (p: { alert: boolean; log: boolean; task: boolean }) => { alert: boolean; log: boolean; task: boolean }) => void;
  onSetEventStatusFilter: (fn: (p: { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => void;
  onSetEventSearch: (v: string) => void;
  onSetEventCategoryFilter: (v: string) => void;
  onSetEventSeverityFilter: (v: string) => void;
  onSetEventsPanelTab: (v: 'alerts' | 'tasks' | 'logs') => void;
  onSetEventsPanelCategory: (v: string) => void;
  onSetEventsPanelSeverity: (v: string) => void;
  onSetEventsPanelShowOverdueOnly: (v: boolean) => void;
  onSetEventsPanelStatus: (fn: (p: { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => void;
  onSetEventsPanelQuickComment: (v: string) => void;
  onSetEventCommentDraft: (v: string) => void;

  onClose: () => void;
  onAddEvent: (type?: 'alert' | 'log' | 'task') => void;
  onDeleteEvent: (eventId: number) => void;
  onSetEventStatus: (eventId: number, status: 'open' | 'ack' | 'resolved' | 'done') => void;
  onPatchEvent: (eventId: number, patch: any) => void;
  onLoadEventComments: (eventId: number) => void;
  onAddEventComment: (eventId: number, bodyOverride?: string) => void;
  onOpenEditModal: (ev: any) => void;
};

const toggleBtnCls = (active: boolean) =>
  cn(
    'rounded-[var(--radius-sm)] px-2 py-1 text-[11px] font-medium transition-colors',
    active
      ? 'bg-[var(--filter-active-bg)] text-indigo-700 border border-[var(--filter-active-border)]'
      : 'bg-[var(--filter-bg)] text-[var(--content-muted)] border border-[var(--filter-border)] hover:bg-slate-50'
  );

const actionBtnCls = 'rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-[11px] text-[var(--content-text)] hover:bg-slate-50 transition-colors';

function TypeIcon({ type }: { type: string }) {
  if (type === 'alert') return <AlertTriangle className="h-3 w-3 text-red-500" />;
  if (type === 'task') return <CheckSquare className="h-3 w-3 text-violet-500" />;
  return <FileText className="h-3 w-3 text-slate-400" />;
}

export function EventsTimeline(props: EventsTimelineProps) {
  const {
    selectedCell, timeline, timelineLoading, selectedEventId, selectedEvent,
    eventError, eventComments, eventCommentsLoading, eventCommentDraft,
    eventTypeFilter, eventStatusFilter, eventSearch, eventCategoryFilter, eventSeverityFilter,
    eventsPanelTab, eventsPanelCategory, eventsPanelSeverity, eventsPanelShowOverdueOnly,
    eventsPanelStatus, eventsPanelQuickComment,
    onSelectEventId, onSetEventTypeFilter, onSetEventStatusFilter,
    onSetEventSearch, onSetEventCategoryFilter, onSetEventSeverityFilter,
    onSetEventsPanelTab, onSetEventsPanelCategory, onSetEventsPanelSeverity,
    onSetEventsPanelShowOverdueOnly, onSetEventsPanelStatus, onSetEventsPanelQuickComment,
    onSetEventCommentDraft,
    onClose, onAddEvent, onDeleteEvent, onSetEventStatus, onPatchEvent,
    onLoadEventComments, onAddEventComment, onOpenEditModal,
  } = props;

  // Capture current time once per render to avoid impure nowMs calls
  const nowMs = Date.now();

  return (
    <Card className="mt-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--content-text)]">
            События за {selectedCell.date}{selectedCell.nmId > 0 ? ` (артикул ${selectedCell.nmId})` : ' (все товары)'}
          </div>
          <div className="mt-1 text-xs text-[var(--content-muted)]">Кликните по ячейке таблицы чтобы выбрать дату и товар.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-slate-50 p-1 text-[11px]">
              <span className="px-2 text-[var(--content-muted)]">Тип</span>
              {([{ key: 'log' as const, label: 'Событие' }, { key: 'task' as const, label: 'Задача' }]).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={toggleBtnCls(eventTypeFilter[t.key])}
                  onClick={() => onSetEventTypeFilter((p) => ({ ...p, [t.key]: !p[t.key] }))}
                  title={t.label}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-slate-50 p-1 text-[11px]">
              <span className="px-2 text-[var(--content-muted)]">Статус</span>
              {(['open', 'ack', 'resolved', 'done'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={toggleBtnCls(eventStatusFilter[s])}
                  onClick={() => onSetEventStatusFilter((p) => ({ ...p, [s]: !p[s] }))}
                  title={s}
                >
                  {s}
                </button>
              ))}
            </div>

            <Input
              className="h-8 w-44 text-[11px]"
              placeholder="поиск…"
              value={eventSearch}
              onChange={(e) => onSetEventSearch(e.target.value)}
            />

            <select
              className="h-8 w-44 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2 text-[11px] text-[var(--content-text)] outline-none"
              value={eventCategoryFilter}
              onChange={(e) => onSetEventCategoryFilter(e.target.value)}
              title="категория"
            >
              <option value="">все категории</option>
              {Array.from(new Set((timeline ?? []).map((x: any) => x.category).filter(Boolean))).map((c) => (
                <option key={String(c)} value={String(c)}>{String(c)}</option>
              ))}
            </select>
          </div>

          <Button size="sm" onClick={() => onAddEvent('log')}>
            <Plus className="h-3.5 w-3.5" /> Добавить
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            <X className="h-3.5 w-3.5" /> Закрыть
          </Button>
        </div>
      </div>

      {eventError ? <div className="mt-2 text-xs text-red-500">{eventError}</div> : null}

      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_340px]">
        <div className="grid gap-2 md:grid-cols-2">
          {(timeline ?? [])
            .filter((ev: any) => eventTypeFilter[ev.type as 'alert' | 'log' | 'task'])
            .filter((ev: any) => eventStatusFilter[ev.status as 'open' | 'ack' | 'resolved' | 'done'])
            .filter((ev: any) => !eventCategoryFilter || String(ev.category ?? '') === eventCategoryFilter)
            .filter((ev: any) => !eventSeverityFilter || String(ev.severity ?? '') === eventSeverityFilter)
            .filter((ev: any) => {
              const q = eventSearch.trim().toLowerCase();
              if (!q) return true;
              return `${ev.title ?? ''} ${ev.description ?? ''} ${ev.category ?? ''}`.toLowerCase().includes(q);
            })
            .filter((ev: any) => {
              if (!eventsPanelShowOverdueOnly) return true;
              return ev.type === 'task' && ev.status !== 'done' && ev.dueAt && new Date(ev.dueAt).getTime() < nowMs;
            })
            .map((ev: any) => (
              <div
                key={ev.eventId}
                className={cn(
                  'rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] p-3 cursor-pointer transition-colors hover:bg-slate-50',
                  selectedEventId === ev.eventId && 'ring-2 ring-inset ring-indigo-300'
                )}
                onClick={() => {
                  onSelectEventId(ev.eventId);
                  onLoadEventComments(ev.eventId);
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-[var(--content-muted)]">
                    <TypeIcon type={ev.type} />
                    <span className="font-mono">{ev.time ?? '—'}</span>
                    <span className="text-[var(--content-text)]">{ev.type}</span>
                    {ev.severity ? <span className="text-[var(--content-muted)]">({ev.severity})</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {ev.type === 'task' ? (
                      <button className="text-[11px] text-emerald-600 hover:text-emerald-700" type="button" onClick={(e) => { e.stopPropagation(); onSetEventStatus(ev.eventId, 'done'); }}>
                        выполнить
                      </button>
                    ) : null}
                    <button className="text-[11px] text-red-500 hover:text-red-600" type="button" onClick={(e) => { e.stopPropagation(); onDeleteEvent(ev.eventId); }}>
                      удалить
                    </button>
                  </div>
                </div>
                <div className="mt-2 text-sm font-medium text-[var(--content-text)]">{ev.title}</div>
                {ev.description ? <div className="mt-1 text-xs text-[var(--content-muted)]">{ev.description}</div> : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--content-muted)]">
                  <span>status: {ev.status}</span>
                  {ev.category ? <span className="rounded-full bg-slate-100 px-2 py-0.5">{ev.category}</span> : null}
                  {ev.dueAt ? (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5',
                        ev.type === 'task' && ev.status !== 'done' && new Date(ev.dueAt).getTime() < nowMs
                          ? 'bg-red-50 text-red-600'
                          : 'bg-slate-100'
                      )}
                      title="dueAt"
                    >
                      due: {new Date(ev.dueAt).toISOString().slice(0, 16).replace('T', ' ')}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          {timelineLoading ? <div className="text-sm text-[var(--content-muted)]">Загрузка…</div> : null}
          {!timelineLoading && (timeline ?? []).length === 0 ? <div className="text-sm text-[var(--content-muted)]">Событий нет</div> : null}
        </div>

        {/* right panel: manage events */}
        <div className="rounded-[var(--radius-md)] border border-[var(--card-border)] bg-slate-50/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-[var(--content-text)]">Управление</div>
            <div className="flex items-center gap-1 text-[11px]">
              {(() => {
                const counts = (timeline ?? []).reduce(
                  (acc: any, ev: any) => {
                    if (ev.type === 'alert' && (ev.status === 'open' || ev.status === 'ack')) acc.alertsOpen += 1;
                    if (ev.type === 'task' && (ev.status === 'open' || ev.status === 'ack')) {
                      acc.tasksOpen += 1;
                      if (ev.dueAt && new Date(ev.dueAt).getTime() < nowMs) acc.tasksOverdue += 1;
                    }
                    if (ev.type === 'log') acc.logs += 1;
                    return acc;
                  },
                  { alertsOpen: 0, tasksOpen: 0, tasksOverdue: 0, logs: 0 }
                );
                const tabs = [
                  { k: 'logs' as const, label: 'События', badge: counts.logs ? String(counts.logs) : '' },
                  { k: 'tasks' as const, label: 'Задачи', badge: counts.tasksOverdue ? `${counts.tasksOverdue}/${counts.tasksOpen}` : counts.tasksOpen ? String(counts.tasksOpen) : '' },
                ];
                return tabs.map((t) => (
                  <button
                    key={t.k}
                    type="button"
                    className={toggleBtnCls(eventsPanelTab === t.k)}
                    onClick={() => onSetEventsPanelTab(t.k)}
                  >
                    <span>{t.label}</span>
                    {t.badge ? <span className="ml-1.5 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-600">{t.badge}</span> : null}
                  </button>
                ));
              })()}
            </div>
          </div>

          <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-[var(--card-bg)] p-2 text-[11px] text-[var(--content-muted)]">
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[var(--content-muted)]">Категория:</span>
                {(['финансы', 'логистика', 'продвижение', 'контент', 'репутация'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={toggleBtnCls(eventsPanelCategory === c)}
                    onClick={() => {
                      const next = eventsPanelCategory === c ? '' : c;
                      onSetEventsPanelCategory(next);
                      onSetEventCategoryFilter(next);
                    }}
                  >
                    {c}
                  </button>
                ))}
                <button
                  type="button"
                  className={actionBtnCls}
                  onClick={() => { onSetEventsPanelCategory(''); onSetEventCategoryFilter(''); }}
                >
                  все
                </button>
              </div>

              {/* Severity filter reserved for future alerts tab */}

              {eventsPanelTab === 'tasks' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={eventsPanelShowOverdueOnly} onChange={(e) => onSetEventsPanelShowOverdueOnly(e.target.checked)} className="accent-indigo-600" />
                    <span className="text-[var(--content-text)]">только просроченные</span>
                  </label>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-3 text-[11px] text-[var(--content-muted)]">
            {selectedEventId ? (
              <div>
                <div className="text-[var(--content-text)]">Выбрано событие #{selectedEventId}</div>
                <div className="mt-2">
                  <div className="text-[var(--content-muted)]">Комментарии</div>
                  <div className="mt-2 max-h-[220px] overflow-auto rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-[var(--card-bg)] p-2">
                    {eventCommentsLoading ? <div className="text-[var(--content-muted)]">Загрузка…</div> : null}
                    {!eventCommentsLoading && eventComments.length === 0 ? <div className="text-[var(--content-muted)]">Комментариев нет</div> : null}
                    {eventComments.map((c: any) => (
                      <div key={c.commentId} className="border-b border-[var(--card-border)] py-1.5 last:border-b-0">
                        <div className="text-[var(--content-muted)]">{String(c.createdAt ?? '').slice(0, 19).replace('T', ' ')}</div>
                        <div className="text-[var(--content-text)]">{c.body}</div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-2 flex gap-2">
                    <Input
                      className="h-8 w-full text-[11px]"
                      placeholder="комментарий…"
                      value={eventCommentDraft}
                      onChange={(e) => onSetEventCommentDraft(e.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={!eventCommentDraft.trim()}
                      onClick={() => onAddEventComment(selectedEventId)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button className={actionBtnCls} type="button" onClick={() => { if (!selectedEvent) return; onOpenEditModal(selectedEvent); }}>
                    редактировать
                  </button>
                  <button className={actionBtnCls} type="button" onClick={() => onSetEventStatus(selectedEventId, 'ack')}>ack</button>
                  <button className={actionBtnCls} type="button" onClick={() => onSetEventStatus(selectedEventId, 'open')}>open</button>
                  <button className={actionBtnCls} type="button" onClick={() => onSetEventStatus(selectedEventId, 'resolved')}>resolved</button>
                  <button className={actionBtnCls} type="button" onClick={() => onSetEventStatus(selectedEventId, 'done')}>done</button>
                </div>
              </div>
            ) : (
              <div className="text-[var(--content-muted)]">Кликни по событию в таймлайне, чтобы открыть управление.</div>
            )}
          </div>

          <div className="mt-4 border-t border-[var(--card-border)] pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-[var(--content-muted)]">Список ({eventsPanelTab === 'logs' ? 'События' : eventsPanelTab === 'tasks' ? 'Задачи' : eventsPanelTab})</div>
              <div className="flex items-center gap-2">
                {eventsPanelTab === 'tasks' ? (
                  <label className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-[11px] text-[var(--content-text)]">
                    <input type="checkbox" checked={eventsPanelShowOverdueOnly} onChange={(e) => onSetEventsPanelShowOverdueOnly(e.target.checked)} className="accent-indigo-600" />
                    <span>только просроченные</span>
                  </label>
                ) : null}
                <button
                  type="button"
                  className={cn(actionBtnCls, 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100')}
                  onClick={() => {
                    const type = eventsPanelTab === 'tasks' ? 'task' : 'log';
                    onAddEvent(type as any);
                  }}
                >
                  <Plus className="mr-1 inline h-3 w-3" /> добавить
                </button>
              </div>
            </div>

            <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-[var(--card-bg)] p-2 text-[11px] text-[var(--content-muted)]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[var(--content-muted)]">Статусы:</span>
                  {(['open', 'ack', 'resolved', 'done'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={toggleBtnCls(eventsPanelStatus[s])}
                      onClick={() => onSetEventsPanelStatus((p) => ({ ...p, [s]: !p[s] }))}
                    >
                      {s}
                    </button>
                  ))}
                </div>

              {/* Quick comment reserved for future alerts tab */}
              </div>
            </div>

            <div className="mt-2 max-h-[260px] overflow-auto rounded-[var(--radius-sm)] border border-[var(--card-border)] bg-[var(--card-bg)]">
              {(timeline ?? [])
                .filter((ev: any) => {
                  const type = eventsPanelTab === 'alerts' ? 'alert' : eventsPanelTab === 'tasks' ? 'task' : 'log';
                  return ev.type === type;
                })
                .filter((ev: any) => eventsPanelStatus[ev.status as 'open' | 'ack' | 'resolved' | 'done'])
                .filter((ev: any) => {
                  if (eventsPanelTab !== 'tasks') return true;
                  if (!eventsPanelShowOverdueOnly) return true;
                  if (ev.status === 'done') return false;
                  if (!ev.dueAt) return false;
                  return new Date(ev.dueAt).getTime() < nowMs;
                })
                .sort((a: any, b: any) => {
                  if (eventsPanelTab === 'alerts') {
                    const sevRank = (x: any) => (x.severity === 'critical' ? 3 : x.severity === 'warn' ? 2 : x.severity === 'info' ? 1 : 0);
                    const d = sevRank(b) - sevRank(a);
                    if (d) return d;
                  }
                  if (eventsPanelTab === 'tasks') {
                    const overdue = (x: any) => x.dueAt && x.status !== 'done' && new Date(x.dueAt).getTime() < nowMs;
                    const d = Number(overdue(b)) - Number(overdue(a));
                    if (d) return d;
                    const da = a.dueAt ? new Date(a.dueAt).getTime() : 0;
                    const db = b.dueAt ? new Date(b.dueAt).getTime() : 0;
                    if (da !== db) return da - db;
                  }
                  const ta = String(a.time ?? '');
                  const tb = String(b.time ?? '');
                  if (ta !== tb) return ta.localeCompare(tb);
                  return Number(b.eventId) - Number(a.eventId);
                })
                .slice(0, 200)
                .map((ev: any) => {
                  const isOverdue = ev.type === 'task' && ev.status !== 'done' && ev.dueAt && new Date(ev.dueAt).getTime() < nowMs;
                  return (
                    <div key={ev.eventId} className={cn('border-b border-[var(--card-border)] px-2 py-2 text-[11px]', selectedEventId === ev.eventId && 'bg-indigo-50/50')}>
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => { onSelectEventId(ev.eventId); onLoadEventComments(ev.eventId); }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <TypeIcon type={ev.type} />
                              <div className="truncate text-[var(--content-text)]">{ev.title}</div>
                            </div>
                            <div className="shrink-0 font-mono text-[var(--content-muted)]">{ev.time ?? '—'}</div>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[var(--content-muted)]">
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5',
                                ev.status === 'open' ? 'bg-slate-100 text-slate-600'
                                  : ev.status === 'ack' ? 'bg-indigo-50 text-indigo-600'
                                  : ev.status === 'resolved' ? 'bg-emerald-50 text-emerald-600'
                                  : 'bg-emerald-50/50 text-emerald-500',
                                isOverdue && 'ring-1 ring-inset ring-red-300'
                              )}
                            >
                              {ev.status}
                            </span>
                            {ev.category ? <span className="rounded-full bg-slate-100 px-2 py-0.5">{ev.category}</span> : null}
                            {ev.severity ? (
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5',
                                  ev.severity === 'critical' ? 'bg-red-50 text-red-600'
                                    : ev.severity === 'warn' ? 'bg-amber-50 text-amber-700'
                                    : 'bg-sky-50 text-sky-600'
                                )}
                              >
                                {ev.severity}
                              </span>
                            ) : null}
                            {isOverdue ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-600">overdue</span> : null}
                          </div>
                        </button>

                        <div className="flex shrink-0 items-center gap-1">
                          {ev.type === 'task' ? (
                            <>
                              <button type="button" className={actionBtnCls} onClick={() => onSetEventStatus(ev.eventId, 'ack')} title="в работе">в работе</button>
                              <button type="button" className={actionBtnCls} onClick={() => onSetEventStatus(ev.eventId, 'done')} title="выполнено">готово</button>
                              <button type="button" className={actionBtnCls} disabled={!ev.dueAt} title="перенести дедлайн на +1 день" onClick={async () => { if (!ev.dueAt) return; const d = new Date(ev.dueAt); d.setDate(d.getDate() + 1); await onPatchEvent(ev.eventId, { dueAt: d.toISOString() }); }}>+1д</button>
                              <button type="button" className={actionBtnCls} disabled={!ev.dueAt} title="перенести дедлайн на +3 дня" onClick={async () => { if (!ev.dueAt) return; const d = new Date(ev.dueAt); d.setDate(d.getDate() + 3); await onPatchEvent(ev.eventId, { dueAt: d.toISOString() }); }}>+3д</button>
                            </>
                          ) : null}
                          {ev.type === 'log' ? (
                            <>
                              <button type="button" className={actionBtnCls} onClick={() => { onSelectEventId(ev.eventId); onOpenEditModal(ev); }}>ред.</button>
                              <button type="button" className={cn(actionBtnCls, 'text-red-500')} onClick={() => onDeleteEvent(ev.eventId)}>удал.</button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              {(timeline ?? []).filter((ev: any) => {
                const type = eventsPanelTab === 'alerts' ? 'alert' : eventsPanelTab === 'tasks' ? 'task' : 'log';
                return ev.type === type;
              }).length === 0 ? <div className="p-2 text-[11px] text-[var(--content-muted)]">Пусто</div> : null}
            </div>

            <div className="mt-3 text-[11px] text-[var(--content-muted)]">Быстрые фильтры</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={actionBtnCls}
                onClick={() => {
                  if (eventsPanelTab === 'tasks') onSetEventTypeFilter(() => ({ alert: false, log: false, task: true }));
                  else onSetEventTypeFilter(() => ({ alert: false, log: true, task: false }));
                }}
              >
                показать только текущий таб
              </button>
              <button
                type="button"
                className={actionBtnCls}
                onClick={() => {
                  onSetEventTypeFilter(() => ({ alert: true, log: true, task: true }));
                  onSetEventStatusFilter(() => ({ open: true, ack: true, resolved: true, done: true }));
                  onSetEventSearch('');
                  onSetEventCategoryFilter('');
                  onSetEventSeverityFilter('');
                  onSetEventsPanelCategory('');
                  onSetEventsPanelSeverity('');
                  onSetEventsPanelShowOverdueOnly(false);
                  onSetEventsPanelStatus(() => ({ open: true, ack: true, resolved: true, done: true }));
                  onSetEventsPanelQuickComment('взял в работу');
                }}
              >
                сбросить фильтры
              </button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
