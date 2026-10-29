'use client';

/**
 * AbPhotoTimeline — график «до/после» по дням для A/B-теста фото.
 *
 * Каждая линия — один вариант (A, B, ...). Переключатель выбирает метрику.
 * Дневные числа считаются на бэке (`/ab-photo/:ws/:testId/timeline`) с
 * пропорциональным делением орendnts по времени активности варианта в день.
 * Если за день вариант не был активен — точка не показывается.
 */

import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts';
import { Card, CardContent } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';

interface DaySlice {
  views: number;
  openCard?: number;
  cart: number;
  orders: number;
  revenueRub: number;
  adSpendRub?: number;
}

interface TimelineRow {
  date: string;
  baseline?: DaySlice;
  [variant: string]: DaySlice | string | undefined;
}

interface TimelineResponse {
  ok: boolean;
  timeline: TimelineRow[];
  variants: string[];
  testStart: string; // YYYY-MM-DD
}

type MetricKey = 'orders' | 'views' | 'cart' | 'revenueRub';

const METRIC_OPTIONS: Array<{ k: MetricKey; l: string; unit: string }> = [
  { k: 'orders',     l: 'Заказы',  unit: 'шт' },
  { k: 'revenueRub', l: 'Выручка', unit: '₽' },
  { k: 'views',      l: 'Показы',  unit: 'шт' },
  { k: 'cart',       l: 'Корзины', unit: 'шт' },
];

const VARIANT_COLORS: Record<string, string> = {
  A: '#6366f1',
  B: '#f97316',
  C: '#10b981',
  D: '#ec4899',
  E: '#eab308',
};

function ruDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso;
}

interface Props {
  workspaceId: number;
  testId: number;
}

export function AbPhotoTimeline({ workspaceId, testId }: Props) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState<MetricKey>('orders');

  useEffect(() => {
    if (!workspaceId || !testId) return;
    setLoading(true);
    apiFetch<TimelineResponse>(`/ab-photo/${workspaceId}/${testId}/timeline`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [workspaceId, testId]);

  // Recharts ожидает плоский массив, преобразуем.
  // Дни ВНЕ периода теста дают `baseline` (= общие числа товара) — рисуем
  // одной серой линией. Дни ВНУТРИ периода — по линии на вариант.
  const chartData = useMemo(() => {
    if (!data?.timeline) return [];
    return data.timeline.map((row) => {
      const out: Record<string, number | string | null> = { date: ruDate(row.date as string), _iso: row.date as string };
      const b = row.baseline as DaySlice | undefined;
      out.baseline = b ? (b[metric] ?? 0) : null;
      for (const v of data.variants) {
        const slice = row[v] as DaySlice | undefined;
        out[v] = slice ? (slice[metric] ?? 0) : null;
      }
      return out;
    });
  }, [data, metric]);

  const testStartRu = useMemo(() => (data?.testStart ? ruDate(data.testStart) : null), [data]);

  // Подсчёт «активного» варианта в каждый день (для подсветки полоской снизу)
  const activeBars = useMemo(() => {
    if (!data?.timeline) return [];
    return data.timeline.map((row) => {
      const winners: string[] = [];
      for (const v of data.variants) {
        const slice = row[v] as DaySlice | undefined;
        if (slice && (slice.views > 0 || slice.orders > 0)) winners.push(v);
      }
      return { date: ruDate(row.date as string), winners };
    });
  }, [data]);

  const opt = METRIC_OPTIONS.find((o) => o.k === metric)!;
  const fmt = (v: number) => {
    if (opt.unit === '₽') return v.toLocaleString('ru-RU') + ' ₽';
    return v.toLocaleString('ru-RU');
  };

  if (loading && !data) {
    return (
      <Card><CardContent className="p-5 text-sm text-gray-500">Загрузка графика…</CardContent></Card>
    );
  }
  if (!data || data.timeline.length === 0) {
    return (
      <Card><CardContent className="p-5 text-sm text-gray-500">Нет данных для графика — тест ещё не накопил дни.</CardContent></Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">График по дням</h2>
            <p className="text-xs text-gray-500 mt-1">
              7 дней до старта (общие числа товара) — день старта теста — 7 дней после.
              В период теста числа разнесены пропорционально доле времени активности варианта.
            </p>
          </div>
          <div className="flex items-center gap-1 text-xs">
            {METRIC_OPTIONS.map((o) => (
              <button
                key={o.k}
                onClick={() => setMetric(o.k)}
                className={
                  'px-2 py-1 rounded ' +
                  (metric === o.k ? 'bg-violet-100 text-violet-700 font-medium' : 'text-gray-500 hover:bg-gray-100')
                }
              >
                {o.l}
              </button>
            ))}
          </div>
        </div>

        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" fontSize={11} tick={{ fill: '#6b7280' }} />
              <YAxis fontSize={11} tick={{ fill: '#6b7280' }} tickFormatter={(v: number) => v.toLocaleString('ru-RU')} />
              <Tooltip formatter={(v) => fmt(Number(v) || 0)} />
              <Legend iconType="line" wrapperStyle={{ fontSize: 12 }} />
              {/* Baseline — общие числа товара для дней ВНЕ периода теста.
                  Серая пунктирная линия с разрывами на днях теста (null). */}
              <Line
                type="monotone"
                dataKey="baseline"
                stroke="#94a3b8"
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={{ r: 2, fill: '#94a3b8' }}
                activeDot={{ r: 4 }}
                connectNulls={false}
                name="Без теста (товар целиком)"
              />
              {data.variants.map((v) => (
                <Line
                  key={v}
                  type="monotone"
                  dataKey={v}
                  stroke={VARIANT_COLORS[v] ?? '#888'}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                  name={`Вариант ${v}`}
                />
              ))}
              {/* Вертикальная линия — день старта теста */}
              {testStartRu && (
                <ReferenceLine
                  x={testStartRu}
                  stroke="#a855f7"
                  strokeDasharray="3 3"
                  strokeWidth={2}
                  label={{
                    value: 'Старт',
                    position: 'top',
                    fill: '#7c3aed',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Полоса под графиком — какой вариант был активен в день */}
        <div className="flex gap-0.5 mt-2">
          {activeBars.map((b) => (
            <div key={b.date} className="flex-1 flex flex-col gap-0.5" title={`${b.date}: ${b.winners.join(', ') || 'нет активности'}`}>
              {b.winners.map((w) => (
                <div
                  key={w}
                  className="h-1 rounded"
                  style={{ background: VARIANT_COLORS[w] ?? '#ccc' }}
                />
              ))}
              {b.winners.length === 0 && <div className="h-1 rounded bg-gray-100" />}
            </div>
          ))}
        </div>
        <div className="text-[11px] text-gray-400 flex justify-between">
          <span>{activeBars[0]?.date}</span>
          <span>{activeBars[activeBars.length - 1]?.date}</span>
        </div>
      </CardContent>
    </Card>
  );
}
