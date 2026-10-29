'use client';

import { useMemo, useState } from 'react';
import { formatNumber, formatNumberShort, formatRub, formatRubShort } from '@/lib/format';

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

type DayCell = {
  date: string; // YYYY-MM-DD
  value: number;
  deltaPct?: number; // vs previous day
  planPct?: number; // plan/fact in percent (0-200)
  anomaly?: 'low' | 'high';
};

type MetricRow = {
  key: string;
  label: string;
  unit?: 'шт' | '₽' | '%';
  values: DayCell[];
};

type ProductRow = {
  id: string;
  title: string;
  vendorCode: string;
  imageUrl: string;
  metrics: MetricRow[];
};

const PRESET_DAYS = [7, 14, 30, 60] as const;

type Density = 'compact' | 'comfortable' | 'spacious';

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function heatColor(deltaPct: number | undefined) {
  // green for growth, red for decline. Keep it subtle.
  if (deltaPct == null || !Number.isFinite(deltaPct)) return 'bg-transparent';
  const v = clamp(deltaPct, -60, 60);
  const a = Math.abs(v) / 60; // 0..1

  // Use Tailwind arbitrary rgba values.
  if (v > 0) return `bg-[rgba(34,197,94,${0.10 + 0.25 * a})]`; // green-500
  if (v < 0) return `bg-[rgba(239,68,68,${0.10 + 0.25 * a})]`; // red-500
  return 'bg-transparent';
}

function formatVal(n: number, mode: 'full' | 'short', unit?: MetricRow['unit']) {
  if (unit === '₽') return mode === 'short' ? formatRubShort(n) : formatRub(n);
  if (unit === '%') return `${Math.round(n)}%`;
  return mode === 'short' ? formatNumberShort(n) : formatNumber(n);
}

