'use client';

import { CheckCircle2, X, Sparkles, AlertTriangle, Zap, Hourglass } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Пороги «достаточности» данных, чтобы вообще заявлять победителя.
 * Ниже — карточки «Победитель / Лучший проигравший» не показываем,
 * заменяем шапку на «Идёт сбор данных». Фидбек оператора 2026-06-08:
 * «по 30 просмотров — какой ещё победитель?».
 *
 * Цифры выбраны как минимально пригодные для z-теста двух пропорций
 * при типичных конверсиях 2-5%: меньше 200 показов = шанс ошибиться
 * больше 30%, меньше 10 заказов суммарно = доверительный интервал
 * шире самой средней.
 */
const MIN_VIEWS_FOR_VERDICT = 200;
const MIN_ORDERS_FOR_VERDICT = 10;

type VariantStats = {
  viewCount: number;
  openCardCount: number;
  cartCount?: number;
  orderCount: number;
  revenueKopecks: number;
  ctrOpen: number | null;
  ctrOrder: number | null;
  cartFromOpen?: number | null;
  orderFromCart?: number | null;
  adViews?: number;
  adClicks?: number;
  adSpendKopecks?: number;
  adOrders?: number;
  adOrdersRubKopecks?: number;
  adCtr?: number | null;
  drr?: number | null;
};

type Forecast = {
  testDays: number;
  monthlyOrders: number;
  priceRubAvg: number;
  monthlyRevenueRub: number;
};

type Significance = { pValue: number | null; confidencePct: number | null; significant: boolean };

interface Props {
  winner: string;
  /** All variant labels in display order (e.g. ['A','B','C']). */
  labels: string[];
  /** Photo URL per variant — used to render the variant thumbnail. */
  photoByVariant: Record<string, string | null>;
  stats: Record<string, VariantStats>;
  forecast: Record<string, Forecast>;
  significance: Significance | null;
  /** Winner vs each other variant (CR1 z-test). Keyed by loser label. */
  pairwiseSignificance: Record<string, Significance>;
  /** Variant that wins by CTR — may differ from `winner` (which uses goal). */
  systemWinnerCtr: string | null;
  /** Variant that wins by orders (CR1). */
  realWinnerOrders: string | null;
}

const fmtPct = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;

const fmtRub = (rub: number) => {
  if (!Number.isFinite(rub)) return '—';
  return new Intl.NumberFormat('ru-RU').format(Math.round(rub)) + ' ₽';
};

const fmtInt = (n: number) => new Intl.NumberFormat('ru-RU').format(Math.round(n));

const pctDelta = (winner: number, loser: number): number | null => {
  if (loser <= 0) return null;
  return ((winner - loser) / loser) * 100;
};

