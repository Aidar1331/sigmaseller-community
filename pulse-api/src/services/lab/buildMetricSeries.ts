/**
 * buildMetricSeries — the ONLY entry point to fact tables for the Лаборатория.
 *
 * CRITICAL INVARIANT (see plan §3.3 and DECISIONS.md shopIsolation):
 *   - shopId is a required non-null bigint.
 *   - Every SELECT contains  WHERE workspace_id = $ws AND shop_id = $shop
 *     (plus nm_id when provided).
 *   - We never mix rows from different shops into one time series.
 *
 * Fact-table quirks the lab layer has to live with:
 *   - `date` columns are TEXT 'YYYY-MM-DD' in wb_*_daily_products — we compare
 *     as text (lexicographic order matches chronology for this format).
 *   - Money columns are stored in kopecks (bigint). We divide by 100 on read,
 *     so the returned series is always in rubles for downstream stat code.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { MetricKey } from './metrics.js';
import { metricDef } from './metrics.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildMetricSeriesArgs {
  workspaceId: number;
  shopId: number;               // REQUIRED — no workspace-wide mode
  nmId: bigint | null;          // null = aggregate over shop (all nmIds)
  dateFrom: string;             // 'YYYY-MM-DD'
  dateTo: string;               // 'YYYY-MM-DD' inclusive
  metric: MetricKey;
}

export interface MetricSeries {
  metric: MetricKey;
  dates: string[];              // length n, 'YYYY-MM-DD'
  values: Array<number | null>; // same length, null = no row that day
  /** Boolean mask same length — true where holiday_calendar has an entry. */
  isHoliday: boolean[];
}

export async function buildMetricSeries(args: BuildMetricSeriesArgs): Promise<MetricSeries> {
  assertValidArgs(args);
  const def = metricDef(args.metric);
  const dates = enumerateDays(args.dateFrom, args.dateTo);
  const values = await fetchValues(args, def.source);
  const isHoliday = await fetchHolidayMask(args.dateFrom, args.dateTo);
  return {
    metric: args.metric,
    dates,
    values,
    isHoliday,
  };
}

// ---------------------------------------------------------------------------
// Source-specific SQL dispatchers
// ---------------------------------------------------------------------------

async function fetchValues(
  args: BuildMetricSeriesArgs,
  source: ReturnType<typeof metricDef>['source'],
): Promise<Array<number | null>> {
  switch (source) {
    case 'orders_sales':  return fromOrdersSales(args);
    case 'funnel':        return fromFunnel(args);
    case 'adv':           return fromAdv(args);
    case 'stocks':        return fromStocks(args);
    case 'finance':       return fromFinance(args);
    case 'price_locf':    return fromPriceLocf(args);
    case 'seo':           return fromSeo(args);
    default:              throw new Error(`Unsupported metric source: ${source}`);
  }
}

/**
 * Common CTE for daily lab queries. Uses TEXT dates everywhere — fact
 * tables store `date` as TEXT 'YYYY-MM-DD' which compares lexicographically
 * in the right order.
 */
const TEXT_DAYS_CTE = (dateFrom: string, dateTo: string) => sql`
  WITH days AS (
    SELECT generate_series(${dateFrom}::date, ${dateTo}::date, '1 day')::date::text AS d
  )
`;

function mapRows(rows: { rows: unknown[] }): Array<number | null> {
  return (rows.rows as Array<{ v: number | string | null }>).map(r => {
    if (r.v === null || r.v === undefined) return null;
    const n = Number(r.v);
    return Number.isFinite(n) ? n : null;
  });
}

// Orders / sales fact table --------------------------------------------------

async function fromOrdersSales(args: BuildMetricSeriesArgs): Promise<Array<number | null>> {
  const { workspaceId, shopId, nmId, dateFrom, dateTo, metric } = args;
  const nmClause = nmId !== null ? sql`AND nm_id = ${nmId.toString()}::bigint` : sql``;
  const agg = nmId !== null
    ? selectOneOrdersSales(metric)
    : selectAggregatedOrdersSales(metric);

  const rows = await db.execute(sql`
    ${TEXT_DAYS_CTE(dateFrom, dateTo)},
    src AS (
      SELECT date AS d, ${agg.expr} AS v
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${workspaceId}
        AND shop_id      = ${shopId}
        ${nmClause}
        AND date BETWEEN ${dateFrom} AND ${dateTo}
      ${agg.groupBy}
    )
    SELECT days.d, src.v
    FROM days LEFT JOIN src USING (d)
    ORDER BY days.d
  `);
  return mapRows(rows);
}

