import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { wbFunnelDailyProducts, wbOrdersSalesDailyProducts, wbAdvDailyProducts, wbCards } from '../db/schema.js';
import log from '../lib/logger.js';
import { getAdvSpendScale } from './advSpendScale.js';

const logger = log.child({ module: 'abPhotoService' });

export type AbVariantStats = {
  viewCount: number;
  openCardCount: number;
  // Корзины. Шаг воронки между открытием и заказом: open → cart → order.
  // Источник: wb_funnel_daily_products.add_to_cart_count.
  cartCount: number;
  orderCount: number;
  revenueKopecks: number;
  ctrOpen: number | null;
  ctrOrder: number | null;
  // Конверсии per-шаг (от прошлого этапа):
  cartFromOpen: number | null;   // cart / open
  orderFromCart: number | null;  // order / cart
  // Реклaмные метрики per-nm за период фазы. adViews/adClicks даёт ЧЕСТНЫЙ
  // CTR (impressions → click), которого нет в Funnel API. ДРР = adSpend / orders_rub.
  adViews: number;
  adClicks: number;
  adSpendKopecks: number;
  adOrders: number;
  adOrdersRubKopecks: number;
  adCtr: number | null;       // adClicks / adViews
  drr: number | null;         // adSpend / orders_rub (доля рекл. расхода в выручке)
};

// Variants are labelled A..E (max 5). Capacity is enforced in route schemas;
// helpers here just walk whatever labels the caller passes in.
export type VariantLabel = 'A' | 'B' | 'C' | 'D' | 'E';
export const ALL_VARIANT_LABELS: VariantLabel[] = ['A', 'B', 'C', 'D', 'E'];

