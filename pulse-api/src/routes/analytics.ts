import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  wbCards,
  wbCogs,
  wbOrdersSalesDailyProducts,
  wbOrdersSalesDailyRegions,
  wbOrdersSalesDailyWarehouses,
  wbOrdersSalesDailyProductWarehouses,
  wbOrdersSalesDailyProductRegions,
  wbStocksCurrent,
  wbTagProducts,
} from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { heavyReportRateLimit, isWithinDayCap } from '../lib/expensiveRouteLimits.js';
import { buildShopFilter } from './pulse/helpers.js';
import { marketplaceShops } from '../db/schema.js';
import { safeDecrypt } from '../lib/crypto.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import {
  getMeasurementPenalties,
  getWarehouseMeasurements,
  getDeductions,
} from '../integrations/wb/penalties.js';
import { getBalance } from '../integrations/wb/balance.js';
import { getReshipmentOrders } from '../integrations/wb/marketplace/client.js';
import {
  getDocumentCategories,
  getDocumentsList,
  downloadDocument,
  downloadDocumentsBatch,
} from '../integrations/wb/documents.js';
import {
  getPromotions,
  getPromotionDetails,
  getPromotionProducts,
  addProductsToPromotion,
  removeProductsFromPromotion,
} from '../integrations/wb/promotions.js';
import {
  getSearchReport,
  getProductSearchTexts,
  getSalesFunnelProducts,
  getSalesFunnelHistory,
  getWbClubAnalytics,
} from '../integrations/wb/searchReport.js';
import { isJamRequiredError } from '../integrations/wb/wbClient.js';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function daysBetweenInclusive(from: string, to: string): number {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  const diff = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  return Math.max(1, diff);
}

