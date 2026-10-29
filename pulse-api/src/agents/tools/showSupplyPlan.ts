/**
 * Tool: show_supply_plan — Планировщик поставок как виджет.
 * Calculates optimal supply quantities per warehouse based on sales velocity.
 * Inspired by JVO's Logistics PRO module and "Подсортировщик" planning.
 */

import { db } from '../../db/client.js';
import { wbStocksCurrent, wbFunnelDailyProducts, wbCards } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';

interface ShowSupplyPlanArgs {
  nmIds?: number[];
  targetDays?: number;   // Target days of inventory (default 45)
  _workspaceId?: number;
  _shopId?: number;
}

export async function showSupplyPlan(args: ShowSupplyPlanArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const targetDays = args.targetDays ?? 45;

  // Current stocks by nmId + warehouse (scoped to shop)
  const stockConds: any[] = [eq(wbStocksCurrent.workspaceId, wsId)];
  if (shopId != null) stockConds.push(eq(wbStocksCurrent.shopId, shopId));
  if (args.nmIds?.length) stockConds.push(inArray(wbStocksCurrent.nmId, args.nmIds));

  const stocks = await db
    .select({
      nmId: wbStocksCurrent.nmId,
      warehouseName: wbStocksCurrent.warehouseName,
      qty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
    })
    .from(wbStocksCurrent)
    .where(and(...stockConds))
    .groupBy(wbStocksCurrent.nmId, wbStocksCurrent.warehouseName);

  if (stocks.length === 0) {
    return JSON.stringify({ __widget: 'supply_plan', props: { items: [], targetDays } });
  }

  // Total stock per nmId
  const stockByNmId = new Map<number, number>();
  const stockByNmWarehouse = new Map<string, number>();
  for (const s of stocks) {
    stockByNmId.set(s.nmId, (stockByNmId.get(s.nmId) ?? 0) + s.qty);
    stockByNmWarehouse.set(`${s.nmId}:${s.warehouseName}`, s.qty);
  }

  const allNmIds = [...stockByNmId.keys()];

  // 30-day sales velocity
  const now = new Date();
  const d30ago = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  // Sales velocity — из funnel (WB Analytics). Раньше брали из Statistics
  // (wb_orders_sales_daily_products), но числа расходились с WB ЛК и
  // дашбордом РНП → план поставки занижался/завышался относительно того,
  // что юзер видит в интерфейсе.
  const sales = await db
    .select({
      nmId: wbFunnelDailyProducts.nmId,
      totalOrders: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      ...(shopId != null ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
      gte(wbFunnelDailyProducts.date, d30ago),
      lte(wbFunnelDailyProducts.date, today),
      inArray(wbFunnelDailyProducts.nmId, allNmIds),
    ))
    .groupBy(wbFunnelDailyProducts.nmId);

  const salesMap = new Map(sales.map((s) => [s.nmId, s.totalOrders]));

  // Product names (scoped to shop)
  const cards = await db
    .select({ nmId: wbCards.nmId, title: wbCards.title })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, wsId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
      inArray(wbCards.nmId, allNmIds),
    ));
  const cardMap = new Map(cards.map((c) => [c.nmId, c.title]));

  // Build supply plan
  const items = allNmIds.map((nmId) => {
    const currentQty = stockByNmId.get(nmId) ?? 0;
    const orders30d = salesMap.get(nmId) ?? 0;
    const avgDailySales = orders30d / 30;
    const daysOfStock = avgDailySales > 0 ? Math.round(currentQty / avgDailySales) : currentQty > 0 ? 999 : 0;
    const neededQty = avgDailySales > 0
      ? Math.max(0, Math.ceil(avgDailySales * targetDays - currentQty))
      : 0;

    return {
      nmId,
      name: cardMap.get(nmId) ?? `Артикул ${nmId}`,
      currentQty,
      avgDailySales: Number(avgDailySales.toFixed(1)),
      daysOfStock,
      targetDays,
      neededQty,
      priority: daysOfStock === 0 ? 'critical' : daysOfStock < 14 ? 'high' : daysOfStock < 30 ? 'medium' : 'low',
    };
  });

  // Sort by priority (critical first, then by neededQty desc)
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  items.sort((a, b) => {
    const pDiff = (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4);
    if (pDiff !== 0) return pDiff;
    return b.neededQty - a.neededQty;
  });

  // Warehouse breakdown for top items
  const warehouseNames = [...new Set(stocks.map((s) => s.warehouseName))];

  return JSON.stringify({
    __widget: 'supply_plan',
    props: {
      targetDays,
      totalProducts: items.length,
      criticalCount: items.filter((i) => i.priority === 'critical').length,
      highCount: items.filter((i) => i.priority === 'high').length,
      totalNeeded: items.reduce((s, i) => s + i.neededQty, 0),
      items: items.slice(0, 50),
      warehouses: warehouseNames.filter(Boolean),
    },
  });
}
