import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, gte, lte, desc, or, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wbAdvDaily, wbAdvDailyProducts, wbCards, wbCogs, wbFinanceDaily, wbFinanceDailyProducts, wbFunnelDaily, wbFunnelDailyProducts, wbOrdersSalesDaily, wbOrdersSalesDailyProducts, wbStocksDailyProducts, wbSyncRuns, wbTagProducts } from '../db/schema.js';
import {
  parseNmIdsParam,
  parseMultiParam,
  intersect,
  parseDate,
  fmtDate,
  addDays,
  daysBetweenInclusive,
  getISOWeek,
  weekStart,
  pctDelta,
  safeDiv,
  getToday,
  getFilteredNmIds,
  buildShopFilter,
  withShopFilter,
  escapeIlike,
  type PulseFilterOptions,
  fetchFunnelOrdersKpi,
} from './pulse/helpers.js';
import { requireRole } from '../plugins/roleCheck.js';
import { getAdvSpendScale } from '../services/advSpendScale.js';

export const pulseRoutes: FastifyPluginAsync = async (app) => {
  app.get('/pulse/:workspaceId/overview', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive() })
      .parse(req.params);

    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        drrBase: z.enum(['sales', 'payout']).optional(),
        groupBy: z.enum(['day', 'week']).optional(),
        anomalies: z.enum(['off', 'on']).optional(),
        anomalyThresholdPct: z.coerce.number().optional(),
        anomalyWindow: z.coerce.number().int().optional(),
        tagId: z.coerce.number().int().positive().optional(),
        nmIds: z.string().optional(),
        vendorCode: z.string().optional(),
        brandName: z.string().optional(),
        subjectId: z.coerce.number().int().optional(),
        subjectName: z.string().optional(),
        taxRate: z.coerce.number().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    
    // Shop filter for multi-shop support
    const shopId = query.shopId;

    const today = new Date().toISOString().slice(0, 10);
    const toRaw = query.to ?? today;
    const to = toRaw > today ? today : toRaw; // cap future dates
    const fromRaw = query.from ?? to;
    // Ensure from <= to; cap range to 1 year max
    const minDate = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const from = fromRaw > to ? to : fromRaw < minDate ? minDate : fromRaw;
    const groupBy = query.groupBy ?? 'day';
    const anomaliesEnabled = (query.anomalies ?? 'on') === 'on';
    const anomalyThresholdPct = query.anomalyThresholdPct ?? 20;
    const anomalyWindow = query.anomalyWindow ?? (groupBy === 'day' ? 7 : 4);
    const taxRateRaw = typeof query.taxRate === 'number' && Number.isFinite(query.taxRate) ? query.taxRate : 0.15;
    const taxRate = taxRateRaw > 1 ? taxRateRaw / 100 : taxRateRaw;

    const run = await db
      .select()
      .from(wbSyncRuns)
      .where(eq(wbSyncRuns.workspaceId, params.workspaceId))
      .orderBy(desc(wbSyncRuns.createdAt))
      .limit(1);

    const lenDays = daysBetweenInclusive(from, to);
    const prevTo = fmtDate(addDays(parseDate(from), -1));
    const prevFrom = fmtDate(addDays(parseDate(from), -lenDays));

    // Optional filters (tag + cards + explicit nmIds)
    let filteredNmIds: number[] | null = null;
    let tagNmIds: number[] | null = null;
    if (query.tagId) {
      const links = await db
        .select({ nmId: wbTagProducts.nmId })
        .from(wbTagProducts)
        .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.tagId, query.tagId)));
      tagNmIds = links.map((l) => Number(l.nmId)).filter((n) => Number.isFinite(n) && n > 0);
    }

    const nmIdsParam = query.nmIds ? parseNmIdsParam(query.nmIds) : [];

    let cardNmIds: number[] | null = null;
    if (query.vendorCode || query.brandName || query.subjectId || query.subjectName) {

      const conds: (SQL | undefined)[] = [eq(wbCards.workspaceId, params.workspaceId), buildShopFilter(wbCards.shopId, shopId)];

      const vendorCodes = parseMultiParam(query.vendorCode);
      if (vendorCodes.length) {
        conds.push(or(...vendorCodes.map((v) => ilike(wbCards.vendorCode, `%${escapeIlike(v)}%`)))!);
      }
      const brandNames = parseMultiParam(query.brandName);
      if (brandNames.length) {
        conds.push(or(...brandNames.map((v) => ilike(wbCards.brandName, `%${escapeIlike(v)}%`)))!);
      }
      const subjectNames = parseMultiParam(query.subjectName);
      if (subjectNames.length) {
        conds.push(or(...subjectNames.map((v) => ilike(wbCards.subjectName, `%${escapeIlike(v)}%`)))!);
      }
      if (typeof query.subjectId === 'number') conds.push(eq(wbCards.subjectId, query.subjectId));

      const rows = await db.select({ nmId: wbCards.nmId }).from(wbCards).where(and(...conds.filter((c): c is SQL => c !== undefined)));
      cardNmIds = rows.map((r) => Number(r.nmId)).filter((n) => Number.isFinite(n) && n > 0);
    }

    const nmLists = [nmIdsParam.length ? nmIdsParam : null, cardNmIds, tagNmIds].filter(Boolean) as number[][];
    if (nmLists.length) {
      filteredNmIds = nmLists[0] ?? [];
      for (let i = 1; i < nmLists.length; i++) {
        filteredNmIds = intersect(filteredNmIds, nmLists[i]!);
      }
      // Important: drizzle inArray([]) can produce invalid SQL (IN ()).
      if (filteredNmIds.length === 0) filteredNmIds = [-1];
    }

    // Fetch orders KPI from WB Funnel API (matches WB personal cabinet)
    // Runs in parallel with DB queries below — result used to override ordersCount/ordersRub in KPIs
    const funnelKpiPromise = fetchFunnelOrdersKpi(params.workspaceId, from, to, shopId, filteredNmIds);
    const prevFunnelKpiPromise = fetchFunnelOrdersKpi(params.workspaceId, prevFrom, prevTo, shopId, filteredNmIds);

    // Orders/Sales (with multi-shop filter)
    // When shopId or product filter is set, use per-product table for accurate shop isolation
    // (aggregate wbOrdersSalesDaily has PK without shopId, so rows get overwritten across shops)
    const useProductTable = !!filteredNmIds || !!shopId;
    const rows = useProductTable
      ? await db
          .select({
            date: wbOrdersSalesDailyProducts.date,
            ordersCount: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersCount})`.mapWith(Number),
            salesCount: sql<number>`sum(${wbOrdersSalesDailyProducts.salesCount})`.mapWith(Number),
            salesRub: sql<number>`sum(${wbOrdersSalesDailyProducts.salesRub})`.mapWith(Number),
            ordersRub: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersRub})`.mapWith(Number),
            discountPercentSumBp: sql<number>`sum(${wbOrdersSalesDailyProducts.discountPercentSumBp})`.mapWith(Number),
            finishedPriceRub: sql<number>`sum(${wbOrdersSalesDailyProducts.finishedPriceRub})`.mapWith(Number),
          })
          .from(wbOrdersSalesDailyProducts)
          .where(
            and(
              eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbOrdersSalesDailyProducts.shopId, shopId),
              gte(wbOrdersSalesDailyProducts.date, from),
              lte(wbOrdersSalesDailyProducts.date, to),
              filteredNmIds ? inArray(wbOrdersSalesDailyProducts.nmId, filteredNmIds as any) : undefined
            )
          )
          .groupBy(wbOrdersSalesDailyProducts.date)
      : await db
          .select()
          .from(wbOrdersSalesDaily)
          .where(and(eq(wbOrdersSalesDaily.workspaceId, params.workspaceId), buildShopFilter(wbOrdersSalesDaily.shopId, shopId), gte(wbOrdersSalesDaily.date, from), lte(wbOrdersSalesDaily.date, to)));

    const prevRows = useProductTable
      ? await db
          .select({
            date: wbOrdersSalesDailyProducts.date,
            ordersCount: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersCount})`.mapWith(Number),
            salesCount: sql<number>`sum(${wbOrdersSalesDailyProducts.salesCount})`.mapWith(Number),
            salesRub: sql<number>`sum(${wbOrdersSalesDailyProducts.salesRub})`.mapWith(Number),
            ordersRub: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersRub})`.mapWith(Number),
            discountPercentSumBp: sql<number>`sum(${wbOrdersSalesDailyProducts.discountPercentSumBp})`.mapWith(Number),
            finishedPriceRub: sql<number>`sum(${wbOrdersSalesDailyProducts.finishedPriceRub})`.mapWith(Number),
          })
          .from(wbOrdersSalesDailyProducts)
          .where(
            and(
              eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbOrdersSalesDailyProducts.shopId, shopId),
              gte(wbOrdersSalesDailyProducts.date, prevFrom),
              lte(wbOrdersSalesDailyProducts.date, prevTo),
              filteredNmIds ? inArray(wbOrdersSalesDailyProducts.nmId, filteredNmIds as any) : undefined
            )
          )
          .groupBy(wbOrdersSalesDailyProducts.date)
      : await db
          .select()
          .from(wbOrdersSalesDaily)
          .where(and(eq(wbOrdersSalesDaily.workspaceId, params.workspaceId), buildShopFilter(wbOrdersSalesDaily.shopId, shopId), gte(wbOrdersSalesDaily.date, prevFrom), lte(wbOrdersSalesDaily.date, prevTo)));

    // Advertising
    const advRows = filteredNmIds
      ? await db
          .select({
            date: wbAdvDailyProducts.date,
            spendKopecks: sql<number>`sum(${wbAdvDailyProducts.spendKopecks})`.mapWith(Number),
            viewsCount: sql<number>`sum(${wbAdvDailyProducts.viewsCount})`.mapWith(Number),
            clicksCount: sql<number>`sum(${wbAdvDailyProducts.clicksCount})`.mapWith(Number),
            atbsCount: sql<number>`sum(${wbAdvDailyProducts.atbsCount})`.mapWith(Number),
            ordersCount: sql<number>`sum(${wbAdvDailyProducts.ordersCount})`.mapWith(Number),
            sumPriceKopecks: sql<number>`sum(${wbAdvDailyProducts.sumPriceKopecks})`.mapWith(Number),
            spendManualKopecks: sql<number>`sum(${wbAdvDailyProducts.spendManualKopecks})`.mapWith(Number),
            viewsManualCount: sql<number>`sum(${wbAdvDailyProducts.viewsManualCount})`.mapWith(Number),
            clicksManualCount: sql<number>`sum(${wbAdvDailyProducts.clicksManualCount})`.mapWith(Number),
            atbsManualCount: sql<number>`sum(${wbAdvDailyProducts.atbsManualCount})`.mapWith(Number),
            ordersManualCount: sql<number>`sum(${wbAdvDailyProducts.ordersManualCount})`.mapWith(Number),
            sumPriceManualKopecks: sql<number>`sum(${wbAdvDailyProducts.sumPriceManualKopecks})`.mapWith(Number),
            spendUnifiedKopecks: sql<number>`sum(${wbAdvDailyProducts.spendUnifiedKopecks})`.mapWith(Number),
            viewsUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.viewsUnifiedCount})`.mapWith(Number),
            clicksUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.clicksUnifiedCount})`.mapWith(Number),
            atbsUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.atbsUnifiedCount})`.mapWith(Number),
            ordersUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.ordersUnifiedCount})`.mapWith(Number),
            sumPriceUnifiedKopecks: sql<number>`sum(${wbAdvDailyProducts.sumPriceUnifiedKopecks})`.mapWith(Number),
          })
          .from(wbAdvDailyProducts)
          .where(
            and(
              eq(wbAdvDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbAdvDailyProducts.shopId, shopId),
              gte(wbAdvDailyProducts.date, from),
              lte(wbAdvDailyProducts.date, to),
              inArray(wbAdvDailyProducts.nmId, filteredNmIds as any)
            )
          )
          .groupBy(wbAdvDailyProducts.date)
      : await db
          .select()
          .from(wbAdvDaily)
          .where(and(eq(wbAdvDaily.workspaceId, params.workspaceId), buildShopFilter(wbAdvDaily.shopId, shopId), gte(wbAdvDaily.date, from), lte(wbAdvDaily.date, to)));

    const prevAdvRows = filteredNmIds
      ? await db
          .select({
            date: wbAdvDailyProducts.date,
            spendKopecks: sql<number>`sum(${wbAdvDailyProducts.spendKopecks})`.mapWith(Number),
            viewsCount: sql<number>`sum(${wbAdvDailyProducts.viewsCount})`.mapWith(Number),
            clicksCount: sql<number>`sum(${wbAdvDailyProducts.clicksCount})`.mapWith(Number),
            atbsCount: sql<number>`sum(${wbAdvDailyProducts.atbsCount})`.mapWith(Number),
            ordersCount: sql<number>`sum(${wbAdvDailyProducts.ordersCount})`.mapWith(Number),
            sumPriceKopecks: sql<number>`sum(${wbAdvDailyProducts.sumPriceKopecks})`.mapWith(Number),
            spendManualKopecks: sql<number>`sum(${wbAdvDailyProducts.spendManualKopecks})`.mapWith(Number),
            viewsManualCount: sql<number>`sum(${wbAdvDailyProducts.viewsManualCount})`.mapWith(Number),
            clicksManualCount: sql<number>`sum(${wbAdvDailyProducts.clicksManualCount})`.mapWith(Number),
            atbsManualCount: sql<number>`sum(${wbAdvDailyProducts.atbsManualCount})`.mapWith(Number),
            ordersManualCount: sql<number>`sum(${wbAdvDailyProducts.ordersManualCount})`.mapWith(Number),
            sumPriceManualKopecks: sql<number>`sum(${wbAdvDailyProducts.sumPriceManualKopecks})`.mapWith(Number),
            spendUnifiedKopecks: sql<number>`sum(${wbAdvDailyProducts.spendUnifiedKopecks})`.mapWith(Number),
            viewsUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.viewsUnifiedCount})`.mapWith(Number),
            clicksUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.clicksUnifiedCount})`.mapWith(Number),
            atbsUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.atbsUnifiedCount})`.mapWith(Number),
            ordersUnifiedCount: sql<number>`sum(${wbAdvDailyProducts.ordersUnifiedCount})`.mapWith(Number),
            sumPriceUnifiedKopecks: sql<number>`sum(${wbAdvDailyProducts.sumPriceUnifiedKopecks})`.mapWith(Number),
          })
          .from(wbAdvDailyProducts)
          .where(
            and(
              eq(wbAdvDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbAdvDailyProducts.shopId, shopId),
              gte(wbAdvDailyProducts.date, prevFrom),
              lte(wbAdvDailyProducts.date, prevTo),
              inArray(wbAdvDailyProducts.nmId, filteredNmIds as any)
            )
          )
          .groupBy(wbAdvDailyProducts.date)
      : await db
          .select()
          .from(wbAdvDaily)
          .where(and(eq(wbAdvDaily.workspaceId, params.workspaceId), buildShopFilter(wbAdvDaily.shopId, shopId), gte(wbAdvDaily.date, prevFrom), lte(wbAdvDaily.date, prevTo)));

    // Масштабируем ТОЛЬКО per-nm ветку (wb_adv_daily_products / fullstats),
    // которая системно занижает spend в 1.5–2×. Shop-level wb_adv_daily
    // уже близок к xlsx ЛК ВБ, scale ему не нужен.
    // 2026-06-06. Тот же подход в /finance/by-product.
    if (filteredNmIds) {
      const advScale = await getAdvSpendScale(params.workspaceId, shopId, from, to);
      const prevAdvScale = await getAdvSpendScale(params.workspaceId, shopId, prevFrom, prevTo);
      for (const r of advRows as any[]) r.spendKopecks = Math.round((r.spendKopecks ?? 0) * advScale);
      for (const r of prevAdvRows as any[]) r.spendKopecks = Math.round((r.spendKopecks ?? 0) * prevAdvScale);
    }

    // Finance — use product-level data for margin calculations on Pulse dashboard.
    // Aggregated wbFinanceDaily contains WB settlement data that may not correspond to
    // current period orders (WB pays for past shipments with 2-3 week delay).
    // Only use product-level data (wbFinanceDailyProducts) which can be matched to orders.
    const finRows = filteredNmIds
      ? await db
          .select({
            date: wbFinanceDailyProducts.date,
            revenueKopecks: sql<number>`sum(${wbFinanceDailyProducts.revenueKopecks})`.mapWith(Number),
            payoutKopecks: sql<number>`sum(${wbFinanceDailyProducts.incomeFromSalesKopecks})`.mapWith(Number),
            commissionKopecks: sql<number>`sum(${wbFinanceDailyProducts.revenueKopecks} - ${wbFinanceDailyProducts.incomeFromSalesKopecks})`.mapWith(Number),
            logisticsKopecks: sql<number>`sum(${wbFinanceDailyProducts.logisticsKopecks})`.mapWith(Number),
            returnLogisticsKopecks: sql<number>`sum(${wbFinanceDailyProducts.returnLogisticsKopecks})`.mapWith(Number),
            paidAcceptanceKopecks: sql<number>`sum(${wbFinanceDailyProducts.paidAcceptanceKopecks})`.mapWith(Number),
            storageKopecks: sql<number>`sum(${wbFinanceDailyProducts.storageKopecks})`.mapWith(Number),
            penaltyKopecks: sql<number>`sum(${wbFinanceDailyProducts.penaltiesKopecks})`.mapWith(Number),
            otherHoldKopecks: sql<number>`sum(${wbFinanceDailyProducts.otherHoldKopecks})`.mapWith(Number),
            acquiringKopecks: sql<number>`sum(${wbFinanceDailyProducts.acquiringKopecks})`.mapWith(Number),
            additionalPaymentKopecks: sql<number>`sum(${wbFinanceDailyProducts.additionalPaymentsKopecks})`.mapWith(Number),
            returnsCount: sql<number>`sum(${wbFinanceDailyProducts.returnsCount})`.mapWith(Number),
          })
          .from(wbFinanceDailyProducts)
          .where(
            and(
              eq(wbFinanceDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbFinanceDailyProducts.shopId, shopId),
              gte(wbFinanceDailyProducts.date, from),
              lte(wbFinanceDailyProducts.date, to),
              inArray(wbFinanceDailyProducts.nmId, filteredNmIds as any)
            )
          )
          .groupBy(wbFinanceDailyProducts.date)
      : await db
          .select({
            date: wbFinanceDailyProducts.date,
            revenueKopecks: sql<number>`sum(${wbFinanceDailyProducts.revenueKopecks})`.mapWith(Number),
            payoutKopecks: sql<number>`sum(${wbFinanceDailyProducts.incomeFromSalesKopecks})`.mapWith(Number),
            commissionKopecks: sql<number>`sum(${wbFinanceDailyProducts.revenueKopecks} - ${wbFinanceDailyProducts.incomeFromSalesKopecks})`.mapWith(Number),
            logisticsKopecks: sql<number>`sum(${wbFinanceDailyProducts.logisticsKopecks})`.mapWith(Number),
            returnLogisticsKopecks: sql<number>`sum(${wbFinanceDailyProducts.returnLogisticsKopecks})`.mapWith(Number),
            paidAcceptanceKopecks: sql<number>`sum(${wbFinanceDailyProducts.paidAcceptanceKopecks})`.mapWith(Number),
            storageKopecks: sql<number>`sum(${wbFinanceDailyProducts.storageKopecks})`.mapWith(Number),
            penaltyKopecks: sql<number>`sum(${wbFinanceDailyProducts.penaltiesKopecks})`.mapWith(Number),
            otherHoldKopecks: sql<number>`sum(${wbFinanceDailyProducts.otherHoldKopecks})`.mapWith(Number),
            acquiringKopecks: sql<number>`sum(${wbFinanceDailyProducts.acquiringKopecks})`.mapWith(Number),
            additionalPaymentKopecks: sql<number>`sum(${wbFinanceDailyProducts.additionalPaymentsKopecks})`.mapWith(Number),
            returnsCount: sql<number>`sum(${wbFinanceDailyProducts.returnsCount})`.mapWith(Number),
          })
          .from(wbFinanceDailyProducts)
          .where(and(eq(wbFinanceDailyProducts.workspaceId, params.workspaceId), buildShopFilter(wbFinanceDailyProducts.shopId, shopId), gte(wbFinanceDailyProducts.date, from), lte(wbFinanceDailyProducts.date, to)))
          .groupBy(wbFinanceDailyProducts.date);

    const prevFinRows = filteredNmIds
      ? await db
          .select({
            date: wbFinanceDailyProducts.date,
            revenueKopecks: sql<number>`sum(${wbFinanceDailyProducts.revenueKopecks})`.mapWith(Number),
            payoutKopecks: sql<number>`sum(${wbFinanceDailyProducts.incomeFromSalesKopecks})`.mapWith(Number),
            // Комиссия = revenue - payout
            commissionKopecks: sql<number>`sum(${wbFinanceDailyProducts.revenueKopecks} - ${wbFinanceDailyProducts.incomeFromSalesKopecks})`.mapWith(Number),
            logisticsKopecks: sql<number>`sum(${wbFinanceDailyProducts.logisticsKopecks})`.mapWith(Number),
            returnLogisticsKopecks: sql<number>`sum(${wbFinanceDailyProducts.returnLogisticsKopecks})`.mapWith(Number),
            paidAcceptanceKopecks: sql<number>`sum(${wbFinanceDailyProducts.paidAcceptanceKopecks})`.mapWith(Number),
            storageKopecks: sql<number>`sum(${wbFinanceDailyProducts.storageKopecks})`.mapWith(Number),
            penaltyKopecks: sql<number>`sum(${wbFinanceDailyProducts.penaltiesKopecks})`.mapWith(Number),
            otherHoldKopecks: sql<number>`sum(${wbFinanceDailyProducts.otherHoldKopecks})`.mapWith(Number),
            acquiringKopecks: sql<number>`sum(${wbFinanceDailyProducts.acquiringKopecks})`.mapWith(Number),
            additionalPaymentKopecks: sql<number>`sum(${wbFinanceDailyProducts.additionalPaymentsKopecks})`.mapWith(Number),
            returnsCount: sql<number>`sum(${wbFinanceDailyProducts.returnsCount})`.mapWith(Number),
          })
          .from(wbFinanceDailyProducts)
          .where(
            and(
              eq(wbFinanceDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbFinanceDailyProducts.shopId, shopId),
              gte(wbFinanceDailyProducts.date, prevFrom),
              lte(wbFinanceDailyProducts.date, prevTo),
              inArray(wbFinanceDailyProducts.nmId, filteredNmIds as any)
            )
          )
          .groupBy(wbFinanceDailyProducts.date)
      : await db
          .select()
          .from(wbFinanceDaily)
          .where(and(eq(wbFinanceDaily.workspaceId, params.workspaceId), buildShopFilter(wbFinanceDaily.shopId, shopId), gte(wbFinanceDaily.date, prevFrom), lte(wbFinanceDaily.date, prevTo)));

    const stockRows = filteredNmIds
      ? await db
          .select({
            date: wbStocksDailyProducts.date,
            quantity: sql<number>`sum(${wbStocksDailyProducts.quantity})`.mapWith(Number),
            inWayToClient: sql<number>`sum(${wbStocksDailyProducts.inWayToClient})`.mapWith(Number),
            inWayFromClient: sql<number>`sum(${wbStocksDailyProducts.inWayFromClient})`.mapWith(Number),
          })
          .from(wbStocksDailyProducts)
          .where(
            and(
              eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbStocksDailyProducts.shopId, shopId),
              gte(wbStocksDailyProducts.date, from),
              lte(wbStocksDailyProducts.date, to),
              inArray(wbStocksDailyProducts.nmId, filteredNmIds as any)
            )
          )
          .groupBy(wbStocksDailyProducts.date)
      : await db
          .select({
            date: wbStocksDailyProducts.date,
            quantity: sql<number>`sum(${wbStocksDailyProducts.quantity})`.mapWith(Number),
            inWayToClient: sql<number>`sum(${wbStocksDailyProducts.inWayToClient})`.mapWith(Number),
            inWayFromClient: sql<number>`sum(${wbStocksDailyProducts.inWayFromClient})`.mapWith(Number),
          })
          .from(wbStocksDailyProducts)
          .where(
            and(
              eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbStocksDailyProducts.shopId, shopId),
              gte(wbStocksDailyProducts.date, from),
              lte(wbStocksDailyProducts.date, to)
            )
          )
          .groupBy(wbStocksDailyProducts.date);

    const prevStockRows = filteredNmIds
      ? await db
          .select({
            date: wbStocksDailyProducts.date,
            quantity: sql<number>`sum(${wbStocksDailyProducts.quantity})`.mapWith(Number),
            inWayToClient: sql<number>`sum(${wbStocksDailyProducts.inWayToClient})`.mapWith(Number),
            inWayFromClient: sql<number>`sum(${wbStocksDailyProducts.inWayFromClient})`.mapWith(Number),
          })
          .from(wbStocksDailyProducts)
          .where(
            and(
              eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbStocksDailyProducts.shopId, shopId),
              gte(wbStocksDailyProducts.date, prevFrom),
              lte(wbStocksDailyProducts.date, prevTo),
              inArray(wbStocksDailyProducts.nmId, filteredNmIds as any)
            )
          )
          .groupBy(wbStocksDailyProducts.date)
      : await db
          .select({
            date: wbStocksDailyProducts.date,
            quantity: sql<number>`sum(${wbStocksDailyProducts.quantity})`.mapWith(Number),
            inWayToClient: sql<number>`sum(${wbStocksDailyProducts.inWayToClient})`.mapWith(Number),
            inWayFromClient: sql<number>`sum(${wbStocksDailyProducts.inWayFromClient})`.mapWith(Number),
          })
          .from(wbStocksDailyProducts)
          .where(
            and(
              eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbStocksDailyProducts.shopId, shopId),
              gte(wbStocksDailyProducts.date, prevFrom),
              lte(wbStocksDailyProducts.date, prevTo)
            )
          )
          .groupBy(wbStocksDailyProducts.date);

    const cogsRows = await db
      .select({ nmId: wbCogs.nmId, cogsKopecks: wbCogs.cogsKopecks })
      .from(wbCogs)
      .where(
        filteredNmIds
          ? and(eq(wbCogs.workspaceId, params.workspaceId), inArray(wbCogs.nmId, filteredNmIds as any))
          : eq(wbCogs.workspaceId, params.workspaceId)
      );
    const cogsByNm = new Map<number, number>(cogsRows.map((r) => [Number(r.nmId), Number(r.cogsKopecks ?? 0)] as const));

    const cogsCostByDate = new Map<string, number>();
    const stockValueByDate = new Map<string, number>();
    const prevCogsCostByDate = new Map<string, number>();
    const prevStockValueByDate = new Map<string, number>();

    if (cogsByNm.size) {
      const cogsFunnelRows = await db
        .select({ date: wbFunnelDailyProducts.date, nmId: wbFunnelDailyProducts.nmId, buyoutCount: wbFunnelDailyProducts.buyoutCount })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, from),
            lte(wbFunnelDailyProducts.date, to),
            ...(filteredNmIds ? [inArray(wbFunnelDailyProducts.nmId, filteredNmIds as any)] : [])
          )
        );
      for (const r of cogsFunnelRows) {
        const cogs = cogsByNm.get(Number(r.nmId)) ?? 0;
        if (!cogs) continue;
        const k = String(r.date);
        const v = Number(r.buyoutCount ?? 0) * cogs;
        cogsCostByDate.set(k, (cogsCostByDate.get(k) ?? 0) + v);
      }

      const prevCogsRows = await db
        .select({ date: wbFunnelDailyProducts.date, nmId: wbFunnelDailyProducts.nmId, buyoutCount: wbFunnelDailyProducts.buyoutCount })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, prevFrom),
            lte(wbFunnelDailyProducts.date, prevTo),
            ...(filteredNmIds ? [inArray(wbFunnelDailyProducts.nmId, filteredNmIds as any)] : [])
          )
        );
      for (const r of prevCogsRows) {
        const cogs = cogsByNm.get(Number(r.nmId)) ?? 0;
        if (!cogs) continue;
        const k = String(r.date);
        const v = Number(r.buyoutCount ?? 0) * cogs;
        prevCogsCostByDate.set(k, (prevCogsCostByDate.get(k) ?? 0) + v);
      }

      const stockValueRows = await db
        .select({
          date: wbStocksDailyProducts.date,
          nmId: wbStocksDailyProducts.nmId,
          quantity: wbStocksDailyProducts.quantity,
          inWayToClient: wbStocksDailyProducts.inWayToClient,
          inWayFromClient: wbStocksDailyProducts.inWayFromClient,
        })
        .from(wbStocksDailyProducts)
        .where(
          and(
            eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbStocksDailyProducts.shopId, shopId),
            gte(wbStocksDailyProducts.date, from),
            lte(wbStocksDailyProducts.date, to),
            ...(filteredNmIds ? [inArray(wbStocksDailyProducts.nmId, filteredNmIds as any)] : [])
          )
        );
      for (const r of stockValueRows) {
        const cogs = cogsByNm.get(Number(r.nmId)) ?? 0;
        if (!cogs) continue;
        const qty = Number(r.quantity ?? 0) + Number(r.inWayToClient ?? 0) + Number(r.inWayFromClient ?? 0);
        const k = String(r.date);
        const v = qty * cogs;
        stockValueByDate.set(k, (stockValueByDate.get(k) ?? 0) + v);
      }

      const prevStockValueRows = await db
        .select({
          date: wbStocksDailyProducts.date,
          nmId: wbStocksDailyProducts.nmId,
          quantity: wbStocksDailyProducts.quantity,
          inWayToClient: wbStocksDailyProducts.inWayToClient,
          inWayFromClient: wbStocksDailyProducts.inWayFromClient,
        })
        .from(wbStocksDailyProducts)
        .where(
          and(
            eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbStocksDailyProducts.shopId, shopId),
            gte(wbStocksDailyProducts.date, prevFrom),
            lte(wbStocksDailyProducts.date, prevTo),
            ...(filteredNmIds ? [inArray(wbStocksDailyProducts.nmId, filteredNmIds as any)] : [])
          )
        );
      for (const r of prevStockValueRows) {
        const cogs = cogsByNm.get(Number(r.nmId)) ?? 0;
        if (!cogs) continue;
        const qty = Number(r.quantity ?? 0) + Number(r.inWayToClient ?? 0) + Number(r.inWayFromClient ?? 0);
        const k = String(r.date);
        const v = qty * cogs;
        prevStockValueByDate.set(k, (prevStockValueByDate.get(k) ?? 0) + v);
      }
    }

    // Prev funnel totals — use per-product table when shopId or product filter is set
    const prevFunnelSelect = {
      viewCount: sql<number>`sum(${wbFunnelDailyProducts.viewCount})`.mapWith(Number),
      openCardCount: sql<number>`sum(${wbFunnelDailyProducts.openCardCount})`.mapWith(Number),
      addToCartCount: sql<number>`sum(${wbFunnelDailyProducts.addToCartCount})`.mapWith(Number),
      addToWishlistCount: sql<number>`sum(${wbFunnelDailyProducts.addToWishlistCount})`.mapWith(Number),
      orderCount: sql<number>`sum(${wbFunnelDailyProducts.orderCount})`.mapWith(Number),
      orderSum: sql<number>`sum(${wbFunnelDailyProducts.orderSum})`.mapWith(Number),
      buyoutCount: sql<number>`sum(${wbFunnelDailyProducts.buyoutCount})`.mapWith(Number),
      buyoutSum: sql<number>`sum(${wbFunnelDailyProducts.buyoutSum})`.mapWith(Number),
      cancelCount: sql<number>`sum(${wbFunnelDailyProducts.cancelCount})`.mapWith(Number),
      cancelSum: sql<number>`sum(${wbFunnelDailyProducts.cancelSum})`.mapWith(Number),
    };
    const prevFunnelTotalsRows = (filteredNmIds || shopId)
      ? await db
          .select(prevFunnelSelect)
          .from(wbFunnelDailyProducts)
          .where(
            and(
              eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
              gte(wbFunnelDailyProducts.date, prevFrom),
              lte(wbFunnelDailyProducts.date, prevTo),
              filteredNmIds ? inArray(wbFunnelDailyProducts.nmId, filteredNmIds as any) : undefined
            )
          )
      : await db
          .select({
            viewCount: sql<number>`sum(${wbFunnelDaily.viewCount})`.mapWith(Number),
            openCardCount: sql<number>`sum(${wbFunnelDaily.openCardCount})`.mapWith(Number),
            addToCartCount: sql<number>`sum(${wbFunnelDaily.addToCartCount})`.mapWith(Number),
            addToWishlistCount: sql<number>`sum(${wbFunnelDaily.addToWishlistCount})`.mapWith(Number),
            orderCount: sql<number>`sum(${wbFunnelDaily.orderCount})`.mapWith(Number),
            orderSum: sql<number>`sum(${wbFunnelDaily.orderSum})`.mapWith(Number),
            buyoutCount: sql<number>`sum(${wbFunnelDaily.buyoutCount})`.mapWith(Number),
            buyoutSum: sql<number>`sum(${wbFunnelDaily.buyoutSum})`.mapWith(Number),
            cancelCount: sql<number>`sum(${wbFunnelDaily.cancelCount})`.mapWith(Number),
            cancelSum: sql<number>`sum(${wbFunnelDaily.cancelSum})`.mapWith(Number),
          })
          .from(wbFunnelDaily)
          .where(
            and(
              eq(wbFunnelDaily.workspaceId, params.workspaceId),
              eq(wbFunnelDaily.source, 'products'),
              gte(wbFunnelDaily.date, prevFrom),
              lte(wbFunnelDaily.date, prevTo)
            )
          );

    const prevFunnelTotals = prevFunnelTotalsRows[0] ?? {
      viewCount: 0,
      openCardCount: 0,
      addToCartCount: 0,
      addToWishlistCount: 0,
      orderCount: 0,
      orderSum: 0,
      buyoutCount: 0,
      buyoutSum: 0,
      cancelCount: 0,
      cancelSum: 0,
    };

    const ordersCount = rows.reduce((acc, r) => acc + r.ordersCount, 0);
    const salesCount = rows.reduce((acc, r) => acc + r.salesCount, 0);
    const salesKopecks = rows.reduce((acc, r) => acc + r.salesRub, 0);
    const ordersKopecks = rows.reduce((acc, r) => acc + (r.ordersRub ?? 0), 0);
    const discountPercentSumBp = rows.reduce((acc, r) => acc + (r.discountPercentSumBp ?? 0), 0);
    const finishedPriceKopecks = rows.reduce((acc, r) => acc + (r.finishedPriceRub ?? 0), 0);

    const advKopecks = advRows.reduce((acc, r) => acc + (r.spendKopecks ?? 0), 0);

    const revenueKopecks = finRows.reduce((acc, r) => acc + ((r as any).revenueKopecks ?? 0), 0);
    const payoutKopecks = finRows.reduce((acc, r) => acc + (r.payoutKopecks ?? 0), 0);
    // Комиссия = revenue - payout (исправлено по методологии Torgstat)
    const commissionKopecks = finRows.reduce((acc, r) => acc + (r.commissionKopecks ?? 0), 0);
    const logisticsKopecks = finRows.reduce((acc, r) => acc + (r.logisticsKopecks ?? 0), 0);
    const returnLogisticsKopecks = finRows.reduce((acc, r) => acc + (r.returnLogisticsKopecks ?? 0), 0);
    const paidAcceptanceKopecks = finRows.reduce((acc, r) => acc + (r.paidAcceptanceKopecks ?? 0), 0);
    const storageKopecks = finRows.reduce((acc, r) => acc + (r.storageKopecks ?? 0), 0);
    const penaltyKopecks = finRows.reduce((acc, r) => acc + (r.penaltyKopecks ?? 0), 0);
    const otherHoldKopecks = finRows.reduce((acc, r) => acc + (r.otherHoldKopecks ?? 0), 0);
    const acquiringKopecks = finRows.reduce((acc, r) => acc + (r.acquiringKopecks ?? 0), 0);
    const additionalPaymentKopecks = finRows.reduce((acc, r) => acc + (r.additionalPaymentKopecks ?? 0), 0);
    const returnsCount = finRows.reduce((acc, r) => acc + (r.returnsCount ?? 0), 0);

    const marketplaceCostsKopecks =
      logisticsKopecks + returnLogisticsKopecks + paidAcceptanceKopecks + storageKopecks + penaltyKopecks + otherHoldKopecks + acquiringKopecks;

    let marginKopecks: number;
    let netProfitKopecks: number;
    let isMarginEstimated = false;

    if (finRows.length > 0) {
      // Точные данные из финансовых отчётов WB
      marginKopecks = payoutKopecks + additionalPaymentKopecks - marketplaceCostsKopecks;
      netProfitKopecks = marginKopecks - advKopecks;
    } else if (ordersKopecks > 0) {
      // Оценочная маржа ПО КАЖДОМУ ТОВАРУ: WB ещё не сформировал финансовый отчёт.
      // Для каждого nmId берём реальную комиссию по категории товара из WB тарифов.
      isMarginEstimated = true;

      // 1. Загрузить тарифы WB (кэшированы на 6 часов)
      let commissionMap = new Map<number, number>(); // subjectId → commissionRate
      try {
        const { getCommissionTariffs, pickCommissionPercent } = await import('../integrations/wb/tariffs.js');
        const tariffs = await getCommissionTariffs('ru');
        for (const t of tariffs) {
          const rate = pickCommissionPercent(t, 'marketplace'); // FBO default, TODO: read from shop settings
          const subjectId = t.subjectID ?? 0;
          if (Number.isFinite(subjectId) && subjectId > 0 && rate != null) {
            commissionMap.set(subjectId, rate);
          }
        }
      } catch { /* fallback ниже */ }

      // 2. Получить заказы по товарам за период
      const productOrders = await db
        .select({
          nmId: wbOrdersSalesDailyProducts.nmId,
          ordersCount: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersCount})`.mapWith(Number),
          ordersRub: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersRub})`.mapWith(Number),
        })
        .from(wbOrdersSalesDailyProducts)
        .where(and(
          eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId),
          buildShopFilter(wbOrdersSalesDailyProducts.shopId, shopId),
          gte(wbOrdersSalesDailyProducts.date, from),
          lte(wbOrdersSalesDailyProducts.date, to),
        ))
        .groupBy(wbOrdersSalesDailyProducts.nmId);

      // 3. Получить subjectId для каждого nmId
      const nmIds = productOrders.map(p => Number(p.nmId)).filter(n => n > 0);
      const cardSubjects = nmIds.length > 0
        ? await db
            .select({ nmId: wbCards.nmId, subjectId: wbCards.subjectId })
            .from(wbCards)
            .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds as any)))
        : [];
      const subjectByNm = new Map(cardSubjects.map(c => [Number(c.nmId), c.subjectId]));

      // 4. Получить COGS по товарам
      const cogsRows = nmIds.length > 0
        ? await db
            .select({ nmId: wbCogs.nmId, cogsKopecks: wbCogs.cogsKopecks })
            .from(wbCogs)
            .where(and(eq(wbCogs.workspaceId, params.workspaceId), inArray(wbCogs.nmId, nmIds as any)))
        : [];
      const cogsByNm = new Map(cogsRows.map(c => [Number(c.nmId), Number(c.cogsKopecks)]));

      // 5. Рассчитать маржу по каждому товару
      let totalEstMargin = 0;
      const DEFAULT_COMMISSION = 0.17; // 17% fallback
      const LOGISTICS_PER_UNIT = 10000; // 100₽ в копейках
      const ACQUIRING_RATE = 0.02; // 2%

      for (const p of productOrders) {
        const nm = Number(p.nmId);
        const subjectId = subjectByNm.get(nm);
        const commRate = (subjectId && commissionMap.get(subjectId)) ?? DEFAULT_COMMISSION;
        const cogsPerUnit = cogsByNm.get(nm) ?? 0;

        const revenue = p.ordersRub;
        const commission = Math.round(revenue * commRate);
        const logistics = p.ordersCount * LOGISTICS_PER_UNIT;
        const acquiring = Math.round(revenue * ACQUIRING_RATE);
        const cogs = cogsPerUnit * p.ordersCount;

        const productMargin = revenue - commission - logistics - acquiring - cogs;
        totalEstMargin += productMargin;
      }

      marginKopecks = totalEstMargin;
      netProfitKopecks = marginKopecks - advKopecks;

    } else {
      marginKopecks = 0;
      netProfitKopecks = 0;
    }

    // prev
    const prevOrdersCount = prevRows.reduce((acc, r) => acc + r.ordersCount, 0);
    const prevSalesCount = prevRows.reduce((acc, r) => acc + r.salesCount, 0);
    const prevSalesKopecks = prevRows.reduce((acc, r) => acc + r.salesRub, 0);
    const prevOrdersKopecks = prevRows.reduce((acc, r) => acc + (r.ordersRub ?? 0), 0);
    const prevDiscountPercentSumBp = prevRows.reduce((acc, r) => acc + (r.discountPercentSumBp ?? 0), 0);
    const prevFinishedPriceKopecks = prevRows.reduce((acc, r) => acc + (r.finishedPriceRub ?? 0), 0);
    const prevReturnsCount = prevFinRows.reduce((acc, r) => acc + (r.returnsCount ?? 0), 0);

    const prevAdvKopecks = prevAdvRows.reduce((acc, r) => acc + (r.spendKopecks ?? 0), 0);
    const prevAdvViews = prevAdvRows.reduce((acc, r) => acc + (r.viewsCount ?? 0), 0);
    const prevAdvClicks = prevAdvRows.reduce((acc, r) => acc + (r.clicksCount ?? 0), 0);
    const prevAdvAtbs = prevAdvRows.reduce((acc, r) => acc + (r.atbsCount ?? 0), 0);
    const prevAdvOrders = prevAdvRows.reduce((acc, r) => acc + (r.ordersCount ?? 0), 0);
    const prevAdvSumPriceKopecks = prevAdvRows.reduce((acc, r) => acc + (r.sumPriceKopecks ?? 0), 0);

    const prevPayoutKopecks = prevFinRows.reduce((acc, r) => acc + (r.payoutKopecks ?? 0), 0);
    const prevCommissionKopecks = prevFinRows.reduce((acc, r) => acc + (r.commissionKopecks ?? 0), 0);
    const prevLogisticsKopecks = prevFinRows.reduce((acc, r) => acc + (r.logisticsKopecks ?? 0), 0);
    const prevReturnLogisticsKopecks = prevFinRows.reduce((acc, r) => acc + (r.returnLogisticsKopecks ?? 0), 0);
    const prevPaidAcceptanceKopecks = prevFinRows.reduce((acc, r) => acc + (r.paidAcceptanceKopecks ?? 0), 0);
    const prevStorageKopecks = prevFinRows.reduce((acc, r) => acc + (r.storageKopecks ?? 0), 0);
    const prevPenaltyKopecks = prevFinRows.reduce((acc, r) => acc + (r.penaltyKopecks ?? 0), 0);
    const prevOtherHoldKopecks = prevFinRows.reduce((acc, r) => acc + (r.otherHoldKopecks ?? 0), 0);
    const prevAcquiringKopecks = prevFinRows.reduce((acc, r) => acc + (r.acquiringKopecks ?? 0), 0);
    const prevAdditionalPaymentKopecks = prevFinRows.reduce((acc, r) => acc + (r.additionalPaymentKopecks ?? 0), 0);

    const prevMarketplaceCostsKopecks =
      prevLogisticsKopecks + prevReturnLogisticsKopecks + prevPaidAcceptanceKopecks + prevStorageKopecks + prevPenaltyKopecks + prevOtherHoldKopecks + prevAcquiringKopecks;

    const prevMarginKopecks = prevPayoutKopecks + prevAdditionalPaymentKopecks - prevMarketplaceCostsKopecks;
    const prevNetProfitKopecks = prevMarginKopecks - prevAdvKopecks;

    const prevPriceNoSppRub = prevOrdersCount > 0 ? Math.round(((prevOrdersKopecks / 100) / prevOrdersCount) * 100) / 100 : 0;
    const prevPriceWithSppRub =
      prevOrdersCount > 0 ? Math.round(((prevFinishedPriceKopecks / 100) / prevOrdersCount) * 100) / 100 : 0;
    const prevSppPercent = prevOrdersCount > 0 ? Math.round(((prevDiscountPercentSumBp / prevOrdersCount) / 100) * 100) / 100 : 0;

    const prevViewCount = prevFunnelTotals.viewCount ?? 0;
    const prevOpenCardCount = prevFunnelTotals.openCardCount ?? 0;
    const prevAddToCartCount = prevFunnelTotals.addToCartCount ?? 0;
    const prevAddToWishlistCount = prevFunnelTotals.addToWishlistCount ?? 0;
    const prevBuyoutCount = prevFunnelTotals.buyoutCount ?? 0;
    const prevOrderCount = prevFunnelTotals.orderCount ?? 0;
    const prevOrderSum = prevFunnelTotals.orderSum ?? 0;
    // Use WB Funnel API for prev period orders too
    const prevFunnelKpi = await prevFunnelKpiPromise;
    const prevOrdersRub = prevFunnelKpi ? prevFunnelKpi.ordersRub : Math.round((prevOrdersKopecks / 100) * 100) / 100;
    const prevEffectiveOrdersCount = prevFunnelKpi ? prevFunnelKpi.ordersCount : prevOrdersCount;
    const prevBuyoutSumRub = Math.round((prevFunnelTotals.buyoutSum ?? 0) * 100) / 100;
    const prevCancelCount = prevFunnelTotals.cancelCount ?? 0;
    const prevCancelSumRub = Math.round((prevFunnelTotals.cancelSum ?? 0) * 100) / 100;
    const prevBuyoutPercent = prevOrderCount > 0 ? (prevBuyoutCount / prevOrderCount) * 100 : 0;
    const prevViewToOpen = prevViewCount > 0 ? (prevOpenCardCount / prevViewCount) * 100 : 0;
    const prevOpenToCart = prevOpenCardCount > 0 ? (prevAddToCartCount / prevOpenCardCount) * 100 : 0;
    const prevCartToOrder = prevAddToCartCount > 0 ? (prevOrderCount / prevAddToCartCount) * 100 : 0;

    const prevForecastSalesCount = prevOrderCount > 0 ? Math.round((prevOrderCount * prevBuyoutPercent) / 100) : 0;
    const prevForecastSalesRub = prevOrderCount > 0 ? Math.round((prevOrderSum * prevBuyoutPercent) / 100 * 100) / 100 : 0;

    const prevCogsKopecksTotal = Array.from(prevCogsCostByDate.values()).reduce((acc, v) => acc + v, 0);
    const prevCogsPerUnitRub = prevBuyoutCount > 0 ? prevCogsKopecksTotal / prevBuyoutCount / 100 : 0;
    const prevMarginPerUnitRub = prevBuyoutCount > 0 ? prevMarginKopecks / prevBuyoutCount / 100 : 0;
    const prevMarginPercent = prevOrdersKopecks > 0 ? (prevMarginKopecks / prevOrdersKopecks) * 100 : 0;
    const prevMarkupX = prevCogsPerUnitRub > 0 ? prevPriceNoSppRub / prevCogsPerUnitRub : 0;

    const prevLatestStock = prevStockRows.reduce((acc, r) => (!acc || r.date > acc.date ? r : acc), null as any);
    const prevStockQty = prevLatestStock?.quantity ?? 0;
    const prevStockInWayTo = prevLatestStock?.inWayToClient ?? 0;
    const prevStockInWayFrom = prevLatestStock?.inWayFromClient ?? 0;
    const prevStockMoneyRub = prevLatestStock ? (prevStockValueByDate.get(prevLatestStock.date) ?? 0) / 100 : 0;

    const prevDailySales = lenDays > 0 ? prevSalesCount / lenDays : 0;
    const prevTurnoverDays = prevDailySales > 0 ? prevStockQty / prevDailySales : 0;

    const prevAdvSpendRub = Math.round((prevAdvKopecks / 100) * 100) / 100;
    const prevAdvOrdersRub = prevAdvSumPriceKopecks / 100;
    const prevDrrForecastPercent = prevForecastSalesRub > 0 ? (prevAdvSpendRub / prevForecastSalesRub) * 100 : 0;
    const prevDrrOrdersPercent = prevOrdersRub > 0 ? (prevAdvSpendRub / prevOrdersRub) * 100 : 0;
    const prevDrrAdsPercent = prevAdvOrdersRub > 0 ? (prevAdvSpendRub / prevAdvOrdersRub) * 100 : 0;

    // Tax cannot be negative (no refund for losses)
    const prevTaxKopecks = Math.max(0, Math.round((prevPayoutKopecks - prevMarketplaceCostsKopecks - prevCogsKopecksTotal) * taxRate));
    const prevRoiPercent =
      prevMarketplaceCostsKopecks + prevCogsKopecksTotal + prevTaxKopecks > 0
        ? (prevPayoutKopecks / (prevMarketplaceCostsKopecks + prevCogsKopecksTotal + prevTaxKopecks)) * 100
        : 0;

    const drrSalesPercent = salesKopecks > 0 ? (advKopecks / salesKopecks) * 100 : 0;
    const drrPayoutPercent = payoutKopecks > 0 ? (advKopecks / payoutKopecks) * 100 : 0;

    const drrBase = query.drrBase ?? 'sales';
    const drrPercent = drrBase === 'payout' ? drrPayoutPercent : drrSalesPercent;

    // reuse availability logic for funnel products
    const prodDates = await db
      .select({ date: wbFunnelDaily.date })
      .from(wbFunnelDaily)
      .where(and(eq(wbFunnelDaily.workspaceId, params.workspaceId), eq(wbFunnelDaily.source, 'products')));
    const set = new Set(prodDates.map((r) => r.date));
    let availableDays = 0;
    for (let i = 0; i <= 90; i++) {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      if (!set.has(key)) break;
      availableDays++;
    }

    function weekStart(iso: string): string {
      const d = new Date(iso + 'T00:00:00Z');
      // Monday as week start
      const day = (d.getUTCDay() + 6) % 7; // 0=Mon
      d.setUTCDate(d.getUTCDate() - day);
      return d.toISOString().slice(0, 10);
    }

    type Bucket = {
      key: string;
      days: number;
      ordersCount: number;
      salesCount: number;
      salesKopecks: number;
      ordersKopecks: number;
      discountPercentSumBp: number;
      finishedPriceKopecks: number;

      advKopecks: number;
      advViews: number;
      advClicks: number;
      advAtbs: number;
      advOrders: number;
      advSumPriceKopecks: number;
      advManualKopecks: number;
      advManualViews: number;
      advManualClicks: number;
      advManualAtbs: number;
      advManualOrders: number;
      advManualSumPriceKopecks: number;
      advUnifiedKopecks: number;
      advUnifiedViews: number;
      advUnifiedClicks: number;
      advUnifiedAtbs: number;
      advUnifiedOrders: number;
      advUnifiedSumPriceKopecks: number;

      payoutKopecks: number;
      commissionKopecks: number;
      logisticsKopecks: number;
      returnLogisticsKopecks: number;
      paidAcceptanceKopecks: number;
      storageKopecks: number;
      penaltyKopecks: number;
      otherHoldKopecks: number;
      acquiringKopecks: number;
      additionalPaymentKopecks: number;
      returnsCount: number;

      marketplaceCostsKopecks: number;
      marginKopecks: number;
      netProfitKopecks: number;
      cogsKopecks: number;
      taxKopecks: number;

      // stocks
      stockQty: number;
      stockInWayTo: number;
      stockInWayFrom: number;
      stockValueKopecks: number;

      // funnel
      viewCount: number;
      openCardCount: number;
      addToCartCount: number;
      addToWishlistCount: number;
      orderCount: number;
      buyoutCount: number;
      orderSum: number;
      buyoutSum: number;
      cancelCount: number;
      cancelSum: number;
    };

    const rowByDate = new Map(rows.map((r) => [r.date, r] as const));
    const advByDate = new Map(advRows.map((r) => [r.date, r] as const));
    const finByDate = new Map(finRows.map((r) => [r.date, r] as const));
    const stockByDate = new Map(stockRows.map((r) => [r.date, r] as const));

    type FunnelAgg = {
      viewCount: number;
      openCardCount: number;
      addToCartCount: number;
      addToWishlistCount: number;
      orderCount: number;
      orderSum: number;
      buyoutCount: number;
      buyoutSum: number;
      cancelCount: number;
      cancelSum: number;
    };

    const funnelByDate = new Map<string, FunnelAgg>();

    if (filteredNmIds) {
      const fRows = await db
        .select({
          date: wbFunnelDailyProducts.date,
          viewCount: wbFunnelDailyProducts.viewCount,
          openCardCount: wbFunnelDailyProducts.openCardCount,
          addToCartCount: wbFunnelDailyProducts.addToCartCount,
          addToWishlistCount: wbFunnelDailyProducts.addToWishlistCount,
          orderCount: wbFunnelDailyProducts.orderCount,
          orderSum: wbFunnelDailyProducts.orderSum,
          buyoutCount: wbFunnelDailyProducts.buyoutCount,
          buyoutSum: wbFunnelDailyProducts.buyoutSum,
          cancelCount: wbFunnelDailyProducts.cancelCount,
          cancelSum: wbFunnelDailyProducts.cancelSum,
        })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, from),
            lte(wbFunnelDailyProducts.date, to),
            inArray(wbFunnelDailyProducts.nmId, filteredNmIds as any)
          )
        );

      for (const r of fRows) {
        const k = String(r.date);
        const cur = funnelByDate.get(k) ?? {
          viewCount: 0,
          openCardCount: 0,
          addToCartCount: 0,
          addToWishlistCount: 0,
          orderCount: 0,
          orderSum: 0,
          buyoutCount: 0,
          buyoutSum: 0,
          cancelCount: 0,
          cancelSum: 0,
        };
        cur.viewCount += Number(r.viewCount ?? 0);
        cur.openCardCount += Number(r.openCardCount ?? 0);
        cur.addToCartCount += Number(r.addToCartCount ?? 0);
        cur.addToWishlistCount += Number(r.addToWishlistCount ?? 0);
        cur.orderCount += Number(r.orderCount ?? 0);
        cur.orderSum += Number(r.orderSum ?? 0);
        cur.buyoutCount += Number(r.buyoutCount ?? 0);
        cur.buyoutSum += Number(r.buyoutSum ?? 0);
        cur.cancelCount += Number(r.cancelCount ?? 0);
        cur.cancelSum += Number(r.cancelSum ?? 0);
        funnelByDate.set(k, cur);
      }
    } else if (shopId) {
      // When shopId is set, use per-product table for accurate shop isolation
      // (aggregate wbFunnelDaily has PK without shopId)
      const fRows = await db
        .select({
          date: wbFunnelDailyProducts.date,
          viewCount: sql<number>`sum(${wbFunnelDailyProducts.viewCount})`.mapWith(Number),
          openCardCount: sql<number>`sum(${wbFunnelDailyProducts.openCardCount})`.mapWith(Number),
          addToCartCount: sql<number>`sum(${wbFunnelDailyProducts.addToCartCount})`.mapWith(Number),
          addToWishlistCount: sql<number>`sum(${wbFunnelDailyProducts.addToWishlistCount})`.mapWith(Number),
          orderCount: sql<number>`sum(${wbFunnelDailyProducts.orderCount})`.mapWith(Number),
          orderSum: sql<number>`sum(${wbFunnelDailyProducts.orderSum})`.mapWith(Number),
          buyoutCount: sql<number>`sum(${wbFunnelDailyProducts.buyoutCount})`.mapWith(Number),
          buyoutSum: sql<number>`sum(${wbFunnelDailyProducts.buyoutSum})`.mapWith(Number),
          cancelCount: sql<number>`sum(${wbFunnelDailyProducts.cancelCount})`.mapWith(Number),
          cancelSum: sql<number>`sum(${wbFunnelDailyProducts.cancelSum})`.mapWith(Number),
        })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, from),
            lte(wbFunnelDailyProducts.date, to)
          )
        )
        .groupBy(wbFunnelDailyProducts.date);

      for (const r of fRows) {
        funnelByDate.set(String(r.date), {
          viewCount: Number(r.viewCount ?? 0),
          openCardCount: Number(r.openCardCount ?? 0),
          addToCartCount: Number(r.addToCartCount ?? 0),
          addToWishlistCount: Number(r.addToWishlistCount ?? 0),
          orderCount: Number(r.orderCount ?? 0),
          orderSum: Number(r.orderSum ?? 0),
          buyoutCount: Number(r.buyoutCount ?? 0),
          buyoutSum: Number(r.buyoutSum ?? 0),
          cancelCount: Number(r.cancelCount ?? 0),
          cancelSum: Number(r.cancelSum ?? 0),
        });
      }
    } else {
      const fRows = await db
        .select({
          date: wbFunnelDaily.date,
          viewCount: wbFunnelDaily.viewCount,
          openCardCount: wbFunnelDaily.openCardCount,
          addToCartCount: wbFunnelDaily.addToCartCount,
          addToWishlistCount: wbFunnelDaily.addToWishlistCount,
          orderCount: wbFunnelDaily.orderCount,
          orderSum: wbFunnelDaily.orderSum,
          buyoutCount: wbFunnelDaily.buyoutCount,
          buyoutSum: wbFunnelDaily.buyoutSum,
          cancelCount: wbFunnelDaily.cancelCount,
          cancelSum: wbFunnelDaily.cancelSum,
        })
        .from(wbFunnelDaily)
        .where(
          and(
            eq(wbFunnelDaily.workspaceId, params.workspaceId),
            eq(wbFunnelDaily.source, 'products'),
            gte(wbFunnelDaily.date, from),
            lte(wbFunnelDaily.date, to)
          )
        );

      for (const r of fRows) {
        funnelByDate.set(String(r.date), {
          viewCount: Number(r.viewCount ?? 0),
          openCardCount: Number(r.openCardCount ?? 0),
          addToCartCount: Number(r.addToCartCount ?? 0),
          addToWishlistCount: Number(r.addToWishlistCount ?? 0),
          orderCount: Number(r.orderCount ?? 0),
          orderSum: Number(r.orderSum ?? 0),
          buyoutCount: Number(r.buyoutCount ?? 0),
          buyoutSum: Number(r.buyoutSum ?? 0),
          cancelCount: Number(r.cancelCount ?? 0),
          cancelSum: Number(r.cancelSum ?? 0),
        });
      }
    }

    // series keys
    const keys: string[] = [];
    for (let dt = new Date(from + 'T00:00:00Z'); dt <= new Date(to + 'T00:00:00Z'); ) {
      const iso = dt.toISOString().slice(0, 10);
      keys.push(groupBy === 'week' ? weekStart(iso) : iso);
      dt.setUTCDate(dt.getUTCDate() + 1);
    }
    const uniqueKeys = Array.from(new Set(keys)).sort();

    const buckets = new Map<string, Bucket>();
    for (const k of uniqueKeys) {
      buckets.set(k, {
        key: k,
        days: 0,
        ordersCount: 0,
        salesCount: 0,
        salesKopecks: 0,
        ordersKopecks: 0,
        discountPercentSumBp: 0,
        finishedPriceKopecks: 0,

        advKopecks: 0,
        advViews: 0,
        advClicks: 0,
        advAtbs: 0,
        advOrders: 0,
        advSumPriceKopecks: 0,
        advManualKopecks: 0,
        advManualViews: 0,
        advManualClicks: 0,
        advManualAtbs: 0,
        advManualOrders: 0,
        advManualSumPriceKopecks: 0,
        advUnifiedKopecks: 0,
        advUnifiedViews: 0,
        advUnifiedClicks: 0,
        advUnifiedAtbs: 0,
        advUnifiedOrders: 0,
        advUnifiedSumPriceKopecks: 0,

        payoutKopecks: 0,
        commissionKopecks: 0,
        logisticsKopecks: 0,
        returnLogisticsKopecks: 0,
        paidAcceptanceKopecks: 0,
        storageKopecks: 0,
        penaltyKopecks: 0,
        otherHoldKopecks: 0,
        acquiringKopecks: 0,
        additionalPaymentKopecks: 0,
        returnsCount: 0,

        marketplaceCostsKopecks: 0,
        marginKopecks: 0,
        netProfitKopecks: 0,
        cogsKopecks: 0,
        taxKopecks: 0,

        stockQty: 0,
        stockInWayTo: 0,
        stockInWayFrom: 0,
        stockValueKopecks: 0,

        viewCount: 0,
        openCardCount: 0,
        addToCartCount: 0,
        addToWishlistCount: 0,
        orderCount: 0,
        buyoutCount: 0,
        orderSum: 0,
        buyoutSum: 0,
        cancelCount: 0,
        cancelSum: 0,
      });
    }

    for (let dt = new Date(from + 'T00:00:00Z'); dt <= new Date(to + 'T00:00:00Z'); ) {
      const iso = dt.toISOString().slice(0, 10);
      const k = groupBy === 'week' ? weekStart(iso) : iso;
      const b = buckets.get(k)!;
      b.days += 1;

      const r = rowByDate.get(iso);
      if (r) {
        b.ordersCount += r.ordersCount;
        b.salesCount += r.salesCount;
        b.salesKopecks += r.salesRub;
        b.ordersKopecks += r.ordersRub ?? 0;
        b.discountPercentSumBp += r.discountPercentSumBp ?? 0;
        b.finishedPriceKopecks += r.finishedPriceRub ?? 0;
      }

      const a = advByDate.get(iso);
      if (a) {
        b.advKopecks += a.spendKopecks ?? 0;
        b.advViews += a.viewsCount ?? 0;
        b.advClicks += a.clicksCount ?? 0;
        b.advAtbs += a.atbsCount ?? 0;
        b.advOrders += a.ordersCount ?? 0;
        b.advSumPriceKopecks += a.sumPriceKopecks ?? 0;

        b.advManualKopecks += a.spendManualKopecks ?? 0;
        b.advManualViews += a.viewsManualCount ?? 0;
        b.advManualClicks += a.clicksManualCount ?? 0;
        b.advManualAtbs += a.atbsManualCount ?? 0;
        b.advManualOrders += a.ordersManualCount ?? 0;
        b.advManualSumPriceKopecks += a.sumPriceManualKopecks ?? 0;

        b.advUnifiedKopecks += a.spendUnifiedKopecks ?? 0;
        b.advUnifiedViews += a.viewsUnifiedCount ?? 0;
        b.advUnifiedClicks += a.clicksUnifiedCount ?? 0;
        b.advUnifiedAtbs += a.atbsUnifiedCount ?? 0;
        b.advUnifiedOrders += a.ordersUnifiedCount ?? 0;
        b.advUnifiedSumPriceKopecks += a.sumPriceUnifiedKopecks ?? 0;
      }

      const f = finByDate.get(iso);
      if (f) {
        const payout = f.payoutKopecks ?? 0;
        const additional = f.additionalPaymentKopecks ?? 0;
        const commission = f.commissionKopecks ?? 0;
        const logistics = f.logisticsKopecks ?? 0;
        const returnLogistics = f.returnLogisticsKopecks ?? 0;
        const paidAcceptance = f.paidAcceptanceKopecks ?? 0;
        const storage = f.storageKopecks ?? 0;
        const penalty = f.penaltyKopecks ?? 0;
        const otherHold = f.otherHoldKopecks ?? 0;
        const acquiring = f.acquiringKopecks ?? 0;
        const returns = f.returnsCount ?? 0;

        b.payoutKopecks += payout;
        b.additionalPaymentKopecks += additional;
        b.commissionKopecks += commission;
        b.logisticsKopecks += logistics;
        b.returnLogisticsKopecks += returnLogistics;
        b.paidAcceptanceKopecks += paidAcceptance;
        b.storageKopecks += storage;
        b.penaltyKopecks += penalty;
        b.otherHoldKopecks += otherHold;
        b.acquiringKopecks += acquiring;
        b.returnsCount += returns;
      }

      const st = stockByDate.get(iso);
      if (st) {
        b.stockQty += st.quantity ?? 0;
        b.stockInWayTo += st.inWayToClient ?? 0;
        b.stockInWayFrom += st.inWayFromClient ?? 0;
      }

      const cogsDay = cogsCostByDate.get(iso) ?? 0;
      if (cogsDay) b.cogsKopecks += cogsDay;

      const stockValueDay = stockValueByDate.get(iso) ?? 0;
      if (stockValueDay) b.stockValueKopecks += stockValueDay;

      const fu = funnelByDate.get(iso);
      if (fu) {
        b.viewCount += fu.viewCount;
        b.openCardCount += fu.openCardCount;
        b.addToCartCount += fu.addToCartCount;
        b.addToWishlistCount += fu.addToWishlistCount;
        b.orderCount += fu.orderCount;
        b.orderSum += fu.orderSum;
        b.buyoutCount += fu.buyoutCount;
        b.buyoutSum += fu.buyoutSum;
        b.cancelCount += fu.cancelCount ?? 0;
        b.cancelSum += fu.cancelSum ?? 0;
      }

      dt.setUTCDate(dt.getUTCDate() + 1);
    }

    const series = Array.from(buckets.values())
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((b) => {
        const viewToOpen = b.viewCount > 0 ? (b.openCardCount / b.viewCount) * 100 : 0;
        const openToCart = b.openCardCount > 0 ? (b.addToCartCount / b.openCardCount) * 100 : 0;
        const cartToOrder = b.addToCartCount > 0 ? (b.orderCount / b.addToCartCount) * 100 : 0;
        const buyoutPercent = b.orderCount > 0 ? (b.buyoutCount / b.orderCount) * 100 : 0;

        // Источник = wb_funnel_daily_products (Analytics, тот же что /plan и /finance).
        // Раньше брали из wb_orders_sales_daily_products (Statistics API) — числа
        // расходились с /plan и ЛК ВБ на 5–30%. оператор 2026-06-04: «финансовые API базовые».
        const effectiveOrdersCount = b.orderCount;
        const effectiveOrdersRub = Math.round(b.orderSum * 100) / 100;
        const ordersRub = effectiveOrdersRub;
        // priceNoSpp / priceWithSpp / sppPercent use Statistics API data (per-order discount details not available in funnel)
        const priceNoSppRub = b.ordersCount > 0 ? Math.round(((b.ordersKopecks / 100) / b.ordersCount) * 100) / 100 : 0;
        const priceWithSppRub =
          b.ordersCount > 0 ? Math.round(((b.finishedPriceKopecks / 100) / b.ordersCount) * 100) / 100 : 0;
        const sppPercent = b.ordersCount > 0 ? Math.round(((b.discountPercentSumBp / b.ordersCount) / 100) * 100) / 100 : 0;
        const buyoutSumRub = Math.round((b.buyoutSum ?? 0) * 100) / 100;
        const cancelSumRub = Math.round((b.cancelSum ?? 0) * 100) / 100;

        const forecastSalesCount = b.orderCount > 0 ? Math.round((b.orderCount * buyoutPercent) / 100) : 0;
        const forecastSalesRub = b.orderCount > 0 ? Math.round((b.orderSum * buyoutPercent) / 100 * 100) / 100 : 0;

        const marketplaceCostsKopecks =
          b.logisticsKopecks +
          b.returnLogisticsKopecks +
          b.paidAcceptanceKopecks +
          b.storageKopecks +
          b.penaltyKopecks +
          b.otherHoldKopecks +
          b.acquiringKopecks;

        const marginKopecks = b.payoutKopecks + b.additionalPaymentKopecks - marketplaceCostsKopecks;
        const netProfitKopecks = marginKopecks - b.advKopecks;

        const cogsPerUnitRub = b.buyoutCount > 0 ? b.cogsKopecks / b.buyoutCount / 100 : 0;
        const marginPerUnitRub = b.buyoutCount > 0 ? marginKopecks / b.buyoutCount / 100 : 0;
        const marginPercent = b.ordersKopecks > 0 ? (marginKopecks / b.ordersKopecks) * 100 : 0;
        const markupX = cogsPerUnitRub > 0 ? priceNoSppRub / cogsPerUnitRub : 0;

        // Tax cannot be negative (no refund for losses)
        const taxKopecks = Math.max(0, Math.round((b.payoutKopecks - marketplaceCostsKopecks - b.cogsKopecks) * taxRate));
        const roiPercent =
          marketplaceCostsKopecks + b.cogsKopecks + taxKopecks > 0
            ? (b.payoutKopecks / (marketplaceCostsKopecks + b.cogsKopecks + taxKopecks)) * 100
            : 0;

        const dailySales = b.days > 0 ? b.salesCount / b.days : 0;
        // Average stock over the period (not sum) for correct turnover calculation
        const avgStockQty = b.days > 0 ? b.stockQty / b.days : b.stockQty;
        const turnoverDays = dailySales > 0 ? avgStockQty / dailySales : 0;
        // Average stock value over the period (not sum) for correct weekly aggregation
        const avgStockValueKopecks = b.days > 0 ? b.stockValueKopecks / b.days : b.stockValueKopecks;
        const stockMoneyRub = Math.round((avgStockValueKopecks / 100) * 100) / 100;

        const advSpendRub = Math.round((b.advKopecks / 100) * 100) / 100;
        const advOrdersRub = Math.round((b.advSumPriceKopecks / 100) * 100) / 100;

        const drrForecastPercent = forecastSalesRub > 0 ? (advSpendRub / forecastSalesRub) * 100 : 0;
        const drrOrdersPercent = ordersRub > 0 ? (advSpendRub / ordersRub) * 100 : 0;
        const drrAdsPercent = advOrdersRub > 0 ? (advSpendRub / advOrdersRub) * 100 : 0;
        // Per-period DRR respecting drrBase setting (sales or payout)
        const drrSeriesSales = b.salesKopecks > 0 ? (b.advKopecks / b.salesKopecks) * 100 : 0;
        const drrSeriesPayout = b.payoutKopecks > 0 ? (b.advKopecks / b.payoutKopecks) * 100 : 0;
        const drrSeriesPercent = drrBase === 'payout' ? drrSeriesPayout : drrSeriesSales;

        const advCtrPercent = b.advViews > 0 ? (b.advClicks / b.advViews) * 100 : 0;
        const advClickToCartPercent = b.advClicks > 0 ? (b.advAtbs / b.advClicks) * 100 : 0;
        const advCartToOrderPercent = b.advAtbs > 0 ? (b.advOrders / b.advAtbs) * 100 : 0;
        const advCrPercent = b.advClicks > 0 ? (b.advOrders / b.advClicks) * 100 : 0;
        const advCpmRub = b.advViews > 0 ? (advSpendRub / b.advViews) * 1000 : 0;
        const advCpcRub = b.advClicks > 0 ? advSpendRub / b.advClicks : 0;
        const advCpoRub = b.advOrders > 0 ? advSpendRub / b.advOrders : 0;

        const manualSpendRub = Math.round((b.advManualKopecks / 100) * 100) / 100;
        const manualOrdersRub = Math.round((b.advManualSumPriceKopecks / 100) * 100) / 100;
        const manualCtr = b.advManualViews > 0 ? (b.advManualClicks / b.advManualViews) * 100 : 0;
        const manualClickToCart = b.advManualClicks > 0 ? (b.advManualAtbs / b.advManualClicks) * 100 : 0;
        const manualCartToOrder = b.advManualAtbs > 0 ? (b.advManualOrders / b.advManualAtbs) * 100 : 0;
        const manualCr = b.advManualClicks > 0 ? (b.advManualOrders / b.advManualClicks) * 100 : 0;
        const manualCpm = b.advManualViews > 0 ? (manualSpendRub / b.advManualViews) * 1000 : 0;
        const manualCpc = b.advManualClicks > 0 ? manualSpendRub / b.advManualClicks : 0;
        const manualCpo = b.advManualOrders > 0 ? manualSpendRub / b.advManualOrders : 0;
        const drrManual = manualOrdersRub > 0 ? (manualSpendRub / manualOrdersRub) * 100 : 0;

        const unifiedSpendRub = Math.round((b.advUnifiedKopecks / 100) * 100) / 100;
        const unifiedOrdersRub = Math.round((b.advUnifiedSumPriceKopecks / 100) * 100) / 100;
        const unifiedCtr = b.advUnifiedViews > 0 ? (b.advUnifiedClicks / b.advUnifiedViews) * 100 : 0;
        const unifiedClickToCart = b.advUnifiedClicks > 0 ? (b.advUnifiedAtbs / b.advUnifiedClicks) * 100 : 0;
        const unifiedCartToOrder = b.advUnifiedAtbs > 0 ? (b.advUnifiedOrders / b.advUnifiedAtbs) * 100 : 0;
        const unifiedCr = b.advUnifiedClicks > 0 ? (b.advUnifiedOrders / b.advUnifiedClicks) * 100 : 0;
        const unifiedCpm = b.advUnifiedViews > 0 ? (unifiedSpendRub / b.advUnifiedViews) * 1000 : 0;
        const unifiedCpc = b.advUnifiedClicks > 0 ? unifiedSpendRub / b.advUnifiedClicks : 0;
        const unifiedCpo = b.advUnifiedOrders > 0 ? unifiedSpendRub / b.advUnifiedOrders : 0;
        const drrUnified = unifiedOrdersRub > 0 ? (unifiedSpendRub / unifiedOrdersRub) * 100 : 0;

        return {
          key: b.key,
          ordersCount: effectiveOrdersCount,
          // salesCount/salesRub теперь = funnel buyout (выкупы), а не Statistics.salesRub.
          // Это «реализованные/выкупленные» — ниже заказов на процент выкупа.
          salesCount: b.buyoutCount,
          salesRub: Math.round(b.buyoutSum * 100) / 100,
          ordersRub,
          priceNoSppRub,
          priceWithSppRub,
          sppPercent,
          forecastSalesCount,
          forecastSalesRub,
          advSpendRub,
          drrPercent: Math.round(drrSeriesPercent * 100) / 100,
          drrOrdersPercent: Math.round(drrOrdersPercent * 100) / 100,
          drrAdsPercent: Math.round(drrAdsPercent * 100) / 100,

          advViews: Math.round(b.advViews),
          advClicks: Math.round(b.advClicks),
          advAtbs: Math.round(b.advAtbs),
          advOrders: Math.round(b.advOrders),
          advOrdersRub,
          advCtrPercent: Math.round(advCtrPercent * 100) / 100,
          advClickToCartPercent: Math.round(advClickToCartPercent * 100) / 100,
          advCartToOrderPercent: Math.round(advCartToOrderPercent * 100) / 100,
          advCrPercent: Math.round(advCrPercent * 100) / 100,
          advCpmRub: Math.round(advCpmRub * 100) / 100,
          advCpcRub: Math.round(advCpcRub * 100) / 100,
          advCpoRub: Math.round(advCpoRub * 100) / 100,

          advManualSpendRub: manualSpendRub,
          advManualViews: Math.round(b.advManualViews),
          advManualClicks: Math.round(b.advManualClicks),
          advManualAtbs: Math.round(b.advManualAtbs),
          advManualOrders: Math.round(b.advManualOrders),
          advManualOrdersRub: manualOrdersRub,
          advManualCtrPercent: Math.round(manualCtr * 100) / 100,
          advManualClickToCartPercent: Math.round(manualClickToCart * 100) / 100,
          advManualCartToOrderPercent: Math.round(manualCartToOrder * 100) / 100,
          advManualCrPercent: Math.round(manualCr * 100) / 100,
          advManualCpmRub: Math.round(manualCpm * 100) / 100,
          advManualCpcRub: Math.round(manualCpc * 100) / 100,
          advManualCpoRub: Math.round(manualCpo * 100) / 100,
          advManualDrrPercent: Math.round(drrManual * 100) / 100,

          advUnifiedSpendRub: unifiedSpendRub,
          advUnifiedViews: Math.round(b.advUnifiedViews),
          advUnifiedClicks: Math.round(b.advUnifiedClicks),
          advUnifiedAtbs: Math.round(b.advUnifiedAtbs),
          advUnifiedOrders: Math.round(b.advUnifiedOrders),
          advUnifiedOrdersRub: unifiedOrdersRub,
          advUnifiedCtrPercent: Math.round(unifiedCtr * 100) / 100,
          advUnifiedClickToCartPercent: Math.round(unifiedClickToCart * 100) / 100,
          advUnifiedCartToOrderPercent: Math.round(unifiedCartToOrder * 100) / 100,
          advUnifiedCrPercent: Math.round(unifiedCr * 100) / 100,
          advUnifiedCpmRub: Math.round(unifiedCpm * 100) / 100,
          advUnifiedCpcRub: Math.round(unifiedCpc * 100) / 100,
          advUnifiedCpoRub: Math.round(unifiedCpo * 100) / 100,
          advUnifiedDrrPercent: Math.round(drrUnified * 100) / 100,

          payoutRub: Math.round((b.payoutKopecks / 100) * 100) / 100,
          additionalPaymentRub: Math.round((b.additionalPaymentKopecks / 100) * 100) / 100,
          commissionRub: Math.round((b.commissionKopecks / 100) * 100) / 100,
          logisticsRub: Math.round((b.logisticsKopecks / 100) * 100) / 100,
          returnLogisticsRub: Math.round((b.returnLogisticsKopecks / 100) * 100) / 100,
          paidAcceptanceRub: Math.round((b.paidAcceptanceKopecks / 100) * 100) / 100,
          storageRub: Math.round((b.storageKopecks / 100) * 100) / 100,
          penaltyRub: Math.round((b.penaltyKopecks / 100) * 100) / 100,
          otherHoldRub: Math.round((b.otherHoldKopecks / 100) * 100) / 100,
          acquiringRub: Math.round((b.acquiringKopecks / 100) * 100) / 100,
          returnsCount: Math.round(b.returnsCount),

          marketplaceCostsRub: Math.round((marketplaceCostsKopecks / 100) * 100) / 100,
          marginRub: Math.round((marginKopecks / 100) * 100) / 100,
          netProfitRub: Math.round((netProfitKopecks / 100) * 100) / 100,
          marginPerUnitRub: Math.round(marginPerUnitRub * 100) / 100,
          marginPercent: Math.round(marginPercent * 100) / 100,
          markupX: Math.round(markupX * 100) / 100,
          roiPercent: Math.round(roiPercent * 100) / 100,

          taxRub: Math.round((taxKopecks / 100) * 100) / 100,
          cogsRub: Math.round((b.cogsKopecks / 100) * 100) / 100,

          // Average stock values (not sum) for weekly aggregation
          stockQty: Math.round(b.days > 0 ? b.stockQty / b.days : b.stockQty),
          stockInWayTo: Math.round(b.days > 0 ? b.stockInWayTo / b.days : b.stockInWayTo),
          stockInWayFrom: Math.round(b.days > 0 ? b.stockInWayFrom / b.days : b.stockInWayFrom),
          stockMoneyRub,
          turnoverDays: Math.round(turnoverDays * 100) / 100,

          viewCount: Math.round(b.viewCount),
          openCardCount: Math.round(b.openCardCount),
          addToCartCount: Math.round(b.addToCartCount),
          addToWishlistCount: Math.round(b.addToWishlistCount),
          funnelOrderCount: Math.round(b.orderCount),
          buyoutCount: Math.round(b.buyoutCount),
          buyoutSumRub,
          cancelCount: Math.round(b.cancelCount),
          cancelSumRub,
          buyoutPercent: Math.round(buyoutPercent * 100) / 100,
          viewToOpenPercent: Math.round(viewToOpen * 100) / 100,
          openToCartPercent: Math.round(openToCart * 100) / 100,
          cartToOrderPercent: Math.round(cartToOrder * 100) / 100,
        };
      });

    function median(xs: number[]): number {
      const arr = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      if (arr.length === 0) return 0;
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 === 1 ? arr[mid]! : (arr[mid - 1]! + arr[mid]!) / 2;
    }

    type AnomalyFlags = {
      low?: boolean;
      high?: boolean;
      pctDiff?: number;
      baseline?: number;
    };

    const anomalies: Record<string, Record<string, AnomalyFlags>> = {};

    if (anomaliesEnabled) {
      const metrics: Array<{ name: string; get: (p: (typeof series)[number]) => number }> = [
        { name: 'ordersCount', get: (p) => p.ordersCount },
        { name: 'salesCount', get: (p) => p.salesCount },
        { name: 'salesRub', get: (p) => p.salesRub },
        { name: 'ordersRub', get: (p) => p.ordersRub },
        { name: 'forecastSalesCount', get: (p) => p.forecastSalesCount },
        { name: 'forecastSalesRub', get: (p) => p.forecastSalesRub },
        { name: 'priceNoSppRub', get: (p) => p.priceNoSppRub },
        { name: 'priceWithSppRub', get: (p) => p.priceWithSppRub },
        { name: 'sppPercent', get: (p) => p.sppPercent },
        { name: 'advSpendRub', get: (p) => p.advSpendRub },
        { name: 'drrPercent', get: (p) => p.drrPercent },
        { name: 'drrOrdersPercent', get: (p) => p.drrOrdersPercent },
        { name: 'drrAdsPercent', get: (p) => p.drrAdsPercent },

        { name: 'advViews', get: (p) => p.advViews ?? 0 },
        { name: 'advClicks', get: (p) => p.advClicks ?? 0 },
        { name: 'advAtbs', get: (p) => p.advAtbs ?? 0 },
        { name: 'advOrders', get: (p) => p.advOrders ?? 0 },
        { name: 'advOrdersRub', get: (p) => p.advOrdersRub ?? 0 },
        { name: 'advManualSpendRub', get: (p) => p.advManualSpendRub ?? 0 },
        { name: 'advManualDrrPercent', get: (p) => p.advManualDrrPercent ?? 0 },
        { name: 'advUnifiedSpendRub', get: (p) => p.advUnifiedSpendRub ?? 0 },
        { name: 'advUnifiedDrrPercent', get: (p) => p.advUnifiedDrrPercent ?? 0 },

        // Funnel drivers
        { name: 'viewCount', get: (p) => p.viewCount ?? 0 },
        { name: 'openCardCount', get: (p) => p.openCardCount ?? 0 },
        { name: 'addToCartCount', get: (p) => p.addToCartCount ?? 0 },
        { name: 'addToWishlistCount', get: (p) => p.addToWishlistCount ?? 0 },
        { name: 'funnelOrderCount', get: (p) => p.funnelOrderCount ?? 0 },
        { name: 'buyoutCount', get: (p) => p.buyoutCount ?? 0 },
        { name: 'buyoutSumRub', get: (p) => p.buyoutSumRub ?? 0 },
        { name: 'cancelCount', get: (p) => p.cancelCount ?? 0 },
        { name: 'cancelSumRub', get: (p) => p.cancelSumRub ?? 0 },
        { name: 'buyoutPercent', get: (p) => p.buyoutPercent ?? 0 },
        { name: 'viewToOpenPercent', get: (p) => p.viewToOpenPercent ?? 0 },
        { name: 'openToCartPercent', get: (p) => p.openToCartPercent ?? 0 },
        { name: 'cartToOrderPercent', get: (p) => p.cartToOrderPercent ?? 0 },

        { name: 'stockQty', get: (p) => p.stockQty ?? 0 },
        { name: 'stockInWayTo', get: (p) => p.stockInWayTo ?? 0 },
        { name: 'stockInWayFrom', get: (p) => p.stockInWayFrom ?? 0 },
        { name: 'stockMoneyRub', get: (p) => p.stockMoneyRub ?? 0 },
        { name: 'turnoverDays', get: (p) => p.turnoverDays ?? 0 },

        { name: 'payoutRub', get: (p) => p.payoutRub },
        { name: 'additionalPaymentRub', get: (p) => p.additionalPaymentRub },
        { name: 'commissionRub', get: (p) => p.commissionRub },
        { name: 'logisticsRub', get: (p) => p.logisticsRub },
        { name: 'returnLogisticsRub', get: (p) => p.returnLogisticsRub },
        { name: 'paidAcceptanceRub', get: (p) => p.paidAcceptanceRub },
        { name: 'storageRub', get: (p) => p.storageRub },
        { name: 'penaltyRub', get: (p) => p.penaltyRub },
        { name: 'otherHoldRub', get: (p) => p.otherHoldRub },
        { name: 'acquiringRub', get: (p) => p.acquiringRub },
        { name: 'returnsCount', get: (p) => p.returnsCount ?? 0 },

        { name: 'marketplaceCostsRub', get: (p) => p.marketplaceCostsRub },
        { name: 'taxRub', get: (p) => p.taxRub },
        { name: 'cogsRub', get: (p) => p.cogsRub },

        { name: 'marginRub', get: (p) => p.marginRub },
        { name: 'netProfitRub', get: (p) => p.netProfitRub },
        { name: 'marginPerUnitRub', get: (p) => p.marginPerUnitRub },
        { name: 'marginPercent', get: (p) => p.marginPercent },
        { name: 'markupX', get: (p) => p.markupX },
        { name: 'roiPercent', get: (p) => p.roiPercent },
      ];

      // Compute median of ALL values within the selected period for each metric,
      // then flag data points that deviate beyond the threshold.
      for (const m of metrics) {
        const allValues = series.map((s) => m.get(s)).filter((v) => Number.isFinite(v));
        const base = median(allValues);
        if (base <= 0) continue;

        for (let i = 0; i < series.length; i++) {
          const key = series[i]!.key;
          if (!anomalies[key]) anomalies[key] = {};
          const cur = m.get(series[i]!);
          if (!Number.isFinite(cur)) continue;
          const pctDiff = ((cur - base) / base) * 100;
          const abs = Math.abs(pctDiff);
          if (abs >= anomalyThresholdPct) {
            anomalies[key]![m.name] = {
              low: pctDiff < 0,
              high: pctDiff > 0,
              pctDiff: Math.round(pctDiff * 100) / 100,
              baseline: Math.round(base * 100) / 100,
            };
          }
        }
      }
    }

    function pctDelta(cur: number, prev: number): number {
      if (prev === 0) return cur === 0 ? 0 : 100;
      return ((cur - prev) / prev) * 100;
    }

    // removed duplicate KPI prelude

    const advViews = advRows.reduce((acc, r) => acc + (r.viewsCount ?? 0), 0);
    const advClicks = advRows.reduce((acc, r) => acc + (r.clicksCount ?? 0), 0);
    const advAtbs = advRows.reduce((acc, r) => acc + (r.atbsCount ?? 0), 0);
    const advOrders = advRows.reduce((acc, r) => acc + (r.ordersCount ?? 0), 0);
    const advSumPriceKopecks = advRows.reduce((acc, r) => acc + (r.sumPriceKopecks ?? 0), 0);

    const priceNoSppRub = ordersCount > 0 ? Math.round(((ordersKopecks / 100) / ordersCount) * 100) / 100 : 0;
    const priceWithSppRub =
      ordersCount > 0 ? Math.round(((finishedPriceKopecks / 100) / ordersCount) * 100) / 100 : 0;
    const sppPercent = ordersCount > 0 ? Math.round(((discountPercentSumBp / ordersCount) / 100) * 100) / 100 : 0;

    const funnelTotals = Array.from(funnelByDate.values()).reduce(
      (acc, f) => {
        acc.viewCount += f.viewCount;
        acc.openCardCount += f.openCardCount;
        acc.addToCartCount += f.addToCartCount;
        acc.addToWishlistCount += f.addToWishlistCount;
        acc.orderCount += f.orderCount;
        acc.orderSum += f.orderSum;
        acc.buyoutCount += f.buyoutCount;
        acc.buyoutSum += f.buyoutSum;
        acc.cancelCount += f.cancelCount ?? 0;
        acc.cancelSum += f.cancelSum ?? 0;
        return acc;
      },
      {
        viewCount: 0,
        openCardCount: 0,
        addToCartCount: 0,
        addToWishlistCount: 0,
        orderCount: 0,
        orderSum: 0,
        buyoutCount: 0,
        buyoutSum: 0,
        cancelCount: 0,
        cancelSum: 0,
      }
    );

    // Use WB Funnel API for ordersCount/ordersRub — matches WB personal cabinet.
    // Fall back to Statistics API if Funnel API fails or is unavailable.
    const funnelKpi = await funnelKpiPromise;
    const ordersRub = funnelKpi ? funnelKpi.ordersRub : Math.round((ordersKopecks / 100) * 100) / 100;
    const effectiveOrdersCount = funnelKpi ? funnelKpi.ordersCount : ordersCount;

    const viewCount = funnelTotals.viewCount;
    const openCardCount = funnelTotals.openCardCount;
    const addToCartCount = funnelTotals.addToCartCount;
    const addToWishlistCount = funnelTotals.addToWishlistCount;
    const orderCount = funnelTotals.orderCount;
    const orderSum = funnelTotals.orderSum;
    const buyoutCount = funnelTotals.buyoutCount;
    const buyoutSumRub = Math.round(funnelTotals.buyoutSum * 100) / 100;
    const cancelCount = funnelTotals.cancelCount;
    const cancelSumRub = Math.round(funnelTotals.cancelSum * 100) / 100;
    const buyoutPercent = orderCount > 0 ? (buyoutCount / orderCount) * 100 : 0;
    const viewToOpen = viewCount > 0 ? (openCardCount / viewCount) * 100 : 0;
    const openToCart = openCardCount > 0 ? (addToCartCount / openCardCount) * 100 : 0;
    const cartToOrder = addToCartCount > 0 ? (orderCount / addToCartCount) * 100 : 0;

    const forecastSalesCount = orderCount > 0 ? Math.round((orderCount * buyoutPercent) / 100) : 0;
    const forecastSalesRub = orderCount > 0 ? Math.round((orderSum * buyoutPercent) / 100 * 100) / 100 : 0;

    const cogsKopecksTotal = Array.from(cogsCostByDate.values()).reduce((acc, v) => acc + v, 0);
    const cogsPerUnitRub = buyoutCount > 0 ? cogsKopecksTotal / buyoutCount / 100 : 0;
    const marginPerUnitRub = buyoutCount > 0 ? marginKopecks / buyoutCount / 100 : 0;
    // Use payout as base for margin% (not orders) — payout reflects actual WB settlements
    const marginBase = payoutKopecks > 0 ? payoutKopecks : ordersKopecks;
    const marginPercent = marginBase > 0 ? (marginKopecks / marginBase) * 100 : 0;
    const markupX = cogsPerUnitRub > 0 ? priceNoSppRub / cogsPerUnitRub : 0;

    const latestStock = stockRows.reduce((acc, r) => (!acc || r.date > acc.date ? r : acc), null as any);
    const stockQty = latestStock?.quantity ?? 0;
    const stockInWayTo = latestStock?.inWayToClient ?? 0;
    const stockInWayFrom = latestStock?.inWayFromClient ?? 0;
    const stockMoneyRub = latestStock ? (stockValueByDate.get(latestStock.date) ?? 0) / 100 : 0;

    const dailySales = lenDays > 0 ? salesCount / lenDays : 0;
    const turnoverDays = dailySales > 0 ? stockQty / dailySales : 0;

    const advSpendRub = Math.round((advKopecks / 100) * 100) / 100;
    const advOrdersRub = advSumPriceKopecks / 100;

    const drrForecastPercent = forecastSalesRub > 0 ? (advSpendRub / forecastSalesRub) * 100 : 0;
    const drrOrdersPercent = ordersRub > 0 ? (advSpendRub / ordersRub) * 100 : 0;
    const drrAdsPercent = advOrdersRub > 0 ? (advSpendRub / advOrdersRub) * 100 : 0;
    // KPI DRR should respect the selected base (sales/payout), falling back to sales-based
    const drrKpiSalesPercent = salesKopecks > 0 ? (advKopecks / salesKopecks) * 100 : 0;
    const drrKpiPayoutPercent = payoutKopecks > 0 ? (advKopecks / payoutKopecks) * 100 : 0;
    const drrKpiPercent = drrBase === 'payout' ? drrKpiPayoutPercent : drrKpiSalesPercent;

    // Tax cannot be negative (no refund for losses)
    const taxKopecks = Math.max(0, Math.round((payoutKopecks - marketplaceCostsKopecks - cogsKopecksTotal) * taxRate));
    const roiPercent =
      marketplaceCostsKopecks + cogsKopecksTotal + taxKopecks > 0
        ? (payoutKopecks / (marketplaceCostsKopecks + cogsKopecksTotal + taxKopecks)) * 100
        : 0;

    const kpis = {
      ordersCount: effectiveOrdersCount,
      // salesCount/salesRub в KPI тоже = funnel buyout — синхронизировано с series.
      salesCount: buyoutCount,
      salesRub: buyoutSumRub,
      ordersRub,
      priceNoSppRub,
      priceWithSppRub,
      sppPercent,
      forecastSalesCount,
      forecastSalesRub,
      advSpendRub,
      drrPercent: Math.round(drrKpiPercent * 100) / 100,
      drrOrdersPercent: Math.round(drrOrdersPercent * 100) / 100,
      drrAdsPercent: Math.round(drrAdsPercent * 100) / 100,

      advViews,
      advClicks,
      advAtbs,
      advOrders,
      advOrdersRub,

      payoutRub: Math.round((payoutKopecks / 100) * 100) / 100,
      commissionRub: Math.round((commissionKopecks / 100) * 100) / 100,
      logisticsRub: Math.round((logisticsKopecks / 100) * 100) / 100,
      returnLogisticsRub: Math.round((returnLogisticsKopecks / 100) * 100) / 100,
      paidAcceptanceRub: Math.round((paidAcceptanceKopecks / 100) * 100) / 100,
      storageRub: Math.round((storageKopecks / 100) * 100) / 100,
      penaltyRub: Math.round((penaltyKopecks / 100) * 100) / 100,
      otherHoldRub: Math.round((otherHoldKopecks / 100) * 100) / 100,
      acquiringRub: Math.round((acquiringKopecks / 100) * 100) / 100,
      returnsCount,

      marketplaceCostsRub: Math.round((marketplaceCostsKopecks / 100) * 100) / 100,
      marginRub: Math.round((marginKopecks / 100) * 100) / 100,
      netProfitRub: Math.round((netProfitKopecks / 100) * 100) / 100,
      isMarginEstimated,
      marginPerUnitRub: Math.round(marginPerUnitRub * 100) / 100,
      marginPercent: Math.round(marginPercent * 100) / 100,
      markupX: Math.round(markupX * 100) / 100,
      roiPercent: Math.round(roiPercent * 100) / 100,

      taxRub: Math.round(taxKopecks / 100 * 100) / 100,
      cogsRub: Math.round((cogsKopecksTotal / 100) * 100) / 100,
      stockQty,
      stockInWayTo,
      stockInWayFrom,
      stockMoneyRub: Math.round(stockMoneyRub * 100) / 100,
      turnoverDays: Math.round(turnoverDays * 100) / 100,

      viewCount,
      openCardCount,
      addToCartCount,
      addToWishlistCount,
      funnelOrderCount: orderCount,
      buyoutCount,
      buyoutSumRub,
      cancelCount,
      cancelSumRub,
      buyoutPercent: Math.round(buyoutPercent * 100) / 100,
      viewToOpenPercent: Math.round(viewToOpen * 100) / 100,
      openToCartPercent: Math.round(openToCart * 100) / 100,
      cartToOrderPercent: Math.round(cartToOrder * 100) / 100,
    };

    const kpisPrev = {
      ordersCount: prevEffectiveOrdersCount,
      salesCount: prevBuyoutCount,
      salesRub: prevBuyoutSumRub,
      ordersRub: prevOrdersRub,
      priceNoSppRub: prevPriceNoSppRub,
      priceWithSppRub: prevPriceWithSppRub,
      sppPercent: prevSppPercent,
      forecastSalesCount: prevForecastSalesCount,
      forecastSalesRub: prevForecastSalesRub,
      advSpendRub: prevAdvSpendRub,
      drrPercent: Math.round(prevDrrForecastPercent * 100) / 100,
      drrOrdersPercent: Math.round(prevDrrOrdersPercent * 100) / 100,
      drrAdsPercent: Math.round(prevDrrAdsPercent * 100) / 100,

      advViews: prevAdvViews,
      advClicks: prevAdvClicks,
      advAtbs: prevAdvAtbs,
      advOrders: prevAdvOrders,
      advOrdersRub: prevAdvOrdersRub,

      payoutRub: Math.round((prevPayoutKopecks / 100) * 100) / 100,
      commissionRub: Math.round((prevCommissionKopecks / 100) * 100) / 100,
      logisticsRub: Math.round((prevLogisticsKopecks / 100) * 100) / 100,
      returnLogisticsRub: Math.round((prevReturnLogisticsKopecks / 100) * 100) / 100,
      paidAcceptanceRub: Math.round((prevPaidAcceptanceKopecks / 100) * 100) / 100,
      storageRub: Math.round((prevStorageKopecks / 100) * 100) / 100,
      penaltyRub: Math.round((prevPenaltyKopecks / 100) * 100) / 100,
      otherHoldRub: Math.round((prevOtherHoldKopecks / 100) * 100) / 100,
      acquiringRub: Math.round((prevAcquiringKopecks / 100) * 100) / 100,
      returnsCount: prevReturnsCount,

      marketplaceCostsRub: Math.round((prevMarketplaceCostsKopecks / 100) * 100) / 100,
      marginRub: Math.round((prevMarginKopecks / 100) * 100) / 100,
      netProfitRub: Math.round((prevNetProfitKopecks / 100) * 100) / 100,
      marginPerUnitRub: Math.round(prevMarginPerUnitRub * 100) / 100,
      marginPercent: Math.round(prevMarginPercent * 100) / 100,
      markupX: Math.round(prevMarkupX * 100) / 100,
      roiPercent: Math.round(prevRoiPercent * 100) / 100,

      taxRub: Math.round(prevTaxKopecks / 100 * 100) / 100,
      cogsRub: Math.round((prevCogsKopecksTotal / 100) * 100) / 100,
      stockQty: prevStockQty,
      stockInWayTo: prevStockInWayTo,
      stockInWayFrom: prevStockInWayFrom,
      stockMoneyRub: Math.round(prevStockMoneyRub * 100) / 100,
      turnoverDays: Math.round(prevTurnoverDays * 100) / 100,

      viewCount: prevViewCount,
      openCardCount: prevOpenCardCount,
      addToCartCount: prevAddToCartCount,
      addToWishlistCount: prevAddToWishlistCount,
      funnelOrderCount: prevOrderCount,
      buyoutCount: prevBuyoutCount,
      buyoutSumRub: prevBuyoutSumRub,
      cancelCount: prevCancelCount,
      cancelSumRub: prevCancelSumRub,
      buyoutPercent: Math.round(prevBuyoutPercent * 100) / 100,
      viewToOpenPercent: Math.round(prevViewToOpen * 100) / 100,
      openToCartPercent: Math.round(prevOpenToCart * 100) / 100,
      cartToOrderPercent: Math.round(prevCartToOrder * 100) / 100,
    };

    const compare = {
      prevFrom,
      prevTo,
      lenDays,
      pct: {
        ordersCount: Math.round(pctDelta(effectiveOrdersCount, prevEffectiveOrdersCount) * 100) / 100,
        ordersRub: Math.round(pctDelta(ordersRub, prevOrdersRub) * 100) / 100,
        salesCount: Math.round(pctDelta(salesCount, prevSalesCount) * 100) / 100,
        salesRub: Math.round(pctDelta(salesKopecks, prevSalesKopecks) * 100) / 100,
        forecastSalesRub: Math.round(pctDelta(forecastSalesRub, prevForecastSalesRub) * 100) / 100,
        advSpendRub: Math.round(pctDelta(advKopecks, prevAdvKopecks) * 100) / 100,
        advOrdersRub: Math.round(pctDelta(advOrdersRub, prevAdvOrdersRub) * 100) / 100,
        drrPercent: Math.round(pctDelta(drrForecastPercent, prevDrrForecastPercent) * 100) / 100,
        marginRub: Math.round(pctDelta(marginKopecks, prevMarginKopecks) * 100) / 100,
        marginPercent: Math.round(pctDelta(marginPercent, prevMarginPercent) * 100) / 100,
        netProfitRub: Math.round(pctDelta(netProfitKopecks, prevNetProfitKopecks) * 100) / 100,
        roiPercent: Math.round(pctDelta(roiPercent, prevRoiPercent) * 100) / 100,
        stockMoneyRub: Math.round(pctDelta(stockMoneyRub, prevStockMoneyRub) * 100) / 100,
        turnoverDays: Math.round(pctDelta(turnoverDays, prevTurnoverDays) * 100) / 100,
      },
    };

    return {
      workspaceId: params.workspaceId,
      from,
      to,
      groupBy,
      availability: {
        funnelProductsDays: availableDays,
        run: run[0] ?? null,
      },
      kpis,
      kpisPrev,
      compare,
      series,
      anomalies: {
        enabled: anomaliesEnabled,
        thresholdPct: anomalyThresholdPct,
        window: anomalyWindow,
        byKey: anomalies,
      },
    };
  });

  // per-product matrix for a selected metric over time
  app.get('/pulse/:workspaceId/products/matrix', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        metric: z
          .enum([
            'ordersCount',
            'ordersRub',
            'salesCount',
            'salesRub',
            'priceNoSppRub',
            'priceWithSppRub',
            'sppPercent',
            'advSpendRub',
            'advManualSpendRub',
            'advManualDrrPercent',
            'advUnifiedSpendRub',
            'advUnifiedDrrPercent',
            'drrPercent',
            'buyoutCount',
            'buyoutSumRub',
            'buyoutPercent',
            'cancelCount',
            'cancelSumRub',
            'viewCount',
            'openCardCount',
            'addToCartCount',
            'addToWishlistCount',
            'funnelOrderCount',
            'viewToOpenPercent',
            'openToCartPercent',
            'cartToOrderPercent',
            'stockQty',
            'stockInWayTo',
            'stockInWayFrom',
            'stockMoneyRub',
            'turnoverDays',
            'payoutRub',
            'additionalPaymentRub',
            'commissionRub',
            'logisticsRub',
            'storageRub',
            'penaltyRub',
            'acquiringRub',
            'returnsCount',
            'marginRub',
            'marginPercent',
            'roiPercent',
            'netProfitRub',
            'taxRub',
            'cogsRub',
          ])
          .default('salesRub'),
        groupBy: z.enum(['day', 'week']).optional(),
        tagId: z.coerce.number().int().positive().optional(),
        anomalyThresholdPct: z.coerce.number().optional(),
        anomalyWindow: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(30),
        offset: z.coerce.number().int().min(0).default(0),
        nmIds: z.string().optional(),
        vendorCode: z.string().optional(),
        brandName: z.string().optional(),
        subjectId: z.coerce.number().int().optional(),
        subjectName: z.string().optional(),
        taxRate: z.coerce.number().optional(),
        shopId: z.coerce.number().int().positive().optional(),
        includeAll: z.enum(['true', 'false']).default('false'),
        productFilter: z.enum(['orders', 'sales', 'all']).optional(),
      })
      .parse(req.query);

    // Shop filter for multi-shop support
    const shopId = query.shopId;

    const today = new Date().toISOString().slice(0, 10);
    const toRaw = query.to ?? today;
    const to = toRaw > today ? today : toRaw; // cap future dates
    const from = query.from ?? to;
    const groupBy = query.groupBy ?? 'day';
    const anomalyThresholdPct = query.anomalyThresholdPct ?? 25;
    const anomalyWindow = query.anomalyWindow ?? (groupBy === 'day' ? 7 : 4);
    const taxRateRaw = typeof query.taxRate === 'number' && Number.isFinite(query.taxRate) ? query.taxRate : 0.15;
    const taxRate = taxRateRaw > 1 ? taxRateRaw / 100 : taxRateRaw;

    // Collect nmIds (by filters or by top sales in range)
    let nmIds: number[] = [];

    const nmIdsParam = query.nmIds ? parseNmIdsParam(query.nmIds) : [];

    let cardNmIds: number[] | null = null;
    if (query.vendorCode || query.brandName || query.subjectId || query.subjectName) {

      const conds: (SQL | undefined)[] = [eq(wbCards.workspaceId, params.workspaceId), buildShopFilter(wbCards.shopId, shopId)];

      const vendorCodes = parseMultiParam(query.vendorCode);
      if (vendorCodes.length) {
        conds.push(or(...vendorCodes.map((v) => ilike(wbCards.vendorCode, `%${escapeIlike(v)}%`)))!);
      }
      const brandNames = parseMultiParam(query.brandName);
      if (brandNames.length) {
        conds.push(or(...brandNames.map((v) => ilike(wbCards.brandName, `%${escapeIlike(v)}%`)))!);
      }
      const subjectNames = parseMultiParam(query.subjectName);
      if (subjectNames.length) {
        conds.push(or(...subjectNames.map((v) => ilike(wbCards.subjectName, `%${escapeIlike(v)}%`)))!);
      }
      if (typeof query.subjectId === 'number') conds.push(eq(wbCards.subjectId, query.subjectId));

      const rows = await db.select({ nmId: wbCards.nmId }).from(wbCards).where(and(...conds.filter((c): c is SQL => c !== undefined)));
      cardNmIds = rows.map((r) => Number(r.nmId)).filter((n) => Number.isFinite(n) && n > 0);
    }

    let tagNmIds: number[] | null = null;
    if (query.tagId) {
      const links = await db
        .select({ nmId: wbTagProducts.nmId })
        .from(wbTagProducts)
        .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.tagId, query.tagId)));
      tagNmIds = links.map((l) => Number(l.nmId)).filter((n) => Number.isFinite(n) && n > 0);
    }

    const nmLists = [nmIdsParam.length ? nmIdsParam : null, cardNmIds, tagNmIds].filter(Boolean) as number[][];
    let baseNmIds: number[] | null = null;
    if (nmLists.length) {
      baseNmIds = nmLists[0] ?? [];
      for (let i = 1; i < nmLists.length; i++) baseNmIds = intersect(baseNmIds, nmLists[i]!);
    }

    // Determine effective product filter mode
    const effectiveFilter = query.productFilter ?? (query.includeAll === 'true' ? 'all' : 'sales');
    // 2026-06-01: переключено с Statistics на Funnel (Analytics) — теперь
    // сортировка топ-товаров по «выручке» использует order_sum/buyout_sum
    // из WB Analytics, что совпадает с WB ЛК. Раньше брали из Statistics,
    // и список «попавших в выборку» nmId оказывался уже того что показывает
    // funnel — пропадали 5-15% товаров.
    const sortColumn = effectiveFilter === 'orders' ? wbFunnelDailyProducts.orderSum : wbFunnelDailyProducts.buyoutSum;

    let totalCount = 0; // total products before limit

    if (baseNmIds) {
      totalCount = baseNmIds.length;
      nmIds = baseNmIds.slice(query.offset, query.offset + query.limit);
    } else if (effectiveFilter === 'all') {
      // Show ALL products from cards catalog, sorted by selected metric.
      //
      // Previously used a correlated subquery in both SELECT and ORDER BY,
      // which on 5k+ cards × 365 days re-scanned
      // wb_orders_sales_daily_products per row → pool exhaustion and 30s+
      // latencies (see PRODUCTION-READINESS-AUDIT.md §3.2 bottleneck #2).
      //
      // Rewritten as a single aggregation CTE + LEFT JOIN: one sequential
      // scan over the period's data (~1.8M rows at the 5000×365 cap,
      // covered by the compound index added in migration 0110), then a
      // hash-join to cards and one ORDER BY on the materialised sum.
      // When a specific shop is selected, filter in BOTH the agg CTE and
      // the cards join so a stray nm_id that was reassigned to a
      // different shop in one table but not the other can't leak across.
      // Shared shop_id is already scoped by the outer wbCards WHERE, but
      // the CTE's SUM runs independently — keep both filters.
      const shopFilterAgg = shopId
        ? sql`AND ${wbFunnelDailyProducts.shopId} = ${shopId}`
        : sql``;
      const shopFilterCards = shopId ? sql`AND ${wbCards.shopId} = ${shopId}` : sql``;
      const top = await db.execute<{ nm_id: number; sum_val: number }>(sql`
        WITH agg AS (
          SELECT ${wbFunnelDailyProducts.nmId} AS nm_id,
                 ${wbFunnelDailyProducts.shopId} AS shop_id,
                 SUM(${sortColumn}) AS sum_val
          FROM ${wbFunnelDailyProducts}
          WHERE ${wbFunnelDailyProducts.workspaceId} = ${params.workspaceId}
            AND ${wbFunnelDailyProducts.date} >= ${from}
            AND ${wbFunnelDailyProducts.date} <= ${to}
            ${shopFilterAgg}
          GROUP BY ${wbFunnelDailyProducts.nmId}, ${wbFunnelDailyProducts.shopId}
        )
        SELECT ${wbCards.nmId} AS nm_id,
               COALESCE(agg.sum_val, 0) AS sum_val
        FROM ${wbCards}
        LEFT JOIN agg
          ON agg.nm_id = ${wbCards.nmId}
         AND agg.shop_id IS NOT DISTINCT FROM ${wbCards.shopId}
        WHERE ${wbCards.workspaceId} = ${params.workspaceId}
          ${shopFilterCards}
        ORDER BY COALESCE(agg.sum_val, 0) DESC
        LIMIT ${query.limit} OFFSET ${query.offset}
      `);
      const topRows = ((top as any).rows ?? (Array.isArray(top) ? top : [])) as Array<{
        nm_id: number;
        sum_val: number;
      }>;
      const allNmIds = topRows
        .map((r) => Number(r.nm_id))
        .filter((n) => Number.isFinite(n) && n > 0);
      // Count total cards for this shop (fast count without subquery)
      const [countRow] = await db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(wbCards)
        .where(and(eq(wbCards.workspaceId, params.workspaceId), buildShopFilter(wbCards.shopId, shopId)));
      totalCount = countRow?.count ?? allNmIds.length;
      nmIds = allNmIds;
    } else {
      // Filter products by activity: top products by ordersRub (Funnel) or buyoutSum (Funnel).
      // 2026-06-01 sortColumn переключён на wb_funnel_daily_products (см. коммент выше),
      // но FROM здесь оставили wb_orders_sales_daily_products → PG валится с
      // «column order_sum does not exist» (RNP/products/matrix падал в 500).
      // FROM привязан к sortColumn: и select, и where, и group/having/order — всё по funnel.
      const top = await db
        .select({ nmId: wbFunnelDailyProducts.nmId, sum: sql<number>`sum(${sortColumn})`.mapWith(Number) })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, from),
            lte(wbFunnelDailyProducts.date, to)
          )
        )
        .groupBy(wbFunnelDailyProducts.nmId)
        .having(sql`sum(${sortColumn}) > 0`)
        .orderBy(desc(sql`sum(${sortColumn})`))
        .limit(query.limit);
      nmIds = top.map((r) => Number(r.nmId)).filter((n) => Number.isFinite(n) && n > 0);
      totalCount = nmIds.length;
    }

    // Avoid invalid SQL inArray([])
    if (nmIds.length === 0) nmIds = [-1];

    // Build date keys
    const keys: string[] = [];
    const daysByKey = new Map<string, number>();
    for (let dt = parseDate(from); dt <= parseDate(to); ) {
      const iso = fmtDate(dt);
      const key = groupBy === 'week' ? weekStart(iso) : iso;
      keys.push(key);
      daysByKey.set(key, (daysByKey.get(key) ?? 0) + 1);
      dt.setUTCDate(dt.getUTCDate() + 1);
    }
    const dateKeys = Array.from(new Set(keys)).sort();

    // Fetch raw per-day, per-product values needed for the selected metric.
    // We'll build a map (nmId -> map(dateKey -> value)).
    const byNm = new Map<number, Map<string, number>>();
    const denomByNm = new Map<number, Map<string, number>>();
    for (const id of nmIds) {
      byNm.set(id, new Map());
      denomByNm.set(id, new Map());
    }

    const cogsByNm = new Map<number, number>();
    if (['roiPercent', 'stockMoneyRub'].includes(query.metric)) {
      const cogsRows = await db
        .select({ nmId: wbCogs.nmId, cogsKopecks: wbCogs.cogsKopecks })
        .from(wbCogs)
        .where(and(eq(wbCogs.workspaceId, params.workspaceId), inArray(wbCogs.nmId, nmIds as any)));
      for (const r of cogsRows) {
        cogsByNm.set(Number(r.nmId), Number(r.cogsKopecks ?? 0));
      }
    }

    const cogsCostByDay = new Map<string, number>();
    if (query.metric === 'roiPercent' && cogsByNm.size) {
      const cogsRows = await db
        .select({ date: wbFunnelDailyProducts.date, nmId: wbFunnelDailyProducts.nmId, buyoutCount: wbFunnelDailyProducts.buyoutCount })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, from),
            lte(wbFunnelDailyProducts.date, to),
            inArray(wbFunnelDailyProducts.nmId, nmIds as any)
          )
        );
      for (const r of cogsRows) {
        const cogs = cogsByNm.get(Number(r.nmId)) ?? 0;
        if (!cogs) continue;
        const iso = String(r.date);
        const mapKey = `${iso}|${Number(r.nmId)}`;
        const v = Number(r.buyoutCount ?? 0) * cogs;
        cogsCostByDay.set(mapKey, (cogsCostByDay.get(mapKey) ?? 0) + v);
      }
    }

    const ratioMetrics = new Set([
      'priceNoSppRub',
      'priceWithSppRub',
      'sppPercent',
      'buyoutPercent',
      'drrPercent',
      'advManualDrrPercent',
      'advUnifiedDrrPercent',
      'viewToOpenPercent',
      'openToCartPercent',
      'cartToOrderPercent',
      'marginPercent',
      'roiPercent',
      'turnoverDays',
    ]);
    const isRatioMetric = ratioMetrics.has(query.metric);

    function addValue(nmId: number, key: string, value: number) {
      const m = byNm.get(nmId) ?? new Map<string, number>();
      const prev = m.get(key) ?? 0;
      m.set(key, prev + (Number.isFinite(value) ? value : 0));
      byNm.set(nmId, m);
    }

    function addDenom(nmId: number, key: string, value: number) {
      const m = denomByNm.get(nmId) ?? new Map<string, number>();
      const prev = m.get(key) ?? 0;
      m.set(key, prev + (Number.isFinite(value) ? value : 0));
      denomByNm.set(nmId, m);
    }

    function addRatio(nmId: number, key: string, numerator: number, denominator: number) {
      addValue(nmId, key, numerator);
      addDenom(nmId, key, denominator);
    }

    if (
      [
        // ordersCount/ordersRub/salesCount/salesRub перенесены в funnel-блок
        // ниже (2026-06-01): они теперь читаются из wb_funnel_daily_products
        // (Analytics API), чтобы совпадать с WB ЛК «Воронка продаж» и xlsx-
        // отчётом. Statistics-таблица оставлена только для priceNoSppRub /
        // priceWithSppRub / sppPercent — там нужны её специфичные колонки
        // (discountPercentSumBp, finishedPriceRub).
        'priceNoSppRub',
        'priceWithSppRub',
        'sppPercent',
        'marginPercent',
        'turnoverDays',
      ].includes(query.metric)
    ) {
      const rows = await db
        .select({
          date: wbOrdersSalesDailyProducts.date,
          nmId: wbOrdersSalesDailyProducts.nmId,
          ordersCount: wbOrdersSalesDailyProducts.ordersCount,
          salesCount: wbOrdersSalesDailyProducts.salesCount,
          salesRub: wbOrdersSalesDailyProducts.salesRub,
          ordersRub: wbOrdersSalesDailyProducts.ordersRub,
          discountPercentSumBp: wbOrdersSalesDailyProducts.discountPercentSumBp,
          finishedPriceRub: wbOrdersSalesDailyProducts.finishedPriceRub,
        })
        .from(wbOrdersSalesDailyProducts)
        .where(
          and(
            eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbOrdersSalesDailyProducts.shopId, shopId),
            gte(wbOrdersSalesDailyProducts.date, from),
            lte(wbOrdersSalesDailyProducts.date, to),
            inArray(wbOrdersSalesDailyProducts.nmId, nmIds as any)
          )
        );
      for (const r of rows) {
        const k = groupBy === 'week' ? weekStart(String(r.date)) : String(r.date);
        const nmId = Number(r.nmId);
        if (query.metric === 'ordersCount') {
          addValue(nmId, k, Number(r.ordersCount));
        } else if (query.metric === 'salesCount') {
          addValue(nmId, k, Number(r.salesCount));
        } else if (query.metric === 'salesRub') {
          addValue(nmId, k, Number(r.salesRub) / 100);
        } else if (query.metric === 'ordersRub') {
          addValue(nmId, k, Number(r.ordersRub) / 100);
        } else if (query.metric === 'priceNoSppRub') {
          addRatio(nmId, k, Number(r.ordersRub), Number(r.ordersCount));
        } else if (query.metric === 'priceWithSppRub') {
          addRatio(nmId, k, Number(r.finishedPriceRub), Number(r.ordersCount));
        } else if (query.metric === 'sppPercent') {
          addRatio(nmId, k, Number(r.discountPercentSumBp), Number(r.ordersCount));
        } else if (query.metric === 'marginPercent') {
          addDenom(nmId, k, Number(r.ordersRub));
        } else if (query.metric === 'turnoverDays') {
          addDenom(nmId, k, Number(r.salesCount));
        }
      }
    }

    if (['advSpendRub', 'advManualSpendRub', 'advManualDrrPercent', 'advUnifiedSpendRub', 'advUnifiedDrrPercent'].includes(query.metric)) {
      const rows = await db
        .select({
          date: wbAdvDailyProducts.date,
          nmId: wbAdvDailyProducts.nmId,
          spendKopecks: wbAdvDailyProducts.spendKopecks,
          spendManualKopecks: wbAdvDailyProducts.spendManualKopecks,
          sumPriceManualKopecks: wbAdvDailyProducts.sumPriceManualKopecks,
          spendUnifiedKopecks: wbAdvDailyProducts.spendUnifiedKopecks,
          sumPriceUnifiedKopecks: wbAdvDailyProducts.sumPriceUnifiedKopecks,
        })
        .from(wbAdvDailyProducts)
        .where(
          and(
            eq(wbAdvDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbAdvDailyProducts.shopId, shopId),
            gte(wbAdvDailyProducts.date, from),
            lte(wbAdvDailyProducts.date, to),
            inArray(wbAdvDailyProducts.nmId, nmIds as any)
          )
        );
      for (const r of rows) {
        const k = groupBy === 'week' ? weekStart(String(r.date)) : String(r.date);
        const nmId = Number(r.nmId);
        if (query.metric === 'advSpendRub') {
          addValue(nmId, k, Number(r.spendKopecks) / 100);
        } else if (query.metric === 'advManualSpendRub') {
          addValue(nmId, k, Number(r.spendManualKopecks) / 100);
        } else if (query.metric === 'advManualDrrPercent') {
          addRatio(nmId, k, Number(r.spendManualKopecks), Number(r.sumPriceManualKopecks));
        } else if (query.metric === 'advUnifiedSpendRub') {
          addValue(nmId, k, Number(r.spendUnifiedKopecks) / 100);
        } else if (query.metric === 'advUnifiedDrrPercent') {
          addRatio(nmId, k, Number(r.spendUnifiedKopecks), Number(r.sumPriceUnifiedKopecks));
        }
      }
    }

    // DRR % = advSpend / salesRub * 100 (needs both adv + orders tables)
    if (query.metric === 'drrPercent') {
      const advRows = await db
        .select({ date: wbAdvDailyProducts.date, nmId: wbAdvDailyProducts.nmId, spendKopecks: wbAdvDailyProducts.spendKopecks })
        .from(wbAdvDailyProducts)
        .where(and(eq(wbAdvDailyProducts.workspaceId, params.workspaceId), buildShopFilter(wbAdvDailyProducts.shopId, shopId), gte(wbAdvDailyProducts.date, from), lte(wbAdvDailyProducts.date, to), inArray(wbAdvDailyProducts.nmId, nmIds as any)));
      for (const r of advRows) {
        const k = groupBy === 'week' ? weekStart(String(r.date)) : String(r.date);
        addValue(Number(r.nmId), k, Number(r.spendKopecks));
      }
      const salesRows = await db
        .select({ date: wbOrdersSalesDailyProducts.date, nmId: wbOrdersSalesDailyProducts.nmId, salesRub: wbOrdersSalesDailyProducts.salesRub })
        .from(wbOrdersSalesDailyProducts)
        .where(and(eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId), buildShopFilter(wbOrdersSalesDailyProducts.shopId, shopId), gte(wbOrdersSalesDailyProducts.date, from), lte(wbOrdersSalesDailyProducts.date, to), inArray(wbOrdersSalesDailyProducts.nmId, nmIds as any)));
      for (const r of salesRows) {
        const k = groupBy === 'week' ? weekStart(String(r.date)) : String(r.date);
        addDenom(Number(r.nmId), k, Number(r.salesRub));
      }
    }

    // cogsRub = COGS per unit * buyout count (from funnel)
    if (query.metric === 'cogsRub') {
      const cogsRows = await db
        .select({ nmId: wbCogs.nmId, cogsKopecks: wbCogs.cogsKopecks })
        .from(wbCogs)
        .where(and(eq(wbCogs.workspaceId, params.workspaceId), inArray(wbCogs.nmId, nmIds as any)));
      const localCogs = new Map<number, number>();
      for (const r of cogsRows) localCogs.set(Number(r.nmId), Number(r.cogsKopecks ?? 0));

      const funnelRows = await db
        .select({ date: wbFunnelDailyProducts.date, nmId: wbFunnelDailyProducts.nmId, buyoutCount: wbFunnelDailyProducts.buyoutCount })
        .from(wbFunnelDailyProducts)
        .where(and(eq(wbFunnelDailyProducts.workspaceId, params.workspaceId), buildShopFilter(wbFunnelDailyProducts.shopId, shopId), gte(wbFunnelDailyProducts.date, from), lte(wbFunnelDailyProducts.date, to), inArray(wbFunnelDailyProducts.nmId, nmIds as any)));
      for (const r of funnelRows) {
        const cogs = localCogs.get(Number(r.nmId)) ?? 0;
        if (!cogs) continue;
        const k = groupBy === 'week' ? weekStart(String(r.date)) : String(r.date);
        addValue(Number(r.nmId), k, (Number(r.buyoutCount) * cogs) / 100);
      }
    }

    if (['buyoutCount', 'buyoutSumRub', 'buyoutPercent', 'cancelCount', 'cancelSumRub',
         'viewCount', 'openCardCount', 'addToCartCount', 'addToWishlistCount', 'funnelOrderCount',
         'viewToOpenPercent', 'openToCartPercent', 'cartToOrderPercent',
         // 2026-06-01: переключено с Statistics на Funnel/Analytics —
         // совпадение 1:1 с WB ЛК «Воронка продаж» и xlsx-экспортом.
         'ordersCount', 'ordersRub', 'salesCount', 'salesRub'].includes(query.metric)) {
      const rows = await db
        .select({
          date: wbFunnelDailyProducts.date,
          nmId: wbFunnelDailyProducts.nmId,
          viewCount: wbFunnelDailyProducts.viewCount,
          openCardCount: wbFunnelDailyProducts.openCardCount,
          addToCartCount: wbFunnelDailyProducts.addToCartCount,
          addToWishlistCount: wbFunnelDailyProducts.addToWishlistCount,
          orderCount: wbFunnelDailyProducts.orderCount,
          orderSum: wbFunnelDailyProducts.orderSum,
          buyoutCount: wbFunnelDailyProducts.buyoutCount,
          buyoutSum: wbFunnelDailyProducts.buyoutSum,
          cancelCount: wbFunnelDailyProducts.cancelCount,
          cancelSum: wbFunnelDailyProducts.cancelSum,
        })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, from),
            lte(wbFunnelDailyProducts.date, to),
            inArray(wbFunnelDailyProducts.nmId, nmIds as any)
          )
        );
      for (const r of rows) {
        const k = groupBy === 'week' ? weekStart(String(r.date)) : String(r.date);
        const nmId = Number(r.nmId);
        if (query.metric === 'buyoutCount') {
          addValue(nmId, k, Number(r.buyoutCount));
        } else if (query.metric === 'buyoutSumRub') {
          addValue(nmId, k, Number(r.buyoutSum));
        } else if (query.metric === 'buyoutPercent') {
          addRatio(nmId, k, Number(r.buyoutCount), Number(r.orderCount));
        } else if (query.metric === 'cancelCount') {
          addValue(nmId, k, Number(r.cancelCount));
        } else if (query.metric === 'cancelSumRub') {
          addValue(nmId, k, Number(r.cancelSum));
        } else if (query.metric === 'viewCount') {
          addValue(nmId, k, Number(r.viewCount));
        } else if (query.metric === 'openCardCount') {
          addValue(nmId, k, Number(r.openCardCount));
        } else if (query.metric === 'addToCartCount') {
          addValue(nmId, k, Number(r.addToCartCount));
        } else if (query.metric === 'addToWishlistCount') {
          addValue(nmId, k, Number(r.addToWishlistCount));
        } else if (query.metric === 'funnelOrderCount') {
          addValue(nmId, k, Number(r.orderCount));
        } else if (query.metric === 'viewToOpenPercent') {
          addRatio(nmId, k, Number(r.openCardCount), Number(r.viewCount));
        } else if (query.metric === 'openToCartPercent') {
          addRatio(nmId, k, Number(r.addToCartCount), Number(r.openCardCount));
        } else if (query.metric === 'cartToOrderPercent') {
          addRatio(nmId, k, Number(r.orderCount), Number(r.addToCartCount));
        } else if (query.metric === 'ordersCount') {
          // 2026-06-01: «Заказы шт» теперь из Analytics (= WB ЛК)
          addValue(nmId, k, Number(r.orderCount));
        } else if (query.metric === 'ordersRub') {
          // 2026-06-01: «Заказы ₽» теперь из Analytics. order_sum в funnel
          // уже в рублях (не копейки), поэтому без /100.
          addValue(nmId, k, Number(r.orderSum));
        } else if (query.metric === 'salesCount') {
          // 2026-06-01: «Продажи шт» = выкупы (Analytics)
          addValue(nmId, k, Number(r.buyoutCount));
        } else if (query.metric === 'salesRub') {
          // 2026-06-01: «Продажи ₽» = сумма выкупов (Analytics)
          addValue(nmId, k, Number(r.buyoutSum));
        }
      }
    }

    if (['stockQty', 'stockInWayTo', 'stockInWayFrom', 'stockMoneyRub', 'turnoverDays'].includes(query.metric)) {
      const rows = await db
        .select({
          date: wbStocksDailyProducts.date,
          nmId: wbStocksDailyProducts.nmId,
          quantity: wbStocksDailyProducts.quantity,
          inWayToClient: wbStocksDailyProducts.inWayToClient,
          inWayFromClient: wbStocksDailyProducts.inWayFromClient,
        })
        .from(wbStocksDailyProducts)
        .where(
          and(
            eq(wbStocksDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbStocksDailyProducts.shopId, shopId),
            gte(wbStocksDailyProducts.date, from),
            lte(wbStocksDailyProducts.date, to),
            inArray(wbStocksDailyProducts.nmId, nmIds as any)
          )
        );
      for (const r of rows) {
        const k = groupBy === 'week' ? weekStart(String(r.date)) : String(r.date);
        const nmId = Number(r.nmId);
        if (query.metric === 'stockQty') {
          addValue(nmId, k, Number(r.quantity));
        } else if (query.metric === 'stockInWayTo') {
          addValue(nmId, k, Number(r.inWayToClient));
        } else if (query.metric === 'stockInWayFrom') {
          addValue(nmId, k, Number(r.inWayFromClient));
        } else if (query.metric === 'stockMoneyRub') {
          const cogs = cogsByNm.get(nmId) ?? 0;
          const qty = Number(r.quantity ?? 0) + Number(r.inWayToClient ?? 0) + Number(r.inWayFromClient ?? 0);
          const v = cogs ? (qty * cogs) / 100 : 0;
          addValue(nmId, k, v);
        } else if (query.metric === 'turnoverDays') {
          addValue(nmId, k, Number(r.quantity));
        }
      }
    }

    if (
      ['payoutRub', 'additionalPaymentRub', 'commissionRub', 'logisticsRub', 'storageRub', 'penaltyRub', 'acquiringRub',
       'returnsCount', 'marginRub', 'marginPercent', 'roiPercent', 'netProfitRub', 'taxRub'].includes(query.metric)
    ) {
      const rows = await db
        .select({
          date: wbFinanceDailyProducts.date,
          nmId: wbFinanceDailyProducts.nmId,
          payoutKopecks: wbFinanceDailyProducts.incomeFromSalesKopecks,
          additionalPaymentKopecks: wbFinanceDailyProducts.additionalPaymentsKopecks,
          commissionKopecks: wbFinanceDailyProducts.commissionKopecks,
          logisticsKopecks: wbFinanceDailyProducts.logisticsKopecks,
          storageKopecks: wbFinanceDailyProducts.storageKopecks,
          penaltyKopecks: wbFinanceDailyProducts.penaltiesKopecks,
          acquiringKopecks: wbFinanceDailyProducts.acquiringKopecks,
          returnsCount: wbFinanceDailyProducts.returnsCount,
        })
        .from(wbFinanceDailyProducts)
        .where(
          and(
            eq(wbFinanceDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFinanceDailyProducts.shopId, shopId),
            gte(wbFinanceDailyProducts.date, from),
            lte(wbFinanceDailyProducts.date, to),
            inArray(wbFinanceDailyProducts.nmId, nmIds as any)
          )
        );

      // For netProfit we need ad spend too — масштабируем к xlsx ЛК ВБ.
      const advByDay = new Map<string, Map<number, number>>();
      if (query.metric === 'netProfitRub') {
        const adv = await db
          .select({ date: wbAdvDailyProducts.date, nmId: wbAdvDailyProducts.nmId, spendKopecks: wbAdvDailyProducts.spendKopecks })
          .from(wbAdvDailyProducts)
          .where(
            and(
              eq(wbAdvDailyProducts.workspaceId, params.workspaceId),
              buildShopFilter(wbAdvDailyProducts.shopId, shopId),
              gte(wbAdvDailyProducts.date, from),
              lte(wbAdvDailyProducts.date, to),
              inArray(wbAdvDailyProducts.nmId, nmIds as any)
            )
          );
        const advScaleHere = await getAdvSpendScale(params.workspaceId, shopId, from, to);
        for (const a of adv) {
          const k = String(a.date);
          const m = advByDay.get(k) ?? new Map<number, number>();
          const scaled = Math.round(Number(a.spendKopecks) * advScaleHere);
          m.set(Number(a.nmId), (m.get(Number(a.nmId)) ?? 0) + scaled);
          advByDay.set(k, m);
        }
      }

      for (const r of rows) {
        const iso = String(r.date);
        const k = groupBy === 'week' ? weekStart(iso) : iso;
        const nmId = Number(r.nmId);

        const payout = Number(r.payoutKopecks);
        const additional = Number(r.additionalPaymentKopecks);
        const commission = Number(r.commissionKopecks);
        const logistics = Number(r.logisticsKopecks);
        const storage = Number(r.storageKopecks);
        const penalty = Number(r.penaltyKopecks);
        const acquiring = Number(r.acquiringKopecks);
        const returns = Number(r.returnsCount ?? 0);

        const margin = payout + additional - logistics - storage - penalty - acquiring;
        const advK = query.metric === 'netProfitRub' ? advByDay.get(iso)?.get(nmId) ?? 0 : 0;
        const net = margin - advK;

        if (query.metric === 'returnsCount') {
          addValue(nmId, k, returns);
          continue;
        }

        if (query.metric === 'marginPercent') {
          addValue(nmId, k, margin);
          continue;
        }

        if (query.metric === 'roiPercent') {
          const cogsKopecks = cogsCostByDay.get(`${iso}|${nmId}`) ?? 0;
          const marketplaceCosts = logistics + storage + penalty + acquiring;
          // Tax cannot be negative (no refund for losses)
          const taxKopecks = Math.max(0, Math.round((payout - marketplaceCosts - cogsKopecks) * taxRate));
          const denom = marketplaceCosts + cogsKopecks + taxKopecks;
          addRatio(nmId, k, payout, denom);
          continue;
        }

        if (query.metric === 'taxRub') {
          const marketplaceCosts = logistics + storage + penalty + acquiring;
          const preTax = payout + additional - marketplaceCosts;
          // Tax cannot be negative (no refund for losses)
          const taxKopecks = Math.max(0, Math.round(preTax * taxRate));
          addValue(nmId, k, taxKopecks / 100);
          continue;
        }

        let vKopecks = 0;
        if (query.metric === 'payoutRub') vKopecks = payout;
        else if (query.metric === 'additionalPaymentRub') vKopecks = additional;
        else if (query.metric === 'commissionRub') vKopecks = commission;
        else if (query.metric === 'logisticsRub') vKopecks = logistics;
        else if (query.metric === 'storageRub') vKopecks = storage;
        else if (query.metric === 'penaltyRub') vKopecks = penalty;
        else if (query.metric === 'acquiringRub') vKopecks = acquiring;
        else if (query.metric === 'marginRub') vKopecks = margin;
        else if (query.metric === 'netProfitRub') vKopecks = net;

        addValue(nmId, k, vKopecks / 100);
      }
    }

    if (isRatioMetric) {
      for (const [nmId, m] of byNm.entries()) {
        const d = denomByNm.get(nmId) ?? new Map<string, number>();
        for (const k of dateKeys) {
          const num = m.get(k) ?? 0;
          const den = d.get(k) ?? 0;
          let v = 0;
          if (den > 0) {
            if (query.metric === 'priceNoSppRub' || query.metric === 'priceWithSppRub') {
              v = num / den / 100; // kopecks -> rub
            } else if (query.metric === 'sppPercent') {
              v = num / den / 100; // bp -> %
            } else if (query.metric === 'buyoutPercent') {
              v = (num / den) * 100;
            } else if (
              query.metric === 'viewToOpenPercent' ||
              query.metric === 'openToCartPercent' ||
              query.metric === 'cartToOrderPercent'
            ) {
              v = (num / den) * 100;
            } else if (query.metric === 'drrPercent') {
              v = (num / den) * 100; // advSpendKopecks / salesRubKopecks * 100
            } else if (
              query.metric === 'advManualDrrPercent' ||
              query.metric === 'advUnifiedDrrPercent' ||
              query.metric === 'marginPercent' ||
              query.metric === 'roiPercent'
            ) {
              v = (num / den) * 100;
            } else if (query.metric === 'turnoverDays') {
              v = num / den;
            }
          }
          m.set(k, v);
        }
      }
    }

    // Card meta
    const cards = await db
      .select({ nmId: wbCards.nmId, title: wbCards.title, vendorCode: wbCards.vendorCode, brandName: wbCards.brandName, mainPhotoUrl: wbCards.mainPhotoUrl })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds as any)));
    const cardBy = new Map<number, any>(cards.map((c) => [Number(c.nmId), c] as const));

    function median(xs: number[]): number {
      const arr = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      if (arr.length === 0) return 0;
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 === 1 ? arr[mid]! : (arr[mid - 1]! + arr[mid]!) / 2;
    }

    function computeAnomalies(values: number[]): Array<{ low?: boolean; high?: boolean; pctDiff?: number; baseline?: number }> {
      const out = values.map(() => ({} as any));
      const w = Math.max(3, anomalyWindow);
      for (let i = 0; i < values.length; i++) {
        const cur = values[i];
        if (!Number.isFinite(cur)) continue;
        const start = Math.max(0, i - w);
        const end = Math.min(values.length - 1, i + w);
        const win = [] as number[];
        for (let j = start; j <= end; j++) {
          if (j === i) continue;
          const v = values[j];
          if (Number.isFinite(v)) win.push(v);
        }
        const base = median(win);
        if (base === 0) continue;
        const pct = ((cur - base) / base) * 100;
        if (Math.abs(pct) >= anomalyThresholdPct) out[i] = { low: pct < 0, high: pct > 0, pctDiff: Math.round(pct * 100) / 100, baseline: Math.round(base * 100) / 100 };
      }
      return out;
    }

    const rows = nmIds
      .filter((n) => n > 0)
      .map((nmId) => {
        const m = byNm.get(nmId) ?? new Map();
        const values = dateKeys.map((k) => m.get(k) ?? 0);
        const anomalies = computeAnomalies(values);
        const c = cardBy.get(nmId) ?? null;
        return {
          nmId,
          title: c?.title ?? null,
          vendorCode: c?.vendorCode ?? null,
          brandName: c?.brandName ?? null,
          mainPhotoUrl: c?.mainPhotoUrl ?? null,
          values,
          anomalies,
        };
      });

    // 2026-06-01: kpiTotal = независимая агрегация ПО ВСЕМ товарам shop+period
    // (не ограничено limit/offset). Frontend использует это для верхних
    // сводных плашек («Заказы за период», «Выручка», «% выкупа») —
    // чтобы пагинация таблицы не искажала KPI.
    const kpiTotalRow = await db.execute<{
      orders_count: number;
      orders_rub: number;
      buyouts_count: number;
      buyouts_rub: number;
      cancels_count: number;
      cancels_rub: number;
      views: number;
      opens: number;
      carts: number;
    }>(sql`
      SELECT
        COALESCE(SUM(${wbFunnelDailyProducts.orderCount}), 0)::bigint AS orders_count,
        COALESCE(SUM(${wbFunnelDailyProducts.orderSum}), 0)::numeric AS orders_rub,
        COALESCE(SUM(${wbFunnelDailyProducts.buyoutCount}), 0)::bigint AS buyouts_count,
        COALESCE(SUM(${wbFunnelDailyProducts.buyoutSum}), 0)::numeric AS buyouts_rub,
        COALESCE(SUM(${wbFunnelDailyProducts.cancelCount}), 0)::bigint AS cancels_count,
        COALESCE(SUM(${wbFunnelDailyProducts.cancelSum}), 0)::numeric AS cancels_rub,
        COALESCE(SUM(${wbFunnelDailyProducts.viewCount}), 0)::bigint AS views,
        COALESCE(SUM(${wbFunnelDailyProducts.openCardCount}), 0)::bigint AS opens,
        COALESCE(SUM(${wbFunnelDailyProducts.addToCartCount}), 0)::bigint AS carts
      FROM ${wbFunnelDailyProducts}
      WHERE ${wbFunnelDailyProducts.workspaceId} = ${params.workspaceId}
        AND ${wbFunnelDailyProducts.date} >= ${from}
        AND ${wbFunnelDailyProducts.date} <= ${to}
        ${shopId ? sql`AND ${wbFunnelDailyProducts.shopId} = ${shopId}` : sql``}
    `);
    const kpiRow = (kpiTotalRow as any).rows?.[0] ?? {};
    const ordersCountTotal = Number(kpiRow.orders_count ?? 0);
    const buyoutsCountTotal = Number(kpiRow.buyouts_count ?? 0);
    const cancelsCountTotal = Number(kpiRow.cancels_count ?? 0);

    return {
      workspaceId: params.workspaceId,
      from,
      to,
      groupBy,
      metric: query.metric,
      dateKeys,
      totalCount,
      page: { offset: query.offset, limit: query.limit, pageSize: rows.length },
      kpiTotal: {
        ordersCount: ordersCountTotal,
        ordersRub: Number(kpiRow.orders_rub ?? 0),
        buyoutsCount: buyoutsCountTotal,
        buyoutsRub: Number(kpiRow.buyouts_rub ?? 0),
        cancelsCount: cancelsCountTotal,
        cancelsRub: Number(kpiRow.cancels_rub ?? 0),
        viewsCount: Number(kpiRow.views ?? 0),
        opensCount: Number(kpiRow.opens ?? 0),
        cartsCount: Number(kpiRow.carts ?? 0),
        buyoutPct: ordersCountTotal > 0 ? Math.round((buyoutsCountTotal / ordersCountTotal) * 1000) / 10 : 0,
        cancelPct: ordersCountTotal > 0 ? Math.round((cancelsCountTotal / ordersCountTotal) * 1000) / 10 : 0,
      },
      rows,
    };
  });

  // Детализация заказов по статусам (для % выкупа и анализа)
  app.get('/pulse/:workspaceId/orders-breakdown', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      nmIds: z.string().optional(),
      tagId: z.coerce.number().int().positive().optional(),
      groupBy: z.enum(['day', 'week', 'month', 'total']).optional(),
    }).parse(req.query);

    const today = getToday(); // returns string YYYY-MM-DD
    const to = query.to ?? today;
    const from = query.from ?? fmtDate(addDays(parseDate(to), -30));
    const groupBy = query.groupBy ?? 'day';

    // Фильтрация по товарам
    const filterNmIds = await getFilteredNmIds(params.workspaceId, {
      nmIds: query.nmIds,
      tagId: query.tagId,
    } as PulseFilterOptions);

    // 2026-06-01: «Заказы»/«Продажи» теперь из Analytics-funnel (= WB ЛК).
    // orderSum/buyoutSum в funnel уже в рублях (не копейках), поэтому ниже
    // потребитель этих данных НЕ делит на 100. Сохраняем имена полей
    // (ordersRub/salesRub/ordersCount/salesCount) для совместимости с
    // фронтом — frontend не знает что источник сменился.
    const ordersData = await db
      .select({
        date: wbFunnelDailyProducts.date,
        nmId: wbFunnelDailyProducts.nmId,
        ordersCount: wbFunnelDailyProducts.orderCount,
        ordersRub: sql<number>`${wbFunnelDailyProducts.orderSum} * 100`.mapWith(Number),
        salesCount: wbFunnelDailyProducts.buyoutCount,
        salesRub: sql<number>`${wbFunnelDailyProducts.buyoutSum} * 100`.mapWith(Number),
      })
      .from(wbFunnelDailyProducts)
      .where(
        and(
          eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
          gte(wbFunnelDailyProducts.date, from),
          lte(wbFunnelDailyProducts.date, to),
          buildShopFilter(wbFunnelDailyProducts.shopId, query.shopId),
          filterNmIds ? inArray(wbFunnelDailyProducts.nmId, filterNmIds) : undefined,
        )
      );

    // Загружаем данные по воронке (для отмен и выкупов)
    const funnelData = await db
      .select({
        date: wbFunnelDailyProducts.date,
        nmId: wbFunnelDailyProducts.nmId,
        orderCount: wbFunnelDailyProducts.orderCount,
        buyoutCount: wbFunnelDailyProducts.buyoutCount,
        cancelCount: wbFunnelDailyProducts.cancelCount,
      })
      .from(wbFunnelDailyProducts)
      .where(
        and(
          eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
          gte(wbFunnelDailyProducts.date, from),
          lte(wbFunnelDailyProducts.date, to),
          buildShopFilter(wbFunnelDailyProducts.shopId, query.shopId),
          filterNmIds ? inArray(wbFunnelDailyProducts.nmId, filterNmIds) : undefined,
        )
      );

    // Группировка
    function getPeriodKey(dateStr: string): string {
      if (groupBy === 'total') return 'total';
      if (groupBy === 'day') return dateStr;
      if (groupBy === 'month') return dateStr.slice(0, 7);
      // week — weekStart принимает ISO string (YYYY-MM-DD)
      return weekStart(dateStr);
    }

    // Агрегация по периодам
    const periodMap = new Map<string, {
      periodKey: string;
      ordersCount: number;
      ordersRub: number;
      salesCount: number;
      salesRub: number;
      buyoutCount: number;
      cancelCount: number;
      inTransitCount: number; // orders - sales - cancels
    }>();

    // Сначала агрегируем orders
    for (const row of ordersData) {
      const key = getPeriodKey(row.date);
      let p = periodMap.get(key);
      if (!p) {
        p = {
          periodKey: key,
          ordersCount: 0,
          ordersRub: 0,
          salesCount: 0,
          salesRub: 0,
          buyoutCount: 0,
          cancelCount: 0,
          inTransitCount: 0,
        };
        periodMap.set(key, p);
      }
      p.ordersCount += Number(row.ordersCount) || 0;
      p.ordersRub += Number(row.ordersRub) || 0;
      p.salesCount += Number(row.salesCount) || 0;
      p.salesRub += Number(row.salesRub) || 0;
    }

    // Добавляем данные из воронки
    for (const row of funnelData) {
      const key = getPeriodKey(row.date);
      const p = periodMap.get(key);
      if (p) {
        p.buyoutCount += Number(row.buyoutCount) || 0;
        p.cancelCount += Number(row.cancelCount) || 0;
      }
    }

    // Формируем результат
    const rows = Array.from(periodMap.values())
      .sort((a, b) => a.periodKey.localeCompare(b.periodKey))
      .map(p => {
        // В пути = Заказы - Выкупы - Отмены
        p.inTransitCount = Math.max(0, p.ordersCount - p.buyoutCount - p.cancelCount);
        
        // Проценты
        const buyoutPct = p.ordersCount > 0 ? (p.buyoutCount / p.ordersCount) * 100 : 0;
        const cancelPct = p.ordersCount > 0 ? (p.cancelCount / p.ordersCount) * 100 : 0;
        const inTransitPct = p.ordersCount > 0 ? (p.inTransitCount / p.ordersCount) * 100 : 0;
        const avgOrderPrice = p.ordersCount > 0 ? p.ordersRub / p.ordersCount : 0;

        return {
          ...p,
          ordersRub: Math.round(p.ordersRub),
          salesRub: Math.round(p.salesRub),
          avgOrderPrice: Math.round(avgOrderPrice),
          buyoutPct: Math.round(buyoutPct * 10) / 10,
          cancelPct: Math.round(cancelPct * 10) / 10,
          inTransitPct: Math.round(inTransitPct * 10) / 10,
        };
      });

    // Итоги
    const totals = {
      ordersCount: rows.reduce((s, r) => s + r.ordersCount, 0),
      ordersRub: rows.reduce((s, r) => s + r.ordersRub, 0),
      salesCount: rows.reduce((s, r) => s + r.salesCount, 0),
      salesRub: rows.reduce((s, r) => s + r.salesRub, 0),
      buyoutCount: rows.reduce((s, r) => s + r.buyoutCount, 0),
      cancelCount: rows.reduce((s, r) => s + r.cancelCount, 0),
      inTransitCount: rows.reduce((s, r) => s + r.inTransitCount, 0),
      buyoutPct: 0,
      cancelPct: 0,
      inTransitPct: 0,
      avgOrderPrice: 0,
    };

    if (totals.ordersCount > 0) {
      totals.buyoutPct = Math.round((totals.buyoutCount / totals.ordersCount) * 1000) / 10;
      totals.cancelPct = Math.round((totals.cancelCount / totals.ordersCount) * 1000) / 10;
      totals.inTransitPct = Math.round((totals.inTransitCount / totals.ordersCount) * 1000) / 10;
      totals.avgOrderPrice = Math.round(totals.ordersRub / totals.ordersCount);
    }

    return {
      workspaceId: params.workspaceId,
      shopId: query.shopId ?? null,
      from,
      to,
      groupBy,
      periodsCount: rows.length,
      rows,
      totals,
    };
  });
};