/**
 * Money metrics stored as kopecks → returned as rubles (÷100).
 *
 * `finished_price_rub` в `wb_orders_sales_daily_products` фактически — это
 * SUM(finishedPrice) по строкам **orders** за день (см. ordersSales.toDb.ts).
 * Делитель должен быть из того же потока, иначе в дни, где заказов сильно
 * больше выкупов, средняя «цена» взлетает в десятки раз и ломает любые
 * корреляции с участием цены. Поэтому делим на orders_count, а не на
 * sales_count.
 */
function selectOneOrdersSales(metric: MetricKey): { expr: ReturnType<typeof sql>; groupBy: ReturnType<typeof sql> } {
  switch (metric) {
    case 'ordersCount':      return { expr: sql`orders_count`,                                 groupBy: sql`` };
    case 'salesCount':       return { expr: sql`sales_count`,                                  groupBy: sql`` };
    case 'ordersRub':        return { expr: sql`orders_rub::numeric / 100`,                    groupBy: sql`` };
    case 'salesRub':         return { expr: sql`sales_rub::numeric / 100`,                     groupBy: sql`` };
    case 'forPayRub':        return { expr: sql`for_pay_rub::numeric / 100`,                   groupBy: sql`` };
    case 'finishedPriceRub':
      return {
        expr: sql`CASE
          WHEN orders_count > 0 THEN finished_price_rub::numeric / orders_count / 100
          ELSE NULL
        END`,
        groupBy: sql``,
      };
    default: throw new Error(`orders_sales: metric ${metric} not supported`);
  }
}

function selectAggregatedOrdersSales(metric: MetricKey): { expr: ReturnType<typeof sql>; groupBy: ReturnType<typeof sql> } {
  const groupBy = sql`GROUP BY date`;
  switch (metric) {
    case 'ordersCount':      return { expr: sql`SUM(orders_count)`,                             groupBy };
    case 'salesCount':       return { expr: sql`SUM(sales_count)`,                              groupBy };
    case 'ordersRub':        return { expr: sql`SUM(orders_rub)::numeric / 100`,                groupBy };
    case 'salesRub':         return { expr: sql`SUM(sales_rub)::numeric / 100`,                 groupBy };
    case 'forPayRub':        return { expr: sql`SUM(for_pay_rub)::numeric / 100`,               groupBy };
    case 'finishedPriceRub':
      // Order-weighted daily price (rubles) across all nmIds that received an
      // order. Числитель и знаменатель из одного потока «orders» — иначе в дни
      // с большим разрывом orders vs sales цена взлетает в разы (см. комментарий
      // у selectOneOrdersSales).
      return {
        expr: sql`CASE WHEN SUM(orders_count) > 0 THEN SUM(finished_price_rub)::numeric / NULLIF(SUM(orders_count), 0) / 100 ELSE NULL END`,
        groupBy,
      };
    default: throw new Error(`orders_sales: metric ${metric} not supported (aggregate)`);
  }
}

// Funnel fact table ----------------------------------------------------------

async function fromFunnel(args: BuildMetricSeriesArgs): Promise<Array<number | null>> {
  const { workspaceId, shopId, nmId, dateFrom, dateTo, metric } = args;
  const nmClause = nmId !== null ? sql`AND nm_id = ${nmId.toString()}::bigint` : sql``;
  const agg = nmId !== null ? selectOneFunnel(metric) : selectAggregatedFunnel(metric);

  const rows = await db.execute(sql`
    ${TEXT_DAYS_CTE(dateFrom, dateTo)},
    src AS (
      SELECT date AS d, ${agg.expr} AS v
      FROM wb_funnel_daily_products
      WHERE workspace_id = ${workspaceId}
        AND shop_id      = ${shopId}
        ${nmClause}
        AND date BETWEEN ${dateFrom} AND ${dateTo}
      ${agg.groupBy}
    )
    SELECT days.d, src.v FROM days LEFT JOIN src USING (d) ORDER BY days.d
  `);
  return mapRows(rows);
}

