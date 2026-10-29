'use client';

/**
 * ProductTimeline — ключевые моменты истории товара (change-points + события
 * из v_product_events). Без слов "change-point/lag".
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

interface Event {
  ts: string;
  type: string;
  source: string;
  summary: string | null;
}
interface ChangePoint {
  date: string;
  meanBefore: number;
  meanAfter: number;
  deltaPct: number;
}
interface Resp {
  ok: boolean;
  events: Event[];
  changePoints: ChangePoint[];
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
}

const EVENT_ICON: Record<string, string> = {
  photo_change: '📸',
  title_change: '📝',
  description_change: '📄',
  brand_change: '🏷',
  subject_change: '🗂',
  video_change: '🎬',
  characteristics_change: '🧩',
  sizes_change: '📏',
  dimensions_change: '📐',
  sigma_action: '🤖',
  price_change: '💰',
};

function eventLabel(type: string): string {
  switch (type) {
    case 'photo_change': return 'Изменены фото';
    case 'title_change': return 'Изменён заголовок';
    case 'description_change': return 'Изменено описание';
    case 'brand_change': return 'Изменён бренд';
    case 'subject_change': return 'Изменена категория';
    case 'video_change': return 'Изменено видео';
    case 'characteristics_change': return 'Обновлены характеристики';
    case 'sizes_change': return 'Изменены размеры';
    case 'dimensions_change': return 'Изменены габариты';
    case 'sigma_action': return 'Действие через Sigma Seller';
    case 'price_change': return 'Изменение цены';
    default: return type;
  }
}

export function ProductTimeline({ workspaceId, shopId, nmId, from, to }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiFetch<Resp>(
      `/lab/${workspaceId}/timeline?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => { if (!ac.signal.aborted) setData(d); })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [workspaceId, shopId, nmId, from, to]);

  if (loading) return <div className="text-xs text-slate-500 italic">Составляем хронологию…</div>;
  if (!data) return null;

  // Связываем переломы с событиями: для каждого перелома ищем event в окне ±3 дня
  const eventsByDay = new Map<string, Array<{ type: string; summary: string | null }>>();
  for (const e of data.events) {
    const day = String(e.ts).slice(0, 10);
    if (!eventsByDay.has(day)) eventsByDay.set(day, []);
    eventsByDay.get(day)!.push({ type: e.type, summary: e.summary });
  }

  function findNearbyEvents(turnDate: string, windowDays = 3): Array<{ date: string; type: string; summary: string | null; daysOffset: number }> {
    const out: Array<{ date: string; type: string; summary: string | null; daysOffset: number }> = [];
    const tDate = new Date(turnDate + 'T00:00:00Z').getTime();
    for (const [day, evs] of eventsByDay) {
      const eDate = new Date(day + 'T00:00:00Z').getTime();
      const diffDays = Math.round((tDate - eDate) / 86400000);
      if (Math.abs(diffDays) <= windowDays) {
        for (const e of evs) out.push({ date: day, type: e.type, summary: e.summary, daysOffset: diffDays });
      }
    }
    return out.sort((a, b) => Math.abs(a.daysOffset) - Math.abs(b.daysOffset));
  }

  // ---- Только переломы с привязанной причиной — иначе бесполезный шаблон «вероятно внешний фактор» ----
  const turnsWithCause = data.changePoints
    .map(c => ({ turn: c, causes: findNearbyEvents(c.date) }))
    .filter(tc => tc.causes.length > 0);
  const unexplainedCount = data.changePoints.length - turnsWithCause.length;

  // ---- Прочие события без связанного перелома ----
  const usedEventDays = new Set<string>();
  for (const tc of turnsWithCause) for (const cause of tc.causes) usedEventDays.add(cause.date + ':' + cause.type);
  const orphanEvents = data.events.filter(e => !usedEventDays.has(String(e.ts).slice(0, 10) + ':' + e.type));

  if (turnsWithCause.length === 0 && orphanEvents.length === 0) {
    return (
      <div>
        <SectionHeader />
        <div className="text-xs text-slate-500 mt-1">
          {unexplainedCount > 0
            ? `За период было ${unexplainedCount} ${unexplainedCount === 1 ? 'перелом' : unexplainedCount < 5 ? 'перелома' : 'переломов'} в заказах, но связать их с правками карточки не удалось — нужно сравнить с календарём акций WB и активностью конкурентов вручную.`
            : 'За период значимых переломов в продажах и правок карточки не зафиксировано — товар стабилен.'}
        </div>
      </div>
    );
  }

  const sortedTurns = [...turnsWithCause].sort((a, b) => (a.turn.date < b.turn.date ? 1 : -1));
  const sortedOrphans = [...orphanEvents].sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return (
    <div>
      <SectionHeader />

      {/* Переломы с причинами — главная секция */}
      {sortedTurns.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] uppercase font-semibold text-slate-500 tracking-wide mb-1">Что повлияло на заказы</div>
          <ol className="space-y-2">
            {sortedTurns.map((tc, i) => {
              const c = tc.turn;
              const direction = c.deltaPct > 0 ? 'вырос' : 'упал';
              const sign = c.deltaPct > 0 ? '+' : '';
              const arrow = c.deltaPct > 0 ? '📈' : '📉';
              return (
                <li key={i} className={`rounded-md border p-2 ${c.deltaPct > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-base leading-none mt-0.5">{arrow}</span>
                    <div className="flex-1">
                      <div className="font-semibold text-slate-800">
                        {c.date} — заказы {direction} на {Math.abs(c.deltaPct)}%
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        Среднее заказов в день: {c.meanBefore.toFixed(1)} → {c.meanAfter.toFixed(1)} ({sign}{c.deltaPct}%, окно 7 дней)
                      </div>
                      <div className="mt-1 pl-2 border-l-2 border-indigo-300">
                        <div className="text-[11px] font-semibold text-indigo-800">Вероятная причина:</div>
                        <ul className="text-[11px] text-slate-700 space-y-0.5">
                          {tc.causes.map((cause, j) => {
                            const offsetTxt = cause.daysOffset === 0
                              ? 'в тот же день'
                              : cause.daysOffset > 0
                                ? `за ${cause.daysOffset} дн до`
                                : `через ${Math.abs(cause.daysOffset)} дн после`;
                            return (
                              <li key={j}>
                                {EVENT_ICON[cause.type] ?? '•'} {eventLabel(cause.type)} ({offsetTxt}) —
                                <span className="text-slate-500"> {cause.summary || cause.date}</span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {unexplainedCount > 0 && (
        <div className="mt-2 text-[11px] text-slate-500">
          Ещё {unexplainedCount} {unexplainedCount === 1 ? 'перелом' : unexplainedCount < 5 ? 'перелома' : 'переломов'} в заказах не привязаны к правкам карточки — внешний фактор (позиция, конкурент, сезон, акция WB).
        </div>
      )}

      {/* Прочие события без перелома — второстепенно */}
      {sortedOrphans.length > 0 && (
        <details className="mt-3">
          <summary className="text-[11px] uppercase font-semibold text-slate-500 tracking-wide cursor-pointer">
            Все правки карточки за период ({sortedOrphans.length})
          </summary>
          <ol className="mt-1 space-y-1 max-h-[180px] overflow-y-auto pr-1">
            {sortedOrphans.slice(0, 50).map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className="text-slate-500 font-mono w-20 shrink-0">{String(e.ts).slice(0, 10)}</span>
                <span className="text-base leading-none mt-0.5">{EVENT_ICON[e.type] ?? '•'}</span>
                <span className="flex-1 text-slate-700">
                  {eventLabel(e.type)}
                  {e.summary && <span className="text-slate-500"> — {e.summary}</span>}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function SectionHeader() {
  return (
    <>
      <div className="text-xs font-medium text-slate-700">Что двигало продажи товара за период</div>
      <div className="text-[11px] text-slate-500">
        Лаборатория ищет резкие переломы в дневных <b>Заказах (шт.)</b> и связывает их с правками карточки и действиями через Sigma Seller.
      </div>
    </>
  );
}
