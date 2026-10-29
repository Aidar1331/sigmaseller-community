/**
 * Tool: query_sales — обзор продаж.
 *
 * Источник: wb_funnel_daily_products (WB Analytics API `/sales-funnel/products`).
 * Раньше брали из wb_orders_sales_daily_products (Statistics API
 * `/supplier/orders`), но числа расходились с WB ЛК на 5-15% — Analytics
 * учитывает все каналы и считает «по факту WB», Statistics — только
 * supplier-стрим с задержкой. Дашборд РНП тоже на funnel — теперь AI-чат
 * показывает те же числа, что и таблицы и WB ЛК.
 *
 * Маппинг старых полей → funnel:
 *   ordersCount → orderCount
 *   ordersRub   → orderSum   *100  (funnel хранит рубли, мы наружу даём копейки)
 *   salesCount  → buyoutCount
 *   salesRub    → buyoutSum  *100
 *   forPayRub   → нет в funnel; используем query_finance.forPay.
 *
 * ВАЖНО: в wb_funnel_daily_products поля *Sum хранятся в РУБЛЯХ (не копейках)
 * — см. комментарий в routes/pulse.ts:2688. Поэтому везде ниже умножаем на 100.
 */

import { db } from '../../db/client.js';
import { wbFunnelDailyProducts } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { logAgent as logger } from '../../lib/logger.js';
import { resolveProductIds } from './_resolveProductIds.js';

interface QuerySalesArgs {
  from: string;
  to: string;
  /** nmId или vendorCode (артикул продавца). Принимается любой. */
  nmIds?: Array<number | string>;
  groupBy?: 'day' | 'week' | 'total';
  _workspaceId?: number;
  _shopId?: number;
}

export async function querySalesOverview(args: QuerySalesArgs): Promise<string> {
  logger.debug({ args: { from: args.from, to: args.to, nmIds: args.nmIds } }, 'query_sales called');
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) {
    logger.error('query_sales: _workspaceId is undefined');
    return JSON.stringify({ error: 'workspace not found' });
  }

  const conds: any[] = [
    eq(wbFunnelDailyProducts.workspaceId, wsId),
    ...(shopId ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
    gte(wbFunnelDailyProducts.date, args.from),
    lte(wbFunnelDailyProducts.date, args.to),
  ];
  if (args.nmIds?.length) {
    const resolvedNmIds = await resolveProductIds(wsId, args.nmIds);
    if (!resolvedNmIds.length) {
      return JSON.stringify({ error: 'no_products_found', hint: `артикулы не найдены: ${args.nmIds.join(', ')}` });
    }
    conds.push(inArray(wbFunnelDailyProducts.nmId, resolvedNmIds));
  }

  if (args.groupBy === 'day') {
    const rows = await db
      .select({
        date: wbFunnelDailyProducts.date,
        ordersCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
        ordersRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
        salesCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
        salesRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutSum}) * 100, 0)`.mapWith(Number),
        cancelCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.cancelCount}), 0)`.mapWith(Number),
      })
      .from(wbFunnelDailyProducts)
      .where(and(...conds))
      .groupBy(wbFunnelDailyProducts.date)
      .orderBy(wbFunnelDailyProducts.date);

    return JSON.stringify({ period: { from: args.from, to: args.to }, groupBy: 'day', source: 'analytics-funnel', rows });
  }

  // Total aggregation
  const rows = await db
    .select({
      ordersCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      ordersRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
      salesCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
      salesRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutSum}) * 100, 0)`.mapWith(Number),
      cancelCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.cancelCount}), 0)`.mapWith(Number),
      cancelSum: sql<number>`coalesce(sum(${wbFunnelDailyProducts.cancelSum}) * 100, 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(...conds));

  const r = rows[0] ?? { ordersCount: 0, ordersRub: 0, salesCount: 0, salesRub: 0, cancelCount: 0, cancelSum: 0 };

  return JSON.stringify({
    source: 'analytics-funnel',
    period: { from: args.from, to: args.to },
    ordersCount: r.ordersCount,
    ordersKop: r.ordersRub,
    salesCount: r.salesCount,
    salesKop: r.salesRub,
    cancelCount: r.cancelCount,
    cancelKop: r.cancelSum,
    avgOrderKop: r.ordersCount > 0 ? Math.round(r.ordersRub / r.ordersCount) : 0,
    sourceNote: 'Данные из WB Analytics (sales-funnel/products) — те же, что в WB ЛК и в дашборде Pulse. Для точного % выкупа используй query_funnel (когортная конверсия по карточкам).',
  });
}