function selectOneFunnel(metric: MetricKey): { expr: ReturnType<typeof sql>; groupBy: ReturnType<typeof sql> } {
  switch (metric) {
    case 'viewCount':          return { expr: sql`view_count`, groupBy: sql`` };
    case 'openCardCount':      return { expr: sql`open_card_count`, groupBy: sql`` };
    case 'addToCartCount':     return { expr: sql`add_to_cart_count`, groupBy: sql`` };
    case 'addToWishlistCount': return { expr: sql`add_to_wishlist_count`, groupBy: sql`` };
    case 'buyoutCount':        return { expr: sql`buyout_count`, groupBy: sql`` };
    case 'cancelCount':        return { expr: sql`cancel_count`, groupBy: sql`` };
    case 'ctrPercent':
      return { expr: sql`CASE WHEN open_card_count > 0 THEN add_to_cart_count::numeric * 100 / open_card_count ELSE NULL END`, groupBy: sql`` };
    case 'crPercent':
      return { expr: sql`CASE WHEN add_to_cart_count > 0 THEN order_count::numeric * 100 / add_to_cart_count ELSE NULL END`, groupBy: sql`` };
    default: throw new Error(`funnel: metric ${metric} not supported`);
  }
}

function selectAggregatedFunnel(metric: MetricKey): { expr: ReturnType<typeof sql>; groupBy: ReturnType<typeof sql> } {
  const groupBy = sql`GROUP BY date`;
  switch (metric) {
    case 'viewCount':          return { expr: sql`SUM(view_count)`, groupBy };
    case 'openCardCount':      return { expr: sql`SUM(open_card_count)`, groupBy };
    case 'addToCartCount':     return { expr: sql`SUM(add_to_cart_count)`, groupBy };
    case 'addToWishlistCount': return { expr: sql`SUM(add_to_wishlist_count)`, groupBy };
    case 'buyoutCount':        return { expr: sql`SUM(buyout_count)`, groupBy };
    case 'cancelCount':        return { expr: sql`SUM(cancel_count)`, groupBy };
    case 'ctrPercent':
      return { expr: sql`CASE WHEN SUM(open_card_count) > 0 THEN SUM(add_to_cart_count)::numeric * 100 / SUM(open_card_count) ELSE NULL END`, groupBy };
    case 'crPercent':
      return { expr: sql`CASE WHEN SUM(add_to_cart_count) > 0 THEN SUM(order_count)::numeric * 100 / SUM(add_to_cart_count) ELSE NULL END`, groupBy };
    default: throw new Error(`funnel: metric ${metric} not supported (aggregate)`);
  }
}

// Advertising fact table -----------------------------------------------------

