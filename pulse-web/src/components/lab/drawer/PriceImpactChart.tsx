'use client';

/**
 * PriceImpactChart — scatter точек (цена × заказы) + линия тренда.
 * Никаких r / slope / intercept в UI — только человеческая подпись
 * «Каждые −100₽ ≈ +3 заказа в день».
 */

import { useEffect, useState } from 'react';
import { ResponsiveContainer, ScatterChart, Scatter, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot } from 'recharts';
import { apiFetch } from '@/lib/api';

interface PairResp {
  ok: boolean;
  scatter?: Array<{ x: number; y: number; date: string }> | null;
  regression?: { slope: number; intercept: number } | null;
  sparsity?: { verdict: string };
  correlation?: { r: number } | null;
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
  xMetric?: string;
  yMetric?: string;
  xLabel?: string;
  yLabel?: string;
}

export function PriceImpactChart({
  workspaceId, shopId, nmId, from, to,
  xMetric = 'listPriceRub', yMetric = 'ordersCount',
  xLabel = 'Цена, ₽ за 1 шт.', yLabel = 'Заказы, шт',
}: Props) {
  const [data, setData] = useState<PairResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiFetch<PairResp>(
      `/lab/${workspaceId}/pair?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}&x=${xMetric}&y=${yMetric}&withScatter=true&withLag=false`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => { if (!ac.signal.aborted) setData(d); })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [workspaceId, shopId, nmId, from, to, xMetric, yMetric]);

  if (loading) return <div className="text-xs text-slate-500 italic">Строим график…</div>;
  if (!data?.scatter || data.scatter.length < 5) {
    return <div className="text-xs text-slate-500">Недостаточно точек для графика. Попробуйте расширить период.</div>;
  }

  // === Sanity-filter ===
  // Выкидываем дни с нулевой/отрицательной ценой и точки далеко за пределами
  // медианы ±3·MAD — обычно это data-quality артефакты (агрегатные суммы вместо
  // цены за штуку, или нулевые дни).
  const rawPts = data.scatter.filter(p => p.x > 0 && Number.isFinite(p.x) && Number.isFinite(p.y));
  const droppedNegative = data.scatter.length - rawPts.length;
  const sortedX = [...rawPts.map(p => p.x)].sort((a, b) => a - b);
  const median = sortedX.length ? sortedX[Math.floor(sortedX.length / 2)] : 0;
  const absDevs = sortedX.map(x => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = absDevs.length ? absDevs[Math.floor(absDevs.length / 2)] : 0;
  // Если MAD=0 (все цены одинаковые) — не фильтруем
  const lower = mad > 0 ? median - 3 * mad : -Infinity;
  const upper = mad > 0 ? median + 3 * mad : Infinity;
  const pts = rawPts.filter(p => p.x >= lower && p.x <= upper);
  const droppedOutliers = rawPts.length - pts.length;
  const droppedTotal = droppedNegative + droppedOutliers;

  if (pts.length < 5) {
    return (
      <div className="text-xs text-slate-500">
        После очистки от выбросов осталось мало точек ({pts.length}). Расширьте период.
      </div>
    );
  }

  const xs = pts.map(p => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  // Пересчитаем регрессию по очищенным точкам — серверная игнорирует фильтр
  const n = pts.length;
  const mxAll = pts.reduce((s, p) => s + p.x, 0) / n;
  const myAll = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mxAll) * (p.y - myAll); den += (p.x - mxAll) ** 2; }
  const cleanSlope = den > 1e-12 ? num / den : 0;
  const cleanIntercept = myAll - cleanSlope * mxAll;

  const slope = cleanSlope;
  const intercept = cleanIntercept;
  const direction = slope > 0 ? 'positive' : slope < 0 ? 'negative' : 'flat';

  // ===== Цена-победитель: средняя цена в топ-30% дней по заказам =====
  const sortedByY = [...pts].sort((a, b) => b.y - a.y);
  const topCount = Math.max(3, Math.ceil(pts.length * 0.3));
  const topPts = sortedByY.slice(0, topCount);
  const winnerPrice = topPts.length
    ? topPts.reduce((s, p) => s + p.x, 0) / topPts.length
    : null;
  const winnerOrdersAvg = topPts.length
    ? topPts.reduce((s, p) => s + p.y, 0) / topPts.length
    : null;
  const allOrdersAvg = pts.length
    ? pts.reduce((s, p) => s + p.y, 0) / pts.length
    : null;
  const upliftPct = winnerOrdersAvg && allOrdersAvg && allOrdersAvg > 0
    ? Math.round(((winnerOrdersAvg - allOrdersAvg) / allOrdersAvg) * 100)
    : null;

  // ===== Прогноз: «если бы держали эту цену все дни, заказов было бы N» =====
  // Берём -10% от средней цены и считаем по тренду (только для negative slope)
  let forecastLine: string | null = null;
  if (direction === 'negative' && winnerPrice && winnerPrice > 0) {
    const target = winnerPrice * 0.9;
    const forecastY = Math.max(0, intercept + slope * target);
    const baseY = Math.max(0, intercept + slope * winnerPrice);
    const delta = forecastY - baseY;
    if (delta > 0.5) {
      forecastLine = `Если опустить до ${target.toFixed(0)}₽ — по тренду ожидаем ~${forecastY.toFixed(0)} заказов/день (+${delta.toFixed(1)} к нынешнему уровню).`;
    }
  }

  // ===== Дни-выбросы (промо/удачные акции выше тренда) =====
  const trendY = (x: number) => intercept + slope * x;
  const outliers = pts
    .map(p => ({ ...p, residual: p.y - trendY(p.x) }))
    .filter(p => p.residual > 0)
    .sort((a, b) => b.residual - a.residual)
    .slice(0, 3);

  return (
    <div>
      <div className="text-xs font-medium text-slate-700 mb-1">Как цена за 1 шт. влияла на заказы</div>
      <div className="text-[11px] text-slate-500 mb-1">
        Цена в диапазоне {minX.toFixed(0)}–{maxX.toFixed(0)} ₽ (медиана {median.toFixed(0)} ₽).{' '}
        {droppedTotal > 0 && (
          <span className="text-slate-400">
            Скрыто {droppedTotal} нетипичных дней (нулевая цена или резкий выброс).
          </span>
        )}
      </div>
      <div className="h-[240px] w-full">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 12, bottom: 28, left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis type="number" dataKey="x" name={xLabel} domain={['auto', 'auto']} tick={{ fontSize: 10 }} label={{ value: xLabel, position: 'bottom', offset: 0, fontSize: 11 }} />
            <YAxis type="number" dataKey="y" name={yLabel} tick={{ fontSize: 10 }} label={{ value: yLabel, angle: -90, position: 'left', offset: 0, fontSize: 11 }} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              formatter={(value) => [Number(value).toLocaleString('ru-RU'), '']}
              labelFormatter={(_, payload) => {
                const d = (payload?.[0] as { payload?: { date: string } } | undefined)?.payload?.date;
                return d ? `Дата: ${d}` : '';
              }}
            />
            <Scatter data={pts} fill="#6366f1" />
            {data.regression && (
              <ReferenceLine
                stroke="#ef4444"
                strokeWidth={2}
                segment={[
                  { x: minX, y: intercept + slope * minX },
                  { x: maxX, y: intercept + slope * maxX },
                ]}
              />
            )}
            {/* Цена-победитель — вертикальная зелёная линия */}
            {winnerPrice && (
              <ReferenceLine
                x={winnerPrice}
                stroke="#10b981"
                strokeDasharray="3 3"
                strokeWidth={2}
                label={{ value: 'победитель', position: 'top', fill: '#10b981', fontSize: 10 }}
              />
            )}
            {/* Дни-выбросы — оранжевые точки */}
            {outliers.map((o, i) => (
              <ReferenceDot
                key={i}
                x={o.x}
                y={o.y}
                r={6}
                fill="#f59e0b"
                stroke="#fff"
                strokeWidth={1.5}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Главный вывод — Цена-победитель */}
      {winnerPrice != null && winnerOrdersAvg != null && (
        <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-xs">
          <div className="font-semibold text-emerald-900">
            🏆 Цена-победитель: {winnerPrice.toFixed(0)} ₽ / шт.
          </div>
          <div className="text-emerald-800 mt-0.5">
            Средняя цена в дни с лучшими заказами (~{winnerOrdersAvg.toFixed(1)} шт/день
            {upliftPct != null && upliftPct > 0 ? ` — это +${upliftPct}% к среднему` : ''}).
          </div>
          {forecastLine && (
            <div className="text-emerald-800 mt-1">📈 {forecastLine}</div>
          )}
        </div>
      )}

      {outliers.length > 0 && (
        <div className="mt-2 text-[11px] text-amber-700">
          🟠 Оранжевые точки — дни выше тренда: {outliers.map(o => o.date).join(', ')}.
          Загляните в Календарь Событий — что там было: акция, смена фото, наплыв трафика?
        </div>
      )}

      {direction === 'flat' && (
        <div className="mt-2 text-xs text-slate-700">
          Цена слабо влияет на заказы — драйвер в другом. Смотрите CTR / охват / позиции.
        </div>
      )}
      {direction === 'positive' && (
        <div className="mt-2 text-xs text-amber-700">
          Нетипичная связь (рост цены = рост заказов): часто это совпадение с акциями WB
          или «эффект Veblen». Сравните с Календарём Событий.
        </div>
      )}
    </div>
  );
}
