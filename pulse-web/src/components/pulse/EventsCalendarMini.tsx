'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { X, ExternalLink, Sparkles } from 'lucide-react';
import { EventEditModal, type EventEditData } from './EventEditModal';

interface EventRow {
  eventId: number;
  nmId?: number | null;
  date: string;
  time?: string | null;
  type: string;
  category?: string | null;
  severity?: string | null;
  status: string;
  title: string;
  description?: string | null;
  evidence?: Record<string, unknown> | null;
}

interface Props {
  workspaceId: number;
  /** When set, the calendar filters to this product. When null/undefined — shows ALL events for the workspace. */
  nmId?: number | null;
  /** Active shop filter (from useWorkspaceStore). When set, only events from this shop are shown. */
  shopId?: number | null;
  /** Date to center the window on. Defaults to today. Ignored when dateFrom+dateTo are provided. */
  selectedDate?: string;
  /** Window size in days around selectedDate, default 30. Ignored when dateFrom+dateTo are provided. */
  windowDays?: number;
  /** Explicit range — when both set, the calendar shows exactly these dates instead of selectedDate±windowDays. */
  dateFrom?: string;
  dateTo?: string;
  /** Show the "Все товары" reset chip (only useful when nmId is set) */
  onClearNmFilter?: () => void;
  /** Optional close button — hidden when not provided */
  onClose?: () => void;
}

const CATEGORIES = [
  { key: 'price', label: 'Цена', color: '#f59e0b' },
  { key: 'card', label: 'Карточка', color: '#8b5cf6' },
  { key: 'promo', label: 'Акции', color: '#10b981' },
  { key: 'review', label: 'Отзывы', color: '#3b82f6' },
  { key: 'stock', label: 'Остатки', color: '#ef4444' },
  { key: 'ads', label: 'Реклама', color: '#f97316' },
  { key: 'sales', label: 'Продажи', color: '#0ea5e9' },
  { key: 'other', label: 'Другое', color: '#6b7280' },
] as const;

