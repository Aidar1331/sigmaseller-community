/**
 * Region Sales API Routes
 * 
 * Regional sales analytics from async reports
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wbRegionSales } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

export const regionSalesRoutes: FastifyPluginAsync = async (app) => {
  // GET /region-sales/:workspaceId
  // Get regional sales data
  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      from?: string;
      to?: string;
      nmId?: string;
      regionId?: string;
      shopId?: string;
    };
  }>('/region-sales/:workspaceId', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { from, to, nmId, regionId } = request.query;
    const shopId = Number(request.query.shopId) || undefined;

    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    let whereConditions: any[] = [
      eq(wbRegionSales.workspaceId, workspaceId),
      gte(wbRegionSales.date, new Date(dateFrom)),
      lte(wbRegionSales.date, new Date(dateTo)),
      buildShopFilter(wbRegionSales.shopId, shopId),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    if (nmId) {
      whereConditions.push(eq(wbRegionSales.nmId, Number(nmId)));
    }

    if (regionId) {
      whereConditions.push(eq(wbRegionSales.regionId, Number(regionId)));
    }

    const rows = await db
      .select()
      .from(wbRegionSales)
      .where(and(...whereConditions))
      .orderBy(desc(wbRegionSales.date))
      .limit(10000);

    return {
      workspaceId,
      dateFrom,
      dateTo,
      rows,
      total: rows.length,
    };
  });

  // GET /region-sales/:workspaceId/summary
  // Get aggregated regional summary
  app.get<{
    Params: { workspaceId: string };
    Querystring: { from?: string; to?: string };
  }>('/region-sales/:workspaceId/summary', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { from, to } = request.query;
    const shopId = Number((request.query as any).shopId) || undefined;

    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Aggregate by region
    const shopFilter = buildShopFilter(wbRegionSales.shopId, shopId);
    const conditions: any[] = [
      eq(wbRegionSales.workspaceId, workspaceId),
      gte(wbRegionSales.date, new Date(dateFrom)),
      lte(wbRegionSales.date, new Date(dateTo)),
    ];
    if (shopFilter) conditions.push(shopFilter);

    const byRegion = await db
      .select({
        regionId: wbRegionSales.regionId,
        regionName: wbRegionSales.regionName,
        totalOrders: sql<number>`sum(${wbRegionSales.orders})::int`,
        totalSales: sql<number>`sum(${wbRegionSales.sales})::int`,
      })
      .from(wbRegionSales)
      .where(and(...conditions))
      .groupBy(wbRegionSales.regionId, wbRegionSales.regionName)
      .orderBy(desc(sql`sum(${wbRegionSales.orders})`));

    // Calculate totals
    const totalOrders = byRegion.reduce((sum, r) => sum + (r.totalOrders || 0), 0);
    const totalSales = byRegion.reduce((sum, r) => sum + (r.totalSales || 0), 0);

    return {
      workspaceId,
      dateFrom,
      dateTo,
      regions: byRegion.map(r => ({
        ...r,
        ordersPercent: totalOrders > 0 ? ((r.totalOrders || 0) / totalOrders * 100).toFixed(1) : '0',
        salesPercent: totalSales > 0 ? ((r.totalSales || 0) / totalSales * 100).toFixed(1) : '0',
      })),
      totals: {
        orders: totalOrders,
        sales: totalSales,
        regionCount: byRegion.length,
      },
    };
  });

  // GET /region-sales/:workspaceId/heatmap
  // Get data for heatmap visualization
  app.get<{
    Params: { workspaceId: string };
    Querystring: { from?: string; to?: string };
  }>('/region-sales/:workspaceId/heatmap', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { from, to } = request.query;

    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Extract shopId for multi-shop filtering
    const shopId = Number((request.query as any)?.shopId) || undefined;

    // Get daily data by region
    const data = await db
      .select({
        date: sql<string>`${wbRegionSales.date}::date::text`,
        regionId: wbRegionSales.regionId,
        regionName: wbRegionSales.regionName,
        orders: sql<number>`sum(${wbRegionSales.orders})::int`,
        sales: sql<number>`sum(${wbRegionSales.sales})::int`,
      })
      .from(wbRegionSales)
      .where(and(
        eq(wbRegionSales.workspaceId, workspaceId),
        gte(wbRegionSales.date, new Date(dateFrom)),
        lte(wbRegionSales.date, new Date(dateTo)),
        ...(shopId ? [eq(wbRegionSales.shopId, shopId)] : []),
      ))
      .groupBy(sql`${wbRegionSales.date}::date`, wbRegionSales.regionId, wbRegionSales.regionName)
      .orderBy(sql`${wbRegionSales.date}::date`, desc(sql`sum(${wbRegionSales.orders})`));

    // Get unique dates and regions
    const dates = [...new Set(data.map(d => d.date))].sort();
    const regions = [...new Map(data.map(d => {
      const key = d.regionId != null ? String(d.regionId) : (d.regionName ?? 'unknown');
      return [key, d.regionName] as const;
    })).entries()]
      .map(([id, name]) => ({ id, name }));

    // Build heatmap matrix (keyed by regionName when regionId is null)
    const matrix: Record<string, Record<string, { orders: number; sales: number }>> = {};
    for (const row of data) {
      const key = row.regionId != null ? String(row.regionId) : (row.regionName ?? 'unknown');
      if (!matrix[key]) matrix[key] = {};
      matrix[key][row.date] = {
        orders: row.orders || 0,
        sales: row.sales || 0,
      };
    }

    return {
      workspaceId,
      dateFrom,
      dateTo,
      dates,
      regions,
      matrix,
    };
  });
};