export function PulseMatrixPreview() {
  const [days, setDays] = useState<(typeof PRESET_DAYS)[number]>(30);
  const [showUnits, setShowUnits] = useState(true);
  const [numberMode, setNumberMode] = useState<'full' | 'short'>('short');
  const [density, setDensity] = useState<Density>('comfortable');
  const [mode, setMode] = useState<'heatmap' | 'delta' | 'anomaly'>('heatmap');
  const [query, setQuery] = useState('');
  const [selectedVendorCode, setSelectedVendorCode] = useState<string>('');

  const sample = useMemo<ProductRow[]>(() => {
    // Deterministic sample for UI preview. Replace with real API later.
    const today = new Date();
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    function mkSeries(seed: number, unit: MetricRow['unit']): DayCell[] {
      const out: DayCell[] = [];
      let prev = seed;
      for (let i = 0; i < dates.length; i++) {
        // pseudo-random walk
        const drift = Math.sin((i + seed) / 3) * 0.12;
        const noise = Math.sin((i + 1) * (seed % 7)) * 0.08;
        const mult = 1 + drift + noise;
        const next = Math.max(0, prev * mult);
        const value = unit === '₽' ? Math.round(next) : Math.round(next);
        const deltaPct = i === 0 || prev === 0 ? 0 : ((value - prev) / prev) * 100;
        const planPct = unit === 'шт' ? clamp(90 + Math.sin(i / 5) * 40, 0, 200) : undefined;

        let anomaly: DayCell['anomaly'] = undefined;
        if (Math.abs(deltaPct) > 25) anomaly = deltaPct > 0 ? 'high' : 'low';

        out.push({ date: dates[i], value, deltaPct, planPct, anomaly });
        prev = Math.max(1, value);
      }
      return out;
    }

    const products: ProductRow[] = [
      {
        id: 'p:summary',
        title: 'Общая сводка',
        vendorCode: 'ALL',
        imageUrl: '',
        metrics: [
          { key: 'orders', label: 'Заказы', unit: 'шт', values: mkSeries(120, 'шт') },
          { key: 'sales', label: 'Продажи', unit: 'шт', values: mkSeries(95, 'шт') },
          { key: 'margin', label: 'Маржа', unit: '₽', values: mkSeries(340000, '₽') },
          { key: 'ads', label: 'Рекл. расход', unit: '₽', values: mkSeries(48000, '₽') },
        ],
      },
      {
        id: 'p:1',
        title: 'Кулон из металла, цвет жёлтый',
        vendorCode: 'BK216-04',
        imageUrl: 'https://picsum.photos/seed/bk216/64/64',
        metrics: [
          { key: 'orders', label: 'Заказы', unit: 'шт', values: mkSeries(8, 'шт') },
          { key: 'sales', label: 'Продажи', unit: 'шт', values: mkSeries(6, 'шт') },
          { key: 'margin', label: 'Маржа', unit: '₽', values: mkSeries(1800, '₽') },
          { key: 'ads', label: 'Рекл. расход', unit: '₽', values: mkSeries(300, '₽') },
        ],
      },
      {
        id: 'p:2',
        title: 'Кулон “Сатурн”',
        vendorCode: 'SATURN-2',
        imageUrl: 'https://picsum.photos/seed/saturn/64/64',
        metrics: [
          { key: 'orders', label: 'Заказы', unit: 'шт', values: mkSeries(5, 'шт') },
          { key: 'sales', label: 'Продажи', unit: 'шт', values: mkSeries(4, 'шт') },
          { key: 'margin', label: 'Маржа', unit: '₽', values: mkSeries(1400, '₽') },
          { key: 'ads', label: 'Рекл. расход', unit: '₽', values: mkSeries(220, '₽') },
        ],
      },
    ];

    return products;
  }, [days]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sample.filter((p) => {
      if (p.vendorCode === 'ALL') return true;
      if (selectedVendorCode && p.vendorCode !== selectedVendorCode) return false;
      if (!q) return true;
      return p.title.toLowerCase().includes(q) || p.vendorCode.toLowerCase().includes(q);
    });
  }, [sample, query, selectedVendorCode]);

  const dayHeaders = sample[0]?.metrics[0]?.values.map((v) => v.date.slice(5)) ?? [];

  const densityCls =
    density === 'compact'
      ? 'text-[11px]'
      : density === 'spacious'
        ? 'text-[13px]'
        : 'text-[12px]';

  const cellPad =
    density === 'compact'
      ? 'px-1.5 py-1'
      : density === 'spacious'
        ? 'px-2.5 py-2'
        : 'px-2 py-1.5';

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--card-border)] bg-[var(--card-bg)] p-4 shadow-[var(--card-shadow)]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-slate-500">Период</div>
              <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
                {PRESET_DAYS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    className={cn(
                      'rounded-lg px-3 py-1 text-sm font-medium transition',
                      days === d ? 'bg-white shadow-sm' : 'text-slate-600 hover:bg-white'
                    )}
                  >
                    {d}д
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-slate-500">Артикул</div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по названию / артикулу продавца"
                className="h-10 w-[360px] rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-slate-300"
              />
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-slate-500">Быстрый выбор</div>
              <select
                value={selectedVendorCode}
                onChange={(e) => setSelectedVendorCode(e.target.value)}
                className="h-10 w-[180px] rounded-xl border border-slate-200 bg-white px-3 text-sm"
              >
                <option value="">Все товары</option>
                {sample
                  .filter((p) => p.vendorCode !== 'ALL')
                  .map((p) => (
                    <option key={p.vendorCode} value={p.vendorCode}>
                      {p.vendorCode}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {([
                ['heatmap', 'Теплокарта'],
                ['delta', 'Дельты'],
                ['anomaly', 'Аномалии'],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setMode(k)}
                  className={cn(
                    'rounded-lg px-3 py-1 text-sm font-medium transition',
                    mode === k ? 'bg-white shadow-sm' : 'text-slate-600 hover:bg-white'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showUnits}
                  onChange={(e) => setShowUnits(e.target.checked)}
                />
                Ед.
              </label>
              <span className="h-4 w-px bg-slate-200" />
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={numberMode === 'short'}
                  onChange={(e) => setNumberMode(e.target.checked ? 'short' : 'full')}
                />
                Короткий формат
              </label>
              <span className="h-4 w-px bg-slate-200" />
              <select
                value={density}
                onChange={(e) => setDensity(e.target.value as Density)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1"
              >
                <option value="compact">Сетка: компакт</option>
                <option value="comfortable">Сетка: комфорт</option>
                <option value="spacious">Сетка: просторно</option>
              </select>
            </div>
          </div>
        </div>

        <div className="overflow-auto rounded-xl border border-slate-200">
          <table className={cn('min-w-[1100px] w-full border-collapse', densityCls)}>
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-200 text-left">
                <th className="w-[320px] px-3 py-2 text-xs font-semibold text-slate-500">Товар</th>
                <th className="w-[220px] px-3 py-2 text-xs font-semibold text-slate-500">Показатели</th>
                <th className="w-[120px] px-3 py-2 text-xs font-semibold text-slate-500">За период</th>
                <th className="w-[140px] px-3 py-2 text-xs font-semibold text-slate-500">Мини-график</th>
                {dayHeaders.map((d) => (
                  <th key={d} className="px-2 py-2 text-[11px] font-semibold text-slate-500">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {filtered.map((p) => (
                <ProductBlock
                  key={p.id}
                  p={p}
                  showUnits={showUnits}
                  numberMode={numberMode}
                  mode={mode}
                  cellPad={cellPad}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-xs text-slate-500">
          Preview: этот блок специально сделан автономным (без API), чтобы быстро увидеть “как будет ощущаться” интерфейс.
        </div>
      </div>
    </section>
  );
}

function ProductBlock({
  p,
  showUnits,
  numberMode,
  mode,
  cellPad,
}: {
  p: ProductRow;
  showUnits: boolean;
  numberMode: 'full' | 'short';
  mode: 'heatmap' | 'delta' | 'anomaly';
  cellPad: string;
}) {
  const isSummary = p.vendorCode === 'ALL';

  return (
    <>
      {p.metrics.map((m, idx) => {
        const total = m.values.reduce((acc, v) => acc + v.value, 0);

        return (
          <tr key={`${p.id}:${m.key}`} className={cn('border-b border-slate-100', isSummary && 'bg-slate-50')}>
            {idx === 0 && (
              <td rowSpan={p.metrics.length} className="px-3 py-3 align-top">
                <div className="flex gap-3">
                  <div className="h-12 w-12 overflow-hidden rounded-xl bg-slate-100">
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imageUrl} alt="" className="h-12 w-12 object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">{p.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{p.vendorCode}</div>
                  </div>
                </div>
              </td>
            )}

            <td className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-800">{m.label}</span>
                {showUnits && m.unit ? <span className="text-xs text-slate-400">{m.unit}</span> : null}
              </div>
            </td>

            <td className="px-3 py-2 text-sm font-semibold">
              {formatVal(total, numberMode, m.unit)}
            </td>

            <td className="px-3 py-2">
              <MiniSparkline values={m.values.map((v) => v.value)} />
            </td>

            {m.values.map((c) => {
              const cls =
                mode === 'heatmap'
                  ? heatColor(c.deltaPct)
                  : mode === 'anomaly'
                    ? c.anomaly === 'high'
                      ? 'bg-[rgba(34,197,94,0.20)]'
                      : c.anomaly === 'low'
                        ? 'bg-[rgba(239,68,68,0.20)]'
                        : 'bg-transparent'
                    : 'bg-transparent';

              const display =
                mode === 'delta'
                  ? `${Math.round(c.deltaPct ?? 0)}%`
                  : formatVal(c.value, numberMode, m.unit);

              const subtle = mode === 'delta' ? 'text-slate-700' : 'text-slate-800';

              return (
                <td key={c.date} className={cn('text-right tabular-nums', cellPad, subtle, cls)}>
                  {display}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}

function MiniSparkline({ values }: { values: number[] }) {
  const points = useMemo(() => {
    if (values.length === 0) return '';
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;
    return values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * 100;
        const y = 20 - ((v - min) / range) * 20;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [values]);

  return (
    <svg viewBox="0 0 100 24" className="h-6 w-28">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-300" />
    </svg>
  );
}
