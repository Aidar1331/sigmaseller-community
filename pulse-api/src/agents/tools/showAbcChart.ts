/**
 * Tool: show_abc_chart — ABC-анализ товаров как виджет.
 * Categorizes products: A (80% revenue), B (15%), C (5%).
 * Inspired by JVO's ABC analysis for task prioritization.
 */

import { db } from '../../db/client.js';
import { wbFunnelDailyProducts, wbCards } from '../../db/schema.js';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';

interface ShowAbcChartArgs {
  from: string;
  to: string;
  _workspaceId?: number;
  _shopId?: number;
}

export async function showAbcChart(args: ShowAbcChartArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  // Get revenue by product (scoped to shop when provided — prevents mixing
  // shops of the same workspace, which would falsely rank another shop's
  // top products above the current shop's).
  //
  // Источник — funnel (WB Analytics). orderSum в funnel хранится в РУБЛЯХ,
  // приводим к копейкам через *100 чтобы revenueKop оставалось копейками
  // как раньше (и Math.round(revenueKop/100) ниже даёт рубли).
  const products = await db
    .select({
      nmId: wbFunnelDailyProducts.nmId,
      revenueKop: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
      ordersCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      salesCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      ...(shopId != null ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
      gte(wbFunnelDailyProducts.date, args.from),
      lte(wbFunnelDailyProducts.date, args.to),
    ))
    .groupBy(wbFunnelDailyProducts.nmId)
    .orderBy(desc(sql`coalesce(sum(${wbFunnelDailyProducts.orderSum}), 0)`));

  if (products.length === 0) {
    return JSON.stringify({ __widget: 'abc_chart', props: { products: [], totals: { a: 0, b: 0, c: 0 } } });
  }

  // Get product names (scoped to shop so cardMap matches the sales scope).
  const cards = await db
    .select({ nmId: wbCards.nmId, title: wbCards.title })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, wsId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
    ));
  const cardMap = new Map(cards.map((c) => [c.nmId, c.title]));

  // Calculate ABC
  const totalRevenue = products.reduce((s, p) => s + p.revenueKop, 0);
  let cumulative = 0;

  const classified = products.map((p) => {
    cumulative += p.revenueKop;
    const cumulativePct = totalRevenue > 0 ? (cumulative / totalRevenue) * 100 : 0;
    let category: 'A' | 'B' | 'C';
    if (cumulativePct <= 80) category = 'A';
    else if (cumulativePct <= 95) category = 'B';
    else category = 'C';

    return {
      nmId: p.nmId,
      name: cardMap.get(p.nmId) ?? `Артикул ${p.nmId}`,
      revenueRub: Math.round(p.revenueKop / 100),
      orders: p.ordersCount,
      sales: p.salesCount,
      sharePct: totalRevenue > 0 ? Number(((p.revenueKop / totalRevenue) * 100).toFixed(1)) : 0,
      cumulativePct: Number(cumulativePct.toFixed(1)),
      category,
    };
  });

  const aCount = classified.filter((p) => p.category === 'A').length;
  const bCount = classified.filter((p) => p.category === 'B').length;
  const cCount = classified.filter((p) => p.category === 'C').length;

  return JSON.stringify({
    __widget: 'abc_chart',
    props: {
      period: { from: args.from, to: args.to },
      totalRevenueRub: Math.round(totalRevenue / 100),
      totalProducts: products.length,
      totals: {
        a: { count: aCount, revenueShare: 80 },
        b: { count: bCount, revenueShare: 15 },
        c: { count: cCount, revenueShare: 5 },
      },
      products: classified.slice(0, 50), // Top 50 for display
    },
  });
}