async function fromAdv(args: BuildMetricSeriesArgs): Promise<Array<number | null>> {
  const { workspaceId, shopId, nmId, dateFrom, dateTo, metric } = args;
  const nmClause = nmId !== null ? sql`AND nm_id = ${nmId.toString()}::bigint` : sql``;

  if (metric === 'advSpendRub') {
    const rows = await db.execute(sql`
      ${TEXT_DAYS_CTE(dateFrom, dateTo)},
      src AS (
        SELECT date AS d, SUM(spend_kopecks)::numeric / 100 AS v
        FROM wb_adv_daily_products
        WHERE workspace_id = ${workspaceId}
          AND shop_id      = ${shopId}
          ${nmClause}
          AND date BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY date
      )
      SELECT days.d, src.v FROM days LEFT JOIN src USING (d) ORDER BY days.d
    `);
    return mapRows(rows);
  }
  if (metric === 'drrPercent') {
    // ДРР = spend / (retail × scale) × 100. Retail с тем же scale-фактором,
    // что и в `fromFinance` — иначе ДРР будет занижен примерно вдвое
    // относительно финансовой страницы (raw retail задвоен в ~2×).
    const rows = await db.execute(sql`
      ${TEXT_DAYS_CTE(dateFrom, dateTo)},
      shop_raw AS (
        SELECT SUM(revenue_kopecks + COALESCE(spp_amount_kopecks, 0))::numeric AS raw_kop
        FROM wb_finance_daily_products
        WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId}
          AND COALESCE(rr_date, date) BETWEEN ${dateFrom} AND ${dateTo}
      ),
      shop_truth AS (
        SELECT COALESCE(SUM(retail_amount_kopecks), 0)::numeric AS truth_kop
        FROM wb_finance_reports
        WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId}
          AND date_from BETWEEN ${dateFrom}::date AND ${dateTo}::date
      ),
      sf AS (
        SELECT CASE
                 WHEN shop_raw.raw_kop > 0 AND shop_truth.truth_kop > 0
                 THEN shop_truth.truth_kop / shop_raw.raw_kop
                 ELSE 1.0
               END AS scale
        FROM shop_raw, shop_truth
      ),
      spend AS (
        SELECT date AS d, SUM(spend_kopecks)::numeric AS s_kop
        FROM wb_adv_daily_products
        WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId} ${nmClause}
          AND date BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY date
      ),
      retail AS (
        SELECT COALESCE(rr_date, date) AS d,
               SUM(revenue_kopecks + COALESCE(spp_amount_kopecks, 0))::numeric AS r_kop
        FROM wb_finance_daily_products
        WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId} ${nmClause}
          AND COALESCE(rr_date, date) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY COALESCE(rr_date, date)
      )
      SELECT days.d,
        CASE WHEN retail.r_kop * sf.scale > 0
             THEN spend.s_kop * 100 / (retail.r_kop * sf.scale)
             ELSE NULL END AS v
      FROM days
      LEFT JOIN spend USING (d)
      LEFT JOIN retail USING (d)
      CROSS JOIN sf
      ORDER BY days.d
    `);
    return mapRows(rows);
  }
  throw new Error(`adv: metric ${metric} not supported`);
}

// Stocks fact table ----------------------------------------------------------

async function fromStocks(args: BuildMetricSeriesArgs): Promise<Array<number | null>> {
  const { workspaceId, shopId, nmId, dateFrom, dateTo, metric } = args;
  const nmClause = nmId !== null ? sql`AND nm_id = ${nmId.toString()}::bigint` : sql``;
  const groupBy = nmId !== null ? sql`` : sql`GROUP BY date`;
  const aggExpr = (col: string) => nmId !== null ? sql.raw(col) : sql.raw(`SUM(${col})`);

  if (metric === 'stockQty' || metric === 'inWayToClient') {
    const col = metric === 'stockQty' ? 'quantity' : 'in_way_to_client';
    const rows = await db.execute(sql`
      ${TEXT_DAYS_CTE(dateFrom, dateTo)},
      src AS (
        SELECT date AS d, ${aggExpr(col)} AS v
        FROM wb_stocks_daily_products
        WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId} ${nmClause}
          AND date BETWEEN ${dateFrom} AND ${dateTo}
        ${groupBy}
      )
      SELECT days.d, src.v FROM days LEFT JOIN src USING (d) ORDER BY days.d
    `);
    return mapRows(rows);
  }

  if (metric === 'daysOfStock') {
    // stock / 7-day trailing orders_count average
    const rows = await db.execute(sql`
      ${TEXT_DAYS_CTE(dateFrom, dateTo)},
      stock AS (
        SELECT date AS d, ${nmId !== null ? sql`quantity` : sql`SUM(quantity)`} AS q
        FROM wb_stocks_daily_products
        WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId} ${nmClause}
          AND date BETWEEN ${dateFrom} AND ${dateTo}
        ${groupBy}
      ),
      orders AS (
        SELECT date AS d, ${nmId !== null ? sql`orders_count` : sql`SUM(orders_count)`} AS o
        FROM wb_orders_sales_daily_products
        WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId} ${nmClause}
          AND date BETWEEN (${dateFrom}::date - INTERVAL '7 days')::text AND ${dateTo}
        ${groupBy}
      ),
      orders7 AS (
        SELECT d,
               AVG(o) OVER (ORDER BY d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS avg7
        FROM orders
      )
      SELECT days.d,
             CASE WHEN orders7.avg7 > 0 THEN stock.q::numeric / orders7.avg7 ELSE NULL END AS v
      FROM days
      LEFT JOIN stock USING (d)
      LEFT JOIN orders7 USING (d)
      ORDER BY days.d
    `);
    return mapRows(rows);
  }

  throw new Error(`stocks: metric ${metric} not supported`);
}

