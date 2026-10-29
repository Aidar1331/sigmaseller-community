'use client';

/**
 * MetricRelationsGrid — упрощённая матрица связей. Без r / p / q — только
 * цветовые ярлыки «сильная / умеренная / слабая / нет».
 */

import { useEffect, useState, type ReactElement } from 'react';
import { apiFetch } from '@/lib/api';
import { metricLabel, strengthLabel, strengthColor } from '../i18n';

interface Cell {
  x: string;
  y: string;
  r: number | null;
  q: number | null;
  n: number;
  significant: boolean;
  sparsity: string;
}

interface MatrixResp {
  ok: boolean;
  metrics: string[];
  cells: Cell[];
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
  /** До 8 метрик — сокращает трафик */
  metrics?: string[];
}

const DEFAULT_METRICS = [
  'ordersCount', 'finishedPriceRub', 'ctrPercent', 'crPercent',
  'advSpendRub', 'drrPercent', 'stockQty', 'marginPct',
];

function bucketOfR(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return 'weak';
  const a = Math.abs(r);
  const sign = r >= 0 ? '+' : '-';
  if (a >= 0.7) return `strong${sign}`;
  if (a >= 0.3) return `moderate${sign}`;
  return 'weak';
}

const CELL_COLORS: Record<'green' | 'blue' | 'amber' | 'slate', string> = {
  green: 'bg-emerald-200 text-emerald-900',
  blue: 'bg-sky-200 text-sky-900',
  amber: 'bg-amber-100 text-amber-900',
  slate: 'bg-slate-100 text-slate-500',
};

