import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, desc, asc, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  supplyPriorityWarehouses,
  supplyBoxSettings,
  supplyDrivers,
  supplyDrafts,
  supplyDraftItems,
  supplyBookingQueue,
  supplies,
  supplyBoxes,
  supplyDocuments,
  supplyPasses,
  supplySlotsCache,
  warehouseRegionMapping,
  regionWarehouseMapping,
  wbWarehouses,
  wbCards,
  wbStocksCurrent,
  wbOrdersSalesDailyProductWarehouses,
  wbOrdersSalesDailyProductRegions,
} from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { extractShopId } from '../plugins/shopFilter.js';
import { buildShopFilter } from './pulse/helpers.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'supplies' });

// =====================
// Helpers
// =====================

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

// =====================
// Routes
// =====================

export const suppliesRoutes: FastifyPluginAsync = async (app) => {
  
  // ─────────────────────────────────────────────────────────────────
  // PRIORITY WAREHOUSES
  // ─────────────────────────────────────────────────────────────────

  // Get all warehouses with priorities, grouped by region
  app.get('/supplies/:workspaceId/warehouses', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    // Get all active warehouses from directory
    const allWarehouses = await db
      .select({
        warehouseId: wbWarehouses.id,
        warehouseName: wbWarehouses.name,
        address: wbWarehouses.address,
        region: wbWarehouses.region,
      })
      .from(wbWarehouses)
      .where(eq(wbWarehouses.isActive, true))
      .orderBy(wbWarehouses.region, wbWarehouses.name);

    // Get user's priorities
    const priorities = await db
      .select()
      .from(supplyPriorityWarehouses)
      .where(eq(supplyPriorityWarehouses.workspaceId, workspaceId));

    const priorityMap = new Map(priorities.map(p => [p.warehouseId, p.priority]));

    // Get sales by warehouse (last 14 days)
    const dateTo = new Date().toISOString().slice(0, 10);
    const dateFrom = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    
    const shopId = Number((req.query as any)?.shopId) || undefined;
    const shopCond = buildShopFilter(wbOrdersSalesDailyProductWarehouses.shopId, shopId);
    const salesConditions: any[] = [
      eq(wbOrdersSalesDailyProductWarehouses.workspaceId, workspaceId),
      sql`${wbOrdersSalesDailyProductWarehouses.date} >= ${dateFrom}`,
      sql`${wbOrdersSalesDailyProductWarehouses.date} <= ${dateTo}`,
    ];
    if (shopCond) salesConditions.push(shopCond);

    const salesByWarehouse = await db
      .select({
        warehouseName: wbOrdersSalesDailyProductWarehouses.warehouseName,
        salesCount: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.salesCount})`.mapWith(Number),
        ordersCount: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.ordersCount})`.mapWith(Number),
      })
      .from(wbOrdersSalesDailyProductWarehouses)
      .where(and(...salesConditions))
      .groupBy(wbOrdersSalesDailyProductWarehouses.warehouseName);

    const salesMap = new Map(salesByWarehouse.map(s => [s.warehouseName, { salesCount: s.salesCount, ordersCount: s.ordersCount }]));

    // Group by region
    const byRegion = new Map<string, typeof allWarehouses>();
    for (const w of allWarehouses) {
      const region = w.region ?? 'Другие';
      const arr = byRegion.get(region) ?? [];
      arr.push(w);
      byRegion.set(region, arr);
    }

    // Convert to response format
    const regions = Array.from(byRegion.entries()).map(([regionName, warehouses]) => ({
      regionName,
      warehouses: warehouses.map(w => {
        const sales = salesMap.get(w.warehouseName);
        return {
          warehouseId: w.warehouseId,
          warehouseName: w.warehouseName,
          address: w.address,
          priority: priorityMap.get(w.warehouseId) ?? null,
          salesCount14d: sales?.salesCount ?? 0,
          ordersCount14d: sales?.ordersCount ?? 0,
        };
      }),
      // Region has priority if any warehouse in it has priority
      hasPriority: warehouses.some(w => priorityMap.has(w.warehouseId)),
    }));

    // Sort: regions with priorities first, then alphabetically
    regions.sort((a, b) => {
      if (a.hasPriority !== b.hasPriority) return a.hasPriority ? -1 : 1;
      return a.regionName.localeCompare(b.regionName, 'ru');
    });

    return { regions };
  });

  // Update warehouse priorities
  app.put('/supplies/:workspaceId/warehouses/priorities', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      priorities: z.array(z.object({
        warehouseId: z.number().int().positive(),
        warehouseName: z.string(),
        priority: z.number().int().min(1).max(10).nullable(),
      })),
    }).parse(req.body);

    // Delete existing and insert new
    await db.delete(supplyPriorityWarehouses).where(eq(supplyPriorityWarehouses.workspaceId, workspaceId));

    const toInsert = body.priorities.filter(p => p.priority !== null);
    if (toInsert.length > 0) {
      await db.insert(supplyPriorityWarehouses).values(
        toInsert.map(p => ({
          workspaceId,
          warehouseId: p.warehouseId,
          warehouseName: p.warehouseName,
          priority: p.priority,
          updatedAt: new Date(),
        }))
      );
    }

    return { success: true, count: toInsert.length };
  });

  // ─────────────────────────────────────────────────────────────────
  // BOX SETTINGS
  // ─────────────────────────────────────────────────────────────────

  // Get box settings
  app.get('/supplies/:workspaceId/box-settings', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const settings = await db
      .select()
      .from(supplyBoxSettings)
      .where(eq(supplyBoxSettings.workspaceId, workspaceId));

    const defaultSetting = settings.find(s => s.nmId === null);
    const perProduct = settings.filter(s => s.nmId !== null);

    return {
      defaultItemsPerBox: defaultSetting?.itemsPerBox ?? 10,
      perProduct: perProduct.map(s => ({
        nmId: s.nmId,
        itemsPerBox: s.itemsPerBox,
      })),
    };
  });

  // Update box settings
  app.put('/supplies/:workspaceId/box-settings', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      defaultItemsPerBox: z.number().int().min(1).max(1000).optional(),
      nmId: z.number().int().positive().optional(),
      itemsPerBox: z.number().int().min(1).max(1000).optional(),
    }).parse(req.body);

    if (body.defaultItemsPerBox !== undefined) {
      await db
        .insert(supplyBoxSettings)
        .values({ workspaceId, nmId: null, itemsPerBox: body.defaultItemsPerBox })
        .onConflictDoUpdate({
          target: [supplyBoxSettings.workspaceId, supplyBoxSettings.nmId],
          set: { itemsPerBox: body.defaultItemsPerBox },
        });
    }

    if (body.nmId !== undefined && body.itemsPerBox !== undefined) {
      await db
        .insert(supplyBoxSettings)
        .values({ workspaceId, nmId: body.nmId, itemsPerBox: body.itemsPerBox })
        .onConflictDoUpdate({
          target: [supplyBoxSettings.workspaceId, supplyBoxSettings.nmId],
          set: { itemsPerBox: body.itemsPerBox },
        });
    }

    return { success: true };
  });

  // ─────────────────────────────────────────────────────────────────
  // DRIVERS
  // ─────────────────────────────────────────────────────────────────

  // Get drivers
  app.get('/supplies/:workspaceId/drivers', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const drivers = await db
      .select()
      .from(supplyDrivers)
      .where(eq(supplyDrivers.workspaceId, workspaceId))
      .orderBy(desc(supplyDrivers.isDefault), asc(supplyDrivers.lastName));

    return { drivers };
  });

  // Create driver
  app.post('/supplies/:workspaceId/drivers', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      firstName: z.string().min(1).max(50),
      lastName: z.string().min(1).max(50),
      carModel: z.string().min(1).max(100),
      carNumber: z.string().min(6).max(15),
      isDefault: z.boolean().optional(),
    }).parse(req.body);

    // If setting as default, unset others
    if (body.isDefault) {
      await db
        .update(supplyDrivers)
        .set({ isDefault: false })
        .where(eq(supplyDrivers.workspaceId, workspaceId));
    }

    const [driver] = await db
      .insert(supplyDrivers)
      .values({ workspaceId, ...body })
      .returning();

    return { driver };
  });

  // Delete driver
  app.delete('/supplies/:workspaceId/drivers/:driverId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      driverId: z.coerce.number().int().positive(),
    }).parse(req.params);

    await db
      .delete(supplyDrivers)
      .where(and(
        eq(supplyDrivers.workspaceId, params.workspaceId),
        eq(supplyDrivers.driverId, params.driverId)
      ));

    return { success: true };
  });

  // ─────────────────────────────────────────────────────────────────
  // DRAFTS
  // ─────────────────────────────────────────────────────────────────

  // List drafts
  app.get('/supplies/:workspaceId/drafts', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      status: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const conditions = [eq(supplyDrafts.workspaceId, workspaceId)];
    const draftsShopFilter = buildShopFilter(supplyDrafts.shopId, query.shopId);
    if (draftsShopFilter) conditions.push(draftsShopFilter);
    if (query.status) {
      conditions.push(eq(supplyDrafts.status, query.status));
    }

    const drafts = await db
      .select()
      .from(supplyDrafts)
      .where(and(...conditions))
      .orderBy(desc(supplyDrafts.updatedAt));

    return { drafts };
  });

  // Get draft with items
  app.get('/supplies/:workspaceId/drafts/:draftId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      draftId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const [draft] = await db
      .select()
      .from(supplyDrafts)
      .where(and(
        eq(supplyDrafts.workspaceId, params.workspaceId),
        eq(supplyDrafts.draftId, params.draftId)
      ));

    if (!draft) {
      throw Object.assign(new Error('Draft not found'), { statusCode: 404 });
    }

    const items = await db
      .select()
      .from(supplyDraftItems)
      .where(eq(supplyDraftItems.draftId, params.draftId));

    return { draft, items };
  });

  // Create draft (with smart calculation)
  app.post('/supplies/:workspaceId/drafts', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      name: z.string().optional(),
      warehouseId: z.preprocess(
        (val) => (val === null || val === undefined || Number.isNaN(val)) ? null : val,
        z.number().int().positive().nullable().optional()
      ),
      warehouseName: z.string(),
      plannedDate: z.string().optional(),
      shopId: z.number().int().positive().optional(),
      items: z.array(z.object({
        nmId: z.number().int().positive(),
        quantity: z.number().int().min(0),
      })),
    }).parse(req.body);
    const draftShopId: number | null = body.shopId ?? extractShopId(req) ?? null;

    // Get box settings
    const boxSettings = await db
      .select()
      .from(supplyBoxSettings)
      .where(eq(supplyBoxSettings.workspaceId, workspaceId));

    const defaultBox = boxSettings.find(s => s.nmId === null)?.itemsPerBox ?? 10;
    const boxMap = new Map(boxSettings.filter(s => s.nmId).map(s => [s.nmId, s.itemsPerBox]));

    // Get product info
    const nmIds = body.items.map(i => i.nmId);
    const cards = nmIds.length > 0 ? await db
      .select({
        nmId: wbCards.nmId,
        vendorCode: wbCards.vendorCode,
        title: wbCards.title,
      })
      .from(wbCards)
      .where(and(
        eq(wbCards.workspaceId, workspaceId),
        inArray(wbCards.nmId, nmIds)
      )) : [];

    const cardMap = new Map(cards.map(c => [c.nmId, c]));

    // Create draft
    const [draft] = await db
      .insert(supplyDrafts)
      .values({
        workspaceId,
        shopId: draftShopId,
        name: body.name ?? `Поставка ${isoDate(new Date())}`,
        warehouseId: body.warehouseId,
        warehouseName: body.warehouseName,
        plannedDate: body.plannedDate,
        status: 'draft',
      })
      .returning();

    // Process items with box calculation
    let totalQty = 0;
    let totalBoxes = 0;

    const itemsToInsert = body.items.filter(i => i.quantity > 0).map(i => {
      const card = cardMap.get(i.nmId);
      const itemsPerBox = boxMap.get(i.nmId) ?? defaultBox;
      const boxes = Math.ceil(i.quantity / itemsPerBox);
      
      totalQty += i.quantity;
      totalBoxes += boxes;

      return {
        draftId: draft.draftId,
        nmId: i.nmId,
        vendorCode: card?.vendorCode ?? null,
        title: card?.title ?? null,
        quantity: i.quantity,
        quantityAdjusted: i.quantity,
        itemsPerBox,
        boxesCount: boxes,
      };
    });

    if (itemsToInsert.length > 0) {
      await db.insert(supplyDraftItems).values(itemsToInsert);
    }

    // Update totals
    await db
      .update(supplyDrafts)
      .set({
        totalItems: itemsToInsert.length,
        totalQty,
        totalBoxes,
        updatedAt: new Date(),
      })
      .where(eq(supplyDrafts.draftId, draft.draftId));

    return { draft: { ...draft, totalItems: itemsToInsert.length, totalQty, totalBoxes } };
  });

  // Update draft
  app.put('/supplies/:workspaceId/drafts/:draftId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      draftId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      name: z.string().optional(),
      warehouseId: z.number().int().positive().optional(),
      warehouseName: z.string().optional(),
      plannedDate: z.string().nullable().optional(),
      status: z.string().optional(),
    }).parse(req.body);

    const [updated] = await db
      .update(supplyDrafts)
      .set({ ...body, updatedAt: new Date() })
      .where(and(
        eq(supplyDrafts.workspaceId, params.workspaceId),
        eq(supplyDrafts.draftId, params.draftId)
      ))
      .returning();

    return { draft: updated };
  });

  // Delete draft
  app.delete('/supplies/:workspaceId/drafts/:draftId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      draftId: z.coerce.number().int().positive(),
    }).parse(req.params);

    await db
      .delete(supplyDrafts)
      .where(and(
        eq(supplyDrafts.workspaceId, params.workspaceId),
        eq(supplyDrafts.draftId, params.draftId)
      ));

    return { success: true };
  });

  // Export draft as Excel (for WB upload)
  app.get('/supplies/:workspaceId/drafts/:draftId/export', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      draftId: z.coerce.number().int().positive(),
    }).parse(req.params);

    // Get draft with items
    const [draft] = await db
      .select()
      .from(supplyDrafts)
      .where(and(
        eq(supplyDrafts.workspaceId, params.workspaceId),
        eq(supplyDrafts.draftId, params.draftId)
      ));

    if (!draft) {
      return reply.status(404).send({ error: 'Draft not found' });
    }

    const items = await db
      .select({
        barcode: supplyDraftItems.barcode,
        quantity: supplyDraftItems.quantity,
      })
      .from(supplyDraftItems)
      .where(eq(supplyDraftItems.draftId, params.draftId));

    // Generate simple CSV (WB accepts CSV with barcode,quantity)
    const csv = ['barcode,quantity', ...items.map(i => `${i.barcode},${i.quantity}`)].join('\n');

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="draft-${params.draftId}.csv"`);
    return csv;
  });

  // ─────────────────────────────────────────────────────────────────
  // RECOMMENDED PRODUCTS FOR SUPPLY (no warehouseId needed — for wizard)
  // ─────────────────────────────────────────────────────────────────

  app.get('/supplies/:workspaceId/recommended', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      salesPeriod: z.coerce.number().int().min(7).max(90).default(14),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const recShopId = query.shopId;
    const today = new Date();
    const dateFrom = isoDate(addDays(today, -query.salesPeriod));
    const dateTo = isoDate(today);

    // Get ALL sales across all warehouses (not per-warehouse)
    const recShopCond = buildShopFilter(wbOrdersSalesDailyProductWarehouses.shopId, recShopId);
    const recSalesConds: any[] = [
      eq(wbOrdersSalesDailyProductWarehouses.workspaceId, workspaceId),
      sql`${wbOrdersSalesDailyProductWarehouses.date} >= ${dateFrom}`,
      sql`${wbOrdersSalesDailyProductWarehouses.date} <= ${dateTo}`,
    ];
    if (recShopCond) recSalesConds.push(recShopCond);

    const recSalesData = await db
      .select({
        nmId: wbOrdersSalesDailyProductWarehouses.nmId,
        ordersCount: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.ordersCount})`.mapWith(Number),
      })
      .from(wbOrdersSalesDailyProductWarehouses)
      .where(and(...recSalesConds))
      .groupBy(wbOrdersSalesDailyProductWarehouses.nmId);

    // Get current stock
    const recStockData = await db
      .select({
        nmId: wbStocksCurrent.nmId,
        quantity: sql<number>`sum(${wbStocksCurrent.quantity})`.mapWith(Number),
      })
      .from(wbStocksCurrent)
      .where(eq(wbStocksCurrent.workspaceId, workspaceId))
      .groupBy(wbStocksCurrent.nmId);
    const recStockMap = new Map(recStockData.map(s => [s.nmId, s]));

    // Get product info
    const recNmIds = [...new Set(recSalesData.map(s => s.nmId))];
    const recCards = recNmIds.length > 0 ? await db
      .select({
        nmId: wbCards.nmId,
        vendorCode: wbCards.vendorCode,
        title: wbCards.title,
        barcode: sql<string>`COALESCE(
          NULLIF(${wbCards.raw}::jsonb #>> '{sizes,0,skus,0}', ''),
          ${wbCards.vendorCode}
        )`.mapWith(String),
      })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, workspaceId), inArray(wbCards.nmId, recNmIds)))
      : [];
    const recCardMap = new Map(recCards.map(c => [c.nmId, c]));

    const deliveryDays = 5;
    const safetyDays = 7;
    const horizonDays = deliveryDays + safetyDays;
    const recItems = [];

    for (const s of recSalesData) {
      const stock = recStockMap.get(s.nmId);
      const card = recCardMap.get(s.nmId);
      const currentStock = stock?.quantity ?? 0;
      const avgDailySales = (s.ordersCount ?? 0) / query.salesPeriod;
      const daysOfStock = avgDailySales > 0 ? currentStock / avgDailySales : null;
      const recommended = Math.max(0, Math.ceil(avgDailySales * horizonDays) - currentStock);

      recItems.push({
        nmId: s.nmId,
        vendorCode: card?.vendorCode ?? null,
        title: card?.title ?? null,
        barcode: card?.barcode ?? null,
        currentStock,
        avgDailySales: Math.round(avgDailySales * 100) / 100,
        daysOfStock: daysOfStock !== null ? Math.round(daysOfStock * 10) / 10 : null,
        recommended,
      });
    }

    // Sort: most urgent first
    recItems.sort((a, b) => (a.daysOfStock ?? 999) - (b.daysOfStock ?? 999));

    return { items: recItems };
  });

  // ─────────────────────────────────────────────────────────────────
  // CALCULATE SUPPLY NEEDS (from Warehouses & Regions data)
  // ─────────────────────────────────────────────────────────────────

  app.get('/supplies/:workspaceId/calculate', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      warehouseId: z.coerce.number().int().positive(),
      salesPeriod: z.coerce.number().int().min(7).max(90).default(14),
      deliveryDays: z.coerce.number().int().min(1).max(30).default(5),
      safetyDays: z.coerce.number().int().min(0).max(60).default(7),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const calcShopId = query.shopId;
    const today = new Date();
    const dateFrom = isoDate(addDays(today, -query.salesPeriod));
    const dateTo = isoDate(today);

    // Get warehouse name and regions
    const warehouseInfo = await db
      .select({
        warehouseName: warehouseRegionMapping.warehouseName,
        regionName: warehouseRegionMapping.regionName,
      })
      .from(warehouseRegionMapping)
      .where(eq(warehouseRegionMapping.warehouseId, query.warehouseId));

    if (warehouseInfo.length === 0) {
      return { items: [], message: 'No regions mapped to this warehouse' };
    }

    const warehouseName = warehouseInfo[0].warehouseName;
    const regionNames = warehouseInfo.map(r => r.regionName);

    // Get sales by product for this warehouse
    const calcShopCond = buildShopFilter(wbOrdersSalesDailyProductWarehouses.shopId, calcShopId);
    const calcSalesConds: any[] = [
      eq(wbOrdersSalesDailyProductWarehouses.workspaceId, workspaceId),
      sql`${wbOrdersSalesDailyProductWarehouses.date} >= ${dateFrom}`,
      sql`${wbOrdersSalesDailyProductWarehouses.date} <= ${dateTo}`,
      eq(wbOrdersSalesDailyProductWarehouses.warehouseName, warehouseName),
    ];
    if (calcShopCond) calcSalesConds.push(calcShopCond);

    const salesData = await db
      .select({
        nmId: wbOrdersSalesDailyProductWarehouses.nmId,
        warehouseName: wbOrdersSalesDailyProductWarehouses.warehouseName,
        ordersCount: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.ordersCount})`.mapWith(Number),
        salesCount: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.salesCount})`.mapWith(Number),
      })
      .from(wbOrdersSalesDailyProductWarehouses)
      .where(and(...calcSalesConds))
      .groupBy(wbOrdersSalesDailyProductWarehouses.nmId, wbOrdersSalesDailyProductWarehouses.warehouseName);

    // Get current stock
    const stockData = await db
      .select({
        nmId: wbStocksCurrent.nmId,
        quantity: sql<number>`sum(${wbStocksCurrent.quantity})`.mapWith(Number),
        inWayToClient: sql<number>`sum(${wbStocksCurrent.inWayToClient})`.mapWith(Number),
        inWayFromClient: sql<number>`sum(${wbStocksCurrent.inWayFromClient})`.mapWith(Number),
      })
      .from(wbStocksCurrent)
      .where(eq(wbStocksCurrent.workspaceId, workspaceId))
      .groupBy(wbStocksCurrent.nmId);

    const stockMap = new Map(stockData.map(s => [s.nmId, s]));

    // Get product info
    const nmIds = [...new Set(salesData.map(s => s.nmId))];
    const cards = nmIds.length > 0 ? await db
      .select({
        nmId: wbCards.nmId,
        vendorCode: wbCards.vendorCode,
        title: wbCards.title,
      })
      .from(wbCards)
      .where(and(
        eq(wbCards.workspaceId, workspaceId),
        inArray(wbCards.nmId, nmIds)
      )) : [];

    const cardMap = new Map(cards.map(c => [c.nmId, c]));

    // Calculate needs
    const horizonDays = query.deliveryDays + query.safetyDays;
    const items = [];

    // Aggregate by nmId
    const salesByNmId = new Map<number, number>();
    for (const s of salesData) {
      const current = salesByNmId.get(s.nmId) ?? 0;
      salesByNmId.set(s.nmId, current + (s.ordersCount ?? 0));
    }

    for (const [nmId, totalOrders] of salesByNmId) {
      const stock = stockMap.get(nmId);
      const card = cardMap.get(nmId);

      const currentStock = stock?.quantity ?? 0;
      const inWay = (stock?.inWayToClient ?? 0) + (stock?.inWayFromClient ?? 0);
      const avgDailySales = totalOrders / query.salesPeriod;
      const daysOfStock = avgDailySales > 0 ? currentStock / avgDailySales : null;

      const needForHorizon = Math.ceil(avgDailySales * horizonDays);
      const needToSend = Math.max(0, needForHorizon - currentStock - inWay);

      let status: 'critical' | 'warning' | 'ok' = 'ok';
      if (daysOfStock !== null) {
        if (daysOfStock <= query.deliveryDays) status = 'critical';
        else if (daysOfStock <= horizonDays) status = 'warning';
      }

      items.push({
        nmId,
        vendorCode: card?.vendorCode ?? null,
        title: card?.title ?? null,
        currentStock,
        inWay,
        avgDailySales: Math.round(avgDailySales * 100) / 100,
        daysOfStock: daysOfStock !== null ? Math.round(daysOfStock * 10) / 10 : null,
        needToSend,
        status,
      });
    }

    // Sort by status priority
    const statusOrder = { critical: 0, warning: 1, ok: 2 };
    items.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || b.needToSend - a.needToSend);

    return {
      warehouseId: query.warehouseId,
      salesPeriod: query.salesPeriod,
      deliveryDays: query.deliveryDays,
      safetyDays: query.safetyDays,
      horizonDays,
      items,
      summary: {
        critical: items.filter(i => i.status === 'critical').length,
        warning: items.filter(i => i.status === 'warning').length,
        ok: items.filter(i => i.status === 'ok').length,
        total: items.length,
      },
    };
  });

  // ─────────────────────────────────────────────────────────────────
  // CALCULATE DEMAND-BASED SUPPLY PLAN
  // ─────────────────────────────────────────────────────────────────

  app.get('/supplies/:workspaceId/demand-plan', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      salesPeriod: z.coerce.number().int().min(7).max(90).default(14),
      deliveryDays: z.coerce.number().int().min(1).max(30).default(5),
      safetyDays: z.coerce.number().int().min(0).max(60).default(7),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    const demandShopId = query.shopId;

    const today = new Date();
    const dateFrom = isoDate(addDays(today, -query.salesPeriod));
    const dateTo = isoDate(today);
    const horizonDays = query.deliveryDays + query.safetyDays;

    // 1. Get demand by region (orders from each region)
    const demandShopCond = buildShopFilter(wbOrdersSalesDailyProductRegions.shopId, demandShopId);
    const demandConds: any[] = [
      eq(wbOrdersSalesDailyProductRegions.workspaceId, workspaceId),
      sql`${wbOrdersSalesDailyProductRegions.date} >= ${dateFrom}`,
      sql`${wbOrdersSalesDailyProductRegions.date} <= ${dateTo}`,
    ];
    if (demandShopCond) demandConds.push(demandShopCond);

    const demandByRegion = await db
      .select({
        nmId: wbOrdersSalesDailyProductRegions.nmId,
        regionName: wbOrdersSalesDailyProductRegions.regionName,
        ordersCount: sql<number>`sum(${wbOrdersSalesDailyProductRegions.ordersCount})`.mapWith(Number),
      })
      .from(wbOrdersSalesDailyProductRegions)
      .where(and(...demandConds))
      .groupBy(wbOrdersSalesDailyProductRegions.nmId, wbOrdersSalesDailyProductRegions.regionName);

    // 2. Get region → warehouse mapping
    const regionMapping = await db
      .select({
        regionName: regionWarehouseMapping.regionName,
        warehouseId: regionWarehouseMapping.warehouseId,
        priority: regionWarehouseMapping.priority,
      })
      .from(regionWarehouseMapping)
      .where(eq(regionWarehouseMapping.priority, 1)); // Primary warehouse only

    const regionToWarehouse = new Map(regionMapping.map(r => [r.regionName, r.warehouseId]));

    // 3. Get user's priority warehouses
    const userPriorities = await db
      .select()
      .from(supplyPriorityWarehouses)
      .where(eq(supplyPriorityWarehouses.workspaceId, workspaceId));
    
    const priorityWarehouseIds = new Set(userPriorities.map(p => p.warehouseId));

    // 4. Get current stock by product (including inWay)
    const stockData = await db
      .select({
        nmId: wbStocksCurrent.nmId,
        warehouseName: wbStocksCurrent.warehouseName,
        quantity: sql<number>`sum(${wbStocksCurrent.quantity})`.mapWith(Number),
        inWayToClient: sql<number>`sum(${wbStocksCurrent.inWayToClient})`.mapWith(Number),
        inWayFromClient: sql<number>`sum(${wbStocksCurrent.inWayFromClient})`.mapWith(Number),
      })
      .from(wbStocksCurrent)
      .where(eq(wbStocksCurrent.workspaceId, workspaceId))
      .groupBy(wbStocksCurrent.nmId, wbStocksCurrent.warehouseName);

    // Stock by nmId+warehouseName (per-warehouse) and total
    const totalStockByNmId = new Map<number, number>();
    const inWayByNmId = new Map<number, number>();
    const stockByNmIdWarehouse = new Map<string, number>();
    const inWayByNmIdWarehouse = new Map<string, number>();
    for (const s of stockData) {
      totalStockByNmId.set(s.nmId, (totalStockByNmId.get(s.nmId) ?? 0) + s.quantity);
      inWayByNmId.set(s.nmId, (inWayByNmId.get(s.nmId) ?? 0) + s.inWayToClient + s.inWayFromClient);
      // Per-warehouse stock (use actual warehouse stock, not proportional distribution)
      if (s.warehouseName) {
        const key = `${s.nmId}|${s.warehouseName}`;
        stockByNmIdWarehouse.set(key, (stockByNmIdWarehouse.get(key) ?? 0) + s.quantity);
        inWayByNmIdWarehouse.set(key, (inWayByNmIdWarehouse.get(key) ?? 0) + s.inWayToClient + s.inWayFromClient);
      }
    }

    // Helper: get actual stock at a specific warehouse (real per-warehouse data)
    function getWarehouseStock(nmId: number, warehouseName: string): number {
      const key = `${nmId}|${warehouseName}`;
      const directStock = stockByNmIdWarehouse.get(key);
      if (directStock !== undefined) return directStock;
      // Fallback: try partial match on warehouse name
      for (const [k, v] of stockByNmIdWarehouse) {
        if (k.startsWith(`${nmId}|`) && k.toLowerCase().includes(warehouseName.toLowerCase().slice(0, 8))) {
          return v;
        }
      }
      return 0; // No stock data for this specific warehouse
    }

    // Helper: get actual inWay at a specific warehouse
    function getWarehouseInWay(nmId: number, warehouseName: string): number {
      const key = `${nmId}|${warehouseName}`;
      const direct = inWayByNmIdWarehouse.get(key);
      if (direct !== undefined) return direct;
      for (const [k, v] of inWayByNmIdWarehouse) {
        if (k.startsWith(`${nmId}|`) && k.toLowerCase().includes(warehouseName.toLowerCase().slice(0, 8))) {
          return v;
        }
      }
      return 0;
    }

    // 5. Get warehouse names
    const warehouseData = await db
      .select({ id: wbWarehouses.id, name: wbWarehouses.name, region: wbWarehouses.region })
      .from(wbWarehouses)
      .where(eq(wbWarehouses.isActive, true));
    
    const warehouseNames = new Map(warehouseData.map(w => [w.id, w.name]));
    const warehouseRegions = new Map(warehouseData.map(w => [w.id, w.region]));

    // 6. Get product info
    const nmIds = [...new Set(demandByRegion.map(d => d.nmId))];
    const cards = nmIds.length > 0 ? await db
      .select({ 
        nmId: wbCards.nmId, 
        vendorCode: wbCards.vendorCode, 
        title: wbCards.title,
        brandName: wbCards.brandName,
        subjectName: wbCards.subjectName,
      })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, workspaceId), inArray(wbCards.nmId, nmIds)))
      : [];
    
    const cardMap = new Map(cards.map(c => [c.nmId, c]));

    // 7. Calculate demand by warehouse
    // Map: warehouseId → nmId → demand
    const demandByWarehouse = new Map<number, Map<number, number>>();
    const unmappedRegions = new Set<string>();

    for (const d of demandByRegion) {
      const warehouseId = regionToWarehouse.get(d.regionName);
      if (!warehouseId) {
        unmappedRegions.add(d.regionName);
        continue;
      }
      
      if (!demandByWarehouse.has(warehouseId)) {
        demandByWarehouse.set(warehouseId, new Map());
      }
      const whDemand = demandByWarehouse.get(warehouseId)!;
      whDemand.set(d.nmId, (whDemand.get(d.nmId) ?? 0) + d.ordersCount);
    }

    // 8. Build warehouse summaries
    const warehouseSummaries = [];
    
    for (const [warehouseId, productDemand] of demandByWarehouse) {
      const warehouseName = warehouseNames.get(warehouseId) ?? `Склад ${warehouseId}`;
      const warehouseRegion = warehouseRegions.get(warehouseId) ?? 'Другие';
      const isPriority = priorityWarehouseIds.has(warehouseId);
      
      const items = [];
      let totalDemand = 0;
      let totalNeed = 0;

      for (const [nmId, orders] of productDemand) {
        const card = cardMap.get(nmId);
        const currentStock = getWarehouseStock(nmId, warehouseName);
        const inWay = getWarehouseInWay(nmId, warehouseName);
        const avgDailySales = orders / query.salesPeriod;
        const needForHorizon = Math.ceil(avgDailySales * horizonDays);
        const effectiveStock = currentStock + inWay;
        const needToSend = Math.max(0, needForHorizon - effectiveStock);
        const daysOfStock = avgDailySales > 0 ? Math.round(effectiveStock / avgDailySales) : 999;

        totalDemand += orders;
        totalNeed += needToSend;

        const tags = [card?.subjectName, card?.brandName].filter(Boolean) as string[];
        items.push({
          nmId,
          vendorCode: card?.vendorCode ?? null,
          title: card?.title ?? null,
          tags: tags.length > 0 ? tags : null,
          regionDemand: orders,
          avgDailySales: Math.round(avgDailySales * 100) / 100,
          currentStock,
          inWay,
          daysOfStock,
          needToSend,
        });
      }

      // Sort by need
      items.sort((a, b) => b.needToSend - a.needToSend);

      warehouseSummaries.push({
        warehouseId,
        warehouseName,
        warehouseRegion,
        isPriority,
        totalDemand,
        totalNeed,
        itemCount: items.length,
        items: items.slice(0, 20), // Top 20 items
      });
    }

    // Sort: priority warehouses first, then by demand
    warehouseSummaries.sort((a, b) => {
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      return b.totalDemand - a.totalDemand;
    });

    // 9. Build total product needs (across all priority warehouses)
    const totalProductNeeds = new Map<number, { nmId: number; totalDemand: number; totalNeed: number }>();
    
    for (const wh of warehouseSummaries) {
      if (!wh.isPriority) continue;
      for (const item of wh.items) {
        const existing = totalProductNeeds.get(item.nmId) ?? { nmId: item.nmId, totalDemand: 0, totalNeed: 0 };
        existing.totalDemand += item.regionDemand;
        existing.totalNeed = Math.max(existing.totalNeed, item.needToSend); // Take max need
        totalProductNeeds.set(item.nmId, existing);
      }
    }

    const consolidatedNeeds = Array.from(totalProductNeeds.values())
      .map(p => ({
        ...p,
        vendorCode: cardMap.get(p.nmId)?.vendorCode ?? null,
        title: cardMap.get(p.nmId)?.title ?? null,
      }))
      .sort((a, b) => b.totalNeed - a.totalNeed);

    return {
      salesPeriod: query.salesPeriod,
      deliveryDays: query.deliveryDays,
      safetyDays: query.safetyDays,
      horizonDays,
      warehouseSummaries,
      consolidatedNeeds: consolidatedNeeds.slice(0, 50),
      unmappedRegions: Array.from(unmappedRegions),
      summary: {
        totalWarehouses: warehouseSummaries.length,
        priorityWarehouses: warehouseSummaries.filter(w => w.isPriority).length,
        totalProducts: consolidatedNeeds.length,
      },
    };
  });

  // ─────────────────────────────────────────────────────────────────
  // BOOKING QUEUE (auto-booking)
  // ─────────────────────────────────────────────────────────────────

  // Add to booking queue
  app.post('/supplies/:workspaceId/booking-queue', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      draftId: z.number().int().positive(),
      warehouseId: z.number().int().positive(),
      desiredDate: z.string(),
      expiresInHours: z.number().int().min(1).max(72).default(24),
    }).parse(req.body);

    const expiresAt = addDays(new Date(), body.expiresInHours / 24);

    const [queue] = await db
      .insert(supplyBookingQueue)
      .values({
        workspaceId,
        draftId: body.draftId,
        warehouseId: body.warehouseId,
        desiredDate: body.desiredDate,
        status: 'waiting',
        nextAttemptAt: new Date(),
        expiresAt,
      })
      .returning();

    return { queue };
  });

  // Get booking queue
  app.get('/supplies/:workspaceId/booking-queue', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const queue = await db
      .select()
      .from(supplyBookingQueue)
      .where(eq(supplyBookingQueue.workspaceId, workspaceId))
      .orderBy(desc(supplyBookingQueue.createdAt));

    return { queue };
  });

  // Cancel booking
  app.delete('/supplies/:workspaceId/booking-queue/:queueId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      queueId: z.coerce.number().int().positive(),
    }).parse(req.params);

    await db
      .update(supplyBookingQueue)
      .set({ status: 'cancelled' })
      .where(and(
        eq(supplyBookingQueue.workspaceId, params.workspaceId),
        eq(supplyBookingQueue.queueId, params.queueId)
      ));

    return { success: true };
  });

  // ─────────────────────────────────────────────────────────────────
  // SUPPLIES (submitted)
  // ─────────────────────────────────────────────────────────────────

  // List supplies
  app.get('/supplies/:workspaceId/list', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const conditions = [eq(supplies.workspaceId, workspaceId)];
    const suppliesShopFilter = buildShopFilter(supplies.shopId, query.shopId);
    if (suppliesShopFilter) conditions.push(suppliesShopFilter);
    if (query.status) {
      conditions.push(eq(supplies.status, query.status));
    }

    const supplyList = await db
      .select()
      .from(supplies)
      .where(and(...conditions))
      .orderBy(desc(supplies.createdAt))
      .limit(query.limit);

    return { supplies: supplyList };
  });

  // Get supply with boxes
  app.get('/supplies/:workspaceId/list/:supplyId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const [supply] = await db
      .select()
      .from(supplies)
      .where(and(
        eq(supplies.workspaceId, params.workspaceId),
        eq(supplies.supplyId, params.supplyId)
      ));

    if (!supply) {
      throw Object.assign(new Error('Supply not found'), { statusCode: 404 });
    }

    const boxes = await db
      .select()
      .from(supplyBoxes)
      .where(eq(supplyBoxes.supplyId, params.supplyId))
      .orderBy(asc(supplyBoxes.boxNumber));

    const docs = await db
      .select({
        docId: supplyDocuments.docId,
        docType: supplyDocuments.docType,
        fileName: supplyDocuments.fileName,
        fileSize: supplyDocuments.fileSize,
        createdAt: supplyDocuments.createdAt,
      })
      .from(supplyDocuments)
      .where(eq(supplyDocuments.supplyId, params.supplyId));

    return { supply, boxes, documents: docs };
  });


  // ─────────────────────────────────────────────────────────────────
  // WB FBW API INTEGRATION
  // ─────────────────────────────────────────────────────────────────

  // Get WB warehouses (with acceptance options for items)
  app.post('/supplies/:workspaceId/wb/acceptance-options', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      items: z.array(z.object({
        barcode: z.string().min(1),
        quantity: z.number().int().min(1).max(999999),
      })).min(1).max(5000),
      warehouseId: z.number().int().positive().optional(),
    }).parse(req.body);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(workspaceId);
    
    const result = await client.getAcceptanceOptions(body.items, body.warehouseId);
    return result;
  });

  // Get WB FBW supplies from API
  app.post('/supplies/:workspaceId/wb/list', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      statusIDs: z.array(z.number().int().min(1).max(6)).optional(),
      dates: z.array(z.object({
        from: z.string(),
        till: z.string(),
        type: z.enum(['factDate', 'createDate', 'supplyDate', 'updatedDate']),
      })).optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    }).parse(req.body);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(workspaceId);
    
    const supplies = await client.getSupplies(
      { statusIDs: body.statusIDs, dates: body.dates },
      body.limit,
      body.offset
    );
    
    return { supplies, count: supplies.length };
  });

  // Get WB supply details
  app.get('/supplies/:workspaceId/wb/:supplyId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({
      isPreorderID: z.coerce.boolean().default(false),
    }).parse(req.query);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);
    
    const details = await client.getSupplyDetails(params.supplyId, query.isPreorderID);
    return details;
  });

  // Get WB supply goods
  app.get('/supplies/:workspaceId/wb/:supplyId/goods', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({
      isPreorderID: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);
    
    const goods = await client.getSupplyGoods(
      params.supplyId,
      query.isPreorderID,
      query.limit,
      query.offset
    );
    
    return { goods, count: goods.length };
  });

  // Get WB supply package (boxes)
  app.get('/supplies/:workspaceId/wb/:supplyId/package', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);
    
    const boxes = await client.getSupplyPackage(params.supplyId);
    return { boxes, count: boxes.length };
  });

  // Get full WB supply (details + goods + boxes)
  app.get('/supplies/:workspaceId/wb/:supplyId/full', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);
    
    const result = await client.getFullSupply(params.supplyId);
    return result;
  });

  // Get WB transit tariffs
  app.get('/supplies/:workspaceId/wb/transit-tariffs', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(workspaceId);
    
    const tariffs = await client.getTransitTariffs();
    return { tariffs, count: tariffs.length };
  });

  // Find best warehouses for products
  app.post('/supplies/:workspaceId/wb/best-warehouses', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      items: z.array(z.object({
        barcode: z.string().min(1),
        quantity: z.number().int().min(1).max(999999),
      })).min(1).max(5000),
      boxType: z.enum(['box', 'monopallet', 'supersafe']).default('box'),
    }).parse(req.body);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(workspaceId);

    // Get raw acceptance options to debug empty results
    const rawOptions = await client.getAcceptanceOptions(body.items);
    const errorBarcodes = (rawOptions?.result ?? [])
      .filter((r: any) => r.isError || !r.warehouses?.length)
      .map((r: any) => ({ barcode: r.barcode, error: r.error?.detail || r.error?.title || 'Неизвестная ошибка' }));

    const warehouses = await client.findBestWarehouses(body.items, body.boxType);

    if (warehouses.length === 0) {
      return {
        warehouses: [],
        debug: {
          totalBarcodes: body.items.length,
          errorBarcodes,
          hint: errorBarcodes.length === body.items.length
            ? 'WB отклонил все баркоды. Проверьте что товары активны в личном кабинете WB и доступны для FBO-поставок.'
            : 'WB не нашёл складов для приёмки этих товаров.',
        },
      };
    }

    // Enrich with warehouse names
    const warehouseData = await db
      .select({ id: wbWarehouses.id, name: wbWarehouses.name, region: wbWarehouses.region })
      .from(wbWarehouses)
      .where(inArray(wbWarehouses.id, warehouses.map(w => w.warehouseID)));
    
    const nameMap = new Map(warehouseData.map(w => [w.id, { name: w.name, region: w.region }]));
    
    const enriched = warehouses.map(w => ({
      ...w,
      warehouseName: nameMap.get(w.warehouseID)?.name ?? `Склад ${w.warehouseID}`,
      warehouseRegion: nameMap.get(w.warehouseID)?.region ?? null,
      acceptanceRate: w.totalBarcodes > 0 
        ? Math.round(w.acceptedBarcodes / w.totalBarcodes * 100) 
        : 0,
    }));
    
    return { warehouses: enriched };
  });

  // Sync WB supplies to local DB
  app.post('/supplies/:workspaceId/wb/sync', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      statusIDs: z.array(z.number().int().min(1).max(6)).default([1, 2, 3, 4, 6]),
    }).parse(req.body);
    const shopId = extractShopId(req);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const { wbSupplies, wbSupplyItems, wbSupplyBoxes, wbSupplyBoxItems } = await import('../db/schema.js');

    const client = new WbSuppliesClient(workspaceId, shopId ?? undefined);
    const wbSupplyList = await client.getSupplies({ statusIDs: body.statusIDs });
    
    let synced = 0;
    let errors = 0;
    const errorDetails: Array<{ preorderID: number; message: string }> = [];

    for (const supply of wbSupplyList) {
      try {
        // Upsert supply
        const supplyData = {
          workspaceId,
          wbSupplyId: supply.supplyID,
          wbPreorderId: supply.preorderID,
          statusId: supply.statusID as number,
          boxTypeId: (supply.boxTypeID ?? null) as number | null,
          supplyDate: supply.supplyDate?.slice(0, 10) ?? null,
          factDate: supply.factDate ? new Date(supply.factDate) : null,
          phone: supply.phone ?? null,
          isBoxOnPallet: supply.isBoxOnPallet ?? false,
          syncedAt: new Date(),
          updatedAt: new Date(),
        };

        // Check if exists
        const existing = await db
          .select({ id: wbSupplies.id })
          .from(wbSupplies)
          .where(and(
            eq(wbSupplies.workspaceId, workspaceId),
            eq(wbSupplies.wbPreorderId, supply.preorderID)
          ))
          .limit(1);

        let localSupplyId: number;

        if (existing.length > 0) {
          localSupplyId = existing[0].id;
          await db.update(wbSupplies).set(supplyData).where(eq(wbSupplies.id, localSupplyId));
        } else {
          const [inserted] = await db.insert(wbSupplies).values(supplyData).returning({ id: wbSupplies.id });
          localSupplyId = inserted.id;
        }

        // If supply has supplyID, fetch details
        if (supply.supplyID) {
          try {
            const details = await client.getSupplyDetails(supply.supplyID);
            await db.update(wbSupplies).set({
              warehouseId: details.warehouseID,
              warehouseName: details.warehouseName,
              transitWarehouseId: details.transitWarehouseID,
              transitWarehouseName: details.transitWarehouseName || null,
              acceptanceCost: details.acceptanceCost ? Math.round(details.acceptanceCost * 100) : null,
              paidAcceptanceCoef: details.paidAcceptanceCoefficient,
              storageCoef: details.storageCoef,
              deliveryCoef: details.deliveryCoef,
              quantity: details.quantity,
              acceptedQuantity: details.acceptedQuantity,
              readyForSaleQty: details.readyForSaleQuantity,
              rejectReason: details.rejectReason,
            }).where(eq(wbSupplies.id, localSupplyId));

            // Fetch and sync goods
            const goods = await client.getSupplyGoods(supply.supplyID);
            if (goods.length > 0) {
              // Delete old items
              await db.delete(wbSupplyItems).where(eq(wbSupplyItems.supplyId, localSupplyId));
              
              // Insert new
              await db.insert(wbSupplyItems).values(goods.map(g => ({
                supplyId: localSupplyId,
                barcode: g.barcode,
                vendorCode: g.vendorCode,
                nmId: g.nmID,
                quantity: g.quantity,
                acceptedQuantity: g.acceptedQuantity ?? 0,
                readyForSaleQty: g.readyForSaleQuantity ?? 0,
                needKiz: g.needKiz,
                tnved: g.tnved,
                techSize: g.techSize,
                color: g.color,
              })));
            }

            // Fetch and sync boxes
            const boxes = await client.getSupplyPackage(supply.supplyID);
            if (boxes.length > 0) {
              // Delete old boxes (cascade deletes box_items)
              await db.delete(wbSupplyBoxes).where(eq(wbSupplyBoxes.supplyId, localSupplyId));
              
              // Insert new boxes
              for (const box of boxes) {
                const [insertedBox] = await db.insert(wbSupplyBoxes).values({
                  supplyId: localSupplyId,
                  packageCode: box.packageCode,
                  quantity: box.quantity,
                }).returning({ id: wbSupplyBoxes.id });

                // Insert box items
                if (box.barcodes.length > 0) {
                  await db.insert(wbSupplyBoxItems).values(box.barcodes.map(b => ({
                    boxId: insertedBox.id,
                    barcode: b.barcode,
                    quantity: b.quantity,
                  })));
                }
              }
            }
          } catch (detailErr) {
            // Log but continue
            logger.error({ err: detailErr, supplyID: supply.supplyID }, 'Failed to fetch details for supply');
          }
        }

        synced++;
      } catch (err: any) {
        logger.error({ err, preorderID: supply.preorderID }, 'Failed to sync supply');
        errors++;
        errorDetails.push({ preorderID: supply.preorderID, message: String(err?.message ?? err).slice(0, 200) });
      }
    }

    return {
      success: true,
      synced,
      errors,
      errorDetails: errorDetails.slice(0, 20),
      total: wbSupplyList.length,
    };
  });

  // Get synced WB supplies from local DB
  app.get('/supplies/:workspaceId/wb-synced', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      statusId: z.coerce.number().int().min(1).max(6).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const { wbSupplies } = await import('../db/schema.js');

    const conditions = [eq(wbSupplies.workspaceId, workspaceId)];
    if (query.statusId) {
      conditions.push(eq(wbSupplies.statusId, query.statusId));
    }

    const supplies = await db
      .select()
      .from(wbSupplies)
      .where(and(...conditions))
      .orderBy(desc(wbSupplies.updatedAt))
      .limit(query.limit)
      .offset(query.offset);

    return { supplies, count: supplies.length };
  });

  // Get synced supply goods from local DB
  app.get('/supplies/:workspaceId/list/:localId/goods', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      localId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const { wbSupplies, wbSupplyItems } = await import('../db/schema.js');

    // Verify supply belongs to workspace
    const [supply] = await db
      .select({ id: wbSupplies.id })
      .from(wbSupplies)
      .where(and(
        eq(wbSupplies.workspaceId, params.workspaceId),
        eq(wbSupplies.id, params.localId)
      ));

    if (!supply) {
      throw Object.assign(new Error('Supply not found'), { statusCode: 404 });
    }

    const goods = await db
      .select({
        barcode: wbSupplyItems.barcode,
        vendorCode: wbSupplyItems.vendorCode,
        nmId: wbSupplyItems.nmId,
        quantity: wbSupplyItems.quantity,
        acceptedQuantity: wbSupplyItems.acceptedQuantity,
      })
      .from(wbSupplyItems)
      .where(eq(wbSupplyItems.supplyId, params.localId));

    return { goods };
  });

  // Get synced supply details from local DB
  app.get('/supplies/:workspaceId/wb-synced/:localId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      localId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const { wbSupplies, wbSupplyItems, wbSupplyBoxes, wbSupplyBoxItems } = await import('../db/schema.js');

    const [supply] = await db
      .select()
      .from(wbSupplies)
      .where(and(
        eq(wbSupplies.workspaceId, params.workspaceId),
        eq(wbSupplies.id, params.localId)
      ));

    if (!supply) {
      throw Object.assign(new Error('Supply not found'), { statusCode: 404 });
    }

    const items = await db
      .select()
      .from(wbSupplyItems)
      .where(eq(wbSupplyItems.supplyId, params.localId));

    const boxes = await db
      .select()
      .from(wbSupplyBoxes)
      .where(eq(wbSupplyBoxes.supplyId, params.localId));

    // Get box items
    const boxIds = boxes.map(b => b.id);
    const boxItems = boxIds.length > 0 ? await db
      .select()
      .from(wbSupplyBoxItems)
      .where(inArray(wbSupplyBoxItems.boxId, boxIds))
      : [];

    // Group box items
    const boxItemsMap = new Map<number, typeof boxItems>();
    for (const item of boxItems) {
      const arr = boxItemsMap.get(item.boxId) ?? [];
      arr.push(item);
      boxItemsMap.set(item.boxId, arr);
    }

    const boxesWithItems = boxes.map(b => ({
      ...b,
      items: boxItemsMap.get(b.id) ?? [],
    }));

    return { supply, items, boxes: boxesWithItems };
  });

  // ─────────────────────────────────────────────────────────────────
  // SUPPLY CREATION (WB API)
  // ─────────────────────────────────────────────────────────────────

  // Get available dates for a warehouse
  app.get('/supplies/:workspaceId/wb/dates/:warehouseId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      warehouseId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({
      deliveryType: z.enum(['box', 'mono_pallet', 'super_safe']).default('box'),
    }).parse(req.query);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);
    
    try {
      const dates = await client.getSupplyDates(params.warehouseId, query.deliveryType);
      return { dates };
    } catch (e: any) {
      return { error: e.message, dates: [] };
    }
  });

  // Create supply in WB (step 1: create preorder)
  app.post('/supplies/:workspaceId/wb/create', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      warehouseID: z.number().int().positive(),
      deliveryType: z.enum(['box', 'mono_pallet', 'super_safe']).default('box'),
      cargoType: z.enum(['standard', 'fragile', 'volumetric']).default('standard'),
      name: z.string().optional(),
    }).parse(req.body);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(workspaceId);

    try {
      const result = await client.createSupply({
        warehouseID: body.warehouseID,
        deliveryType: body.deliveryType,
        cargoType: body.cargoType,
        name: body.name,
      });
      return { ok: true, preorderID: result.preorderID };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ ok: false, error: msg });
    }
  });

  // Add goods to supply (step 2)
  app.put('/supplies/:workspaceId/wb/:preorderID/goods', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      preorderID: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      goods: z.array(z.object({
        barcode: z.string().min(1),
        quantity: z.number().int().min(1),
      })),
    }).parse(req.body);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);

    try {
      await client.setSupplyGoods(params.preorderID, body.goods);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ ok: false, error: msg });
    }
  });

  // Set package (boxes) for supply (step 3)
  app.put('/supplies/:workspaceId/wb/:preorderID/package', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      preorderID: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      boxes: z.array(z.object({
        boxBarcode: z.string().min(1),
        barcodes: z.array(z.string().min(1)),
      })),
    }).parse(req.body);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);

    try {
      await client.setSupplyPackage(params.preorderID, body.boxes);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ ok: false, error: msg });
    }
  });

  // Confirm supply (book slot) (step 4)
  app.post('/supplies/:workspaceId/wb/:preorderID/confirm', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      preorderID: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      coefficient: z.number().optional(),
    }).parse(req.body);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);

    try {
      const result = await client.confirmSupply(params.preorderID, {
        date: body.date,
        coefficient: body.coefficient,
      });
      return { ok: true, supplyID: result.supplyID, date: result.date, coefficient: result.coefficient };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ ok: false, error: msg });
    }
  });

  // Cancel supply
  app.delete('/supplies/:workspaceId/wb/:id', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      id: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({
      isPreorderID: z.coerce.boolean().default(false),
    }).parse(req.query);

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);

    try {
      await client.cancelSupply(params.id, query.isPreorderID);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ ok: false, error: msg });
    }
  });

  // Create supply from draft (full wizard)
  app.post('/supplies/:workspaceId/drafts/:draftId/submit-to-wb', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      draftId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      deliveryType: z.enum(['box', 'mono_pallet', 'super_safe']).default('box'),
      cargoType: z.enum(['standard', 'fragile', 'volumetric']).default('standard'),
    }).parse(req.body);

    // Get draft with items
    const [draft] = await db
      .select()
      .from(supplyDrafts)
      .where(and(
        eq(supplyDrafts.draftId, params.draftId),
        eq(supplyDrafts.workspaceId, params.workspaceId)
      ));

    if (!draft) {
      return reply.code(404).send({ ok: false, error: 'Draft not found' });
    }

    if (!draft.warehouseId) {
      return reply.code(400).send({ ok: false, error: 'Warehouse not selected in draft' });
    }

    const items = await db
      .select()
      .from(supplyDraftItems)
      .where(eq(supplyDraftItems.draftId, params.draftId));

    if (items.length === 0) {
      return reply.code(400).send({ ok: false, error: 'No items in draft' });
    }

    // Get barcodes for items
    const nmIds = items.map(i => i.nmId);
    const cards = await db
      .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode })
      .from(wbCards)
      .where(and(
        eq(wbCards.workspaceId, params.workspaceId),
        inArray(wbCards.nmId, nmIds)
      ));

    const barcodeMap = new Map(cards.map(c => [c.nmId, c.vendorCode]));

    const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
    const client = new WbSuppliesClient(params.workspaceId);

    try {
      // Step 1: Create supply
      const { preorderID } = await client.createSupply({
        warehouseID: draft.warehouseId,
        deliveryType: body.deliveryType,
        cargoType: body.cargoType,
        name: draft.name || `Поставка от ${new Date().toLocaleDateString('ru-RU')}`,
      });

      // Step 2: Add goods
      const goods = items
        .map(item => ({
          barcode: barcodeMap.get(item.nmId) || String(item.nmId),
          quantity: item.quantity,
        }))
        .filter(g => g.barcode);

      await client.setSupplyGoods(preorderID, goods);

      // Step 3: Confirm (book slot)
      const result = await client.confirmSupply(preorderID, { date: body.date });

      // Update draft status
      await db
        .update(supplyDrafts)
        .set({
          status: 'submitted',
          plannedDate: body.date,
          updatedAt: new Date(),
        })
        .where(eq(supplyDrafts.draftId, params.draftId));

      return {
        ok: true,
        preorderID,
        supplyID: result.supplyID,
        date: result.date,
        coefficient: result.coefficient,
      };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ ok: false, error: msg });
    }
  });

};