// Finance fact table ---------------------------------------------------------

/**
 * Все finance-метрики Лаборатории берутся из `wb_finance_daily_products` —
 * того же источника, что и `/finance/:ws/by-product` (РНП).
 *
 * Ключевые решения (директива оператора 2026-06-08):
 *   - Группировка по `COALESCE(rr_date, date)`. В таблице на каждую операцию
 *     ВБ две даты: `date` = sale_dt (когда продали) и `rr_date` = отчётная
 *     дата ВБ. Если суммировать по `date`, ту же продажу можно поймать
 *     второй раз через запись отчёта с другим `date`. `rr_date` — это
 *     отчётная истина (xlsx ЛК ВБ), а `date` берётся только когда rr_date
 *     ещё не пришёл. Это в точности логика финансовой страницы.
 *   - Берём только per-nm колонки. Shop-level суммы (без `nm_id`) — пропускаем.
 *     Не размазываем по выручке.
 *   - Logistics = `logistics + return_logistics` (per-nm обе есть).
 *   - Margin = retail − (logistics + storage + paid_acceptance + penalties
 *     + other_hold) + additional_payments − COGS. По формуле финансовой
 *     страницы (`finance.ts:1030`): commission и acquiring в profit не
 *     вычитаются (там retail уже за вычетом). Налоги/НДС — shop-level,
 *     на день не размазываем (оператор: «что нельзя распределить — не учитывай»).
 *   - COGS = unit_cogs × max(0, sale_qty − returns_count).
 */