export function MetricRelationsGrid({ workspaceId, shopId, nmId, from, to, metrics = DEFAULT_METRICS }: Props) {
  const [data, setData] = useState<MatrixResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiFetch<MatrixResp>(
      `/lab/${workspaceId}/matrix?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}&metrics=${metrics.join(',')}`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => { if (!ac.signal.aborted) setData(d); })
      .catch(e => { if (!ac.signal.aborted) setError((e as Error).message); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [workspaceId, shopId, nmId, from, to, metrics.join(',')]);

  if (loading) return <div className="text-xs text-slate-500 italic">Считаем связи между метриками…</div>;
  if (error) return <div className="text-xs text-rose-600">Не удалось загрузить: {error}</div>;
  if (!data || !data.metrics?.length) return null;

  const byPair = new Map<string, Cell>();
  for (const c of data.cells) {
    byPair.set(`${c.x}|${c.y}`, c);
    byPair.set(`${c.y}|${c.x}`, c);
  }

  return (
    <div className="overflow-auto">
      <table className="text-xs border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white" />
            {data.metrics.map(m => (
              <th key={m} className="px-1 py-0.5 text-[10px] font-medium text-slate-600 whitespace-nowrap rotate-[-30deg] origin-bottom-left h-16 align-bottom">
                {metricLabel(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.metrics.map(mx => (
            <tr key={mx}>
              <td className="sticky left-0 bg-white pr-2 text-[11px] font-medium text-slate-700 whitespace-nowrap">
                {metricLabel(mx)}
              </td>
              {data.metrics.map(my => {
                if (mx === my) return <td key={my} className="h-8 w-16 bg-slate-50 rounded" />;
                const c = byPair.get(`${mx}|${my}`);
                if (!c || c.sparsity === 'blocked' || c.r === null) {
                  return <td key={my} className="h-8 w-16 bg-slate-50 rounded text-center text-[10px] text-slate-400" title="Мало данных">—</td>;
                }
                const bucket = bucketOfR(c.r);
                const color = strengthColor(bucket);
                const label = strengthLabel(bucket);
                const star = c.significant ? '★' : '';
                return (
                  <CellWithTooltip
                    key={my}
                    cell={c}
                    label={label}
                    star={star}
                    cellClass={`h-8 w-16 rounded text-center text-[10px] font-medium ${CELL_COLORS[color]}`}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[10px] text-slate-500">
        ★ — связь надёжно подтверждена. «—» — данных по паре недостаточно.
      </div>

      {/* Главные выводы — генерируются по реальным значимым связям */}
      {data && <MatrixOutcomes cells={data.cells} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CellWithTooltip — кастомный hover-popover в таблице. Показывает совет
// прямо при наведении, не заставляя скроллить вниз к Outcomes.
// ---------------------------------------------------------------------------

function CellWithTooltip({
  cell, label, star, cellClass,
}: {
  cell: Cell;
  label: string;
  star: string;
  cellClass: string;
}) {
  const [hover, setHover] = useState(false);
  const advice = cell.r != null ? pickAction(cell.x, cell.y, cell.r) : null;
  const sigBadge = cell.significant ? '★ надёжно подтверждено' : '⚠ требует подтверждения';

  return (
    <td
      className={`relative ${cellClass}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {label}{star ? ` ${star}` : ''}
      {hover && (
        <div className="absolute z-30 left-1/2 -translate-x-1/2 top-full mt-1 w-72 bg-white border border-slate-300 shadow-lg rounded-md p-3 text-left text-[11px] text-slate-800 leading-snug whitespace-normal">
          <div className="font-semibold text-slate-900">
            {metricLabel(cell.x)} ↔ {metricLabel(cell.y)}
          </div>
          <div className="text-[10px] text-slate-500 mb-1.5">{sigBadge}</div>
          {advice ? (
            <>
              <div className="mb-1">
                <span className="font-semibold text-emerald-700">✅ Что делать:</span> {advice.doIt}
              </div>
              {advice.example && (
                <div className="mb-1 text-slate-600 italic">Пример: {advice.example}</div>
              )}
              {advice.dont && (
                <div>
                  <span className="font-semibold text-rose-700">⛔ Чего НЕ делать:</span> {advice.dont}
                </div>
              )}
            </>
          ) : (
            <div className="text-slate-500">Для этой пары метрик автоматическая рекомендация не сформулирована.</div>
          )}
        </div>
      )}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Auto-выводы: AI генерирует за пользователя, пользователю не нужно искать связи
// ---------------------------------------------------------------------------

interface OutcomesProps { cells: Cell[] }

function MatrixOutcomes({ cells }: OutcomesProps) {
  // Расширяем порог: показываем все пары |r|≥0.3 (сильные + умеренные),
  // даже если FDR не подтвердил — помечаем «требует подтверждения».
  const moderate = cells.filter(c => c.r != null && Math.abs(c.r) >= 0.3);
  const ordered = moderate
    .sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0))
    .map(c => ({ cell: c, advice: pickAction(c.x, c.y, c.r as number) }))
    .filter(x => x.advice != null)
    .slice(0, 6);

  if (ordered.length === 0) {
    return (
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <div className="font-semibold mb-1">📊 Главные выводы по вашему товару</div>
        За выбранный период связей силы хотя бы &laquo;умеренная&raquo; не найдено — товар стабилен,
        либо данных мало. Попробуйте увеличить период до 60–90 дней.
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs">
      <div className="font-semibold text-emerald-900 mb-1.5">📊 Главные выводы по вашему товару</div>
      <ul className="space-y-2.5">
        {ordered.map(({ cell, advice }, i) => {
          const r = cell.r as number;
          const strong = Math.abs(r) >= 0.7;
          const strengthWord = strong ? 'сильная' : 'умеренная';
          const dirWord = r < 0 ? 'обратная связь' : 'прямая связь';
          const reliable = cell.significant ? 'надёжно подтверждена' : 'требует подтверждения';
          const xLab = metricLabel(cell.x);
          const yLab = metricLabel(cell.y);
          return (
            <li key={i} className="text-slate-800 leading-snug">
              {/* Связное предложение из 4 фраз */}
              <div>
                У вас <b>{strengthWord} {dirWord}</b> между «<b>{xLab}</b>» и «<b>{yLab}</b>» —
                {' '}<i className="text-slate-600">{reliable}</i>.
              </div>
              <div className="mt-0.5">
                <span className="font-semibold text-emerald-700">Что делать:</span> {advice!.doIt}
              </div>
              {advice!.dont && (
                <div>
                  <span className="font-semibold text-rose-700">Чего НЕ делать:</span> {advice!.dont}
                </div>
              )}
              {advice!.example && (
                <div className="text-slate-600 italic">Пример: {advice!.example}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface Action {
  headline: (r: number) => string;
  doIt: string;
  example?: string;
  dont?: string;
}

/** Возвращает Action только если для пары есть конкретный совет. Иначе null — пара не выводится. */
function pickAction(x: string, y: string, r: number): Action | null {
  const pos = r > 0;
  const neg = r < 0;
  const has = (a: string, b: string) =>
    (x === a && y === b) || (x === b && y === a);
  const strong = Math.abs(r) >= 0.7;
  const head = (sign: '+' | '−') => (rr: number) =>
    `${sign} ${Math.abs(rr) >= 0.7 ? 'Сильная' : Math.abs(rr) >= 0.3 ? 'Умеренная' : 'Слабая'} связь`;

  if (has('finishedPriceRub', 'ordersCount')) {
    return neg
      ? {
          headline: head('−'),
          doIt: 'снижайте цену небольшими шагами −5/−10% и фиксируйте, при каком уровне заказы стабилизируются.',
          example: 'если у товара цена 5 022₽ и при ней 14 заказов, попробуйте 4 770₽ на 7 дней — по тренду ожидайте +1–2 заказа/день.',
          dont: 'не повышайте цену в рекламные дни — вы потеряете объём вдвойне (рост ДРР + падение конверсии).',
        }
      : {
          headline: head('+'),
          doIt: 'эта связь часто отражает совпадение с акцией — сверьтесь с календарём WB-распродаж и не используйте её как «повышай цену = больше заказов».',
          dont: 'не интерпретировать буквально — эффект Веблена крайне редок, скорее это совпадение.',
        };
  }
  if (has('finishedPriceRub', 'marginRub')) {
    return pos
      ? {
          headline: head('+'),
          doIt: 'у вас есть запас по марже — можно осторожно тестировать +3–5% цены при сохранении объёма.',
          dont: 'не делайте +10% разом — потеряете часть конверсии в воронке.',
        }
      : {
          headline: head('−'),
          doIt: 'оставайтесь на текущем уровне цены или попробуйте −5% — высокая цена режет маржу через рост возвратов и падение конверсии.',
          dont: 'не повышайте цену надеясь компенсировать снижение объёма — это усугубит падение маржи.',
        };
  }
  if (has('ctrPercent', 'ordersCount') || has('ctrPercent', 'salesCount')) {
    return pos
      ? {
          headline: head('+'),
          doIt: 'обложка конвертит — масштабируйте показы (реклама, SEO, новые ключевые запросы).',
          example: strong ? 'каждый +1% CTR в дни с CTR ≥ N даёт измеримый прирост заказов.' : undefined,
          dont: 'не трогайте обложку «потому что давно не меняли» — вы рискуете сломать рабочий креатив.',
        }
      : {
          headline: head('−'),
          doIt: 'проверьте источник трафика — рост CTR при падении заказов означает нерелевантную аудиторию.',
          dont: 'не наращивайте бюджет рекламы пока не разберётесь с конверсией.',
        };
  }
  if (has('viewCount', 'ordersCount') || has('openCardCount', 'ordersCount')) {
    return pos
      ? {
          headline: head('+'),
          doIt: 'охват — главный рычаг: вкладывайтесь в позиции в поиске и рекламу.',
          dont: 'не оптимизируйте обложку до улучшения охвата — конверсия не лимитирует.',
        }
      : {
          headline: head('−'),
          doIt: 'отслеживайте качество трафика — рост показов должен идти в заказы.',
          dont: 'не запускайте дорогую рекламу с широким таргетом — растите релевантность.',
        };
  }
  if (has('crPercent', 'ordersCount')) {
    return pos
      ? {
          headline: head('+'),
          doIt: 'конверсия растёт с заказами — продолжайте улучшать контент и цену.',
          dont: 'не запускайте «слепой» прайсинг — он может уронить CR.',
        }
      : null;
  }
  if (has('advSpendRub', 'ordersCount')) {
    return pos
      ? {
          headline: head('+'),
          doIt: 'реклама окупается — можно поднять дневной бюджет на 20% и проверить ДРР через 3 дня.',
          example: 'если в дни ДРР < 15% заказы росли на +30% — это рабочая связка.',
          dont: 'не наращивайте бюджет одним рывком >50% — аукцион перегреется.',
        }
      : {
          headline: head('−'),
          doIt: 'отрежьте 30% спенда на 7 дней и сравните: если падения нет, реклама не работает.',
          dont: 'не масштабируйте кампанию пока не разберётесь с креативом и ставками.',
        };
  }
  if (has('advSpendRub', 'drrPercent')) {
    return pos
      ? {
          headline: head('+'),
          doIt: 'окно насыщено — снижайте ставки на дорогих ключах или открывайте новые кампании.',
          dont: 'не наращивайте ставки слепо — каждый новый рубль даёт меньше отдачи.',
        }
      : {
          headline: head('−'),
          doIt: 'связка работает: больше бюджета — ниже ДРР. Можно осторожно растить.',
          dont: 'не сворачивайте кампанию — ДРР здоровый.',
        };
  }
  if (has('stockQty', 'ordersCount')) {
    return pos
      ? {
          headline: head('+'),
          doIt: 'у вас OOS-потери: усильте поставку. Цель — покрытие ≥14 дней.',
          example: 'в дни остатка < 5 шт заказы падали — заведите алерт на остаток.',
          dont: 'не оставляйте «маленький страховой запас» при росте продаж.',
        }
      : null;
  }
  if (has('daysOfStock', 'marginPct')) {
    return neg
      ? {
          headline: head('−'),
          doIt: 'неликвид ест маржу — устраивайте акцию −15/−20% на товары с покрытием > 60 дней.',
          dont: 'не держите сток >90 дней — хранение растёт нелинейно.',
        }
      : null;
  }
  if (has('storageRub', 'ordersCount') || has('penaltyRub', 'ordersCount')) {
    return neg
      ? {
          headline: head('−'),
          doIt: 'разберите тип удержаний (штраф / платная приёмка / возвраты) — устраните корень.',
          dont: 'не игнорируйте — каждые −1% к марже × 1000 заказов = −10K маржи в месяц.',
        }
      : null;
  }
  if (has('positionBest', 'viewCount') || has('positionMean', 'viewCount')) {
    return neg
      ? {
          headline: head('−'),
          doIt: 'инвестируйте в SEO-ключи и контент — позиция в поиске напрямую тянет показы.',
          dont: 'не вливайте бюджет в рекламу за счёт SEO — органический охват дешевле.',
        }
      : null;
  }
  if (has('positionBest', 'ordersCount')) {
    return neg
      ? {
          headline: head('−'),
          doIt: 'поднимайтесь в выдаче — заказы пойдут с лагом 1–3 дня.',
          dont: 'не делайте резких правок контента в момент пика позиций — рискуете обнулить эффект.',
        }
      : null;
  }

  // Возврат null — пара без конкретной формулы вообще не отображается
  return null;
}