export function emptyStats(): AbVariantStats {
  return {
    viewCount: 0, openCardCount: 0, cartCount: 0, orderCount: 0, revenueKopecks: 0,
    ctrOpen: null, ctrOrder: null,
    cartFromOpen: null, orderFromCart: null,
    adViews: 0, adClicks: 0, adSpendKopecks: 0, adOrders: 0, adOrdersRubKopecks: 0,
    adCtr: null, drr: null,
  };
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function sumFunnel(workspaceId: number, nmId: number, start: string, end: string): Promise<AbVariantStats> {
  const [funnelRow] = await db
    .select({
      viewCount: sql<number>`sum(${wbFunnelDailyProducts.viewCount})`.mapWith(Number),
      openCardCount: sql<number>`sum(${wbFunnelDailyProducts.openCardCount})`.mapWith(Number),
      cartCount: sql<number>`sum(${wbFunnelDailyProducts.addToCartCount})`.mapWith(Number),
      orderCount: sql<number>`sum(${wbFunnelDailyProducts.orderCount})`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(
      and(
        eq(wbFunnelDailyProducts.workspaceId, workspaceId),
        eq(wbFunnelDailyProducts.nmId, nmId),
        gte(wbFunnelDailyProducts.date, start),
        lte(wbFunnelDailyProducts.date, end)
      )
    );

  const [revenueRow] = await db
    .select({
      salesRub: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesRub}), 0)`.mapWith(Number),
      ordersRub: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersRub}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(
      and(
        eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
        eq(wbOrdersSalesDailyProducts.nmId, nmId),
        gte(wbOrdersSalesDailyProducts.date, start),
        lte(wbOrdersSalesDailyProducts.date, end)
      )
    );

  const [advRow] = await db
    .select({
      adViews:    sql<number>`coalesce(sum(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
      adClicks:   sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
      adSpend:    sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
      adOrders:   sql<number>`coalesce(sum(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
      adOrdersRub: sql<number>`coalesce(sum(${wbAdvDailyProducts.sumPriceKopecks}), 0)`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(
      and(
        eq(wbAdvDailyProducts.workspaceId, workspaceId),
        eq(wbAdvDailyProducts.nmId, nmId),
        gte(wbAdvDailyProducts.date, start),
        lte(wbAdvDailyProducts.date, end)
      )
    );

  const view = Number(funnelRow?.viewCount ?? 0);
  const open = Number(funnelRow?.openCardCount ?? 0);
  const cart = Number(funnelRow?.cartCount ?? 0);
  const orders = Number(funnelRow?.orderCount ?? 0);
  const revenueKopecks = Number(revenueRow?.salesRub ?? 0);
  const ordersRubKop = Number(revenueRow?.ordersRub ?? 0);

  const adViews = Number(advRow?.adViews ?? 0);
  const adClicks = Number(advRow?.adClicks ?? 0);
  // Масштабируем spend к фактическим списаниям из wb_adv_finance (xlsx ЛК ВБ).
  // fullstats per-nm занижает реальный расход — без scale ДРР заниженный.
  // Резолвим shopId через wb_cards (per-nm), чтобы не путать scales разных шопов.
  const [cardShop] = await db.select({ shopId: wbCards.shopId }).from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId))).limit(1);
  const advScale = await getAdvSpendScale(workspaceId, cardShop?.shopId ?? null, start, end);
  const adSpendKopecks = Math.round(Number(advRow?.adSpend ?? 0) * advScale);
  const adOrders = Number(advRow?.adOrders ?? 0);
  const adOrdersRubKopecks = Number(advRow?.adOrdersRub ?? 0);

  return {
    viewCount: view,
    openCardCount: open,
    cartCount: cart,
    orderCount: orders,
    revenueKopecks,
    ctrOpen: view > 0 ? open / view : null,
    ctrOrder: view > 0 ? orders / view : null,
    cartFromOpen: open > 0 ? cart / open : null,
    orderFromCart: cart > 0 ? orders / cart : null,
    adViews,
    adClicks,
    adSpendKopecks,
    adOrders,
    adOrdersRubKopecks,
    adCtr: adViews > 0 ? adClicks / adViews : null,
    // ДРР по органике (полная выручка по заказам). Альтернатива — по ad_orders
    // только, но оператор хочет общую долю рекламного расхода в выручке.
    drr: ordersRubKop > 0 ? adSpendKopecks / ordersRubKop : null,
  };
}

export async function computeStatsByVariant(
  workspaceId: number,
  nmId: number,
  phases: Array<{ variant: string; startedAt: string | Date; endedAt?: string | Date | null }>
): Promise<Record<'A' | 'B', AbVariantStats>> {
  // Back-compat 2-variant view. New callers should use computeStatsByVariants.
  const map = await computeStatsByVariants(workspaceId, nmId, phases, ['A', 'B']);
  return { A: map.A ?? emptyStats(), B: map.B ?? emptyStats() };
}

/**
 * N-variant stats walker. Pass an explicit `labels` list (e.g. ['A','B','C'])
 * so the result includes a zeroed entry for every declared variant even when
 * a variant has no phases yet.
 */
export async function computeStatsByVariants(
  workspaceId: number,
  nmId: number,
  phases: Array<{ variant: string; startedAt: string | Date; endedAt?: string | Date | null }>,
  labels: VariantLabel[]
): Promise<Record<string, AbVariantStats>> {
  const out: Record<string, AbVariantStats> = {};
  for (const l of labels) out[l] = emptyStats();

  // Фикс 2026-06-08: ранее в цикле для КАЖДОЙ фазы вызывался sumFunnel за её
  // период (startDay..endDay). При ротации 20 мин это давало 36+ фаз в день;
  // каждая возвращала ПОЛНЫЕ дневные orders/views и суммировалась → итог
  // = orders_дня × N_фаз_варианта_в_день. На скриншоте 15/12 — это просто
  // число фаз A/B за период теста.
  //
  // Новый алгоритм:
  //   1) Идём по фазам, в каждом дне считаем длительность активности
  //      варианта (мс). Один день может содержать активность нескольких
  //      вариантов — каждый получает свою долю.
  //   2) Для каждого дня запрашиваем sumFunnel ОДИН раз.
  //   3) Делим дневные числа пропорционально времени экспозиции варианта.
  //
  // Свойства новых чисел:
  //   - orders_A + orders_B + ... = orders_дня (сумма по всем активным).
  //   - Округление до целых даёт ±1 ошибку на день, но не раздутие.
  //   - Если за день только один вариант был активен — он получает все
  //     заказы дня (1.0 share).
  //   - Дни без активных фаз игнорируются (в orders теста не идут).

  type DayExposure = { totalMs: number; perVariant: Map<string, number> };
  const dateMap = new Map<string, DayExposure>();
  const nowMs = Date.now();

  for (const p of phases) {
    const variant = (p.variant ?? '').toUpperCase();
    if (!variant) continue;
    if (!out[variant]) out[variant] = emptyStats();
    const startMs = new Date(p.startedAt).getTime();
    const endMs = p.endedAt ? new Date(p.endedAt).getTime() : nowMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    // Итерируем по календарным дням UTC между startMs и endMs.
    let cursorMs = startMs;
    while (cursorMs < endMs) {
      const dayStart = new Date(cursorMs);
      const dateKey = isoDate(dayStart);
      const nextDayMs = Date.UTC(
        dayStart.getUTCFullYear(),
        dayStart.getUTCMonth(),
        dayStart.getUTCDate() + 1,
      );
      const segmentEndMs = Math.min(endMs, nextDayMs);
      const ms = segmentEndMs - cursorMs;
      if (ms > 0) {
        let entry = dateMap.get(dateKey);
        if (!entry) {
          entry = { totalMs: 0, perVariant: new Map() };
          dateMap.set(dateKey, entry);
        }
        entry.totalMs += ms;
        entry.perVariant.set(variant, (entry.perVariant.get(variant) ?? 0) + ms);
      }
      cursorMs = nextDayMs;
    }
  }

  for (const [date, exposure] of dateMap) {
    if (exposure.totalMs <= 0) continue;
    const dayFunnel = await sumFunnel(workspaceId, nmId, date, date);
    for (const [variant, ms] of exposure.perVariant) {
      const share = ms / exposure.totalMs;
      const cur = out[variant];
      if (!cur) continue;
      cur.viewCount += Math.round(dayFunnel.viewCount * share);
      cur.openCardCount += Math.round(dayFunnel.openCardCount * share);
      cur.cartCount += Math.round(dayFunnel.cartCount * share);
      cur.orderCount += Math.round(dayFunnel.orderCount * share);
      cur.revenueKopecks += Math.round(dayFunnel.revenueKopecks * share);
      cur.adViews += Math.round(dayFunnel.adViews * share);
      cur.adClicks += Math.round(dayFunnel.adClicks * share);
      cur.adSpendKopecks += Math.round(dayFunnel.adSpendKopecks * share);
      cur.adOrders += Math.round(dayFunnel.adOrders * share);
      cur.adOrdersRubKopecks += Math.round(dayFunnel.adOrdersRubKopecks * share);
    }
  }

  for (const k of Object.keys(out)) {
    const cur = out[k];
    cur.ctrOpen = cur.viewCount > 0 ? cur.openCardCount / cur.viewCount : null;
    cur.ctrOrder = cur.viewCount > 0 ? cur.orderCount / cur.viewCount : null;
    cur.cartFromOpen = cur.openCardCount > 0 ? cur.cartCount / cur.openCardCount : null;
    cur.orderFromCart = cur.cartCount > 0 ? cur.orderCount / cur.cartCount : null;
    cur.adCtr = cur.adViews > 0 ? cur.adClicks / cur.adViews : null;
    // Для ДРР делим расход рекламы на ВСЮ выручку (revenueKopecks из orders_sales.salesRub).
    // Это даёт реальный показатель «сколько % выручки уходит в рекламу» — то же,
    // что в РНП. Альтернатива — adSpend / adOrdersRub (узкий рекл.ДРР).
    cur.drr = cur.revenueKopecks > 0 ? cur.adSpendKopecks / cur.revenueKopecks : null;
  }
  return out;
}

/**
 * Per-day stats per variant. Та же логика что и `computeStatsByVariants`,
 * но с разбивкой по дням — для графика «до/после».
 *
 * Возвращает массив элементов вида:
 *   { date: 'YYYY-MM-DD', perVariant: { A: {...}, B: {...} } }
 * Дни без активных фаз — НЕ включаются.
 */
export async function computeStatsByDay(
  workspaceId: number,
  nmId: number,
  phases: Array<{ variant: string; startedAt: string | Date; endedAt?: string | Date | null }>,
  labels: VariantLabel[],
): Promise<Array<{ date: string; perVariant: Record<string, AbVariantStats> }>> {
  type DayExposure = { totalMs: number; perVariant: Map<string, number> };
  const dateMap = new Map<string, DayExposure>();
  const nowMs = Date.now();

  for (const p of phases) {
    const variant = (p.variant ?? '').toUpperCase();
    if (!variant) continue;
    const startMs = new Date(p.startedAt).getTime();
    const endMs = p.endedAt ? new Date(p.endedAt).getTime() : nowMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    let cursorMs = startMs;
    while (cursorMs < endMs) {
      const dayStart = new Date(cursorMs);
      const dateKey = isoDate(dayStart);
      const nextDayMs = Date.UTC(
        dayStart.getUTCFullYear(),
        dayStart.getUTCMonth(),
        dayStart.getUTCDate() + 1,
      );
      const segmentEndMs = Math.min(endMs, nextDayMs);
      const ms = segmentEndMs - cursorMs;
      if (ms > 0) {
        let entry = dateMap.get(dateKey);
        if (!entry) {
          entry = { totalMs: 0, perVariant: new Map() };
          dateMap.set(dateKey, entry);
        }
        entry.totalMs += ms;
        entry.perVariant.set(variant, (entry.perVariant.get(variant) ?? 0) + ms);
      }
      cursorMs = nextDayMs;
    }
  }

  const sortedDates = Array.from(dateMap.keys()).sort();
  const result: Array<{ date: string; perVariant: Record<string, AbVariantStats> }> = [];

  for (const date of sortedDates) {
    const exposure = dateMap.get(date)!;
    if (exposure.totalMs <= 0) continue;
    const dayFunnel = await sumFunnel(workspaceId, nmId, date, date);
    const perVariant: Record<string, AbVariantStats> = {};
    for (const l of labels) perVariant[l] = emptyStats();
    for (const [variant, ms] of exposure.perVariant) {
      const share = ms / exposure.totalMs;
      const cur = perVariant[variant] ?? emptyStats();
      perVariant[variant] = cur;
      cur.viewCount = Math.round(dayFunnel.viewCount * share);
      cur.openCardCount = Math.round(dayFunnel.openCardCount * share);
      cur.cartCount = Math.round(dayFunnel.cartCount * share);
      cur.orderCount = Math.round(dayFunnel.orderCount * share);
      cur.revenueKopecks = Math.round(dayFunnel.revenueKopecks * share);
      cur.adViews = Math.round(dayFunnel.adViews * share);
      cur.adClicks = Math.round(dayFunnel.adClicks * share);
      cur.adSpendKopecks = Math.round(dayFunnel.adSpendKopecks * share);
      cur.adOrders = Math.round(dayFunnel.adOrders * share);
      cur.adOrdersRubKopecks = Math.round(dayFunnel.adOrdersRubKopecks * share);
      cur.ctrOrder = cur.viewCount > 0 ? cur.orderCount / cur.viewCount : null;
      cur.cartFromOpen = cur.openCardCount > 0 ? cur.cartCount / cur.openCardCount : null;
      cur.orderFromCart = cur.cartCount > 0 ? cur.orderCount / cur.cartCount : null;
      cur.adCtr = cur.adViews > 0 ? cur.adClicks / cur.adViews : null;
      cur.drr = cur.revenueKopecks > 0 ? cur.adSpendKopecks / cur.revenueKopecks : null;
    }
    result.push({ date, perVariant });
  }
  return result;
}

export type AbGoal = 'orders' | 'ctr' | 'revenue';

export function pickWinner(goal: AbGoal | string, stats: Record<string, AbVariantStats>): string | null {
  const labels = Object.keys(stats);
  if (labels.length === 0) return null;

  const score = (s: AbVariantStats): number => {
    // WB Funnel API не отдаёт impressions, поэтому ctrOpen (= open / view)
    // дублирует view = open и всегда 1.0. Для goal='ctr' используем
    // ctrOrder (% корзин = открытие → заказ) — это единственная честная
    // конверсия которую можно посчитать из доступных данных.
    if (goal === 'ctr') return s.ctrOrder ?? 0;
    if (goal === 'revenue') return s.revenueKopecks;
    return s.orderCount;  // 'orders' + default
  };

  let best: string | null = null;
  let bestScore = -Infinity;
  let tied = false;
  for (const l of labels) {
    const sc = score(stats[l]);
    if (sc > bestScore) { bestScore = sc; best = l; tied = false; }
    else if (sc === bestScore) { tied = true; }
  }

  // No winner if everyone tied at zero or top-2 are tied.
  if (best == null || bestScore <= 0 || tied) return null;
  return best;
}

/**
 * Two-proportion z-test (one-sided) for "is variant X's conversion really
 * higher than variant Y's, or is it noise". Returns p-value and a friendly
 * confidence label. We don't pull in a stats library — the math is 12 lines.
 *
 * H0: p1 = p2.  H1: p1 > p2.  Reject H0 when z is large enough.
 *
 *   pooled  p  = (x1 + x2) / (n1 + n2)
 *   SE         = sqrt( p (1-p) (1/n1 + 1/n2) )
 *   z          = (p1 - p2) / SE
 *   p-value    = 1 - Φ(z)   (one-sided)
 */
export function twoPropZTest(
  successA: number, trialsA: number,
  successB: number, trialsB: number,
): { pValue: number | null; confidencePct: number | null; significant: boolean } {
  if (trialsA <= 0 || trialsB <= 0) return { pValue: null, confidencePct: null, significant: false };
  const pA = successA / trialsA;
  const pB = successB / trialsB;
  if (pA === pB) return { pValue: 1, confidencePct: 0, significant: false };

  const pPool = (successA + successB) / (trialsA + trialsB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return { pValue: null, confidencePct: null, significant: false };

  const z = Math.abs(pA - pB) / se;
  const pValue = 1 - normalCdf(z);  // one-sided
  const confidencePct = (1 - pValue) * 100;
  return { pValue, confidencePct, significant: pValue < 0.05 };
}

/**
 * Abramowitz & Stegun 26.2.17 — accuracy ~7.5e-8, no dependencies.
 */
function normalCdf(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Extrapolate test-period conversions to a monthly forecast, then to revenue.
 * Mirrors how Sellium presents results: "за 12 дней получили X корзин → за 30
 * дней получим X * 30/12 = Y корзин × средняя цена = ₽/мес".
 *
 * Uses orders as the conversion unit because it's the actual money-making
 * event (basket adds don't always convert). priceRubAvg is computed from
 * revenue / orders within the test period — falls back to 0 if no orders.
 */
export type AbForecast = {
  testDays: number;
  monthlyOrders: number;
  priceRubAvg: number;
  monthlyRevenueRub: number;
};

export function forecastMonthly(stats: AbVariantStats, testDays: number): AbForecast {
  const safeDays = testDays > 0 ? testDays : 1;
  const scale = 30 / safeDays;
  const monthlyOrders = Math.round(stats.orderCount * scale);
  const priceRubAvg = stats.orderCount > 0 ? Math.round(stats.revenueKopecks / 100 / stats.orderCount) : 0;
  const monthlyRevenueRub = Math.round((stats.revenueKopecks / 100) * scale);
  return { testDays: safeDays, monthlyOrders, priceRubAvg, monthlyRevenueRub };
}
