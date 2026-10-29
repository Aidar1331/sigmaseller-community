import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbStocksCurrent, wbStocksDailyProducts, wbStocksDaily, marketplaceShops } from '../db/schema.js';
import { syncWbStocksCurrentAndSnapshot } from '../integrations/wb/stocks.js';
import { requireRole } from '../plugins/roleCheck.js';
import { extractShopId } from '../plugins/shopFilter.js';
import { buildShopFilter } from './pulse/helpers.js';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const stocksRoutes: FastifyPluginAsync = async (app) => {
  // Current stocks (best-effort) from WB Statistics API v1.
  // Docs: https://statistics-api.wildberries.ru/api/v1/supplier/stocks
  app.get('/stocks/:workspaceId/current', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        nmIds: z.string().optional(),
        refresh: z.enum(['0', '1']).optional(),
        noRefresh: z.enum(['0', '1']).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    
    const shopId = query.shopId;

    const nmIds = (query.nmIds ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    const refresh = (query.refresh ?? '0') === '1';
    const noRefresh = (query.noRefresh ?? '0') === '1';

    // cache freshness window
    const maxAgeMs = 30 * 60 * 1000;
    const now = Date.now();

    if (!noRefresh) {
      if (refresh) {
        await refreshStocks(params.workspaceId);
      } else {
        // refresh if empty or stale for this workspace
        const any = await db
          .select({ updatedAt: wbStocksCurrent.updatedAt })
          .from(wbStocksCurrent)
          .where(eq(wbStocksCurrent.workspaceId, params.workspaceId))
          .orderBy(desc(wbStocksCurrent.updatedAt))
          .limit(1);
        const at = any[0]?.updatedAt ? new Date(any[0].updatedAt).getTime() : 0;
        if (!at || now - at > maxAgeMs) {
          await refreshStocks(params.workspaceId);
        }
      }
    }

    const baseConditions = [
      eq(wbStocksCurrent.workspaceId, params.workspaceId),
      buildShopFilter(wbStocksCurrent.shopId, shopId),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    
    const where = nmIds.length
      ? and(...baseConditions, inArray(wbStocksCurrent.nmId, nmIds as any))
      : baseConditions.length > 1 ? and(...baseConditions) : baseConditions[0];

    const rows = await db
      .select({
        nmId: wbStocksCurrent.nmId,
        quantity: wbStocksCurrent.quantity,
        inWayToClient: wbStocksCurrent.inWayToClient,
        inWayFromClient: wbStocksCurrent.inWayFromClient,
        warehouseName: wbStocksCurrent.warehouseName,
        updatedAt: wbStocksCurrent.updatedAt,
      })
      .from(wbStocksCurrent)
      .where(where)
      .limit(2000);

    return {
      workspaceId: params.workspaceId,
      rows: rows.map((r) => ({
        nmId: r.nmId,
        quantity: r.quantity,
        inWayToClient: r.inWayToClient,
        inWayFromClient: r.inWayFromClient,
        warehouseName: r.warehouseName,
        updatedAt: new Date(r.updatedAt).toISOString(),
      })),
    };
  });

  // Daily snapshot series (from our own snapshots collected during refreshStocks)
  app.get('/stocks/:workspaceId/daily', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        start: z.string(),
        end: z.string(),
        nmIds: z.string().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const nmIds = (query.nmIds ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    
    const shopId = query.shopId;

    const baseConditions = [
      eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
      buildShopFilter(wbStocksDailyProducts.shopId, shopId),
      gte(wbStocksDailyProducts.date, query.start),
      lte(wbStocksDailyProducts.date, query.end),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const whereBase = and(...baseConditions);

    const where = nmIds.length ? and(whereBase, inArray(wbStocksDailyProducts.nmId, nmIds as any)) : whereBase;

    const rows = await db
      .select({
        date: wbStocksDailyProducts.date,
        nmId: wbStocksDailyProducts.nmId,
        quantity: wbStocksDailyProducts.quantity,
        inWayToClient: wbStocksDailyProducts.inWayToClient,
        inWayFromClient: wbStocksDailyProducts.inWayFromClient,
      })
      .from(wbStocksDailyProducts)
      .where(where)
      .limit(200_000);

    return { workspaceId: params.workspaceId, start: query.start, end: query.end, rows };
  });

  // History from WB API
  app.get('/stocks/:workspaceId/history', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        nmId: z.coerce.number().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getStocksHistoryByDay } = await import('../integrations/wb/stocksHistory.js');

    const apiKey = await getWbApiKey(params.workspaceId, extractShopId(req));
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [] };
    }

    const today = new Date();
    const dateTo = query.to || today.toISOString().slice(0, 10);
    const dateFrom = query.from || new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
      const result = await getStocksHistoryByDay(apiKey, {
        dateFrom,
        dateTo,
        nmIds: query.nmId ? [query.nmId] : undefined,
      });

      return { data: result.data, dateFrom, dateTo };
    } catch (e: any) {
      return { error: e.message, data: [] };
    }
  });

  // Warehouse details from reports
  app.get('/stocks/:workspaceId/warehouses', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        nmId: z.coerce.number().optional(),
        warehouseId: z.coerce.number().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const today = new Date();
    const dateTo = query.to || today.toISOString().slice(0, 10);
    const dateFrom = query.from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const shopId = query.shopId;

    let whereConditions: any[] = [
      eq(wbStocksDaily.workspaceId, params.workspaceId),
      buildShopFilter(wbStocksDaily.shopId, shopId),
      gte(wbStocksDaily.date, new Date(dateFrom)),
      lte(wbStocksDaily.date, new Date(dateTo)),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    if (query.nmId) {
      whereConditions.push(eq(wbStocksDaily.nmId, query.nmId));
    }

    if (query.warehouseId) {
      whereConditions.push(eq(wbStocksDaily.warehouseId, query.warehouseId));
    }

    const rows = await db
      .select()
      .from(wbStocksDaily)
      .where(and(...whereConditions))
      .orderBy(desc(wbStocksDaily.date))
      .limit(10000);

    // Aggregate by warehouse
    const byWarehouse: Record<string, { warehouseId: number | null; warehouseName: string | null; totalQty: number; count: number }> = {};
    for (const row of rows) {
      const key = row.warehouseName || 'unknown';
      if (!byWarehouse[key]) {
        byWarehouse[key] = { warehouseId: row.warehouseId, warehouseName: row.warehouseName, totalQty: 0, count: 0 };
      }
      byWarehouse[key].totalQty += row.qty || 0;
      byWarehouse[key].count++;
    }

    return {
      workspaceId: params.workspaceId,
      dateFrom,
      dateTo,
      rows,
      warehouses: Object.values(byWarehouse).sort((a, b) => b.totalQty - a.totalQty),
    };
  });
};

async function refreshStocks(workspaceId: number): Promise<void> {
  const shops = await db
    .select({ shopId: marketplaceShops.shopId })
    .from(marketplaceShops)
    .where(eq(marketplaceShops.workspaceId, workspaceId));
  for (const { shopId } of shops) {
    await syncWbStocksCurrentAndSnapshot(workspaceId, shopId);
  }
}