const CATEGORY_ALIAS: Record<string, string> = {
  card_change: 'card',
};

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function EventsCalendarMini({
  workspaceId,
  nmId,
  shopId,
  selectedDate,
  windowDays = 30,
  dateFrom,
  dateTo,
  onClearNmFilter,
  onClose,
}: Props) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<{ date: string; category: string; label: string; color: string } | null>(null);
  const [editData, setEditData] = useState<EventEditData | null>(null);

  const centerDate = selectedDate ?? ymd(new Date());
  const useExplicitRange = !!(dateFrom && dateTo);

  // Window: explicit dateFrom/dateTo (synced with main table) wins;
  // otherwise fall back to centerDate ± windowDays/2.
  const { fromDate, toDate, dayList } = useMemo(() => {
    if (useExplicitRange) {
      const from = new Date(dateFrom + 'T00:00:00Z');
      const to = new Date(dateTo + 'T00:00:00Z');
      const days: string[] = [];
      const cursor = new Date(from);
      while (cursor <= to) {
        days.push(ymd(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return { fromDate: dateFrom!, toDate: dateTo!, dayList: days };
    }
    const center = new Date(centerDate + 'T00:00:00Z');
    const half = Math.floor(windowDays / 2);
    const from = new Date(center);
    from.setUTCDate(from.getUTCDate() - half);
    const to = new Date(center);
    to.setUTCDate(to.getUTCDate() + (windowDays - half));
    const days: string[] = [];
    for (let i = 0; i <= windowDays; i++) {
      const d = new Date(from);
      d.setUTCDate(d.getUTCDate() + i);
      days.push(ymd(d));
    }
    return { fromDate: ymd(from), toDate: ymd(to), dayList: days };
  }, [useExplicitRange, dateFrom, dateTo, centerDate, windowDays]);

  // Load events in window — filtered by nmId if set, otherwise workspace-wide
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const nmParam = nmId ? `&nmId=${nmId}` : '';
        const shopParam = shopId ? `&shopId=${shopId}` : '';
        const limit = nmId ? 500 : 2000;
        const res = (await apiFetch(
          `/events/${workspaceId}?from=${fromDate}&to=${toDate}${nmParam}${shopParam}&limit=${limit}`,
        )) as { rows: EventRow[] };
        if (!cancelled) setEvents(res.rows ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Не удалось загрузить события');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [workspaceId, nmId, shopId, fromDate, toDate]);

  // Group: category → date → events
  const byCategory = useMemo(() => {
    const map = new Map<string, Map<string, EventRow[]>>();
    CATEGORIES.forEach((c) => map.set(c.key, new Map()));
    for (const ev of events) {
      const rawCat = ev.category ?? ev.type ?? 'other';
      const cat = CATEGORY_ALIAS[rawCat] ?? rawCat;
      // Unknown categories go to a dedicated "Другое" bucket so we don't
      // silently misrepresent them as Card changes (AUDIT-02 fix).
      const m = map.get(cat) ?? map.get('other')!;
      const arr = m.get(ev.date) ?? [];
      arr.push(ev);
      m.set(ev.date, arr);
    }
    return map;
  }, [events]);

  // Category stats (total + max for heatmap opacity)
  const stats = useMemo(
    () =>
      CATEGORIES.map((cat) => {
        const m = byCategory.get(cat.key)!;
        let total = 0;
        let max = 0;
        for (const evs of m.values()) {
          total += evs.length;
          if (evs.length > max) max = evs.length;
        }
        return { ...cat, total, max };
      }),
    [byCategory],
  );

  const grandTotal = stats.reduce((s, c) => s + c.total, 0);

  const drillEvents = drill
    ? byCategory.get(drill.category)?.get(drill.date) ?? []
    : [];

  const cellOpacity = (n: number, maxInRow: number): number => {
    if (n <= 0) return 0;
    if (maxInRow <= 1) return 0.85;
    return 0.35 + 0.65 * Math.min(1, (n - 1) / (maxInRow - 1));
  };

  const openEdit = useCallback((ev: EventRow) => {
    setEditData({
      eventId: ev.eventId,
      date: ev.date,
      time: ev.time ?? '',
      category: ev.category ?? '',
      severity: ev.severity ?? '',
      title: ev.title,
      description: ev.description ?? '',
      dueAt: '',
      nmId: ev.nmId ?? null,
      evidence: ev.evidence ?? null,
    });
  }, []);

  const dayWidth = 28;

  return (
    <>
      <Card className="p-4 overflow-x-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-semibold text-sm truncate">
              {nmId ? 'События по товару' : 'События за период'}
            </h3>
            {nmId ? (
              <>
                <NmIdLink nmId={nmId} className="inline-flex items-center gap-1 rounded-md border border-[var(--card-border)] px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50">
                  <ExternalLink className="h-3 w-3" />
                  {nmId}
                </NmIdLink>
                {onClearNmFilter && (
                  <button
                    type="button"
                    onClick={onClearNmFilter}
                    className="text-xs text-violet-600 hover:text-violet-800 hover:underline"
                    title="Показать события всех товаров"
                  >
                    × все товары
                  </button>
                )}
              </>
            ) : (
              <span className="text-xs text-[var(--content-muted)]">все товары</span>
            )}
            <Badge variant="neutral" size="sm">всего: {grandTotal}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--content-muted)]">
              {new Date(fromDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — {new Date(toDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
            </span>
            {onClose && (
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-gray-100 text-gray-500"
                title="Закрыть"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {loading && <div className="text-xs text-gray-500 py-4 text-center">Загрузка…</div>}
        {error && <div className="text-xs text-red-600 py-4 text-center">{error}</div>}

        {!loading && !error && grandTotal === 0 && (
          <div className="text-xs text-gray-500 py-6 text-center">
            {useExplicitRange
              ? (nmId ? 'За выбранный период событий по этому товару нет' : 'За выбранный период событий нет')
              : (nmId ? `За окно ±${windowDays} дней событий по этому товару нет` : `За окно ±${windowDays} дней событий нет`)}
          </div>
        )}

        {!loading && !error && grandTotal > 0 && (
          <div style={{ minWidth: dayList.length * dayWidth + 180 }}>
            {/* Date header */}
            <div className="flex border-b border-[var(--table-border)]">
              <div className="w-[180px] shrink-0 text-xs font-medium text-[var(--content-muted)] p-2">Событие</div>
              {dayList.map((d) => {
                const date = new Date(d + 'T00:00:00');
                const isSelected = d === selectedDate;
                const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                return (
                  <div
                    key={d}
                    className={cn(
                      'text-center text-[10px] p-1 shrink-0',
                      isSelected ? 'bg-indigo-100 font-bold text-indigo-700 rounded' : isWeekend ? 'text-gray-300' : 'text-gray-500'
                    )}
                    style={{ width: dayWidth }}
                  >
                    {date.getDate()}
                  </div>
                );
              })}
            </div>

            {/* Category rows */}
            {stats.map((cat) => {
              if (cat.total === 0) return null; // skip empty categories in mini
              const m = byCategory.get(cat.key)!;
              return (
                <div key={cat.key} className="flex border-b border-[var(--table-border)] hover:bg-[var(--bg-subtle)]">
                  <div className="w-[180px] shrink-0 text-xs text-[var(--content-text)] p-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: cat.color }} />
                      <span className="truncate">{cat.label}</span>
                    </div>
                    <span className="text-[10px] text-[var(--content-muted)] tabular-nums shrink-0">{cat.total}</span>
                  </div>
                  {dayList.map((d) => {
                    const evs = m.get(d);
                    const n = evs?.length ?? 0;
                    const isOpen = drill?.date === d && drill?.category === cat.key;
                    return (
                      <div
                        key={d}
                        className="shrink-0 flex items-center justify-center"
                        style={{ width: dayWidth, minHeight: 26 }}
                        title={evs ? evs.map((e) => e.title).slice(0, 5).join('\n') : undefined}
                      >
                        {n > 0 && (
                          <button
                            type="button"
                            className={cn(
                              'w-5 h-5 rounded text-[10px] font-semibold flex items-center justify-center text-white transition-all',
                              isOpen && 'ring-2 ring-offset-1 ring-indigo-500'
                            )}
                            style={{ background: cat.color, opacity: cellOpacity(n, cat.max) }}
                            onClick={() => {
                              if (isOpen) setDrill(null);
                              else setDrill({ date: d, category: cat.key, label: cat.label, color: cat.color });
                            }}
                          >
                            {n}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Drill-down for selected (date, category) */}
      {drill && (
        <Card className="p-4 mt-2">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-3 h-3 rounded-full shrink-0" style={{ background: drill.color }} />
              <h4 className="font-medium text-sm truncate">
                {drill.label} · {new Date(drill.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
              </h4>
              <Badge variant="neutral" size="sm">{drillEvents.length}</Badge>
            </div>
            <button
              onClick={() => setDrill(null)}
              className="p-1 rounded hover:bg-gray-100 text-gray-500"
              title="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-2">
            {drillEvents.length === 0 ? (
              <div className="text-xs text-gray-500 text-center py-4">Нет событий</div>
            ) : (
              drillEvents.map((ev) => (
                <button
                  key={ev.eventId}
                  type="button"
                  onClick={() => openEdit(ev)}
                  className="w-full text-left rounded-lg border border-[var(--card-border)] bg-white p-3 hover:ring-1 hover:ring-violet-300 transition-shadow"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900">{ev.title}</div>
                      {ev.description && (
                        <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{ev.description}</div>
                      )}
                    </div>
                    <div className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-violet-100 text-violet-700 text-xs shrink-0">
                      <Sparkles className="h-3 w-3" />
                      AI
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </Card>
      )}

      {/* Event editor + AI panel modal */}
      <EventEditModal
        open={!!editData}
        data={editData}
        onChange={(update) => setEditData((prev) => (prev ? { ...prev, ...update } : prev))}
        onSave={() => setEditData(null)}
        onClose={() => setEditData(null)}
      />
    </>
  );
}
