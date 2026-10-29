/**
 * insightEngine — turns a RunPairResult into a classified, localisable insight
 * with hypothesis metadata.
 *
 * Three categories (per plan §Phase 4):
 *   critical      — r ≥ 0.5 (|·|) at q<0.1 AND sign contradicts expectedSign
 *                    OR storage/penalty hypotheses showing the wrong sign.
 *   growth_point  — r ≥ 0.5 (|·|) at q<0.1 AND sign matches expectedSign AND actionable.
 *   false_alarm   — r ≥ 0.3 (|·|) but noiseDelta>0.15 OR holidayOverlap>0.3
 *                    OR sparsity≠ok OR no text mapping available.
 */

import type { RunPairResult, PairExamples } from './runPair.js';
import {
  HYPOTHESES,
  bucketOf,
  findHypothesesByPair,
  type HypothesisSpec,
  type RBucket,
} from './hypothesisRegistry.js';
import { metricDef, type MetricKey } from './metrics.js';

export type InsightCategory = 'critical' | 'growth_point' | 'false_alarm';

export interface Insight {
  hypothesisId: string;
  category: InsightCategory;
  hypothesisText: string;
  hypothesisCategory: HypothesisSpec['category'];
  bucket: RBucket;
  r: number;
  p: number;
  n: number;
  method: 'pearson' | 'spearman' | 'kendall';
  interpretation: string;
  decision: string;
  noiseRisk: string;
  flags: string[];
  confidence: 'green' | 'yellow' | 'red';
  /** Lag in days if relevant and detected. */
  bestLag: number | null;
  /** Сырые числа товара — для блока «На вашем товаре». */
  examples: PairExamples | null;
  /** Жирный однострочный итог для верха карточки — с реальными числами. null если данных мало. */
  concreteCallout: string | null;
  /** Пара метрик (xKey, yKey) — для UI-форматирования цифр в InsightCard. */
  metrics: [string, string];
}

const DEFAULT_INTERP: Record<RBucket, string> = {
  'strong-':   'Сильная обратная связь — изменение {x} кратно двигает {y} в противоположную сторону.',
  'moderate-': 'Умеренная обратная связь — рост {x} сопровождается падением {y}.',
  'weak':      'Заметной линейной связи нет. Магнитуда r в пределах шума.',
  'moderate+': 'Умеренная прямая связь — метрики движутся согласованно.',
  'strong+':   'Сильная прямая связь — метрики движутся почти синхронно.',
};

// Generic дефолты используются только если в registry нет специфичной фразы.
// Все они опираются на placeholder'ы реальных чисел товара ({bestX}, {worstX}…).
const DEFAULT_DECISION: Record<RBucket, string> = {
  'strong-':   'У вас на {bestDate} было {bestY} {y} при {x}={bestX}; на {worstDate} {worstY} {y} при {x}={worstX}. Стремитесь к уровню {x}≈{topAvgX}.',
  'moderate-': 'В лучшие дни {x} был ≈{topAvgX}, в слабые ≈{bottomAvgX}. Тестируйте более агрессивный {x} в спокойные дни.',
  'weak':      'Связь слабая — не используйте {x} как рычаг для управления {y}.',
  'moderate+': 'В удачные дни {x}≈{topAvgX}, тогда {y} был ≈{topAvgY}. В слабые дни {x}≈{bottomAvgX}. Поддерживайте {x} ближе к {topAvgX}.',
  'strong+':   '{bestDate}: {x}={bestX} → {y}={bestY}. {worstDate}: {x}={worstX} → {y}={worstY}. Воспроизведите параметры лучшего дня.',
};

/**
 * Render an insight from a completed pair analysis. Returns null if the pair
 * fails all hypothesis matches AND has no meaningful correlation.
 */
