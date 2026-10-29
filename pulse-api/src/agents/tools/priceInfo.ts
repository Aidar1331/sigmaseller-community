/**
 * Shared helper: resolve current price info for a product.
 *
 * Three data sources, tried in order:
 *
 *  1. **WB API live** (`/api/v2/list/goods/filter`) — authoritative current
 *     base price + seller discount, same data shown in the WB seller cabinet.
 *     This is what the user actually sees and changes. Try this FIRST.
 *
 *  2. `wb_prices_history` — locally cached snapshot when the prices-sync cron
 *     is configured. Used if WB API is unavailable / not authorised.
 *
 *  3. `wb_orders_sales_daily_products` aggregate (progressive lookback
 *     14d → 60d → all-time) — derived from order events, may be stale (shows
 *     price AT-ORDER-TIME, not current). Last resort so the agent has at
 *     least some anchor when neither WB API nor local history is available.
 *
 * Returns null only when no source has any data.
 */

import { db } from '../../db/client.js';
import { wbPricesHistory, wbOrdersSalesDailyProducts, wbSppWeekly } from '../../db/schema.js';
import { and, eq, desc, sql, gte, isNull, or } from 'drizzle-orm';
import { wbGetCurrentPrice } from '../../integrations/wb/wbActions.js';
import logger from '../../lib/logger.js';

/**
 * Подтащить последний известный SPP% (Скидка постоянного покупателя WB)
 * из wb_spp_weekly. WB Public API не отдаёт SPP в /v2/list/goods/filter и
 * в /api/v3/prices — наш wb_prices_history.spp на проде заполнен NULL'ом
 * (см. 2026-06-01: 0/5472 строк имеют spp). Зато sppWeekly.toDb.ts
 * усредняет SPP из реализационного отчёта (ppvz_spp_prc), получаем
 * spp_pct_bp в basis points (39.85% → 3985).
 *
 * Возвращаем процент (0-100) или null если данных нет за последние 30
 * дней. Без shopId не ищем (SPP per-shop, кросс-магазинная путаница даст
 * чужие значения).
 */
async function lookupRecentSppPct(
  workspaceId: number,
  shopId: number | null | undefined,
  nmId: number,
): Promise<number | null> {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  // Подвох: старый sppWeekly.toDb.ts пишет shop_id=NULL. Для мульти-магазинных
  // workspace'ов фильтруем по shop_id если задан, иначе — берём строки с
  // shop_id IS NULL (или совпадающим). nmId всё равно уникален в WB → путаницы
  // между магазинами не будет.
  const shopFilter = shopId != null
    ? or(eq(wbSppWeekly.shopId, shopId), isNull(wbSppWeekly.shopId))
    : undefined;
  const conds = [
    eq(wbSppWeekly.workspaceId, workspaceId),
    eq(wbSppWeekly.nmId, nmId),
    gte(wbSppWeekly.dateTo, since),
  ];
  if (shopFilter) conds.push(shopFilter);
  const [row] = await db
    .select({ sppBp: wbSppWeekly.sppPctBp, dateTo: wbSppWeekly.dateTo })
    .from(wbSppWeekly)
    .where(and(...conds))
    .orderBy(desc(wbSppWeekly.dateTo))
    .limit(1);
  if (!row || row.sppBp == null) return null;
  const pct = Number(row.sppBp) / 100;
  return Number.isFinite(pct) && pct > 0 ? pct : null;
}

export type PriceInfoSource = 'wb_api_live' | 'prices_history' | 'orders_avg_14d';

export interface CurrentPriceInfo {
  source: PriceInfoSource;
  /** Cell A in the WB cabinet — «Цена продавца до скидки», копейки. */
  basePriceKop: number | null;
  /** «Скидка продавца», 0–100. */
  discountPct: number | null;
  /** «Цена со скидкой» (после скидки продавца, до SPP), копейки. */
  finalPriceKop: number | null;
  /** Орографически «цена покупателя» — после SPP. Может быть null если не агрегируется. */
  finishedPriceKop?: number | null;
  /** Кол-во заказов, на которых построен средний (только для orders_avg_14d). */
  samples?: number;
  /** Дата источника: ISO для prices_history, диапазон строкой для агрегата. */
  asOf: string;
}

const DEFAULT_LOOKBACK_DAYS = 14;

