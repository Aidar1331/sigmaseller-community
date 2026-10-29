/**
 * Tool: query_funnel — Conversion funnel overview.
 * Reuses patterns from routes/pulse.ts funnel data
 */

import { db } from '../../db/client.js';
import { wbFunnelDailyProducts } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { resolveProductIds } from './_resolveProductIds.js';

interface QueryFunnelArgs {
  from: string;
  to: string;
  /** nmId (артикул WB) или vendorCode (артикул продавца). Принимается любой. */
  nmIds?: Array<number | string>;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryFunnelOverview(args: QueryFunnelArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const conds: any[] = [
    eq(wbFunnelDailyProducts.workspaceId, wsId),
    ...(shopId ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
    gte(wbFunnelDailyProducts.date, args.from),
    lte(wbFunnelDailyProducts.date, args.to),
  ];
  if (args.nmIds?.length) {
    const resolvedNmIds = await resolveProductIds(wsId, args.nmIds);
    if (!resolvedNmIds.length) {
      return JSON.stringify({ error: 'no_products_found', hint: `артикулы не найдены: ${args.nmIds.join(', ')} (поддерживаются как WB-артикул nmId, так и артикул продавца vendorCode)` });
    }
    conds.push(inArray(wbFunnelDailyProducts.nmId, resolvedNmIds));
  }

  const rows = await db
    .select({
      cardOpens: sql<number>`coalesce(sum(${wbFunnelDailyProducts.openCardCount}), 0)`.mapWith(Number),
      addToCart: sql<number>`coalesce(sum(${wbFunnelDailyProducts.addToCartCount}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      ordersRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}), 0)`.mapWith(Number),
      buyouts: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
      buyoutsRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutSum}), 0)`.mapWith(Number),
      cancels: sql<number>`coalesce(sum(${wbFunnelDailyProducts.cancelCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(...conds));

  const f = rows[0] ?? { cardOpens: 0, addToCart: 0, orders: 0, ordersRub: 0, buyouts: 0, buyoutsRub: 0, cancels: 0 };

  // Conversion rates. cardOpens = "Перешли в карточку" (WB sales-funnel/products endpoint), NOT search impressions. WB этим endpoint impressions не отдаёт.
  const cartConv = f.cardOpens > 0 ? ((f.addToCart / f.cardOpens) * 100).toFixed(1) : '0';
  const cartToOrder = f.addToCart > 0 ? ((f.orders / f.addToCart) * 100).toFixed(1) : '0';
  const orderToBuyout = f.orders > 0 ? ((f.buyouts / f.orders) * 100).toFixed(1) : '0';
  const overallConversion = f.cardOpens > 0 ? ((f.buyouts / f.cardOpens) * 100).toFixed(2) : '0';

  return JSON.stringify({
    period: { from: args.from, to: args.to },
    funnel: {
      cardOpens: f.cardOpens,
      addToCart: f.addToCart,
      orders: f.orders,
      buyouts: f.buyouts,
      cancels: f.cancels,
    },
    conversions: {
      cardOpenToCartPct: Number(cartConv),
      cartToOrderPct: Number(cartToOrder),
      orderToBuyoutPct: Number(orderToBuyout),
      overallPct: Number(overallConversion),
    },
    revenue: {
      ordersRub: f.ordersRub,
      buyoutsRub: f.buyoutsRub,
    },
    note: 'cardOpens — «Перешли в карточку» (переходы из выдачи в карточку товара). Поиск-impressions (показы в результатах поиска) WB через этот endpoint НЕ отдаёт — отдельной метрики «показы в выдаче» здесь нет.',
  });
}