async function fromFinance(args: BuildMetricSeriesArgs): Promise<Array<number | null>> {
  const { workspaceId, shopId, nmId, dateFrom, dateTo, metric } = args;
  const nmClause = nmId !== null ? sql`AND fdp.nm_id = ${nmId.toString()}::bigint` : sql``;

  /**
   * SCALE-FACTOR — единый коэффициент за период (как в /finance/by-product).
   *
   * В `wb_finance_daily_products` одна продажа кладётся несколькими строками
   * (попадание в недельные отчёты ВБ). Сырое суммирование завышает retail
   * в ~2× относительно xlsx ЛК ВБ. Эталон — `wb_finance_reports.retail_amount_kopecks`
   * (= xlsx). Коэффициент scale = truth / raw считается shop-level за период
   * и применяется ко всем колонкам кроме COGS (физический расход).
   *
   * Это пропорциональное распределение: per-nm точность зависит от того,
   * насколько ровно ВБ задваивает все товары. Финансовая страница работает
   * так же.
   */
  const scaleCte = sql`
    shop_raw AS (
      SELECT SUM(revenue_kopecks + COALESCE(spp_amount_kopecks, 0))::numeric AS raw_kop
      FROM wb_finance_daily_products
      WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId}
        AND COALESCE(rr_date, date) BETWEEN ${dateFrom} AND ${dateTo}
    ),
    shop_truth AS (
      SELECT COALESCE(SUM(retail_amount_kopecks), 0)::numeric AS truth_kop
      FROM wb_finance_reports
      WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId}
        AND date_from BETWEEN ${dateFrom}::date AND ${dateTo}::date
    ),
    sf AS (
      SELECT CASE
               WHEN shop_raw.raw_kop > 0 AND shop_truth.truth_kop > 0
               THEN shop_truth.truth_kop / shop_raw.raw_kop
               ELSE 1.0
             END AS scale
      FROM shop_raw, shop_truth
    )
  `;

  // 1) Простые finance-колонки (commission/logistics/storage/penalty)
  //    — pre-aggregator по `COALESCE(rr_date, date)` + scale.
  const colExpr: Record<string, ReturnType<typeof sql>> = {
    commissionRub: sql`SUM(fdp.commission_kopecks)::numeric`,
    // Логистика включает return-logistics — обе per-nm в той же таблице.
    logisticsRub:  sql`SUM(fdp.logistics_kopecks + COALESCE(fdp.return_logistics_kopecks, 0))::numeric`,
    storageRub:    sql`SUM(fdp.storage_kopecks)::numeric`,
    penaltyRub:    sql`SUM(fdp.penalties_kopecks)::numeric`,
  };
  if (colExpr[metric]) {
    const rows = await db.execute(sql`
      ${TEXT_DAYS_CTE(dateFrom, dateTo)},
      ${scaleCte},
      src AS (
        SELECT COALESCE(fdp.rr_date, fdp.date) AS d, ${colExpr[metric]} AS v_kop
        FROM wb_finance_daily_products fdp
        WHERE fdp.workspace_id = ${workspaceId} AND fdp.shop_id = ${shopId} ${nmClause}
          AND COALESCE(fdp.rr_date, fdp.date) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY COALESCE(fdp.rr_date, fdp.date)
      )
      SELECT days.d, (src.v_kop * sf.scale / 100) AS v
      FROM days LEFT JOIN src USING (d) CROSS JOIN sf
      ORDER BY days.d
    `);
    return mapRows(rows);
  }

  // 2) marginRub / marginPct — единая формула, согласованная с финансовой страницей.
  if (metric === 'marginRub' || metric === 'marginPct') {
    const rows = await db.execute(sql`
      ${TEXT_DAYS_CTE(dateFrom, dateTo)},
      ${scaleCte},
      fin AS (
        SELECT COALESCE(fdp.rr_date, fdp.date) AS d,
               SUM(fdp.revenue_kopecks + COALESCE(fdp.spp_amount_kopecks, 0))::numeric AS retail_raw,
               SUM(fdp.logistics_kopecks + COALESCE(fdp.return_logistics_kopecks, 0)
                   + fdp.storage_kopecks + COALESCE(fdp.paid_acceptance_kopecks, 0)
                   + fdp.penalties_kopecks + COALESCE(fdp.other_hold_kopecks, 0))::numeric AS hold_raw,
               SUM(COALESCE(fdp.additional_payments_kopecks, 0))::numeric AS add_raw,
               SUM(COALESCE(c.cogs_kopecks, 0)
                   * GREATEST(0, fdp.sale_qty - COALESCE(fdp.returns_count, 0)))::numeric AS cogs_kop
        FROM wb_finance_daily_products fdp
        LEFT JOIN wb_cogs c ON c.workspace_id = fdp.workspace_id AND c.nm_id = fdp.nm_id
        WHERE fdp.workspace_id = ${workspaceId} AND fdp.shop_id = ${shopId} ${nmClause}
          AND COALESCE(fdp.rr_date, fdp.date) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY COALESCE(fdp.rr_date, fdp.date)
      )
      SELECT days.d,
             ${metric === 'marginRub'
                ? sql`((COALESCE(fin.retail_raw, 0) - COALESCE(fin.hold_raw, 0) + COALESCE(fin.add_raw, 0)) * sf.scale
                       - COALESCE(fin.cogs_kop, 0))::numeric / 100`
                : sql`CASE WHEN COALESCE(fin.retail_raw, 0) > 0
                           THEN ((fin.retail_raw - fin.hold_raw + fin.add_raw) * sf.scale - fin.cogs_kop)
                                * 100.0 / (fin.retail_raw * sf.scale)
                           ELSE NULL END`
             } AS v
      FROM days
      LEFT JOIN fin USING (d)
      CROSS JOIN sf
      ORDER BY days.d
    `);
    return mapRows(rows);
  }

  throw new Error(`finance: metric ${metric} not supported`);
}

// Price LOCF (via wb_price_daily function, migration 0116) -------------------

