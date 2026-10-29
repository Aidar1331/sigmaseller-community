'use client';

/**
 * BestComboCard — топ-5 дней с максимальной выручкой за период с
 * метриками-контекстом. Показывает «при каких ДРР, цене и CTR товар
 * приносил максимум».
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Explainer } from './Explainer';
import { metricLabel } from '../i18n';

interface DayRow {
  date: string;
  ordersCount?: number | null;
  salesRub?: number | null;
  finishedPriceRub?: number | null;
  ctrPercent?: number | null;
  crPercent?: number | null;
  advSpendRub?: number | null;
  drrPercent?: number | null;
  stockQty?: number | null;
}
interface SuccessFormulaItem {
  metric: string;
  p25: number;
  p50: number;
  p75: number;
  iqrPct: number;
  label: 'stable' | 'range';
  n: number;
}
interface Resp {
  ok: boolean;
  days: DayRow[];
  averagesOverPeriod: Record<string, number | null>;
  successFormula?: SuccessFormulaItem[];
  commentary: string[];
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-slate-500">{label}:</span>{' '}
      <span className="font-semibold">{value}</span>
    </div>
  );
}

const COLS: Array<{ key: keyof DayRow; format: (v: number) => string }> = [
  { key: 'salesRub',         format: v => v.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽' },
  { key: 'ordersCount',      format: v => v.toFixed(0) },
  { key: 'finishedPriceRub', format: v => v.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽' },
  { key: 'ctrPercent',       format: v => v.toFixed(1) + '%' },
  { key: 'drrPercent',       format: v => v.toFixed(1) + '%' },
  { key: 'advSpendRub',      format: v => v.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽' },
  { key: 'stockQty',         format: v => v.toFixed(0) + ' шт' },
];

export function BestComboCard({ workspaceId, shopId, nmId, from, to }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiFetch<Resp>(
      `/lab/${workspaceId}/best-combo?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => { if (!ac.signal.aborted) setData(d); })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [workspaceId, shopId, nmId, from, to]);

  if (loading) return <div className="text-xs text-slate-500 italic">Ищем лучшие дни товара…</div>;
  if (!data) return null;
  if (data.days.length === 0) {
    return <div className="text-xs text-slate-500">{data.commentary?.[0] || 'Недостаточно данных для лучшей комбинации.'}</div>;
  }

  const fmt = (row: DayRow, k: keyof DayRow): string => {
    const v = row[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const col = COLS.find(c => c.key === k);
    return col ? col.format(v) : String(v);
  };

  // === Best-day summary + pattern recognition ===
  const best = data.days[0];
  const ord = (n: number, unit: string) => n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + (unit ? ' ' + unit : '');
  const pct = (n: number) => n.toFixed(1) + '%';

  // Используем готовый successFormula (Q25/Q50/Q75) от backend — больше нет
  // широких min–max диапазонов вроде «825 ₽ – 2 773 ₽».
  const formulaByMetric = new Map((data.successFormula ?? []).map(f => [f.metric, f]));
  const formulaLine = (
    metric: keyof DayRow,
    fmt: (v: number) => string,
    label: string,
  ): string | null => {
    const f = formulaByMetric.get(metric as string);
    if (!f) return null;
    if (f.label === 'stable') {
      return `${label} стабильно ~${fmt(f.p50)}`;
    }
    return `${label} ~${fmt(f.p50)} (типично ${fmt(f.p25)} – ${fmt(f.p75)})`;
  };

  return (
    <div>
      <div className="text-xs font-medium text-slate-700 mb-1">Лучшая комбинация — топ-5 самых результативных дней</div>
      <div className="text-[11px] text-slate-500 mb-2">
        Какие были метрики в дни максимальной выручки. Сравните с обычными днями.
      </div>

      {/* Best-day summary с явными цифрами */}
      <div className="rounded-md border-2 border-emerald-300 bg-emerald-50 p-3 mb-3">
        <div className="text-xs font-semibold text-emerald-900 mb-1.5">
          ★ Лучший день: {best.date}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1 text-[11px] text-slate-800">
          {best.salesRub != null && <Fact label="Продажи" value={ord(best.salesRub, '₽')} />}
          {best.ordersCount != null && <Fact label="Заказы" value={ord(best.ordersCount, 'шт')} />}
          {best.finishedPriceRub != null && <Fact label="Цена" value={ord(best.finishedPriceRub, '₽/шт')} />}
          {best.drrPercent != null && <Fact label="ДРР" value={pct(best.drrPercent)} />}
          {best.advSpendRub != null && <Fact label="Реклама" value={ord(best.advSpendRub, '₽')} />}
          {best.ctrPercent != null && <Fact label="CTR" value={pct(best.ctrPercent)} />}
          {best.stockQty != null && <Fact label="Остаток" value={ord(best.stockQty, 'шт')} />}
        </div>
      </div>

      {/* Pattern recognition — медиана + IQR по топ-30% дней */}
      {(data.successFormula?.length ?? 0) > 0 && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 mb-3">
          <div className="text-xs font-semibold text-slate-800 mb-1">📐 Формула успешных дней</div>
          <div className="text-[11px] text-slate-700 space-y-0.5">
            {(() => {
              const lines = [
                formulaLine('finishedPriceRub', v => ord(v, '₽'), 'Цена'),
                formulaLine('drrPercent',       pct,             'ДРР'),
                formulaLine('advSpendRub',      v => ord(v, '₽'), 'Реклама'),
                formulaLine('ctrPercent',       pct,             'CTR'),
                formulaLine('stockQty',         v => ord(v, 'шт'),'Остаток'),
              ].filter((l): l is string => l != null);
              return lines.map((l, i) => <div key={i}>• <b>{l}</b></div>);
            })()}
          </div>
          <div className="text-[11px] text-emerald-800 mt-1.5 font-medium">
            💡 Воспроизведите эти параметры в текущем дне — это управляемый рост.
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-slate-50 text-slate-700">
              <th className="px-2 py-1.5 text-left font-semibold">Дата</th>
              {COLS.map(c => (
                <th key={c.key} className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                  {metricLabel(c.key as string).replace(/\s\(.*?\)/, '')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.days.map((d, i) => (
              <tr key={d.date} className={i === 0 ? 'bg-emerald-50/50 font-medium' : ''}>
                <td className="px-2 py-1.5 font-mono text-slate-700 whitespace-nowrap">
                  {i === 0 && <span className="text-emerald-700 mr-1">★</span>}
                  {d.date}
                </td>
                {COLS.map(c => (
                  <td key={c.key} className="px-2 py-1.5 text-right text-slate-700 whitespace-nowrap">{fmt(d, c.key)}</td>
                ))}
              </tr>
            ))}
            {/* Строка средних значений за период для сравнения */}
            <tr className="border-t border-slate-200 bg-slate-50 text-slate-500 italic">
              <td className="px-2 py-1.5">в среднем за период</td>
              {COLS.map(c => {
                const avg = data.averagesOverPeriod?.[c.key as string];
                if (typeof avg !== 'number' || !Number.isFinite(avg)) {
                  return <td key={c.key} className="px-2 py-1.5 text-right">—</td>;
                }
                return <td key={c.key} className="px-2 py-1.5 text-right whitespace-nowrap">{c.format(avg)}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {data.commentary?.length > 0 && (
        <div className="mt-2 space-y-1">
          {data.commentary.map((c, i) => (
            <div key={i} className="text-xs text-indigo-700 font-medium leading-snug">💡 {c}</div>
          ))}
        </div>
      )}

      <Explainer
        read={
          <span>
            Топ-5 дней по сумме продаж за выбранный период. <b>★ — самый результативный день</b>.
            Внизу — средние значения по всему периоду для сравнения. Если в лучшие дни цена / ДРР /
            CTR заметно отличаются от средних — вы нашли формулу.
          </span>
        }
        use={
          <ul className="list-disc list-inside space-y-0.5">
            <li>Найдите общий <b>паттерн</b> у топ-5 дней: похожая цена? одинаковый низкий ДРР? полный остаток?</li>
            <li>Если у топ-дней <b>цена ниже средней</b> — попробуйте удерживать эту цену дольше (особенно вне акций).</li>
            <li>Если у топ-дней <b>остатки на максимуме</b> — out-of-stock вы теряете часть продаж. Скорректируйте план поставок.</li>
            <li>Если у топ-дней <b>ДРР ниже среднего, а заказов больше</b> — реклама работает в этом ценовом окне; разгоняйте бюджет на похожие дни.</li>
            <li>Воспроизведите параметры лучшего дня в текущем — это и есть управляемый рост.</li>
          </ul>
        }
        defaultOpen
      />
    </div>
  );
}