export async function getCurrentPriceInfo(
  workspaceId: number,
  shopId: number | null | undefined,
  nmId: number,
  opts: { lookbackDays?: number; skipLive?: boolean } = {},
): Promise<CurrentPriceInfo | null> {
  // ── 1. WB API live (authoritative) ───────────────────────────────────
  // Skip if shopId is unknown (no JWT to sign the request) or caller opts out.
  if (!opts.skipLive && shopId != null) {
    try {
      const live = await wbGetCurrentPrice(workspaceId, shopId, nmId);
      if (live.success && live.data) {
        const basePriceKop = Math.round(live.data.basePriceRub * 100);
        const finalPriceKop = Math.round(live.data.finalPriceRub * 100);
        // WB live endpoint не отдаёт SPP — дотягиваем из wb_spp_weekly
        // (последняя усреднённая SPP за 30 дней). Без этого AI отвечал
        // «цену кабинета» (7877 ₽), а юзер хочет витринную (4622 ₽).
        const sppPct = await lookupRecentSppPct(workspaceId, shopId, nmId);
        const finishedPriceKop = sppPct != null
          ? Math.round(finalPriceKop * (1 - sppPct / 100))
          : null;
        return {
          source: 'wb_api_live',
          basePriceKop,
          discountPct: live.data.discountPct,
          finalPriceKop,
          finishedPriceKop,
          asOf: new Date().toISOString(),
        };
      }
      // No item returned → product not in WB price-list (deactivated card,
      // wrong shop, etc.). Continue to local fallback rather than nulling out.
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), nmId, workspaceId, shopId }, 'wbGetCurrentPrice failed, falling back to local');
    }
  }

  // ── 2. wb_prices_history ─────────────────────────────────────────────
  const historyConds = [
    eq(wbPricesHistory.workspaceId, workspaceId),
    eq(wbPricesHistory.nmId, nmId),
  ];
  if (shopId != null) historyConds.push(eq(wbPricesHistory.shopId, shopId));

  const [latest] = await db
    .select({
      price: wbPricesHistory.price,
      discount: wbPricesHistory.discount,
      spp: wbPricesHistory.spp,
      date: wbPricesHistory.date,
    })
    .from(wbPricesHistory)
    .where(and(...historyConds))
    .orderBy(desc(wbPricesHistory.date))
    .limit(1);

  if (latest && latest.price != null) {
    const basePriceKop = Number(latest.price);
    const discountPct = latest.discount != null ? Number(latest.discount) : 0;
    const finalPriceKop = Math.round(basePriceKop * (1 - discountPct / 100));
    // SPP сначала из истории; если там NULL (как на проде 2026-06-01) —
    // дотягиваем из wb_spp_weekly.
    let sppPct: number | null = latest.spp != null ? Number(latest.spp) : null;
    if (sppPct == null || !Number.isFinite(sppPct) || sppPct <= 0) {
      sppPct = await lookupRecentSppPct(workspaceId, shopId, nmId);
    }
    const finishedPriceKop = sppPct != null
      ? Math.round(finalPriceKop * (1 - sppPct / 100))
      : null;
    return {
      source: 'prices_history',
      basePriceKop,
      discountPct,
      finalPriceKop,
      finishedPriceKop,
      asOf: latest.date instanceof Date ? latest.date.toISOString() : String(latest.date),
    };
  }

  // ── 2. orders aggregate fallback (progressive lookback) ──────────────
  // Try short window first (recent = more accurate for current price), then
  // widen to 60d, then all-time. Even a 60-day-old sample beats "no data" —
  // WB cabinet still shows that price. Slow-moving SKUs (no orders for weeks)
  // would otherwise look "unknown" when their price is actually well-defined.
  //
  // NOTE 2026-06-01: здесь источник остаётся wb_orders_sales_daily_products
  // (Statistics API), а не funnel (Analytics). Причина: нужны колонки
  // `finished_price_rub` (фактическая цена со скидкой) и `discount_percent_sum_bp`
  // (сумма скидок для усреднения) — их в Funnel НЕТ. Без них нельзя
  // вычислить пару (basePrice, discountPct, finalPrice). Это внутренний
  // расчёт средней цены для price-guard'ов, не пользовательский вывод
  // выручки/заказов, поэтому расхождение со ЛК тут не критично.
  const explicit = opts.lookbackDays;
  const windows: Array<number | null> = explicit != null
    ? [explicit]
    : [DEFAULT_LOOKBACK_DAYS, 60, null]; // null = all-time, no date filter

  for (const days of windows) {
    const ordersConds = [
      eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
      eq(wbOrdersSalesDailyProducts.nmId, nmId),
    ];
    if (shopId != null) ordersConds.push(eq(wbOrdersSalesDailyProducts.shopId, shopId));

    let asOfLabel: string;
    if (days != null) {
      const sinceDate = new Date();
      sinceDate.setUTCDate(sinceDate.getUTCDate() - days);
      const since = sinceDate.toISOString().slice(0, 10);
      ordersConds.push(sql`${wbOrdersSalesDailyProducts.date}::text >= ${since}`);
      asOfLabel = `last ${days}d (>=${since})`;
    } else {
      asOfLabel = 'all-time';
    }

    const [agg] = await db
      .select({
        orders: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersCount}), 0)`,
        ordersRub: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersRub}), 0)`,
        finishedRub: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.finishedPriceRub}), 0)`,
        discBpSum: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.discountPercentSumBp}), 0)`,
        maxDate: sql<string>`MAX(${wbOrdersSalesDailyProducts.date})`,
      })
      .from(wbOrdersSalesDailyProducts)
      .where(and(...ordersConds));

    const orders = Number(agg?.orders ?? 0);
    if (!orders) continue;

    const finalPriceKop = Math.round(Number(agg.ordersRub) / orders);
    const finishedPriceKop = Math.round(Number(agg.finishedRub) / orders);
    const discountPct = Math.round((Number(agg.discBpSum) / 100 / orders) * 10) / 10;
    const basePriceKop = discountPct > 0 && discountPct < 100
      ? Math.round(finalPriceKop / (1 - discountPct / 100))
      : finalPriceKop;

    const lastDate = agg.maxDate ? String(agg.maxDate) : null;
    return {
      source: 'orders_avg_14d',
      basePriceKop,
      discountPct,
      finalPriceKop,
      finishedPriceKop,
      samples: orders,
      asOf: lastDate ? `${asOfLabel}, последние данные ${lastDate}` : asOfLabel,
    };
  }

  return null;
}

