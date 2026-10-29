/**
 * Tool: query_storage — Анализ расходов на хранение.
 * Выявляет "мёртвый" сток, дорогие позиции, оптимизация объёмов.
 * Inspired by JVO's storage cost tracking and dead stock analysis.
 */

import { db } from '../../db/client.js';
import { wbStorageDaily, wbFunnelDailyProducts } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';

interface QueryStorageArgs {
  from: string;
  to: string;
  nmIds?: number[];
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryStorageOverview(args: QueryStorageArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const { from, to } = args;

  const conds: any[] = [
    eq(wbStorageDaily.workspaceId, wsId),
    ...(shopId ? [eq(wbStorageDaily.shopId, shopId)] : []),
    gte(wbStorageDaily.date, new Date(from)),
    lte(wbStorageDaily.date, new Date(to)),
  ];
  if (args.nmIds?.length) conds.push(inArray(wbStorageDaily.nmId, args.nmIds));

  // Storage costs by product
  const byProduct = await db
    .select({
      nmId: wbStorageDaily.nmId,
      totalCostKop: sql<number>`coalesce(sum(${wbStorageDaily.cost}), 0)`.mapWith(Number),
      totalDays: sql<number>`coalesce(sum(${wbStorageDaily.days}), 0)`.mapWith(Number),
      avgVolume: sql<number>`coalesce(avg(${wbStorageDaily.volume}), 0)`.mapWith(Number),
      warehouseCount: sql<number>`count(distinct ${wbStorageDaily.warehouseName})`.mapWith(Number),
    })
    .from(wbStorageDaily)
    .where(and(...conds))
    .groupBy(wbStorageDaily.nmId)
    .orderBy(desc(sql`coalesce(sum(${wbStorageDaily.cost}), 0)`))
    .limit(30);

  // Get sales for same period to identify dead stock
  const nmIdsFromStorage = byProduct.map((p) => p.nmId);
  let salesMap = new Map<number, number>();

  if (nmIdsFromStorage.length > 0) {
    // Источник выкупов — funnel (WB Analytics), как в дашборде. Раньше
    // brали из Statistics → числа «продано» расходились с РНП и ЛК.
    const sales = await db
      .select({
        nmId: wbFunnelDailyProducts.nmId,
        totalSalesCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
      })
      .from(wbFunnelDailyProducts)
      .where(and(
        eq(wbFunnelDailyProducts.workspaceId, wsId),
        ...(shopId ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
        gte(wbFunnelDailyProducts.date, from),
        lte(wbFunnelDailyProducts.date, to),
        inArray(wbFunnelDailyProducts.nmId, nmIdsFromStorage),
      ))
      .groupBy(wbFunnelDailyProducts.nmId);

    salesMap = new Map(sales.map((s) => [s.nmId, s.totalSalesCount]));
  }

  // By warehouse
  const byWarehouse = await db
    .select({
      warehouseName: wbStorageDaily.warehouseName,
      totalCostKop: sql<number>`coalesce(sum(${wbStorageDaily.cost}), 0)`.mapWith(Number),
      productsCount: sql<number>`count(distinct ${wbStorageDaily.nmId})`.mapWith(Number),
    })
    .from(wbStorageDaily)
    .where(and(...conds))
    .groupBy(wbStorageDaily.warehouseName)
    .orderBy(desc(sql`coalesce(sum(${wbStorageDaily.cost}), 0)`));

  const totalCostKop = byProduct.reduce((s, p) => s + p.totalCostKop, 0);

  const products = byProduct.map((p) => {
    const sales = salesMap.get(p.nmId) ?? 0;
    const isDeadStock = sales === 0 && p.totalCostKop > 0;
    return {
      nmId: p.nmId,
      storageCostRub: Math.round(p.totalCostKop / 100),
      storageDays: p.totalDays,
      volumeM3: Number(p.avgVolume.toFixed(3)),
      warehouses: p.warehouseCount,
      salesInPeriod: sales,
      isDeadStock,
    };
  });

  return JSON.stringify({
    period: { from, to },
    totalStorageCostRub: Math.round(totalCostKop / 100),
    products,
    deadStockCount: products.filter((p) => p.isDeadStock).length,
    deadStockCostRub: Math.round(products.filter((p) => p.isDeadStock).reduce((s, p) => s + p.storageCostRub, 0)),
    byWarehouse: byWarehouse.map((w) => ({
      warehouse: w.warehouseName || 'Не указан',
      costRub: Math.round(w.totalCostKop / 100),
      products: w.productsCount,
    })),
  });
}
