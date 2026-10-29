/**
 * Tool: query_regional — Региональная аналитика продаж.
 * Определяет приоритетные регионы, рекомендации по складам.
 * Inspired by JVO's regional warehouse optimization.
 */

import { db } from '../../db/client.js';
import { wbRegionSales, wbStocksCurrent } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';

interface QueryRegionalArgs {
  from: string;
  to: string;
  nmIds?: number[];
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryRegionalOverview(args: QueryRegionalArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const { from, to } = args;

  const conds: any[] = [
    eq(wbRegionSales.workspaceId, wsId),
    ...(shopId ? [eq(wbRegionSales.shopId, shopId)] : []),
    gte(wbRegionSales.date, new Date(from)),
    lte(wbRegionSales.date, new Date(to)),
  ];
  if (args.nmIds?.length) conds.push(inArray(wbRegionSales.nmId, args.nmIds));

  // Sales by region
  const byRegion = await db
    .select({
      regionName: wbRegionSales.regionName,
      districtName: wbRegionSales.districtName,
      totalOrders: sql<number>`coalesce(sum(${wbRegionSales.orders}), 0)`.mapWith(Number),
      totalSalesKop: sql<number>`coalesce(sum(${wbRegionSales.sales}), 0)`.mapWith(Number),
      productsCount: sql<number>`count(distinct ${wbRegionSales.nmId})`.mapWith(Number),
    })
    .from(wbRegionSales)
    .where(and(...conds))
    .groupBy(wbRegionSales.regionName, wbRegionSales.districtName)
    .orderBy(desc(sql`coalesce(sum(${wbRegionSales.orders}), 0)`))
    .limit(20);

  // Stocks by warehouse (to correlate with regions)
  const stockConds: any[] = [eq(wbStocksCurrent.workspaceId, wsId), ...(shopId ? [eq(wbStocksCurrent.shopId, shopId)] : [])];
  if (args.nmIds?.length) stockConds.push(inArray(wbStocksCurrent.nmId, args.nmIds));

  const stocksByWarehouse = await db
    .select({
      warehouseName: wbStocksCurrent.warehouseName,
      totalQty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
      productsCount: sql<number>`count(distinct ${wbStocksCurrent.nmId})`.mapWith(Number),
    })
    .from(wbStocksCurrent)
    .where(and(...stockConds))
    .groupBy(wbStocksCurrent.warehouseName)
    .orderBy(desc(sql`coalesce(sum(${wbStocksCurrent.quantity}), 0)`));

  // Calculate totals
  const totalOrders = byRegion.reduce((s, r) => s + r.totalOrders, 0);
  const totalSalesKop = byRegion.reduce((s, r) => s + r.totalSalesKop, 0);

  // Region share analysis
  const regions = byRegion.map((r) => ({
    region: r.regionName || 'Не указан',
    district: r.districtName || '',
    orders: r.totalOrders,
    salesRub: Math.round(r.totalSalesKop / 100),
    sharePct: totalOrders > 0 ? Number(((r.totalOrders / totalOrders) * 100).toFixed(1)) : 0,
    products: r.productsCount,
  }));

  return JSON.stringify({
    period: { from, to },
    totalOrders,
    totalSalesRub: Math.round(totalSalesKop / 100),
    regions,
    warehouses: stocksByWarehouse.map((w) => ({
      name: w.warehouseName || 'Не указан',
      qty: w.totalQty,
      products: w.productsCount,
    })),
    topRegion: regions[0] ?? null,
    regionCount: regions.length,
  });
}