/**
 * Format current price info as a short Russian one-liner for the confirmation
 * prompt. Returns empty string if `info` is null.
 *
 * Examples:
 *   "сейчас: 2151 ₽ × −4% = 2064 ₽ (источник: история)"
 *   "сейчас: ~2064 ₽ (среднее за 14д, 35 заказов)"
 *   "" — если данных нет
 */
export function formatCurrentPriceLine(info: CurrentPriceInfo | null): string {
  if (!info) return '';
  const finalRub = info.finalPriceKop != null ? Math.round(info.finalPriceKop / 100) : null;
  const baseRub = info.basePriceKop != null ? Math.round(info.basePriceKop / 100) : null;
  const showcaseRub = info.finishedPriceKop != null ? Math.round(info.finishedPriceKop / 100) : null;
  // «Витрина с СПП» — то, что видит покупатель на сайте. Если есть,
  // дописываем суффиксом, чтобы AI отвечал юзеру «4622 ₽ с СПП», а
  // не «7877 ₽ из кабинета» (тот хочет цену сайта).
  const showcaseSuffix = showcaseRub != null && showcaseRub > 0 && showcaseRub !== finalRub
    ? ` · на витрине ~${showcaseRub} ₽ (с СПП)`
    : '';

  if (info.source === 'wb_api_live' && baseRub != null && info.discountPct != null && info.discountPct > 0) {
    return `Сейчас: ${baseRub} ₽ × −${info.discountPct}% = ${finalRub} ₽ (live из кабинета WB)${showcaseSuffix}`;
  }
  if (info.source === 'wb_api_live' && baseRub != null) {
    return `Сейчас: ${baseRub} ₽ (без скидки, live из кабинета WB)${showcaseSuffix}`;
  }
  if (info.source === 'prices_history' && baseRub != null && info.discountPct != null && info.discountPct > 0) {
    return `Сейчас: ${baseRub} ₽ × −${info.discountPct}% = ${finalRub} ₽ (история цен WB)${showcaseSuffix}`;
  }
  if (info.source === 'prices_history' && baseRub != null) {
    return `Сейчас: ${baseRub} ₽ (без скидки продавца, история цен WB)${showcaseSuffix}`;
  }
  if (info.source === 'orders_avg_14d' && finalRub != null) {
    const samples = info.samples ?? 0;
    if (info.discountPct != null && info.discountPct > 0 && baseRub != null) {
      return `Сейчас: ~${baseRub} ₽ × −${info.discountPct}% = ${finalRub} ₽ (средняя цена заказов за 14д, ${samples} заказов)`;
    }
    return `Сейчас: ~${finalRub} ₽ (средняя за 14д, ${samples} заказов; точная база неизвестна)`;
  }
  return '';
}

/**
 * Compute the new final price (after seller discount) for a proposed change.
 * Caller passes the old discount when newDiscountPct isn't supplied.
 */
export function computeNewFinalKop(
  newBasePriceKop: number,
  newDiscountPct: number | undefined,
  fallbackDiscountPct: number | null | undefined,
): { finalKop: number; discountPctUsed: number } {
  const disc = newDiscountPct ?? fallbackDiscountPct ?? 0;
  const safeDisc = Math.max(0, Math.min(99, disc));
  return {
    finalKop: Math.round(newBasePriceKop * (1 - safeDisc / 100)),
    discountPctUsed: safeDisc,
  };
}