type AbcMetric = 'orders' | 'sales';

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/analytics/:workspaceId/abc', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        metric: z.enum(['orders', 'sales']).optional(),
        thresholdA: z.coerce.number().min(1).max(99).optional(),
        thresholdB: z.coerce.number().min(1).max(100).optional(),
        tagId: z.coerce.number().int().positive().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    
    const shopId = query.shopId;

    const today = isoDate(new Date());
    const to = query.to ?? today;
    const from = query.from ?? isoDate(addDays(new Date(to + 'T00:00:00Z'), -30));

    const metric: AbcMetric = query.metric ?? 'orders';
    const thresholdA = query.thresholdA ?? 80;
    const thresholdB = query.thresholdB ?? 95;

    if (thresholdA >= thresholdB) {
      const reply = (req as any).server?.httpErrors?.createError?.(400, 'thresholdA must be < thresholdB');
      if (reply) throw reply;
      throw Object.assign(new Error('thresholdA must be < thresholdB'), { statusCode: 400 });
    }

    

    let queryBuilder = db
      .select({
        nmId: wbOrdersSalesDailyProducts.nmId,
        ordersCount: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersCount})`.mapWith(Number),
        ordersRub: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersRub})`.mapWith(Number),
        salesRub: sql<number>`sum(${wbOrdersSalesDailyProducts.salesRub})`.mapWith(Number),
        forPayRub: sql<number>`sum(${wbOrdersSalesDailyProducts.forPayRub})`.mapWith(Number),
        vendorCode: wbCards.vendorCode,
        title: wbCards.title,
      })
      .from(wbOrdersSalesDailyProducts)
      .leftJoin(
        wbCards,
        and(
          eq(wbCards.workspaceId, params.workspaceId),
          eq(wbCards.nmId, wbOrdersSalesDailyProducts.nmId)
        )
      )
      .where(
        and(
          eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId),
          buildShopFilter(wbOrdersSalesDailyProducts.shopId, shopId),
          gte(wbOrdersSalesDailyProducts.date, from),
          lte(wbOrdersSalesDailyProducts.date, to)
        )
      );

    if (query.tagId) {
      queryBuilder = queryBuilder.innerJoin(
        wbTagProducts,
        and(
          eq(wbTagProducts.workspaceId, params.workspaceId),
          eq(wbTagProducts.nmId, wbOrdersSalesDailyProducts.nmId),
          eq(wbTagProducts.tagId, query.tagId)
        )
      );
    }

    const rows = await queryBuilder
      .groupBy(wbOrdersSalesDailyProducts.nmId, wbCards.vendorCode, wbCards.title)
      .orderBy(wbOrdersSalesDailyProducts.nmId);

    const mapped = rows.map((r: any) => {
      const metricRub = metric === 'orders' ? Number(r.ordersRub ?? 0) : Number(r.salesRub ?? 0);
      return {
        nmId: Number(r.nmId),
        vendorCode: r.vendorCode ?? null,
        title: r.title ?? null,
        ordersCount: Number(r.ordersCount ?? 0),
        ordersRub: Number(r.ordersRub ?? 0),
        salesRub: Number(r.salesRub ?? 0),
        forPayRub: Number(r.forPayRub ?? 0),
        metricRub,
      };
    });

    mapped.sort((a, b) => b.metricRub - a.metricRub);

    const totalRub = mapped.reduce((acc, r) => acc + r.metricRub, 0);

    let cumulative = 0;
    const out = mapped.map((r) => {
      cumulative += r.metricRub;
      const sharePercent = totalRub > 0 ? (r.metricRub / totalRub) * 100 : 0;
      const cumulativePercent = totalRub > 0 ? (cumulative / totalRub) * 100 : 0;
      const abcGroup =
        cumulativePercent <= thresholdA ? 'A' : cumulativePercent <= thresholdB ? 'B' : 'C';

      return {
        ...r,
        sharePercent,
        cumulativePercent,
        abcGroup,
      };
    });

    return {
      workspaceId: params.workspaceId,
      from,
      to,
      metric,
      thresholdA,
      thresholdB,
      tagId: query.tagId ?? null,
      totalRub,
      rows: out,
    };
  });

  app.get('/analytics/:workspaceId/warehouses', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        nmId: z.coerce.number().int().positive().optional(),
        tagId: z.coerce.number().int().positive().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const today = isoDate(new Date());
    const to = query.to ?? today;
    const from = query.from ?? isoDate(addDays(new Date(to + 'T00:00:00Z'), -30));
    const daysCount = daysBetweenInclusive(from, to);
    const shopId = query.shopId;

    const hasFilter = query.nmId || query.tagId;

    // Get list of nmIds to filter by (from tag or single nmId)
    let filterNmIds: number[] | null = null;
    if (query.tagId) {
      const tagProducts = await db
        .select({ nmId: wbTagProducts.nmId })
        .from(wbTagProducts)
        .where(
          and(
            eq(wbTagProducts.workspaceId, params.workspaceId),
            eq(wbTagProducts.tagId, query.tagId)
          )
        );
      filterNmIds = tagProducts.map((p) => p.nmId);
    } else if (query.nmId) {
      filterNmIds = [query.nmId];
    }

    type WarehouseAgg = { warehouseName: string; ordersCount: number; salesCount: number; ordersRub: number; salesRub: number; forPayRub: number };
    type RegionAgg = { regionName: string; ordersCount: number; salesCount: number; ordersRub: number; salesRub: number; forPayRub: number };
    
    let warehouseAgg: WarehouseAgg[];
    let regionAgg: RegionAgg[];

    if (hasFilter && filterNmIds && filterNmIds.length > 0) {
      // Use product-level detail tables with nmId filter
      const warehouseRows = await db
        .select({
          warehouseName: wbOrdersSalesDailyProductWarehouses.warehouseName,
          ordersCount: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.ordersCount})`.mapWith(Number),
          salesCount: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.salesCount})`.mapWith(Number),
          ordersRub: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.ordersRub})`.mapWith(Number),
          salesRub: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.salesRub})`.mapWith(Number),
          forPayRub: sql<number>`sum(${wbOrdersSalesDailyProductWarehouses.forPayRub})`.mapWith(Number),
        })
        .from(wbOrdersSalesDailyProductWarehouses)
        .where(
          and(
            eq(wbOrdersSalesDailyProductWarehouses.workspaceId, params.workspaceId),
            buildShopFilter(wbOrdersSalesDailyProductWarehouses.shopId, shopId),
            gte(wbOrdersSalesDailyProductWarehouses.date, from),
            lte(wbOrdersSalesDailyProductWarehouses.date, to),
            inArray(wbOrdersSalesDailyProductWarehouses.nmId, filterNmIds)
          )
        )
        .groupBy(wbOrdersSalesDailyProductWarehouses.warehouseName);

      warehouseAgg = warehouseRows.map((r) => ({
        warehouseName: r.warehouseName,
        ordersCount: Number(r.ordersCount ?? 0),
        salesCount: Number(r.salesCount ?? 0),
        ordersRub: Number(r.ordersRub ?? 0),
        salesRub: Number(r.salesRub ?? 0),
        forPayRub: Number(r.forPayRub ?? 0),
      }));

      const regionRows = await db
        .select({
          regionName: wbOrdersSalesDailyProductRegions.regionName,
          ordersCount: sql<number>`sum(${wbOrdersSalesDailyProductRegions.ordersCount})`.mapWith(Number),
          salesCount: sql<number>`sum(${wbOrdersSalesDailyProductRegions.salesCount})`.mapWith(Number),
          ordersRub: sql<number>`sum(${wbOrdersSalesDailyProductRegions.ordersRub})`.mapWith(Number),
          salesRub: sql<number>`sum(${wbOrdersSalesDailyProductRegions.salesRub})`.mapWith(Number),
          forPayRub: sql<number>`sum(${wbOrdersSalesDailyProductRegions.forPayRub})`.mapWith(Number),
        })
        .from(wbOrdersSalesDailyProductRegions)
        .where(
          and(
            eq(wbOrdersSalesDailyProductRegions.workspaceId, params.workspaceId),
            buildShopFilter(wbOrdersSalesDailyProductRegions.shopId, shopId),
            gte(wbOrdersSalesDailyProductRegions.date, from),
            lte(wbOrdersSalesDailyProductRegions.date, to),
            inArray(wbOrdersSalesDailyProductRegions.nmId, filterNmIds)
          )
        )
        .groupBy(wbOrdersSalesDailyProductRegions.regionName);

      regionAgg = regionRows.map((r) => ({
        regionName: r.regionName,
        ordersCount: Number(r.ordersCount ?? 0),
        salesCount: Number(r.salesCount ?? 0),
        ordersRub: Number(r.ordersRub ?? 0),
        salesRub: Number(r.salesRub ?? 0),
        forPayRub: Number(r.forPayRub ?? 0),
      }));
    } else {
      // No filter - use aggregated tables
      const warehouseRows = await db
        .select({
          warehouseName: wbOrdersSalesDailyWarehouses.warehouseName,
          ordersCount: sql<number>`sum(${wbOrdersSalesDailyWarehouses.ordersCount})`.mapWith(Number),
          salesCount: sql<number>`sum(${wbOrdersSalesDailyWarehouses.salesCount})`.mapWith(Number),
          ordersRub: sql<number>`sum(${wbOrdersSalesDailyWarehouses.ordersRub})`.mapWith(Number),
          salesRub: sql<number>`sum(${wbOrdersSalesDailyWarehouses.salesRub})`.mapWith(Number),
          forPayRub: sql<number>`sum(${wbOrdersSalesDailyWarehouses.forPayRub})`.mapWith(Number),
        })
        .from(wbOrdersSalesDailyWarehouses)
        .where(
          and(
            eq(wbOrdersSalesDailyWarehouses.workspaceId, params.workspaceId),
            buildShopFilter(wbOrdersSalesDailyWarehouses.shopId, shopId),
            gte(wbOrdersSalesDailyWarehouses.date, from),
            lte(wbOrdersSalesDailyWarehouses.date, to)
          )
        )
        .groupBy(wbOrdersSalesDailyWarehouses.warehouseName);

      warehouseAgg = warehouseRows.map((r) => ({
        warehouseName: r.warehouseName,
        ordersCount: Number(r.ordersCount ?? 0),
        salesCount: Number(r.salesCount ?? 0),
        ordersRub: Number(r.ordersRub ?? 0),
        salesRub: Number(r.salesRub ?? 0),
        forPayRub: Number(r.forPayRub ?? 0),
      }));

      const regionRows = await db
        .select({
          regionName: wbOrdersSalesDailyRegions.regionName,
          ordersCount: sql<number>`sum(${wbOrdersSalesDailyRegions.ordersCount})`.mapWith(Number),
          salesCount: sql<number>`sum(${wbOrdersSalesDailyRegions.salesCount})`.mapWith(Number),
          ordersRub: sql<number>`sum(${wbOrdersSalesDailyRegions.ordersRub})`.mapWith(Number),
          salesRub: sql<number>`sum(${wbOrdersSalesDailyRegions.salesRub})`.mapWith(Number),
          forPayRub: sql<number>`sum(${wbOrdersSalesDailyRegions.forPayRub})`.mapWith(Number),
        })
        .from(wbOrdersSalesDailyRegions)
        .where(
          and(
            eq(wbOrdersSalesDailyRegions.workspaceId, params.workspaceId),
            buildShopFilter(wbOrdersSalesDailyRegions.shopId, shopId),
            gte(wbOrdersSalesDailyRegions.date, from),
            lte(wbOrdersSalesDailyRegions.date, to)
          )
        )
        .groupBy(wbOrdersSalesDailyRegions.regionName);

      regionAgg = regionRows.map((r) => ({
        regionName: r.regionName,
        ordersCount: Number(r.ordersCount ?? 0),
        salesCount: Number(r.salesCount ?? 0),
        ordersRub: Number(r.ordersRub ?? 0),
        salesRub: Number(r.salesRub ?? 0),
        forPayRub: Number(r.forPayRub ?? 0),
      }));
    }

    // Stock aggregation (with optional nmId filter).
    // CRITICAL: must scope by shopId too — a workspace may contain multiple
    // WB seller accounts; without this filter the "Склады и регионы" view
    // showed stock from all shops aggregated into the current selector, so a
    // warehouse could report stockQty > 0 while the selected shop actually
    // had 0 units there (session-26 bug #1 reported by the user).
    let stockAgg;
    if (filterNmIds && filterNmIds.length > 0) {
      stockAgg = await db
        .select({
          warehouseName: wbStocksCurrent.warehouseName,
          stockQty: sql<number>`sum(${wbStocksCurrent.quantity})`.mapWith(Number),
        })
        .from(wbStocksCurrent)
        .where(
          and(
            eq(wbStocksCurrent.workspaceId, params.workspaceId),
            buildShopFilter(wbStocksCurrent.shopId, shopId),
            inArray(wbStocksCurrent.nmId, filterNmIds)
          )
        )
        .groupBy(wbStocksCurrent.warehouseName);
    } else {
      stockAgg = await db
        .select({
          warehouseName: wbStocksCurrent.warehouseName,
          stockQty: sql<number>`sum(${wbStocksCurrent.quantity})`.mapWith(Number),
        })
        .from(wbStocksCurrent)
        .where(and(
          eq(wbStocksCurrent.workspaceId, params.workspaceId),
          buildShopFilter(wbStocksCurrent.shopId, shopId),
        ))
        .groupBy(wbStocksCurrent.warehouseName);
    }

    // Get stock cost by warehouse (quantity × cost price) — same shop scope.
    const stockCostAgg = await db
      .select({
        warehouseName: wbStocksCurrent.warehouseName,
        stockCostRub: sql<number>`sum(${wbStocksCurrent.quantity} * COALESCE(${wbCogs.cogsKopecks}, 0)) / 100`.mapWith(Number),
      })
      .from(wbStocksCurrent)
      .leftJoin(wbCogs, and(
        eq(wbCogs.workspaceId, wbStocksCurrent.workspaceId),
        eq(wbCogs.nmId, wbStocksCurrent.nmId)
      ))
      .where(and(
        eq(wbStocksCurrent.workspaceId, params.workspaceId),
        buildShopFilter(wbStocksCurrent.shopId, shopId),
      ))
      .groupBy(wbStocksCurrent.warehouseName);

    const stockCostByWarehouse = new Map<string, number>();
    for (const row of stockCostAgg) {
      if (!row.warehouseName) continue;
      stockCostByWarehouse.set(row.warehouseName, Number(row.stockCostRub ?? 0));
    }

    const ordersByWarehouse = new Map<string, WarehouseAgg>();
    for (const row of warehouseAgg) {
      if (!row.warehouseName) continue;
      ordersByWarehouse.set(row.warehouseName, row);
    }

    const stockByWarehouse = new Map<string, number>();
    for (const row of stockAgg) {
      if (!row.warehouseName) continue;
      stockByWarehouse.set(row.warehouseName, Number(row.stockQty ?? 0));
    }

    const allWarehouseNames = new Set<string>([
      ...ordersByWarehouse.keys(),
      ...stockByWarehouse.keys(),
    ]);

    const totalWarehouseOrders = warehouseAgg.reduce((acc, r) => acc + Number(r.ordersCount ?? 0), 0);

    const warehouses = Array.from(allWarehouseNames).map((name) => {
      const agg = ordersByWarehouse.get(name);
      const ordersCount = Number(agg?.ordersCount ?? 0);
      const ordersRub = Number(agg?.ordersRub ?? 0);
      const salesCount = Number(agg?.salesCount ?? 0);
      const salesRub = Number(agg?.salesRub ?? 0);
      const forPayRub = Number(agg?.forPayRub ?? 0);
      const stockQty = Number(stockByWarehouse.get(name) ?? 0);
      const stockCostRub = Number(stockCostByWarehouse.get(name) ?? 0);

      const avgOrdersPerDay = ordersCount > 0 ? ordersCount / daysCount : 0;
      const daysOfStock = avgOrdersPerDay > 0 ? stockQty / avgOrdersPerDay : null;
      const sharePercent = totalWarehouseOrders > 0 ? (ordersCount / totalWarehouseOrders) * 100 : 0;

      return {
        warehouseName: name,
        ordersCount,
        ordersRub,
        salesCount,
        salesRub,
        forPayRub,
        stockQty,
        stockCostRub,
        daysOfStock,
        sharePercent,
      };
    });

    warehouses.sort((a, b) => (b.ordersRub || b.ordersCount) - (a.ordersRub || a.ordersCount));

    const totalRegionOrders = regionAgg.reduce((acc, r) => acc + Number(r.ordersCount ?? 0), 0);

    // WB cluster benchmarks — average order share by region cluster
    const clusterBenchmarks: Record<string, number> = {
      'Москва и МО': 37,
      'Центральный': 22,
      'Поволжье': 12,
      'Юг': 11,
      'Урал': 8,
      'Сибирь': 6,
      'Дальний Восток': 3,
      'Прочее': 1,
    };

    // Map WB region names to clusters
    const regionToCluster: Record<string, string> = {
      'Москва': 'Москва и МО', 'Московская область': 'Москва и МО',
      'Подольск': 'Москва и МО', 'Электросталь': 'Москва и МО',
      'Коледино': 'Москва и МО', 'Тула': 'Центральный',
      'Санкт-Петербург': 'Центральный', 'Ленинградская область': 'Центральный',
      'Брянск': 'Центральный', 'Тверь': 'Центральный',
      'Курск': 'Центральный', 'Калуга': 'Центральный',
      'Смоленск': 'Центральный', 'Воронеж': 'Центральный',
      'Ярославль': 'Центральный', 'Владимир': 'Центральный',
      'Иваново': 'Центральный', 'Кострома': 'Центральный',
      'Орёл': 'Центральный', 'Рязань': 'Центральный',
      'Белгород': 'Центральный', 'Тамбов': 'Центральный',
      'Липецк': 'Центральный', 'Вологда': 'Центральный',
      'Великий Новгород': 'Центральный', 'Псков': 'Центральный',
      'Калининград': 'Центральный', 'Архангельск': 'Центральный',
      'Мурманск': 'Центральный', 'Петрозаводск': 'Центральный',
      'Казань': 'Поволжье', 'Нижний Новгород': 'Поволжье',
      'Самара': 'Поволжье', 'Саратов': 'Поволжье',
      'Ульяновск': 'Поволжье', 'Пенза': 'Поволжье',
      'Чебоксары': 'Поволжье', 'Йошкар-Ола': 'Поволжье',
      'Оренбург': 'Поволжье', 'Волгоград': 'Поволжье',
      'Астрахань': 'Поволжье', 'Киров': 'Поволжье',
      'Краснодар': 'Юг', 'Ростов-на-Дону': 'Юг',
      'Сочи': 'Юг', 'Ставрополь': 'Юг',
      'Симферополь': 'Юг', 'Крым': 'Юг',
      'Махачкала': 'Юг', 'Грозный': 'Юг',
      'Нальчик': 'Юг', 'Владикавказ': 'Юг',
      'Екатеринбург': 'Урал', 'Челябинск': 'Урал',
      'Пермь': 'Урал', 'Уфа': 'Урал',
      'Тюмень': 'Урал', 'Ижевск': 'Урал',
      'Курган': 'Урал', 'Магнитогорск': 'Урал',
      'Сургут': 'Урал', 'Ханты-Мансийск': 'Урал',
      'Новосибирск': 'Сибирь', 'Омск': 'Сибирь',
      'Красноярск': 'Сибирь', 'Барнаул': 'Сибирь',
      'Томск': 'Сибирь', 'Кемерово': 'Сибирь',
      'Иркутск': 'Сибирь', 'Новокузнецк': 'Сибирь',
      'Абакан': 'Сибирь', 'Улан-Удэ': 'Сибирь',
      'Чита': 'Сибирь',
      'Владивосток': 'Дальний Восток', 'Хабаровск': 'Дальний Восток',
      'Якутск': 'Дальний Восток', 'Южно-Сахалинск': 'Дальний Восток',
      'Петропавловск-Камчатский': 'Дальний Восток', 'Благовещенск': 'Дальний Восток',
      'Магадан': 'Дальний Восток', 'Анадырь': 'Дальний Восток',
    };

    // Additional keyword-based cluster mapping for oblast/krai/republic forms
    const keywordToCluster: Array<[string, string]> = [
      // Москва и МО
      ['москв', 'Москва и МО'], ['подольск', 'Москва и МО'], ['коледино', 'Москва и МО'],
      ['электросталь', 'Москва и МО'],
      // Центральный
      ['петербург', 'Центральный'], ['ленинград', 'Центральный'],
      ['тульск', 'Центральный'], ['брянск', 'Центральный'], ['тверск', 'Центральный'],
      ['курск', 'Центральный'], ['калужск', 'Центральный'], ['смоленск', 'Центральный'],
      ['воронежск', 'Центральный'], ['ярославск', 'Центральный'], ['владимирск', 'Центральный'],
      ['ивановск', 'Центральный'], ['костромск', 'Центральный'], ['орловск', 'Центральный'],
      ['рязанск', 'Центральный'], ['белгородск', 'Центральный'], ['тамбовск', 'Центральный'],
      ['липецк', 'Центральный'], ['вологодск', 'Центральный'], ['новгородск', 'Центральный'],
      ['псковск', 'Центральный'], ['калининградск', 'Центральный'], ['архангельск', 'Центральный'],
      ['мурманск', 'Центральный'], ['карели', 'Центральный'], ['коми', 'Центральный'],
      // Поволжье
      ['татарст', 'Поволжье'], ['нижегородск', 'Поволжье'], ['самарск', 'Поволжье'],
      ['саратовск', 'Поволжье'], ['ульяновск', 'Поволжье'], ['пензенск', 'Поволжье'],
      ['чувашск', 'Поволжье'], ['марий эл', 'Поволжье'], ['оренбургск', 'Поволжье'],
      ['волгоградск', 'Поволжье'], ['астраханск', 'Поволжье'], ['кировск', 'Поволжье'],
      ['мордови', 'Поволжье'], ['удмурт', 'Поволжье'], ['набережн', 'Поволжье'],
      // Юг
      ['краснодарск', 'Юг'], ['ростовск', 'Юг'], ['ставропольск', 'Юг'],
      ['крым', 'Юг'], ['севастопол', 'Юг'], ['адыге', 'Юг'], ['дагестан', 'Юг'], ['чечен', 'Юг'],
      ['ингушет', 'Юг'], ['кабардин', 'Юг'], ['осети', 'Юг'], ['калмыки', 'Юг'],
      ['карачаев', 'Юг'], ['черкес', 'Юг'],
      // Урал
      ['свердловск', 'Урал'], ['челябинск', 'Урал'], ['пермск', 'Урал'],
      ['башкорт', 'Урал'], ['тюменск', 'Урал'], ['курганск', 'Урал'],
      ['ханты', 'Урал'], ['ямал', 'Урал'],
      // Сибирь
      ['новосибирск', 'Сибирь'], ['омск', 'Сибирь'], ['красноярск', 'Сибирь'],
      ['алтайск', 'Сибирь'], ['алтай', 'Сибирь'], ['томск', 'Сибирь'],
      ['кемеровск', 'Сибирь'], ['кузбасс', 'Сибирь'], ['иркутск', 'Сибирь'],
      ['хакаси', 'Сибирь'], ['бурят', 'Сибирь'], ['забайкал', 'Сибирь'],
      ['тыва', 'Сибирь'], ['тува', 'Сибирь'],
      // Дальний Восток
      ['приморск', 'Дальний Восток'], ['хабаровск', 'Дальний Восток'],
      ['якут', 'Дальний Восток'], ['саха', 'Дальний Восток'],
      ['сахалин', 'Дальний Восток'], ['камчат', 'Дальний Восток'],
      ['амурск', 'Дальний Восток'], ['магадан', 'Дальний Восток'],
      ['чукот', 'Дальний Восток'], ['еврейск', 'Дальний Восток'],
    ];

    function findCluster(regionName: string): string {
      // Direct match
      if (regionToCluster[regionName]) return regionToCluster[regionName];
      // Keyword-based match (works with "Ростовская область", "Кемеровская область", etc.)
      const lower = regionName.toLowerCase();
      for (const [keyword, cluster] of keywordToCluster) {
        if (lower.includes(keyword)) return cluster;
      }
      // Fallback: partial city name match
      for (const [key, cluster] of Object.entries(regionToCluster)) {
        if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
          return cluster;
        }
      }
      return 'Прочее';
    }

    const regions = regionAgg
      .filter((r) => r.regionName)
      .map((r) => {
        const ordersCount = Number(r.ordersCount ?? 0);
        const sharePercent = totalRegionOrders > 0 ? (ordersCount / totalRegionOrders) * 100 : 0;
        const cluster = findCluster(r.regionName as string);
        const benchmark = clusterBenchmarks[cluster] ?? 1;
        const potential = sharePercent - benchmark;
        return {
          regionName: r.regionName as string,
          ordersCount,
          ordersRub: Number(r.ordersRub ?? 0),
          salesCount: Number(r.salesCount ?? 0),
          salesRub: Number(r.salesRub ?? 0),
          forPayRub: Number(r.forPayRub ?? 0),
          sharePercent,
          cluster,
          benchmark,
          potential,
        };
      })
      .sort((a, b) => (b.ordersRub || b.ordersCount) - (a.ordersRub || a.ordersCount));

    return {
      workspaceId: params.workspaceId,
      from,
      to,
      totalOrdersCount: totalWarehouseOrders,
      totalOrdersRub: warehouseAgg.reduce((acc, r) => acc + Number(r.ordersRub ?? 0), 0),
      warehouses,
      regions,
    };
  });

  // Products by warehouse
  app.get('/analytics/:workspaceId/warehouses/:warehouseName/products', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId, warehouseName } = req.params as { workspaceId: string; warehouseName: string };
    const { from, to, shopId: shopIdStr } = req.query as { from?: string; to?: string; shopId?: string };
    const wid = Number.parseInt(workspaceId, 10);
    const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;
    
    const today = new Date();
    const fromDate = from || isoDate(addDays(today, -30));
    const toDate = to || isoDate(today);

    // Get products for this warehouse
    const productsAgg = await db
      .select({
        nmId: wbOrdersSalesDailyProductWarehouses.nmId,
        ordersCount: sql<number>`SUM(${wbOrdersSalesDailyProductWarehouses.ordersCount})`.mapWith(Number),
        salesCount: sql<number>`SUM(${wbOrdersSalesDailyProductWarehouses.salesCount})`.mapWith(Number),
      })
      .from(wbOrdersSalesDailyProductWarehouses)
      .where(and(
        eq(wbOrdersSalesDailyProductWarehouses.workspaceId, wid),
        buildShopFilter(wbOrdersSalesDailyProductWarehouses.shopId, shopId),
        eq(wbOrdersSalesDailyProductWarehouses.warehouseName, warehouseName),
        gte(wbOrdersSalesDailyProductWarehouses.date, fromDate),
        lte(wbOrdersSalesDailyProductWarehouses.date, toDate)
      ))
      .groupBy(wbOrdersSalesDailyProductWarehouses.nmId);

    if (productsAgg.length === 0) {
      return { rows: [] };
    }

    const nmIds = productsAgg.map(p => p.nmId);

    // Get card info
    const cards = await db
      .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, wid), inArray(wbCards.nmId, nmIds)));
    const cardMap = new Map(cards.map(c => [c.nmId, c]));

    // Get current stock
    const stocks = await db
      .select({ nmId: wbStocksCurrent.nmId, qty: sql<number>`SUM(${wbStocksCurrent.quantity})`.mapWith(Number) })
      .from(wbStocksCurrent)
      .where(and(
        eq(wbStocksCurrent.workspaceId, wid),
        buildShopFilter(wbStocksCurrent.shopId, shopId),
        eq(wbStocksCurrent.warehouseName, warehouseName),
        inArray(wbStocksCurrent.nmId, nmIds)
      ))
      .groupBy(wbStocksCurrent.nmId);
    const stockMap = new Map(stocks.map(s => [s.nmId, s.qty]));

    const rows = productsAgg.map(p => {
      const card = cardMap.get(p.nmId);
      const stockQty = stockMap.get(p.nmId) ?? 0;
      const buyoutPctRaw = p.ordersCount > 0 ? (p.salesCount / p.ordersCount) * 100 : 0;
      const buyoutPct = Math.min(buyoutPctRaw, 100); // cap at 100% — timing offsets can cause sales > orders in a period
      return {
        nmId: p.nmId,
        vendorCode: card?.vendorCode ?? null,
        title: card?.title ?? null,
        ordersCount: p.ordersCount,
        salesCount: p.salesCount,
        stockQty,
        buyoutPct: Math.round(buyoutPct * 10) / 10,
      };
    });

    // Sort by ordersCount desc
    rows.sort((a, b) => b.ordersCount - a.ordersCount);

    return { rows };
  });

  // =========================================================================
  // REGIONS: товары для дропдауна по конкретному региону.
  // Симметрично warehouses/:warehouseName/products, источник —
  // wb_orders_sales_daily_product_regions. Без него фронт ловил 404 → «Нет
  // данных по товарам для этого региона».
  // =========================================================================
  app.get('/analytics/:workspaceId/regions/:regionName/products', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId, regionName } = req.params as { workspaceId: string; regionName: string };
    const { from, to, shopId: shopIdStr } = req.query as { from?: string; to?: string; shopId?: string };
    const wid = Number.parseInt(workspaceId, 10);
    const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;

    const today = new Date();
    const fromDate = from || isoDate(addDays(today, -30));
    const toDate = to || isoDate(today);

    // Aggregate orders/sales по nmId внутри региона
    const productsAgg = await db
      .select({
        nmId: wbOrdersSalesDailyProductRegions.nmId,
        ordersCount: sql<number>`SUM(${wbOrdersSalesDailyProductRegions.ordersCount})`.mapWith(Number),
        salesCount: sql<number>`SUM(${wbOrdersSalesDailyProductRegions.salesCount})`.mapWith(Number),
      })
      .from(wbOrdersSalesDailyProductRegions)
      .where(and(
        eq(wbOrdersSalesDailyProductRegions.workspaceId, wid),
        buildShopFilter(wbOrdersSalesDailyProductRegions.shopId, shopId),
        eq(wbOrdersSalesDailyProductRegions.regionName, regionName),
        gte(wbOrdersSalesDailyProductRegions.date, fromDate),
        lte(wbOrdersSalesDailyProductRegions.date, toDate),
      ))
      .groupBy(wbOrdersSalesDailyProductRegions.nmId);

    if (productsAgg.length === 0) {
      return { rows: [] };
    }

    const nmIds = productsAgg.map((p) => p.nmId);

    // Карточки для имени/артикула
    const cards = await db
      .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, wid), inArray(wbCards.nmId, nmIds)));
    const cardMap = new Map(cards.map((c) => [c.nmId, c]));

    // Текущий остаток — суммарный по всем складам (региональный остаток в
    // wb_stocks_current не хранится, складская сетка ≠ регион поставок).
    const stocks = await db
      .select({ nmId: wbStocksCurrent.nmId, qty: sql<number>`SUM(${wbStocksCurrent.quantity})`.mapWith(Number) })
      .from(wbStocksCurrent)
      .where(and(
        eq(wbStocksCurrent.workspaceId, wid),
        buildShopFilter(wbStocksCurrent.shopId, shopId),
        inArray(wbStocksCurrent.nmId, nmIds),
      ))
      .groupBy(wbStocksCurrent.nmId);
    const stockMap = new Map(stocks.map((s) => [s.nmId, s.qty]));

    const rows = productsAgg.map((p) => {
      const card = cardMap.get(p.nmId);
      const stockQty = stockMap.get(p.nmId) ?? 0;
      const buyoutPctRaw = p.ordersCount > 0 ? (p.salesCount / p.ordersCount) * 100 : 0;
      const buyoutPct = Math.min(buyoutPctRaw, 100);
      return {
        nmId: p.nmId,
        vendorCode: card?.vendorCode ?? null,
        title: card?.title ?? null,
        ordersCount: p.ordersCount,
        salesCount: p.salesCount,
        stockQty,
        buyoutPct: Math.round(buyoutPct * 10) / 10,
      };
    });

    rows.sort((a, b) => b.ordersCount - a.ordersCount);
    return { rows };
  });

  // =========================================================================
  // WB API: BALANCE
  // =========================================================================

  /**
   * Get seller balance
   * ⚠️ Rate limit: 1 req/min
   */
  app.get('/analytics/:workspaceId/balance', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const balance = await getBalance(apiKey);
    return { ok: true, balance };
  });

  // =========================================================================
  // WB API: PENALTIES
  // =========================================================================

  /**
   * Get measurement penalties
   * ⚠️ Rate limit: 1 req/min
   */
  app.get('/analytics/:workspaceId/penalties/measurement', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getMeasurementPenalties(apiKey, {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      limit: query.limit,
      offset: query.offset,
    });
    return { ok: true, ...result };
  });

  /**
   * Get warehouse measurements
   * ⚠️ Rate limit: 1 req/min
   */
  app.get('/analytics/:workspaceId/penalties/warehouse', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getWarehouseMeasurements(apiKey, {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      limit: query.limit,
      offset: query.offset,
    });
    return { ok: true, ...result };
  });

  /**
   * Get deductions
   * ⚠️ Rate limit: 1 req/min
   */
  app.get('/analytics/:workspaceId/deductions', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string(),
      sort: z.enum(['nmId', 'dtBonus', 'bonusSumm']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getDeductions(apiKey, {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return { ok: true, ...result };
  });

  // =========================================================================
  // WB API: RESHIPMENTS
  // =========================================================================

  /**
   * Get orders requiring reshipment
   */
  app.get('/analytics/:workspaceId/reshipments', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getReshipmentOrders(apiKey);
    return { ok: true, ...result };
  });

  // =========================================================================
  // WB API: DOCUMENTS
  // =========================================================================

  /**
   * Get document categories
   */
  app.get('/analytics/:workspaceId/documents/categories', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getDocumentCategories(apiKey);
    return { ok: true, ...result };
  });

  /**
   * Get documents list
   */
  app.get('/analytics/:workspaceId/documents', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      beginTime: z.string(),  // YYYY-MM-DD
      endTime: z.string(),
      category: z.string().optional(),
      sort: z.enum(['date', 'category']).default('date'),
      order: z.enum(['asc', 'desc']).default('desc'),
      limit: z.coerce.number().int().min(1).max(50).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getDocumentsList(apiKey, {
      beginTime: query.beginTime,
      endTime: query.endTime,
      category: query.category,
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return { ok: true, ...result };
  });

  /**
   * Download single document (base64)
   */
  app.get('/analytics/:workspaceId/documents/download', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      serviceName: z.string().min(1),
      extension: z.string().min(1),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await downloadDocument(apiKey, query.serviceName, query.extension);
    return { ok: true, ...result };
  });

  /**
   * Download multiple documents as zip (base64)
   * ⚠️ Rate limit: 1 req/5 min
   */
  app.post('/analytics/:workspaceId/documents/download-batch', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      items: z.array(z.object({
        serviceName: z.string().min(1),
        extension: z.string().min(1),
      })).min(1).max(50),
    }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    const result = await downloadDocumentsBatch(apiKey, body.items);
    return { ok: true, ...result };
  });

  // =========================================================================
  // WB API: PROMOTIONS (Акции)
  // =========================================================================

  /**
   * Get promotions list
   */
  app.get('/analytics/:workspaceId/promotions', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      startDateTime: z.string().optional(),
      endDateTime: z.string().optional(),
      allPromo: z.coerce.boolean().optional(),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    try {
      const result = await getPromotions(apiKey, {
        startDateTime: query.startDateTime,
        endDateTime: query.endDateTime,
        allPromo: query.allPromo,
      });
      return { ok: true, ...result };
    } catch (err: any) {
      req.log.warn({ err: err?.message }, 'promotions fetch failed');
      return { ok: false, error: 'Не удалось загрузить акции. Проверьте доступ API-ключа к календарю акций.', data: { promotions: [] } };
    }
  });

  /**
   * Get promotion details
   */
  app.get('/analytics/:workspaceId/promotions/:promotionId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      promotionId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    try {
      const result = await getPromotionDetails(apiKey, params.promotionId);
      return { ok: true, ...result };
    } catch (err: any) {
      req.log.warn({ err: err?.message }, 'promotion details fetch failed');
      return { ok: false, error: 'Не удалось загрузить детали акции.' };
    }
  });

  /**
   * Get products eligible for promotion
   */
  app.get('/analytics/:workspaceId/promotions/:promotionId/products', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      promotionId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      inAction: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    try {
      let allProducts: any[] = [];
      if (query.inAction !== undefined) {
        // Specific filter
        const result = await getPromotionProducts(apiKey, params.promotionId, {
          inAction: query.inAction,
          limit: query.limit,
          offset: query.offset,
        });
        allProducts = result?.data?.nomenclatures ?? [];
      } else {
        // Fetch both: products in action AND eligible products not yet in action
        const [inActionRes, notInActionRes] = await Promise.all([
          getPromotionProducts(apiKey, params.promotionId, { inAction: true, limit: query.limit, offset: query.offset }),
          getPromotionProducts(apiKey, params.promotionId, { inAction: false, limit: query.limit, offset: query.offset }),
        ]);
        const inAction = (inActionRes?.data?.nomenclatures ?? []).map((n: any) => ({ ...n, inAction: true }));
        const notInAction = (notInActionRes?.data?.nomenclatures ?? []).map((n: any) => ({ ...n, inAction: false }));
        allProducts = [...inAction, ...notInAction];
      }
      // Remap WB API response: nomenclatures → products
      // WB API fields: id (nmId), inAction, price, currencyCode, planPrice, discount, planDiscount
      const products = allProducts.map((n: any) => ({
        nmId: n.id ?? n.nmId,
        inAction: n.inAction ?? false,
        currPrice: n.price ?? null,
        actionPrice: n.planPrice ?? null,
        discount: n.discount ?? null,
        planDiscount: n.planDiscount ?? null,
      }));
      return { ok: true, data: { products } };
    } catch (err: any) {
      req.log.warn({ err: err?.message }, 'promotion products fetch failed');
      return { ok: false, error: 'Не удалось загрузить товары акции. WB API вернул ошибку. Возможно, акция уже завершена или у API-ключа нет доступа.', data: { products: [] } };
    }
  });

  /**
   * Add products to promotion
   */
  app.post('/analytics/:workspaceId/promotions/:promotionId/products', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      promotionId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      nmIds: z.array(z.coerce.number().int()).min(1).max(100),
    }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await addProductsToPromotion(apiKey, params.promotionId, body.nmIds);
    return { ok: true, count: body.nmIds.length };
  });

  /**
   * Remove products from promotion
   */
  app.delete('/analytics/:workspaceId/promotions/:promotionId/products', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      promotionId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      nmIds: z.array(z.coerce.number().int()).min(1).max(100),
    }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await removeProductsFromPromotion(apiKey, params.promotionId, body.nmIds);
    return { ok: true, count: body.nmIds.length };
  });

  // =========================================================================
  // WB API: SEARCH REPORT & SALES FUNNEL
  // =========================================================================

  /**
   * Get search report
   */
  app.post('/analytics/:workspaceId/search-report', {
    preHandler: requireRole('viewer'),
    config: heavyReportRateLimit,
  }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string(),
      dateTo: z.string(),
      nmIds: z.array(z.coerce.number().int()).optional(),
      brandNames: z.array(z.string()).optional(),
      objectIds: z.array(z.coerce.number().int()).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse((req as any).body ?? {});

    // Hard cap on the period — these reports load N days × M nmIds into
    // memory; over 90 days the report can OOM the api process under bursts.
    if (!isWithinDayCap(body.dateFrom, body.dateTo, 90)) {
      return reply.code(400).send({ ok: false, error: 'period_too_long', message: 'Период отчёта не может превышать 90 дней.' });
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    try {
      const result = await getSearchReport(apiKey, {
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
        nmIds: body.nmIds,
        brandNames: body.brandNames,
        objectIds: body.objectIds,
        limit: body.limit,
        offset: body.offset,
      });
      return { ok: true, ...result };
    } catch (err) {
      if (isJamRequiredError(err)) {
        return {
          ok: false,
          error: 'jam_required',
          message: 'Для доступа к отчёту по поисковым запросам требуется подписка "Джем" в личном кабинете WB. Подключите её на seller.wildberries.ru в разделе "Тарифы".',
        };
      }
      throw err;
    }
  });

  /**
   * Get search texts for product (what queries lead to this product)
   */
  app.get('/analytics/:workspaceId/search-texts/:nmId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      nmId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string(),
      dateTo: z.string(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getProductSearchTexts(apiKey, {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      nmIds: [params.nmId],
      limit: query.limit,
    });
    return { ok: true, ...result };
  });

  /**
   * Get sales funnel products
   */
  app.post('/analytics/:workspaceId/sales-funnel', {
    preHandler: requireRole('viewer'),
    config: heavyReportRateLimit,
  }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string(),
      dateTo: z.string(),
      nmIds: z.array(z.coerce.number().int()).optional(),
      brandNames: z.array(z.string()).optional(),
      objectIds: z.array(z.coerce.number().int()).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      orderBy: z.object({
        field: z.enum(['views', 'clicks', 'ctr', 'addToCart', 'orders', 'buyoutPercent']),
        mode: z.enum(['asc', 'desc']),
      }).optional(),
    }).parse((req as any).body ?? {});

    if (!isWithinDayCap(body.dateFrom, body.dateTo, 90)) {
      return reply.code(400).send({ ok: false, error: 'period_too_long', message: 'Период отчёта не может превышать 90 дней.' });
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    const result = await getSalesFunnelProducts(apiKey, {
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      nmIds: body.nmIds,
      brandNames: body.brandNames,
      objectIds: body.objectIds,
      limit: body.limit,
      offset: body.offset,
      orderBy: body.orderBy,
    });
    return { ok: true, ...result };
  });

  /**
   * Get sales funnel history (daily/weekly)
   */
  app.post('/analytics/:workspaceId/sales-funnel/history', {
    preHandler: requireRole('viewer'),
    config: heavyReportRateLimit,
  }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string(),
      dateTo: z.string(),
      nmIds: z.array(z.coerce.number().int()).min(1).max(20),
      period: z.enum(['day', 'week']).default('day'),
    }).parse((req as any).body ?? {});

    if (!isWithinDayCap(body.dateFrom, body.dateTo, 90)) {
      return reply.code(400).send({ ok: false, error: 'period_too_long', message: 'Период отчёта не может превышать 90 дней.' });
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    const result = await getSalesFunnelHistory(apiKey, {
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      nmIds: body.nmIds,
      period: body.period,
    });
    return { ok: true, ...result };
  });

  // =========================================================================
  // WB CLUB ANALYTICS
  // =========================================================================

  /**
   * Get WB Club analytics.
   *
   * WB removed the v3/sales-funnel/wb-club endpoint in early 2026 (returns 404).
   * To avoid log spam from the analytics page polling this on every shop view,
   * we short-circuit after the first 404 for the lifetime of the process.
   */
  app.post('/analytics/:workspaceId/wb-club', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      dateFrom: z.string(),
      dateTo: z.string(),
      nmIds: z.array(z.coerce.number().int()).optional(),
      brandNames: z.array(z.string()).optional(),
      objectIds: z.array(z.coerce.number().int()).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse((req as any).body ?? {});

    if (wbClubEndpointDead) {
      // Service Unavailable: WB removed the endpoint, kill switch is on.
      // Frontend (WbClubCard) wraps the call in try/catch and hides the card
      // when the throw lands, so a 503 here matches the existing graceful UX.
      return reply.code(503).send({ ok: false, error: 'WB Club аналитика временно недоступна', data: [], totals: null });
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    try {
      const result = await getWbClubAnalytics(apiKey, {
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
        nmIds: body.nmIds,
        brandNames: body.brandNames,
        objectIds: body.objectIds,
        limit: body.limit,
        offset: body.offset,
      });
      return { ok: true, ...result };
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      // 404 means WB removed the endpoint — flip the kill switch and stop logging.
      if (msg.includes(' 404 ') || msg.includes('path not found')) {
        if (!wbClubEndpointDead) {
          wbClubEndpointDead = true;
          req.log.warn('wb-club analytics endpoint removed by WB (404) — disabling for this process');
        }
      } else {
        // Other errors (network, auth) are still worth surfacing
        req.log.warn({ err: msg }, 'wb-club analytics unavailable');
      }
      return reply.code(503).send({ ok: false, error: 'WB Club аналитика временно недоступна', data: [], totals: null });
    }
  });
};

// Module-level kill switch for the WB Club endpoint. Reset on process restart.
let wbClubEndpointDead = false;

// ---------------------------------------------------------------------------
// Helper: Get API key for shop
// ---------------------------------------------------------------------------

async function getShopApiKey(
  workspaceId: number,
  platform: 'wb' | 'ozon' | 'yandex_market',
  shopId?: number,
): Promise<string> {
  const where = [
    eq(marketplaceShops.workspaceId, workspaceId),
    eq(marketplaceShops.platform, platform),
    eq(marketplaceShops.isActive, true),
  ];

  if (shopId) {
    where.push(eq(marketplaceShops.shopId, shopId));
  }

  const [shop] = await db
    .select({ apiKey: marketplaceShops.apiKey, name: marketplaceShops.name })
    .from(marketplaceShops)
    .where(and(...where))
    .limit(1);

  if (!shop?.apiKey) {
    throw new NotFoundError(`No active ${platform.toUpperCase()} shop found for workspace`);
  }

  const decrypted = safeDecrypt(shop.apiKey);
  if (!decrypted) {
    throw new BadRequestError('Failed to decrypt API key');
  }

  return decrypted;
}
