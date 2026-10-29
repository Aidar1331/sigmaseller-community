'use client';

import { ArrowRight } from 'lucide-react';

interface PhotoUrls {
  thumb: string;
  big: string;
}

interface CharacteristicDiff {
  name: string;
  from: unknown;
  to: unknown;
}

export interface CardChangeDetails {
  title?: { from: string; to: string };
  description?: { fromLen: number; toLen: number; fromPreview: string; toPreview: string };
  brand?: { from: string; to: string };
  subject?: { from: number | null; to: number | null };
  photos?: {
    from: PhotoUrls[];
    to: PhotoUrls[];
    addedCount: number;
    removedCount: number;
  };
  characteristics?: {
    changed: CharacteristicDiff[];
    added: CharacteristicDiff[];
    removed: CharacteristicDiff[];
  };
  sizes?: { fromCount: number; toCount: number };
  dimensions?: { from: unknown; to: unknown };
  video?: { from: string; to: string };
}

interface Props {
  details: CardChangeDetails;
}

function fmt(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(fmt).join(', ');
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// Human-readable rendering for WB card "dimensions" object.
// Raw shape: {"width":52,"height":6,"length":55,"isValid":true,"weightBrutto":2.1}
// User-visible: "Ш 52 см · В 6 см · Д 55 см · Вес 2.1 кг".
const DIMENSION_LABELS: Record<string, { ru: string; unit: string }> = {
  width: { ru: 'Ш', unit: 'см' },
  height: { ru: 'В', unit: 'см' },
  length: { ru: 'Д', unit: 'см' },
  weightBrutto: { ru: 'Вес', unit: 'кг' },
  weight: { ru: 'Вес', unit: 'кг' },
};

function fmtDimensions(v: unknown): string {
  if (v == null) return '—';
  if (typeof v !== 'object' || Array.isArray(v)) return fmt(v);
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['width', 'height', 'length', 'weightBrutto', 'weight'] as const) {
    if (o[key] == null) continue;
    const lbl = DIMENSION_LABELS[key];
    if (!lbl) continue;
    parts.push(`${lbl.ru} ${o[key]} ${lbl.unit}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function PhotoStrip({ urls, label }: { urls: PhotoUrls[]; label: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label} ({urls.length})</div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {urls.length === 0 ? (
          <div className="text-xs text-gray-400 italic py-2">—</div>
        ) : (
          urls.map((p, i) => (
            <a
              key={i}
              href={p.big}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 block rounded-md overflow-hidden border border-gray-200 hover:ring-2 hover:ring-violet-400 transition"
              title="Открыть фото в полном размере"
            >
              <img
                src={p.thumb}
                alt={`photo ${i + 1}`}
                className="w-16 h-20 object-cover"
                loading="lazy"
              />
            </a>
          ))
        )}
      </div>
    </div>
  );
}

export function CardChangeDetailsView({ details }: Props) {
  const hasAny =
    details.title ||
    details.description ||
    details.brand ||
    details.subject ||
    details.photos ||
    details.characteristics ||
    details.sizes ||
    details.dimensions ||
    details.video;

  if (!hasAny) return null;

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 space-y-3 text-sm">
      <div className="text-xs font-semibold text-indigo-900 uppercase tracking-wide">Детали изменений</div>

      {details.title && (
        <div className="grid grid-cols-1 gap-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500">Название</div>
          <div className="rounded bg-red-50 border border-red-100 px-2 py-1 text-gray-700 line-through">
            {details.title.from || <span className="italic text-gray-400">(пусто)</span>}
          </div>
          <div className="flex items-center justify-center text-gray-400">
            <ArrowRight className="w-3 h-3" />
          </div>
          <div className="rounded bg-green-50 border border-green-100 px-2 py-1 text-gray-900 font-medium">
            {details.title.to || <span className="italic text-gray-400">(пусто)</span>}
          </div>
        </div>
      )}

      {details.brand && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-gray-500">Бренд:</span>
          <span className="rounded bg-red-50 border border-red-100 px-2 py-0.5 text-xs text-gray-700 line-through">
            {details.brand.from || '—'}
          </span>
          <ArrowRight className="w-3 h-3 text-gray-400" />
          <span className="rounded bg-green-50 border border-green-100 px-2 py-0.5 text-xs text-gray-900 font-medium">
            {details.brand.to || '—'}
          </span>
        </div>
      )}

      {details.subject && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-gray-500">Категория (ID WB):</span>
          <span className="rounded bg-red-50 border border-red-100 px-2 py-0.5 text-xs text-gray-700 line-through">
            {details.subject.from ?? '—'}
          </span>
          <ArrowRight className="w-3 h-3 text-gray-400" />
          <span className="rounded bg-green-50 border border-green-100 px-2 py-0.5 text-xs text-gray-900 font-medium">
            {details.subject.to ?? '—'}
          </span>
        </div>
      )}

      {details.description && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500">
            Описание · {details.description.fromLen} → {details.description.toLen} символов
          </div>
          <details className="group">
            <summary className="text-xs text-violet-600 cursor-pointer hover:underline select-none">
              Показать превью текста
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-2">
              <div className="rounded bg-red-50 border border-red-100 px-2 py-1.5 text-xs text-gray-700">
                <div className="text-[10px] uppercase text-red-700 mb-0.5">Было</div>
                {details.description.fromPreview || <span className="italic text-gray-400">(пусто)</span>}
              </div>
              <div className="rounded bg-green-50 border border-green-100 px-2 py-1.5 text-xs text-gray-700">
                <div className="text-[10px] uppercase text-green-700 mb-0.5">Стало</div>
                {details.description.toPreview || <span className="italic text-gray-400">(пусто)</span>}
              </div>
            </div>
          </details>
        </div>
      )}

      {details.photos && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wide text-gray-500">
              Фото · {details.photos.from.length} → {details.photos.to.length}
            </div>
            <div className="text-[10px] text-gray-500">
              {details.photos.addedCount > 0 && (
                <span className="text-green-700">+{details.photos.addedCount} </span>
              )}
              {details.photos.removedCount > 0 && (
                <span className="text-red-700">−{details.photos.removedCount}</span>
              )}
            </div>
          </div>
          <PhotoStrip urls={details.photos.from} label="Было" />
          <PhotoStrip urls={details.photos.to} label="Стало" />
        </div>
      )}

      {details.video && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-gray-500">Видео:</span>
          {details.video.to ? (
            <a href={details.video.to} target="_blank" rel="noopener noreferrer" className="text-xs text-violet-600 hover:underline">
              Открыть новое видео ↗
            </a>
          ) : (
            <span className="text-xs text-gray-500 italic">Видео удалено</span>
          )}
        </div>
      )}

      {details.characteristics && (
        details.characteristics.changed.length +
          details.characteristics.added.length +
          details.characteristics.removed.length
      ) > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500">
            Характеристики: {details.characteristics.changed.length} изменено{details.characteristics.added.length > 0 ? `, ${details.characteristics.added.length} добавлено` : ''}{details.characteristics.removed.length > 0 ? `, ${details.characteristics.removed.length} удалено` : ''}
          </div>
          <div className="rounded border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Параметр</th>
                  <th className="text-left px-2 py-1.5 font-medium">Было</th>
                  <th className="text-left px-2 py-1.5 font-medium">Стало</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {details.characteristics.changed.map((c, i) => (
                  <tr key={`chg-${i}`} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-medium text-gray-800">{c.name}</td>
                    <td className="px-2 py-1.5 text-red-700 bg-red-50/50 line-through">{fmt(c.from)}</td>
                    <td className="px-2 py-1.5 text-green-700 bg-green-50/50 font-medium">{fmt(c.to)}</td>
                  </tr>
                ))}
                {details.characteristics.added.map((c, i) => (
                  <tr key={`add-${i}`} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-medium text-gray-800">
                      <span className="inline-block w-3 text-green-700">+</span>
                      {c.name}
                    </td>
                    <td className="px-2 py-1.5 text-gray-400 italic">—</td>
                    <td className="px-2 py-1.5 text-green-700 bg-green-50/50 font-medium">{fmt(c.to)}</td>
                  </tr>
                ))}
                {details.characteristics.removed.map((c, i) => (
                  <tr key={`rem-${i}`} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-medium text-gray-800">
                      <span className="inline-block w-3 text-red-700">−</span>
                      {c.name}
                    </td>
                    <td className="px-2 py-1.5 text-red-700 bg-red-50/50 line-through">{fmt(c.from)}</td>
                    <td className="px-2 py-1.5 text-gray-400 italic">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Sizes — hide when fromCount == toCount (nothing changed semantically) */}
      {details.sizes && details.sizes.fromCount !== details.sizes.toCount && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-gray-500">Размеры/варианты:</span>
          <span className="text-xs text-gray-700">{details.sizes.fromCount} → {details.sizes.toCount}</span>
        </div>
      )}

      {/* Dimensions — render the WB API object as human "Ш 52 · В 6 · Д 55 · Вес 2.1 кг".
          Hide entirely when from == to (no semantic change). */}
      {details.dimensions && (() => {
        const fromText = fmtDimensions(details.dimensions.from);
        const toText = fmtDimensions(details.dimensions.to);
        if (fromText === toText) return null;
        return (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-gray-500">Габариты / вес</div>
            <div className="grid grid-cols-1 gap-1 text-xs">
              <div className="rounded bg-red-50 border border-red-100 px-2 py-1 text-gray-700 line-through">
                {fromText}
              </div>
              <div className="rounded bg-green-50 border border-green-100 px-2 py-1 text-gray-900 font-medium">
                {toText}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
