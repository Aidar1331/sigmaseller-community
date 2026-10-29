/**
 * Tool: query_advertising — Детальная аналитика рекламы.
 * ROI/ROAS, DRR по кампаниям, эффективность по товарам.
 * Inspired by JVO's advertising analytics with DRR attribution.
 */

import { db } from '../../db/client.js';
import { wbAdvDailyProducts } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';

interface QueryAdvertisingArgs {
  from: string;
  to: string;
  nmIds?: number[];
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryAdvertisingOverview(args: QueryAdvertisingArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const { from, to } = args;

  const advConds: any[] = [
    eq(wbAdvDailyProducts.workspaceId, wsId),
    ...(shopId ? [eq(wbAdvDailyProducts.shopId, shopId)] : []),
    gte(wbAdvDailyProducts.date, from),
    lte(wbAdvDailyProducts.date, to),
  ];
  if (args.nmIds?.length) advConds.push(inArray(wbAdvDailyProducts.nmId, args.nmIds));

  // Aggregate ad metrics by product
  const byProduct = await db
    .select({
      nmId: wbAdvDailyProducts.nmId,
      spendKop: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
      views: sql<number>`coalesce(sum(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
      clicks: sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
      atbs: sql<number>`coalesce(sum(${wbAdvDailyProducts.atbsCount}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
      revenueKop: sql<number>`coalesce(sum(${wbAdvDailyProducts.sumPriceKopecks}), 0)`.mapWith(Number),
      campaigns: sql<number>`coalesce(max(${wbAdvDailyProducts.advertsCount}), 0)`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(and(...advConds))
    .groupBy(wbAdvDailyProducts.nmId)
    .orderBy(desc(sql`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`))
    .limit(30);

  // Total summary
  const [totals] = await db
    .select({
      totalSpendKop: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
      totalViews: sql<number>`coalesce(sum(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
      totalClicks: sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
      totalAtbs: sql<number>`coalesce(sum(${wbAdvDailyProducts.atbsCount}), 0)`.mapWith(Number),
      totalOrders: sql<number>`coalesce(sum(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
      totalRevenueKop: sql<number>`coalesce(sum(${wbAdvDailyProducts.sumPriceKopecks}), 0)`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(and(...advConds));

  const t = totals ?? { totalSpendKop: 0, totalViews: 0, totalClicks: 0, totalAtbs: 0, totalOrders: 0, totalRevenueKop: 0 };

  // Calculate metrics
  const ctr = t.totalViews > 0 ? ((t.totalClicks / t.totalViews) * 100).toFixed(2) : '0';
  const cr = t.totalClicks > 0 ? ((t.totalOrders / t.totalClicks) * 100).toFixed(2) : '0';
  const cpc = t.totalClicks > 0 ? Math.round(t.totalSpendKop / t.totalClicks) : 0;
  const cpo = t.totalOrders > 0 ? Math.round(t.totalSpendKop / t.totalOrders) : 0;
  const roas = t.totalSpendKop > 0 ? ((t.totalRevenueKop / t.totalSpendKop) * 100).toFixed(0) : '0';
  const drrPct = t.totalRevenueKop > 0 ? ((t.totalSpendKop / t.totalRevenueKop) * 100).toFixed(1) : '0';

  // Products with ROI analysis
  const products = byProduct.map((p) => {
    const productDrr = p.revenueKop > 0 ? ((p.spendKop / p.revenueKop) * 100).toFixed(1) : '0';
    const productRoas = p.spendKop > 0 ? ((p.revenueKop / p.spendKop) * 100).toFixed(0) : '0';
    const productCtr = p.views > 0 ? ((p.clicks / p.views) * 100).toFixed(2) : '0';
    return {
      nmId: p.nmId,
      spendRub: Math.round(p.spendKop / 100),
      revenueRub: Math.round(p.revenueKop / 100),
      views: p.views,
      clicks: p.clicks,
      orders: p.orders,
      ctr: Number(productCtr),
      drr: Number(productDrr),
      roas: Number(productRoas),
      campaigns: p.campaigns,
      isUnprofitable: Number(productDrr) > 30,
    };
  });

  return JSON.stringify({
    period: { from, to },
    totals: {
      spendRub: Math.round(t.totalSpendKop / 100),
      revenueRub: Math.round(t.totalRevenueKop / 100),
      views: t.totalViews,
      clicks: t.totalClicks,
      orders: t.totalOrders,
      ctr: Number(ctr),
      cr: Number(cr),
      cpcKop: cpc,
      cpoKop: cpo,
      roas: Number(roas),
      drrPct: Number(drrPct),
    },
    products,
    unprofitableCount: products.filter((p) => p.isUnprofitable).length,
  });
}
