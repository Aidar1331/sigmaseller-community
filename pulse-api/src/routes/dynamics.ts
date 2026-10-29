import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { 
  wbAdvDaily, 
  wbAdvDailyProducts, 
  wbCards, 
  wbFunnelDailyProducts, 
  wbOrdersSalesDailyProducts, 
  wbTagProducts,
  wbFinanceDailyProducts,
  wbStocksDailyProducts,
} from '../db/schema.js';
import { guardedSpawn } from '../lib/guardedSpawn.js';
import { requireRole } from '../plugins/roleCheck.js';
import { log as rootLog } from '../lib/logger.js';

const log = rootLog.child({ module: 'dynamics' });
import { buildShopFilter } from './pulse/helpers.js';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let dt = new Date(from + 'T00:00:00Z'); dt <= new Date(to + 'T00:00:00Z'); ) {
    out.push(dt.toISOString().slice(0, 10));
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return out;
}

function daysBetweenInclusive(from: string, to: string): number {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  const diff = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  return Math.max(1, diff);
}

export const dynamicsRoutes: FastifyPluginAsync = async (app) => {
  // Product dynamics: orders/sales timeseries with finance, funnel, ads, stocks
  app.get('/dynamics/:workspaceId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        nmIds: z.string().optional(),
        tagId: z.coerce.number().int().positive().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    
    const shopId = query.shopId;

    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));

    let nmIds = (query.nmIds ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    // tag filter
    if (query.tagId) {
      const links = await db
        .select({ nmId: wbTagProducts.nmId })
        .from(wbTagProducts)
        .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.tagId, query.tagId)));
      nmIds = links.map((l: any) => Number(l.nmId)).filter((n) => Number.isFinite(n) && n > 0);
    }

    if (nmIds.length === 0) return { workspaceId: params.workspaceId, start, end, rows: [] };
    if (nmIds.length > 50) nmIds = nmIds.slice(0, 50);

    // 1) Orders/Sales from DB
    const cached = await db
      .select({
        date: wbOrdersSalesDailyProducts.date,
        nmId: wbOrdersSalesDailyProducts.nmId,
        ordersCount: wbOrdersSalesDailyProducts.ordersCount,
        salesCount: wbOrdersSalesDailyProducts.salesCount,
        salesRub: wbOrdersSalesDailyProducts.salesRub,
        forPayRub: wbOrdersSalesDailyProducts.forPayRub,
      })
      .from(wbOrdersSalesDailyProducts)
      .where(
        and(
          eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId),
          buildShopFilter(wbOrdersSalesDailyProducts.shopId, shopId),
          gte(wbOrdersSalesDailyProducts.date, start),
          lte(wbOrdersSalesDailyProducts.date, end),
          inArray(wbOrdersSalesDailyProducts.nmId, nmIds as any)
        )
      );

    const haveDays = new Set(cached.map((r: any) => `${r.date}|${r.nmId}`));
    const days = enumerateDays(start, end);
    const missingKeys: Array<{ date: string; nmId: number }> = [];
    for (const d of days) {
      for (const id of nmIds) {
        const k = `${d}|${id}`;
        if (!haveDays.has(k)) missingKeys.push({ date: d, nmId: id });
      }
    }

    const daysBack = daysBetweenInclusive(start, end);

    let ordersSalesSync = false;
    if (missingKeys.length) {
      ordersSalesSync = true;
      guardedSpawn(params.workspaceId, 'wb:orders-sales:to-db', 'orders-sales', { DAYS_BACK: String(daysBack) }).catch((err) => log.error({ err, workspaceId: params.workspaceId }, 'orders-sales sync failed'));
    }

    // Build dense matrix
    const cachedByKey = new Map<string, any>(cached.map((r: any) => [`${r.date}|${r.nmId}`, r]));
    const fresh: any[] = [];
    for (const d of days) {
      for (const id of nmIds) {
        const k = `${d}|${id}`;
        const row = cachedByKey.get(k);
        fresh.push(row ?? { date: d, nmId: id, ordersCount: 0, salesCount: 0, salesRub: 0, forPayRub: 0 });
      }
    }

    // 2) Check funnel sync
    const funnelCached = await db
      .select({ date: wbFunnelDailyProducts.date, nmId: wbFunnelDailyProducts.nmId })
      .from(wbFunnelDailyProducts)
      .where(
        and(
          eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
          buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
          gte(wbFunnelDailyProducts.date, start),
          lte(wbFunnelDailyProducts.date, end),
          inArray(wbFunnelDailyProducts.nmId, nmIds as any)
        )
      );
    const haveFunnel = new Set(funnelCached.map((r) => `${r.date}|${r.nmId}`));
    let funnelSync = false;
    for (const d of days) {
      for (const id of nmIds) {
        if (!haveFunnel.has(`${d}|${id}`)) { funnelSync = true; break; }
      }
      if (funnelSync) break;
    }
    if (funnelSync) {
      guardedSpawn(params.workspaceId, 'wb:funnel:products:to-db', 'funnel-products', { DAYS_BACK_LIST: String(daysBack) }).catch((err) => log.error({ err, workspaceId: params.workspaceId }, 'funnel-products sync failed'));
    }

    // 3) Check finance sync
    const financeCached = await db
      .select({ date: wbFinanceDailyProducts.date, nmId: wbFinanceDailyProducts.nmId })
      .from(wbFinanceDailyProducts)
      .where(
        and(
          eq(wbFinanceDailyProducts.workspaceId, params.workspaceId),
          buildShopFilter(wbFinanceDailyProducts.shopId, shopId),
          gte(wbFinanceDailyProducts.date, start),
          lte(wbFinanceDailyProducts.date, end),
          inArray(wbFinanceDailyProducts.nmId, nmIds as any)
        )
      );
    const haveFinance = new Set(financeCached.map((r) => `${r.date}|${r.nmId}`));
    let financeSync = false;
    for (const d of days) {
      for (const id of nmIds) {
        if (!haveFinance.has(`${d}|${id}`)) { financeSync = true; break; }
      }
      if (financeSync) break;
    }
    if (financeSync) {
      guardedSpawn(params.workspaceId, 'wb:finance:to-db', 'finance', { DAYS_BACK: String(daysBack), WINDOW_DAYS: '7' }).catch((err) => log.error({ err, workspaceId: params.workspaceId }, 'finance sync failed'));
    }

    // 4) Load all related data in parallel
    const [funnel, finance, stocks, advProd, adv, cards] = await Promise.all([
      // Funnel
      db
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
          buyoutPercentBp: wbFunnelDailyProducts.buyoutPercentBp,
        })
        .from(wbFunnelDailyProducts)
        .where(
          and(
            eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFunnelDailyProducts.shopId, shopId),
            gte(wbFunnelDailyProducts.date, start),
            lte(wbFunnelDailyProducts.date, end),
            inArray(wbFunnelDailyProducts.nmId, nmIds as any)
          )
        ),
      // Finance
      db
        .select({
          date: wbFinanceDailyProducts.date,
          nmId: wbFinanceDailyProducts.nmId,
          revenueKopecks: wbFinanceDailyProducts.revenueKopecks,
          incomeFromSalesKopecks: wbFinanceDailyProducts.incomeFromSalesKopecks,
          commissionKopecks: wbFinanceDailyProducts.commissionKopecks,
          logisticsKopecks: wbFinanceDailyProducts.logisticsKopecks,
          returnLogisticsKopecks: wbFinanceDailyProducts.returnLogisticsKopecks,
          storageKopecks: wbFinanceDailyProducts.storageKopecks,
          penaltiesKopecks: wbFinanceDailyProducts.penaltiesKopecks,
          acquiringKopecks: wbFinanceDailyProducts.acquiringKopecks,
          additionalPaymentsKopecks: wbFinanceDailyProducts.additionalPaymentsKopecks,
          returnsCount: wbFinanceDailyProducts.returnsCount,
        })
        .from(wbFinanceDailyProducts)
        .where(
          and(
            eq(wbFinanceDailyProducts.workspaceId, params.workspaceId),
            buildShopFilter(wbFinanceDailyProducts.shopId, shopId),
            gte(wbFinanceDailyProducts.date, start),
            lte(wbFinanceDailyProducts.date, end),
            inArray(wbFinanceDailyProducts.nmId, nmIds as any)
          )
        ),
      // Stocks
      db
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
            gte(wbStocksDailyProducts.date, start),
            lte(wbStocksDailyProducts.date, end),
            inArray(wbStocksDailyProducts.nmId, nmIds as any)
          )
        ),
      // Ads per product
      db
        .select({ date: wbAdvDailyProducts.date, nmId: wbAdvDailyProducts.nmId, spendKopecks: wbAdvDailyProducts.spendKopecks })
        .from(wbAdvDailyProducts)
        .where(
          and(
            eq(wbAdvDailyProducts.workspaceId, params.workspaceId),
            gte(wbAdvDailyProducts.date, start),
            lte(wbAdvDailyProducts.date, end),
            inArray(wbAdvDailyProducts.nmId, nmIds as any)
          )
        ),
      // Ads total
      db
        .select({ date: wbAdvDaily.date, spendKopecks: wbAdvDaily.spendKopecks })
        .from(wbAdvDaily)
        .where(and(eq(wbAdvDaily.workspaceId, params.workspaceId), gte(wbAdvDaily.date, start), lte(wbAdvDaily.date, end))),
      // Cards
      db
        .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title })
        .from(wbCards)
        .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds as any))),
    ]);

    // Build lookup maps
    const funnelBy = new Map(funnel.map((r: any) => [`${r.date}|${r.nmId}`, r] as const));
    const financeBy = new Map(finance.map((r: any) => [`${r.date}|${r.nmId}`, r] as const));
    const stocksBy = new Map(stocks.map((r: any) => [`${r.date}|${r.nmId}`, r] as const));
    const advByDateNm = new Map((advProd as any[]).map((r) => [`${r.date}|${r.nmId}`, r.spendKopecks] as const));
    const advByDate = new Map((adv as any[]).map((r) => [r.date, r.spendKopecks] as const));
    const cardBy = new Map((cards as any[]).map((c) => [c.nmId, c] as const));

    // Build output rows
    const out = (fresh as any[]).map((r) => {
      const c = cardBy.get(r.nmId);
      const salesRub = (r.salesRub ?? 0) / 100;
      const salesCount = r.salesCount ?? 0;
      const avgPrice = salesCount > 0 ? Math.round((salesRub / salesCount) * 100) / 100 : 0;

      // Funnel
      const f = funnelBy.get(`${r.date}|${r.nmId}`);
      const viewCount = f?.viewCount ?? 0;
      const openCardCount = f?.openCardCount ?? 0;
      const addToCartCount = f?.addToCartCount ?? 0;
      const addToWishlistCount = f?.addToWishlistCount ?? 0;
      const orderCount = f?.orderCount ?? 0;
      const buyoutCount = f?.buyoutCount ?? 0;
      const buyoutPct = typeof f?.buyoutPercentBp === 'number' ? f.buyoutPercentBp / 100 : 0;
      const orderSumRub = (f?.orderSum ?? 0) as number;
      const viewToOpenPercent = viewCount > 0 ? Math.round((openCardCount / viewCount) * 10000) / 100 : 0;
      const openToCartPercent = openCardCount > 0 ? Math.round((addToCartCount / openCardCount) * 10000) / 100 : 0;
      const cartToOrderPercent = addToCartCount > 0 ? Math.round((orderCount / addToCartCount) * 10000) / 100 : 0;

      // Finance
      const fin = financeBy.get(`${r.date}|${r.nmId}`);
      const payoutRub = (fin?.incomeFromSalesKopecks ?? 0) / 100;
      const commissionRub = (fin?.commissionKopecks ?? 0) / 100;
      const logisticsRub = ((fin?.logisticsKopecks ?? 0) + (fin?.returnLogisticsKopecks ?? 0)) / 100;
      const storageRub = (fin?.storageKopecks ?? 0) / 100;
      const penaltyRub = (fin?.penaltiesKopecks ?? 0) / 100;
      const acquiringRub = (fin?.acquiringKopecks ?? 0) / 100;
      const additionalPaymentRub = (fin?.additionalPaymentsKopecks ?? 0) / 100;
      const financeReturnsCount = fin?.returnsCount ?? 0;

      // Stocks
      const st = stocksBy.get(`${r.date}|${r.nmId}`);
      const stockQty = st?.quantity ?? null;
      const stockInWayTo = st?.inWayToClient ?? 0;
      const stockInWayFrom = st?.inWayFromClient ?? 0;

      // Ads
      const advSpendRub = ((advByDateNm.get(`${r.date}|${r.nmId}`) ?? 0) as number) / 100;
      const drrPct = salesRub > 0 ? Math.round((advSpendRub / salesRub) * 10000) / 100 : 0;

      // Calculated: margin, profit
      const marginRub = payoutRub + additionalPaymentRub - logisticsRub - storageRub - penaltyRub - acquiringRub;
      const ordersRub = (r.salesRub ?? 0) / 100; // orders value (before commissions)
      const marginPercent = ordersRub > 0 ? Math.round((marginRub / ordersRub) * 10000) / 100 : 0;
      const netProfitRub = marginRub - advSpendRub;

      return {
        date: r.date,
        nmId: r.nmId,
        vendorCode: c?.vendorCode ?? null,
        title: c?.title ?? null,

        // Orders/Sales
        ordersCount: r.ordersCount ?? 0,
        salesCount,
        salesRub,
        forPayRub: (r.forPayRub ?? 0) / 100,
        avgPrice,

        // Funnel
        viewCount,
        openCardCount,
        addToWishlistCount,
        cartCount: addToCartCount,
        orderCount,
        orderSumRub,
        buyoutCount,
        buyoutPercent: buyoutPct,
        viewToOpenPercent,
        openToCartPercent,
        cartToOrderPercent,
        cancelsCount: Math.max(0, orderCount - buyoutCount),

        // Finance
        payoutRub,
        commissionRub,
        logisticsRub,
        storageRub,
        penaltyRub,
        acquiringRub,
        additionalPaymentRub,
        marginRub,
        marginPercent,
        netProfitRub,
        returnsCount: financeReturnsCount,

        // Stocks
        stockQty,
        stockInWayTo,
        stockInWayFrom,

        // Ads
        advSpendRub,
        drrPercent: drrPct,
      };
    });

    return {
      workspaceId: params.workspaceId,
      start,
      end,
      rows: out,
      sync: { ordersSales: ordersSalesSync, funnel: funnelSync, finance: financeSync },
    };
  });
};