export function WinnerReport({
  winner, labels, photoByVariant, stats, forecast, significance, pairwiseSignificance,
  systemWinnerCtr, realWinnerOrders,
}: Props) {
  const w = stats[winner];
  const fw = forecast[winner];
  // Best loser = highest CR1 among non-winners (the meaningful comparison).
  const loserLabel = labels.filter((l) => l !== winner).reduce<string | null>((acc, l) => {
    if (!acc) return l;
    const cr = stats[l]?.ctrOrder ?? 0;
    const accCr = stats[acc]?.ctrOrder ?? 0;
    return cr > accCr ? l : acc;
  }, null);
  const loser = loserLabel ? stats[loserLabel] : null;
  const fl = loserLabel ? forecast[loserLabel] : null;

  const ctrDelta = loser ? pctDelta(w.ctrOpen ?? 0, loser.ctrOpen ?? 0) : null;
  const ordersDelta = loser ? pctDelta(w.orderCount, loser.orderCount) : null;
  const crDelta = loser ? pctDelta(w.ctrOrder ?? 0, loser.ctrOrder ?? 0) : null;

  const totalViews = labels.reduce((s, l) => s + (stats[l]?.viewCount ?? 0), 0);
  const totalOrders = labels.reduce((s, l) => s + (stats[l]?.orderCount ?? 0), 0);

  // Достаточно ли данных, чтобы вообще заявлять победителя.
  // Если нет — показываем только сводную таблицу и подсказку «нужно больше
  // данных». Карточки «Победитель / Лучший проигравший» и баннеры скрываются.
  const enoughData = totalViews >= MIN_VIEWS_FOR_VERDICT && totalOrders >= MIN_ORDERS_FOR_VERDICT;

  // Show "system vs real winner" notice only when they actually disagree.
  const winnersDisagree =
    systemWinnerCtr && realWinnerOrders && systemWinnerCtr !== realWinnerOrders;

  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {enoughData ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : (
            <Hourglass className="h-5 w-5 text-amber-600" />
          )}
          <h3 className="text-base font-semibold text-gray-900">
            {enoughData
              ? 'Автоматический победитель по итоговой статистике'
              : 'Идёт сбор данных'}
          </h3>
        </div>
      </div>

      <div className="mb-4 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
        Сравнение {labels.length} вариантов · {fmtInt(totalViews)} показов · {fmtInt(totalOrders)} заказов
      </div>

      {!enoughData && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div>
            Чтобы достоверно выбрать победителя, нужно минимум {MIN_VIEWS_FOR_VERDICT} показов и {MIN_ORDERS_FOR_VERDICT} заказов суммарно.
            Сейчас данных мало — числа в таблице могут поменяться. Пусть тест поработает ещё несколько дней.
          </div>
        </div>
      )}

      {/* All-variants table — глаз падает на колонку победителя, остальные подсвечены побледнее.
          Показываем воронку (открытия → заказы → % заказов) + рекламные метрики (CTR/ДРР).
          % выкупа намеренно не выводим — оператор попросил не использовать. */}
      {(() => {
        const hasAdImpressions = labels.some((l) => (stats[l]?.adViews ?? 0) > 0);
        const hasAdSpend = labels.some((l) => (stats[l]?.adSpendKopecks ?? 0) > 0);
        return (
      <div className="mb-4 overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Вариант</th>
              <th className="px-2 py-2 text-right font-medium" title="Открытия карточки (WB API)">Открытий</th>
              <th className="px-2 py-2 text-right font-medium">В корзину</th>
              <th className="px-2 py-2 text-right font-medium" title="Корзина / открытие">→ % в корзину</th>
              <th className="px-2 py-2 text-right font-medium">Заказов</th>
              <th className="px-2 py-2 text-right font-medium" title="Заказ / корзина">→ % выкупа корзины</th>
              {hasAdImpressions && (
                <th className="px-2 py-2 text-right font-medium" title="Рекламный CTR: клики / показы (WB Adv API)">Рекл. CTR</th>
              )}
              {hasAdSpend && (
                <th className="px-2 py-2 text-right font-medium" title="ДРР = рекл. расход / выручка">ДРР</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {labels.map((l) => {
              const s = stats[l] ?? null;
              if (!s) return null;
              const isWinner = l === winner;
              const isSysCtr = l === systemWinnerCtr;
              const isRealOrders = l === realWinnerOrders;
              return (
                <tr key={l} className={cn(isWinner ? 'bg-emerald-50/40' : 'hover:bg-gray-50')}>
                  <td className="px-2 py-2 font-semibold">
                    <span className={cn('inline-flex items-center gap-1', isWinner ? 'text-emerald-700' : 'text-gray-700')}>
                      {isWinner && <CheckCircle2 className="h-3.5 w-3.5" />}
                      Вариант {l}
                    </span>
                    {(isSysCtr || isRealOrders) && (
                      <div className="mt-0.5 flex gap-1 text-[10px] text-gray-500">
                        {isSysCtr && <span className="rounded bg-indigo-100 px-1 py-0.5 text-indigo-700">по % заказов</span>}
                        {isRealOrders && <span className="rounded bg-violet-100 px-1 py-0.5 text-violet-700">по заказам</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtInt(s.openCardCount)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtInt(s.cartCount ?? 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{s.cartFromOpen != null ? fmtPct(s.cartFromOpen, 1) : '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-medium">{fmtInt(s.orderCount)}</td>
                  <td className={cn('px-2 py-2 text-right tabular-nums font-medium', isRealOrders && 'text-violet-700')}>{s.orderFromCart != null ? fmtPct(s.orderFromCart, 1) : '—'}</td>
                  {hasAdImpressions && (
                    <td className="px-2 py-2 text-right tabular-nums">{s.adCtr != null ? fmtPct(s.adCtr, 2) : '—'}</td>
                  )}
                  {hasAdSpend && (
                    <td className="px-2 py-2 text-right tabular-nums">{s.drr != null ? fmtPct(s.drr, 1) : '—'}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
        );
      })()}

      {/* Winner vs best-loser comparison cards — только при достаточной выборке */}
      {enoughData && loserLabel && loser && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <VariantCard kind="winner" label={`Победитель · Вариант ${winner}`} stats={w} photoUrl={photoByVariant[winner] ?? null} />
          <VariantCard kind="loser" label={`Лучший проигравший · Вариант ${loserLabel}`} stats={loser} photoUrl={photoByVariant[loserLabel] ?? null} />
        </div>
      )}

      {/* Big delta tiles (Sellium style) */}
      {enoughData && (ctrDelta != null || ordersDelta != null || crDelta != null) && (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {ctrDelta != null && <DeltaTile label="CTR" value={ctrDelta} />}
          {crDelta != null && <DeltaTile label="% показ→корзина" value={crDelta} />}
          {ordersDelta != null && <DeltaTile label="корзины" value={ordersDelta} />}
        </div>
      )}

      {/* Hint about variant comparison */}
      {enoughData && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-gray-800">
            {loserLabel ? (
              <>Победитель — <b>Вариант {winner}</b>. Сравнение с лучшим из остальных (Вариант {loserLabel}).</>
            ) : (
              <>Победитель — <b>Вариант {winner}</b>.</>
            )}
          </div>
        </div>
      )}

      {/* System vs real winner — only when they disagree */}
      {enoughData && winnersDisagree && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
          <div>
            <b>Победитель по % заказов — Вариант {systemWinnerCtr}</b>{' '}
            ({fmtPct(stats[systemWinnerCtr!]?.ctrOrder, 2)}).
            {' '}<b>Победитель по числу заказов — Вариант {realWinnerOrders}</b>{' '}
            ({fmtInt(stats[realWinnerOrders!]?.orderCount)} vs {fmtInt(stats[systemWinnerCtr!]?.orderCount)}).
            <div className="mt-1 text-xs text-indigo-700/80">
              На малом числе показов % заказов важнее абсолютов — он не зависит от длительности фазы.
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function VariantCard({
  kind, label, stats, photoUrl,
}: { kind: 'winner' | 'loser'; label: string; stats: VariantStats; photoUrl: string | null }) {
  const isWinner = kind === 'winner';
  return (
    <div className={cn(
      'rounded-lg border-2 p-3',
      isWinner ? 'border-emerald-500 bg-emerald-50/40' : 'border-rose-300 bg-rose-50/30'
    )}>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
        {isWinner ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <X className="h-3.5 w-3.5 text-rose-500" />}
        <span className={isWinner ? 'text-emerald-700' : 'text-rose-600'}>{label}</span>
      </div>
      {photoUrl && (
        <div className="mb-3 aspect-[3/4] overflow-hidden rounded-md bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl} alt="" className="h-full w-full object-cover" />
        </div>
      )}
      <div className={cn(
        'grid grid-cols-3 gap-1 text-center',
        isWinner ? 'text-emerald-700' : 'text-rose-600'
      )}>
        <div>
          <div className="text-lg font-bold">{fmtPct(stats.ctrOpen, 2)}</div>
          <div className="text-[10px] text-gray-500">CTR</div>
        </div>
        <div>
          <div className="text-lg font-bold">{fmtInt(stats.orderCount)}</div>
          <div className="text-[10px] text-gray-500">корзины</div>
        </div>
        <div>
          <div className="text-lg font-bold">{fmtPct(stats.ctrOrder, 1)}</div>
          <div className="text-[10px] text-gray-500">% корзин</div>
        </div>
      </div>
    </div>
  );
}

function DeltaTile({ label, value }: { label: string; value: number }) {
  const positive = value > 0;
  return (
    <div className={cn(
      'rounded-lg px-3 py-2 text-center',
      positive ? 'bg-violet-50' : 'bg-rose-50'
    )}>
      <div className={cn('text-lg font-bold', positive ? 'text-violet-700' : 'text-rose-700')}>
        {positive ? '+' : ''}{value.toFixed(0)}%
      </div>
      <div className="text-[11px] text-gray-600">{label}</div>
    </div>
  );
}

