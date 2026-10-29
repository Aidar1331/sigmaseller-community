'use client';

/**
 * CardChangeTimelineWidget — рендер события `category='card_change'` в
 * Календаре Событий Канбана. Показывает diff-view фото и текстовых полей.
 *
 * Event.meta ожидает { changes: string[], date: 'YYYY-MM-DD' }.
 * Данные снапшотов тянем из /lab/:ws/timeline (если сервер доступен), в
 * fallback — используем meta.changes и human-readable description события.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

interface Props {
  event: {
    eventId: number;
    workspaceId: number;
    shopId: number | null;
    nmId: number | null;
    title: string | null;
    description: string | null;
    severity: string;
    evidence?: { changes?: string[]; date?: string } | null;
    /** Backwards compat alias — некоторые фиды отдают это поле как `meta`. */
    meta?: { changes?: string[]; date?: string } | null;
  };
}

interface Snapshot {
  snapshot_date: string;
  title: string | null;
  description: string | null;
  brand: string | null;
  photos: Array<Record<string, string>>;
}

const ICONS: Record<string, string> = {
  title_change: '📝',
  description_change: '📄',
  photo_change: '📸',
  brand_change: '🏷',
  subject_change: '🗂',
  video_change: '🎬',
  characteristics_change: '🧩',
  sizes_change: '📏',
  dimensions_change: '📐',
};

export function CardChangeTimelineWidget({ event }: Props) {
  const [snap, setSnap] = useState<{ prev: Snapshot | null; curr: Snapshot | null }>({ prev: null, curr: null });
  const [loading, setLoading] = useState(false);

  const evDate = event.evidence?.date ?? event.meta?.date;
  useEffect(() => {
    if (!event.shopId || !event.nmId || !evDate) return;
    const from = evDate;
    const to = evDate;
    const ac = new AbortController();
    setLoading(true);
    apiFetch<{ ok: boolean; snapshots?: Array<Snapshot> }>(
      `/lab/${event.workspaceId}/card-snapshots?shopId=${event.shopId}&nmId=${event.nmId}&from=${from}&to=${to}`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => {
        if (ac.signal.aborted) return;
        const snaps = d.snapshots ?? [];
        setSnap({ prev: snaps[1] ?? null, curr: snaps[0] ?? null });
      })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [event.workspaceId, event.shopId, event.nmId, evDate]);

  const changes = event.evidence?.changes ?? event.meta?.changes ?? [];
  const icons = changes.map(c => ICONS[c] ?? '•').join(' ');

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-semibold">
            <span className="mr-1">{icons}</span>
            {event.title || `Изменения на карточке ${event.nmId}`}
          </div>
          {event.description && (
            <div className="text-xs text-slate-600 mt-0.5">{event.description}</div>
          )}
        </div>
        <span
          className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full ${
            event.severity === 'significant' ? 'bg-rose-100 text-rose-800'
              : event.severity === 'moderate' ? 'bg-amber-100 text-amber-800'
              : 'bg-slate-100 text-slate-700'
          }`}
        >
          {event.severity === 'significant' ? 'значительно' : event.severity === 'moderate' ? 'умеренно' : 'незначительно'}
        </span>
      </div>

      {loading && <div className="text-xs text-slate-500 italic">Загружаем сравнение…</div>}

      {snap.prev && snap.curr && (
        <div className="grid grid-cols-2 gap-3 mt-2">
          <SnapshotColumn label="Было" snap={snap.prev} />
          <SnapshotColumn label="Стало" snap={snap.curr} highlight />
        </div>
      )}

      {!loading && !snap.prev && !snap.curr && changes.length > 0 && (
        <ul className="mt-2 text-xs text-slate-700 list-disc list-inside space-y-0.5">
          {changes.map(c => (
            <li key={c}>{ICONS[c] ?? '•'} {HUMAN_CHANGE[c] ?? c}</li>
          ))}
        </ul>
      )}

      {event.nmId && (
        <a
          href={`/ai?prefill=${encodeURIComponent(`Как повлияли изменения на артикул ${event.nmId} за последние 14 дней?`)}&nmId=${event.nmId}&shopId=${event.shopId ?? ''}`}
          className="mt-3 inline-block text-xs font-medium text-indigo-700 hover:underline"
        >
          🧠 Проанализировать последствия
        </a>
      )}
    </div>
  );
}

function SnapshotColumn({ label, snap, highlight }: { label: string; snap: Snapshot; highlight?: boolean }) {
  const mainPhoto = snap.photos?.[0]?.big ?? snap.photos?.[0]?.c516x688 ?? snap.photos?.[0]?.c246x328;
  return (
    <div className={`rounded border p-2 ${highlight ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-slate-50'}`}>
      <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">{label} · {snap.snapshot_date}</div>
      {mainPhoto && (
        // object-contain + увеличенная высота, чтобы фото товара (часто
        // вертикальное 3:4) показывалось целиком, а не обрезалось до верхней
        // трети. Серый фон скроет letterbox для горизонтальных кадров.
        <img
          src={mainPhoto}
          alt=""
          className="w-full h-48 object-contain rounded mb-1 bg-slate-100"
        />
      )}
      <div className="text-xs font-medium text-slate-800 truncate">{snap.title ?? '—'}</div>
      {snap.brand && <div className="text-[11px] text-slate-500">{snap.brand}</div>}
    </div>
  );
}

const HUMAN_CHANGE: Record<string, string> = {
  title_change: 'Изменён заголовок',
  description_change: 'Изменено описание',
  photo_change: 'Изменены фото',
  brand_change: 'Изменён бренд',
  subject_change: 'Изменена категория',
  video_change: 'Изменено видео',
  characteristics_change: 'Обновлены характеристики',
  sizes_change: 'Изменены размеры',
  dimensions_change: 'Изменены габариты',
};