export function buildInsight(result: RunPairResult): Insight | null {
  const corr = result.correlation;
  if (!corr || !Number.isFinite(corr.r)) {
    return null;
  }
  const matched = findHypothesesByPair(result.x, result.y);
  const hyp: HypothesisSpec | undefined = matched[0] ?? fallbackSpec(result);
  const bucket = bucketOf(corr.r);
  const flags = [...result.flags];

  // Category classification
  let category: InsightCategory = 'false_alarm';
  const q = corr.p;
  const strong = Math.abs(corr.r) >= 0.5 && q < 0.1;
  const moderate = Math.abs(corr.r) >= 0.3;
  const signMatches = hyp
    ? (hyp.expectedSign === '+' ? corr.r > 0
      : hyp.expectedSign === '-' ? corr.r < 0
      : true)
    : true;
  // Sparsity влияет на `confidence` (отдельная шкала ниже), но НЕ должна
  // автоматически переводить сильную корреляцию в false_alarm. Иначе
  // практически любой реальный товар с 60-90 днями попадал в false_alarm
  // даже при r=0.7+, и пользователь не видел полезных карточек.
  // Источники шума, которые реально опасны для интерпретации:
  //   - noiseDelta > 0.15 (winsorize меняет r сильно → выбросы решают)
  //   - holidayOverlap > 0.3 (треть периода — праздники/распродажи)
  const noisy = (result.noiseDelta ?? 0) > 0.15
    || result.holidayOverlap > 0.3;

  if (strong && hyp && hyp.expectedSign !== '0' && !signMatches) {
    category = 'critical';
  } else if (strong && !noisy) {
    category = 'growth_point';
  } else if (moderate && !noisy) {
    category = 'growth_point';
  } else {
    category = 'false_alarm';
  }

  // Template fill
  const bestLag = result.lag?.bestLag ?? null;
  const fillCtx = {
    x: result.x, y: result.y,
    r: corr.r, p: corr.p, n: corr.n,
    lag: bestLag,
    examples: result.examples,
  };
  const filledInterp = fill(
    hyp?.interpretation[bucket] ?? DEFAULT_INTERP[bucket],
    fillCtx,
  );
  const filledDecision = fill(
    hyp?.decision[bucket] ?? DEFAULT_DECISION[bucket],
    fillCtx,
  );
  const concreteCallout = buildConcreteCallout(result.x, result.y, corr.r, result.examples);

  const confidence: Insight['confidence'] =
    result.sparsity.verdict === 'ok' && !noisy && corr.n >= 30 ? 'green'
    : result.sparsity.verdict === 'blocked' ? 'red'
    : 'yellow';

  return {
    hypothesisId: hyp?.id ?? 'ad_hoc',
    category,
    hypothesisText: hyp?.hypothesis ?? 'Произвольная пара метрик.',
    hypothesisCategory: hyp?.category ?? 'Мета',
    bucket,
    r: corr.r,
    p: corr.p,
    n: corr.n,
    method: corr.method,
    interpretation: filledInterp,
    decision: filledDecision,
    noiseRisk: hyp?.noiseRisk ?? 'Проверьте период на совпадение с акциями WB.',
    flags,
    confidence,
    bestLag,
    examples: result.examples,
    concreteCallout,
    metrics: [result.x, result.y],
  };
}

// ---------------------------------------------------------------------------
// concreteCallout — одна строка с реальными числами товара
// ---------------------------------------------------------------------------

/**
 * RU_LABEL — короткие русские названия метрик для подстановки в шаблоны
 * рекомендаций (`{x}`, `{y}`). Никаких camelCase в тексте, который видит
 * пользователь — это техимена БД/кода, они допустимы только в логах и в
 * drawer-е «Объяснить глубже».
 *
 * При добавлении новой метрики обязательно расширять эту карту — иначе
 * в UI вылезет `crPercent`/`advSpendRub` и т.п.
 */
const RU_LABEL: Record<MetricKey, string> = {
  // Sales / orders
  ordersCount: 'заказы',
  ordersRub: 'заказы (₽)',
  salesCount: 'продажи',
  salesRub: 'продажи (₽)',
  forPayRub: 'к перечислению',
  buyoutCount: 'выкупы',
  cancelCount: 'отмены',
  // Price
  finishedPriceRub: 'цена',
  listPriceRub: 'базовая цена',
  sellerDiscountPct: 'скидка продавца',
  sppPct: 'СПП',
  clubDiscountPct: 'скидка WB Клуб',
  // Funnel
  viewCount: 'показы',
  openCardCount: 'открытия карточки',
  addToCartCount: 'добавления в корзину',
  addToWishlistCount: 'добавления в избранное',
  ctrPercent: 'CTR',
  crPercent: 'CR в заказ',
  // Ads
  advSpendRub: 'расход на рекламу',
  drrPercent: 'ДРР',
  // Stock
  stockQty: 'остаток',
  inWayToClient: 'в пути к клиенту',
  daysOfStock: 'дней покрытия',
  // Finance
  commissionRub: 'комиссия WB',
  logisticsRub: 'логистика',
  storageRub: 'хранение',
  penaltyRub: 'штрафы',
  marginRub: 'прибыль до налога',
  marginPct: 'прибыльность до налога',
  // SEO
  positionBest: 'позиция',
  positionMean: 'средняя позиция',
  keywordsInTop10: 'ключей в ТОП-10',
};

