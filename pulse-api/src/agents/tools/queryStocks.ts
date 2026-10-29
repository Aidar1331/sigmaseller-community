/**
 * Tool: query_stocks — Current inventory overview.
 * Reuses patterns from routes/stocks.ts
 */

import { db } from '../../db/client.js';
import { wbStocksCurrent, wbStocksFbsCurrent, wbFunnelDailyProducts, wbCards } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';
import { resolveProductIds } from './_resolveProductIds.js';

interface QueryStocksArgs {
  /** nmId или vendorCode (артикул продавца). Принимается любой. */
  nmIds?: Array<number | string>;
  lowDaysThreshold?: number;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryStocksOverview(args: QueryStocksArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const lowThreshold = args.lowDaysThreshold ?? 14;

  // Resolve nmId или vendorCode → массив nmId
  const resolvedNmIds = args.nmIds?.length ? await resolveProductIds(wsId, args.nmIds) : [];
  if (args.nmIds?.length && !resolvedNmIds.length) {
    return JSON.stringify({ error: 'no_products_found', hint: `артикулы не найдены: ${args.nmIds.join(', ')}` });
  }

  // Current stocks grouped by nmId
  const stockConds: any[] = [eq(wbStocksCurrent.workspaceId, wsId), ...(shopId ? [eq(wbStocksCurrent.shopId, shopId)] : [])];
  if (resolvedNmIds.length) stockConds.push(inArray(wbStocksCurrent.nmId, resolvedNmIds));

  const stocks = await db
    .select({
      nmId: wbStocksCurrent.nmId,
      totalQty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
      inWayToClient: sql<number>`coalesce(sum(${wbStocksCurrent.inWayToClient}), 0)`.mapWith(Number),
      inWayFromClient: sql<number>`coalesce(sum(${wbStocksCurrent.inWayFromClient}), 0)`.mapWith(Number),
      warehouseCount: sql<number>`count(distinct ${wbStocksCurrent.warehouseName})`.mapWith(Number),
    })
    .from(wbStocksCurrent)
    .where(and(...stockConds))
    .groupBy(wbStocksCurrent.nmId);

  // FBS-остатки (склад продавца) — отдельно от FBO. Используются как буфер
  // при OOS-расчётах и не учитываются в избытке (хранение WB не платится).
  const fbsConds: any[] = [eq(wbStocksFbsCurrent.workspaceId, wsId), ...(shopId ? [eq(wbStocksFbsCurrent.shopId, shopId)] : [])];
  if (resolvedNmIds.length) fbsConds.push(inArray(wbStocksFbsCurrent.nmId, resolvedNmIds));
  const fbsStocks = await db
    .select({
      nmId: wbStocksFbsCurrent.nmId,
      fbsQty: sql<number>`coalesce(sum(${wbStocksFbsCurrent.quantity}), 0)`.mapWith(Number),
      fbsWarehouseCount: sql<number>`count(distinct ${wbStocksFbsCurrent.warehouseId})`.mapWith(Number),
    })
    .from(wbStocksFbsCurrent)
    .where(and(...fbsConds))
    .groupBy(wbStocksFbsCurrent.nmId);
  const fbsMap = new Map(fbsStocks.map((s) => [s.nmId, { qty: s.fbsQty, warehouses: s.fbsWarehouseCount }]));

  // Объединяем nmId — могут быть товары только на FBS (нет на FBO)
  const allNmIds = new Set<number>([...stocks.map((s) => s.nmId), ...fbsMap.keys()]);
  const fboMap = new Map(stocks.map((s) => [s.nmId, s]));

  // Get 14-day avg daily sales for days-of-stock calculation
  const now = new Date();
  const d14ago = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const nmIdsForSales = [...allNmIds];
  if (nmIdsForSales.length === 0) {
    return JSON.stringify({ totalProducts: 0, zeroStock: [], lowStock: [], healthy: [] });
  }

  // Source: funnel (WB Analytics) buyoutCount = выкупы за 14 дней. Раньше
  // брали из Statistics → days-of-stock расходился с дашбордом.
  const sales = await db
    .select({
      nmId: wbFunnelDailyProducts.nmId,
      totalSalesCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      ...(shopId ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
      gte(wbFunnelDailyProducts.date, d14ago),
      lte(wbFunnelDailyProducts.date, today),
      inArray(wbFunnelDailyProducts.nmId, nmIdsForSales),
    ))
    .groupBy(wbFunnelDailyProducts.nmId);

  const salesMap = new Map(sales.map((s) => [s.nmId, s.totalSalesCount]));

  const zeroStock: any[] = [];
  const lowStock: any[] = [];
  const healthy: any[] = [];

  for (const nmId of allNmIds) {
    const fbo = fboMap.get(nmId);
    const fboQty = fbo?.totalQty ?? 0;
    const fbs = fbsMap.get(nmId);
    const fbsQty = fbs?.qty ?? 0;
    const totalQty = fboQty + fbsQty;
    const totalSales14d = salesMap.get(nmId) ?? 0;
    const avgDailySales = totalSales14d / 14;
    const daysOfStock = avgDailySales > 0 ? Math.round(totalQty / avgDailySales) : totalQty > 0 ? 999 : 0;

    const item = {
      nmId,
      qty: totalQty,
      fboQty,
      fbsQty,
      daysOfStock,
      avgDailySales: +avgDailySales.toFixed(1),
      warehouses: fbo?.warehouseCount ?? 0,
      fbsWarehouses: fbs?.warehouses ?? 0,
    };

    if (totalQty === 0) zeroStock.push(item);
    else if (daysOfStock < lowThreshold) lowStock.push(item);
    else healthy.push(item);
  }

  return JSON.stringify({
    note: 'qty = fboQty + fbsQty. Избыток считается только по FBO (хранение WB).',
    totalProducts: allNmIds.size,
    zeroStockCount: zeroStock.length,
    lowStockCount: lowStock.length,
    healthyCount: healthy.length,
    zeroStock: zeroStock.slice(0, 20),
    lowStock: lowStock.sort((a, b) => a.daysOfStock - b.daysOfStock).slice(0, 20),
    healthySummary: { count: healthy.length, avgDaysOfStock: healthy.length > 0 ? Math.round(healthy.reduce((s, h) => s + h.daysOfStock, 0) / healthy.length) : 0 },
  });
}