async function fromPriceLocf(args: BuildMetricSeriesArgs): Promise<Array<number | null>> {
  const { workspaceId, shopId, nmId, dateFrom, dateTo, metric } = args;
  if (nmId === null) {
    throw new Error(`price_locf metric ${metric} requires a specific nmId`);
  }
  const colMap: Record<string, string> = {
    listPriceRub:      'price_kop',
    sellerDiscountPct: 'discount_pct',
    sppPct:            'spp_pct',
    clubDiscountPct:   'club_discount_pct',
  };
  const col = colMap[metric];
  if (!col) throw new Error(`price_locf: unknown metric ${metric}`);

  const rows = await db.execute(sql`
    SELECT d::text AS d, ${sql.raw(col)} AS v
    FROM public.wb_price_daily(${workspaceId}::bigint, ${shopId}::bigint, ${nmId.toString()}::bigint, ${dateFrom}::date, ${dateTo}::date)
    ORDER BY d
  `);
  return (rows.rows as Array<{ v: number | string | null }>).map(r => {
    if (r.v === null || r.v === undefined) return null;
    const n = Number(r.v);
    if (!Number.isFinite(n)) return null;
    return metric === 'listPriceRub' ? n / 100 : n;
  });
}

// SEO via v_seo_snapshots_scoped --------------------------------------------

async function fromSeo(args: BuildMetricSeriesArgs): Promise<Array<number | null>> {
  const { workspaceId, shopId, nmId, dateFrom, dateTo, metric } = args;
  const nmClause = nmId !== null ? sql`AND nm_id = ${nmId.toString()}::bigint` : sql``;
  let expr: ReturnType<typeof sql>;
  switch (metric) {
    case 'positionBest':
      expr = sql`MIN(position) FILTER (WHERE position IS NOT NULL)`;
      break;
    case 'positionMean':
      expr = sql`AVG(position) FILTER (WHERE position IS NOT NULL)`;
      break;
    case 'keywordsInTop10':
      expr = sql`COUNT(DISTINCT keyword_id) FILTER (WHERE position <= 10)`;
      break;
    default:
      throw new Error(`seo: metric ${metric} not supported`);
  }
  const rows = await db.execute(sql`
    WITH days AS (
      SELECT generate_series(${dateFrom}::date, ${dateTo}::date, '1 day')::date AS d
    ),
    src AS (
      SELECT checked_date AS d, ${expr} AS v
      FROM public.v_seo_snapshots_scoped
      WHERE workspace_id = ${workspaceId}
        AND shop_id      = ${shopId}
        ${nmClause}
        AND checked_date BETWEEN ${dateFrom}::date AND ${dateTo}::date
      GROUP BY checked_date
    )
    SELECT days.d::text AS d, src.v FROM days LEFT JOIN src USING (d) ORDER BY days.d
  `);
  return mapRows(rows);
}

// Holiday mask --------------------------------------------------------------

async function fetchHolidayMask(dateFrom: string, dateTo: string): Promise<boolean[]> {
  const rows = await db.execute(sql`
    WITH days AS (SELECT generate_series(${dateFrom}::date, ${dateTo}::date, '1 day')::date AS d)
    SELECT days.d::text AS d,
           EXISTS (SELECT 1 FROM holiday_calendar h WHERE h.date = days.d) AS is_h
    FROM days
    ORDER BY days.d
  `);
  return (rows.rows as Array<{ is_h: boolean }>).map(r => Boolean(r.is_h));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValidArgs(args: BuildMetricSeriesArgs): void {
  if (!Number.isInteger(args.workspaceId) || args.workspaceId <= 0) {
    throw new Error(`buildMetricSeries: invalid workspaceId ${args.workspaceId}`);
  }
  if (!Number.isInteger(args.shopId) || args.shopId <= 0) {
    throw new Error(`buildMetricSeries: shopId is REQUIRED and must be a positive integer (got ${args.shopId})`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(args.dateTo)) {
    throw new Error(`buildMetricSeries: invalid date format`);
  }
  if (args.dateTo < args.dateFrom) {
    throw new Error(`buildMetricSeries: dateTo < dateFrom`);
  }
}

function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