function fmtMetric(key: MetricKey, v: number): string {
  const def = metricDef(key);
  const label = RU_LABEL[key] ?? key;
  switch (def.unit) {
    case 'rub':
      return `${label} ${Math.round(v).toLocaleString('ru-RU')}₽`;
    case 'pct':
      return `${label} ${v.toFixed(1)}%`;
    case 'count':
      return `${Math.round(v).toLocaleString('ru-RU')} ${label}`;
    case 'rank':
      return `${label} #${Math.round(v)}`;
    case 'days':
      return `${label} ${v.toFixed(0)} дн`;
    default:
      return `${label} ${v.toFixed(1)}`;
  }
}

function ruDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}`;
}

function buildConcreteCallout(
  xKey: MetricKey, yKey: MetricKey, _r: number, ex: PairExamples | null,
): string | null {
  if (!ex || !ex.bestByY || !ex.worstByY) return null;
  // Если разница между лучшим и худшим днём по Y слишком мала — скрываем callout,
  // он будет неубедительным.
  if (Math.abs(ex.bestByY.y - ex.worstByY.y) < 1e-6) return null;
  return (
    `${ruDate(ex.bestByY.date)}: ${fmtMetric(xKey, ex.bestByY.x)} → ${fmtMetric(yKey, ex.bestByY.y)}. ` +
    `${ruDate(ex.worstByY.date)}: ${fmtMetric(xKey, ex.worstByY.x)} → ${fmtMetric(yKey, ex.worstByY.y)}.`
  );
}

/**
 * Build insights for multiple pair results, then sort:
 *   critical first, then growth_point by |r|, then false_alarm.
 */
export function rankInsights(results: RunPairResult[]): Insight[] {
  const insights: Insight[] = [];
  for (const r of results) {
    const ins = buildInsight(r);
    if (ins) insights.push(ins);
  }
  const order: Record<InsightCategory, number> = { critical: 0, growth_point: 1, false_alarm: 2 };
  return insights.sort((a, b) => {
    const c = order[a.category] - order[b.category];
    if (c !== 0) return c;
    return Math.abs(b.r) - Math.abs(a.r);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fill(
  template: string,
  ctx: {
    x: string; y: string;
    r: number; p: number; n: number;
    lag: number | null;
    examples?: PairExamples | null;
  },
): string {
  // Отдельный pass — числовые плейсхолдеры из examples.
  let out = template;
  const ex = ctx.examples;
  const num = (v: number | undefined) => v == null || !Number.isFinite(v) ? '?' : Math.round(v).toLocaleString('ru-RU');
  const num1 = (v: number | undefined) => v == null || !Number.isFinite(v) ? '?' : v.toFixed(1);

  if (ex) {
    out = out
      .replace(/\{bestX\}/g, num(ex.bestByY?.x))
      .replace(/\{bestY\}/g, num(ex.bestByY?.y))
      .replace(/\{bestDate\}/g, ex.bestByY?.date ? ruDate(ex.bestByY.date) : '?')
      .replace(/\{worstX\}/g, num(ex.worstByY?.x))
      .replace(/\{worstY\}/g, num(ex.worstByY?.y))
      .replace(/\{worstDate\}/g, ex.worstByY?.date ? ruDate(ex.worstByY.date) : '?')
      .replace(/\{medianX\}/g, num(ex.medianX))
      .replace(/\{medianY\}/g, num(ex.medianY))
      .replace(/\{topAvgX\}/g, num(ex.topYBucket?.avgX))
      .replace(/\{topAvgY\}/g, num1(ex.topYBucket?.avgY))
      .replace(/\{bottomAvgX\}/g, num(ex.bottomYBucket?.avgX))
      .replace(/\{bottomAvgY\}/g, num1(ex.bottomYBucket?.avgY));
  }

  // `{x}` / `{y}` — это MetricKey (camelCase). В UI он не должен попасть никогда:
  // подставляем человекочитаемые ru-лейблы. Если метрики нет в карте — лучше
  // оставить дефис, чем «crPercent» в тексте рекомендации.
  const xLabel = RU_LABEL[ctx.x as MetricKey] ?? '—';
  const yLabel = RU_LABEL[ctx.y as MetricKey] ?? '—';
  return out
    .replace(/\{x\}/g, xLabel)
    .replace(/\{y\}/g, yLabel)
    .replace(/\{r\}/g, ctx.r.toFixed(2))
    .replace(/\{p\}/g, ctx.p.toFixed(3))
    .replace(/\{n\}/g, String(ctx.n))
    .replace(/\{lag\}/g, ctx.lag == null ? '?' : String(ctx.lag));
}

function fallbackSpec(_r: RunPairResult): HypothesisSpec | undefined {
  // Not strictly needed — findHypothesesByPair handles absence
  // by returning empty. This hook exists for future enrichment.
  return HYPOTHESES.find(h => h.id === 'matrix_scan');
}
