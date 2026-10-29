import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbCards, wbCogs, wbFinanceWeeklyProducts, wbFinanceDaily, wbSppWeekly, wbAdvDailyProducts, wbOrdersSalesDailyProducts, wbStocksCurrent, wbFunnelDailyProducts, marketplaceShops } from '../db/schema.js';
import { getSalesFunnelProductsStat } from '../integrations/wb/analytics.js';
import { getCommissionTariffs, pickCommissionPercent } from '../integrations/wb/tariffs.js';
import { getWbApiKey, wbGetJson } from '../integrations/wb/wbClient.js';
import { requireRole } from '../plugins/roleCheck.js';
import { extractShopId } from '../plugins/shopFilter.js';
import { buildShopFilter } from './pulse/helpers.js';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function weekStart(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // 0=Mon
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function weekEnd(startIso: string): string {
  return isoDate(addDays(new Date(startIso + 'T00:00:00Z'), 6));
}

export const unitEconomicsRoutes: FastifyPluginAsync = async (app) => {
  // All products unit economics summary (расширенная версия по методологии Торгстат)
  app.get('/unit-economics/:workspaceId/all', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      tagId: z.coerce.number().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      sortBy: z.enum([
        'revenue', 'profit', 'margin', 'drr', 'cogs', 'qty', 'roi', 'roce', 'profitability', 
        'buyoutPct', 'advSpend', 'tacoo', 'tacos', 'netProfitPerUnit', 'commissionPct', 'logisticsPct',
        'ordersCount', 'salesQty', 'stockQty', 'stockMoneyRub', 'grossProfitRub', 'netProfitRub',
        // Воронка
        'funnelViewCount', 'funnelOpenCardCount', 'funnelAddToCartCount', 'funnelOrderCount', 'funnelBuyoutCount',
        'viewToOpenCr', 'openToCartCr', 'cartToOrderCr', 'orderToBuyoutCr', 'viewToBuyoutCr'
      ]).optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
      limit: z.coerce.number().min(1).max(500).optional(),
      offset: z.coerce.number().min(0).optional(),
      abcThresholdA: z.coerce.number().min(1).max(99).optional(), // для двумерного ABC
      abcThresholdB: z.coerce.number().min(1).max(100).optional(),
      taxRate: z.coerce.number().min(0).max(100).optional(), // переопределение ставки налога
      vatPct: z.coerce.number().min(0).max(100).optional(), // переопределение НДС
    }).parse(req.query);

    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const sortBy = query.sortBy ?? 'revenue';
    const sortOrder = query.sortOrder ?? 'desc';
    const abcThresholdA = query.abcThresholdA ?? 80;
    const abcThresholdB = query.abcThresholdB ?? 95;

    // 1. Финансовые данные по товарам
    const finance = await db
      .select({
        nmId: wbFinanceWeeklyProducts.nmId,
        revenueKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.revenueKopecks})`.as('revenueKopecks'),
        incomeKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.incomeFromSalesKopecks})`.as('incomeKopecks'),
        logisticsKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.logisticsKopecks})`.as('logisticsKopecks'),
        penaltiesKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.penaltiesKopecks})`.as('penaltiesKopecks'),
        storageKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.storageKopecks})`.as('storageKopecks'),
        paidAcceptanceKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.paidAcceptanceKopecks})`.as('paidAcceptanceKopecks'),
        additionalPaymentsKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.additionalPaymentsKopecks})`.as('additionalPaymentsKopecks'),
        otherHoldKopecks: sql<number>`sum(${wbFinanceWeeklyProducts.otherHoldKopecks})`.as('otherHoldKopecks'),
        saleQty: sql<number>`sum(${wbFinanceWeeklyProducts.lines})`.as('saleQty'),
      })
      .from(wbFinanceWeeklyProducts)
      .where(
        and(
          eq(wbFinanceWeeklyProducts.workspaceId, params.workspaceId),
          buildShopFilter(wbFinanceWeeklyProducts.shopId, query.shopId),
          gte(wbFinanceWeeklyProducts.dateFrom, start),
          lte(wbFinanceWeeklyProducts.dateTo, end),
        )
      )
      .groupBy(wbFinanceWeeklyProducts.nmId);

    const nmIds = finance.map(f => f.nmId);
    if (nmIds.length === 0) {
      return { workspaceId: params.workspaceId, start, end, total: 0, rows: [], totals: null };
    }

    // 2. Данные по рекламе (ДРР)
    const advData = await db
      .select({
        nmId: wbAdvDailyProducts.nmId,
        advSpendKopecks: sql<number>`sum(${wbAdvDailyProducts.spendKopecks})`.as('advSpendKopecks'),
        advViews: sql<number>`sum(${wbAdvDailyProducts.viewsCount})`.as('advViews'),
        advClicks: sql<number>`sum(${wbAdvDailyProducts.clicksCount})`.as('advClicks'),
        advOrders: sql<number>`sum(${wbAdvDailyProducts.ordersCount})`.as('advOrders'),
        advOrdersRub: sql<number>`sum(${wbAdvDailyProducts.sumPriceKopecks})`.as('advOrdersRub'),
      })
      .from(wbAdvDailyProducts)
      .where(
        and(
          eq(wbAdvDailyProducts.workspaceId, params.workspaceId),
          gte(wbAdvDailyProducts.date, start),
          lte(wbAdvDailyProducts.date, end),
          buildShopFilter(wbAdvDailyProducts.shopId, query.shopId),
          inArray(wbAdvDailyProducts.nmId, nmIds),
        )
      )
      .groupBy(wbAdvDailyProducts.nmId);
    const advByNm = new Map(advData.map(a => [Number(a.nmId), a]));

    // 3. Заказы и продажи (для % выкупа)
    const ordersData = await db
      .select({
        nmId: wbOrdersSalesDailyProducts.nmId,
        ordersCount: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersCount})`.as('ordersCount'),
        ordersRub: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersRub})`.as('ordersRub'),
        salesCount: sql<number>`sum(${wbOrdersSalesDailyProducts.salesCount})`.as('salesCount'),
        salesRub: sql<number>`sum(${wbOrdersSalesDailyProducts.salesRub})`.as('salesRub'),
        returnsCount: sql<number>`0`.as('returnsCount'),
        cancelCount: sql<number>`0`.as('cancelCount'),
      })
      .from(wbOrdersSalesDailyProducts)
      .where(
        and(
          eq(wbOrdersSalesDailyProducts.workspaceId, params.workspaceId),
          gte(wbOrdersSalesDailyProducts.date, start),
          lte(wbOrdersSalesDailyProducts.date, end),
          buildShopFilter(wbOrdersSalesDailyProducts.shopId, query.shopId),
          inArray(wbOrdersSalesDailyProducts.nmId, nmIds),
        )
      )
      .groupBy(wbOrdersSalesDailyProducts.nmId);
    const ordersByNm = new Map(ordersData.map(o => [Number(o.nmId), o]));

    // 3.5. "Зрелые" заказы (30+ дней назад) для точного % выкупа
    const matureStart = isoDate(addDays(new Date(start + 'T00:00:00Z'), -30));
    const matureEnd = isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));
    const matureOrdersData = await db
      .select({
        nmId: wbFunnelDailyProducts.nmId,
        orderCount: sql<number>`sum(${wbFunnelDailyProducts.orderCount})`.as('orderCount'),
        buyoutCount: sql<number>`sum(${wbFunnelDailyProducts.buyoutCount})`.as('buyoutCount'),
        cancelCount: sql<number>`sum(${wbFunnelDailyProducts.cancelCount})`.as('cancelCount'),
      })
      .from(wbFunnelDailyProducts)
      .where(
        and(
          eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
          gte(wbFunnelDailyProducts.date, matureStart),
          lte(wbFunnelDailyProducts.date, matureEnd),
          buildShopFilter(wbFunnelDailyProducts.shopId, query.shopId),
          inArray(wbFunnelDailyProducts.nmId, nmIds),
        )
      )
      .groupBy(wbFunnelDailyProducts.nmId);
    const matureByNm = new Map(matureOrdersData.map(m => [Number(m.nmId), m]));

    // 3.6. Дополнительные финансовые данные (возвраты, компенсации)
    const extraFinanceData = await db
      .select({
        returnsCount: sql<number>`sum(${wbFinanceDaily.returnsCount})`.as('returnsCount'),
        returnLogisticsKopecks: sql<number>`sum(${wbFinanceDaily.returnLogisticsKopecks})`.as('returnLogisticsKopecks'),
        additionalPaymentKopecks: sql<number>`sum(${wbFinanceDaily.additionalPaymentKopecks})`.as('additionalPaymentKopecks'),
      })
      .from(wbFinanceDaily)
      .where(
        and(
          eq(wbFinanceDaily.workspaceId, params.workspaceId),
          gte(wbFinanceDaily.date, start),
          lte(wbFinanceDaily.date, end),
          buildShopFilter(wbFinanceDaily.shopId, query.shopId),
        )
      );
    const extraFinance = extraFinanceData[0] || { returnsCount: 0, returnLogisticsKopecks: 0, additionalPaymentKopecks: 0 };

    // 4. Остатки (для ROCE)
    const stocksData = await db
      .select({
        nmId: wbStocksCurrent.nmId,
        inWayToClient: sql<number>`sum(${wbStocksCurrent.inWayToClient})`.as('inWayToClient'),
        inWayFromClient: sql<number>`sum(${wbStocksCurrent.inWayFromClient})`.as('inWayFromClient'),
        quantity: sql<number>`sum(${wbStocksCurrent.quantity})`.as('quantity'),
      })
      .from(wbStocksCurrent)
      .where(
        and(
          eq(wbStocksCurrent.workspaceId, params.workspaceId),
          buildShopFilter(wbStocksCurrent.shopId, query.shopId),
          inArray(wbStocksCurrent.nmId, nmIds),
        )
      )
      .groupBy(wbStocksCurrent.nmId);
    const stocksByNm = new Map(stocksData.map(s => [Number(s.nmId), { qty: Number(s.quantity) || 0, inWayTo: Number(s.inWayToClient) || 0, inWayFrom: Number(s.inWayFromClient) || 0 }]));

    // 4.5. Воронка продаж (для конверсий)
    const funnelData = await db
      .select({
        nmId: wbFunnelDailyProducts.nmId,
        viewCount: sql<number>`sum(${wbFunnelDailyProducts.viewCount})`.as('viewCount'),
        openCardCount: sql<number>`sum(${wbFunnelDailyProducts.openCardCount})`.as('openCardCount'),
        addToCartCount: sql<number>`sum(${wbFunnelDailyProducts.addToCartCount})`.as('addToCartCount'),
        addToWishlistCount: sql<number>`sum(${wbFunnelDailyProducts.addToWishlistCount})`.as('addToWishlistCount'),
        orderCount: sql<number>`sum(${wbFunnelDailyProducts.orderCount})`.as('orderCount'),
        orderSum: sql<number>`sum(${wbFunnelDailyProducts.orderSum})`.as('orderSum'),
        buyoutCount: sql<number>`sum(${wbFunnelDailyProducts.buyoutCount})`.as('buyoutCount'),
        buyoutSum: sql<number>`sum(${wbFunnelDailyProducts.buyoutSum})`.as('buyoutSum'),
      })
      .from(wbFunnelDailyProducts)
      .where(
        and(
          eq(wbFunnelDailyProducts.workspaceId, params.workspaceId),
          gte(wbFunnelDailyProducts.date, start),
          lte(wbFunnelDailyProducts.date, end),
          buildShopFilter(wbFunnelDailyProducts.shopId, query.shopId),
          inArray(wbFunnelDailyProducts.nmId, nmIds),
        )
      )
      .groupBy(wbFunnelDailyProducts.nmId);
    const funnelByNm = new Map(funnelData.map(f => [Number(f.nmId), f]));

    // 5. Карточки и себестоимость
    const cards = await db
      .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title, subjectId: wbCards.subjectId })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds)));
    const cardByNm = new Map(cards.map(c => [c.nmId, c]));

    const cogsRows = await db
      .select({ nmId: wbCogs.nmId, cogsKopecks: wbCogs.cogsKopecks })
      .from(wbCogs)
      .where(and(eq(wbCogs.workspaceId, params.workspaceId), inArray(wbCogs.nmId, nmIds)));
    const cogsByNm = new Map(cogsRows.map(r => [r.nmId, r.cogsKopecks]));

    // 6. Настройки налогообложения магазина
    let shopTaxSettings = {
      taxRegime: 'usn15' as string,
      taxRate: 15,
      vatPct: 0,
      vatIncluded: false,
    };
    
    if (query.shopId) {
      const shopSettings = await db
        .select({
          taxRegime: marketplaceShops.taxRegime,
          taxRate: marketplaceShops.taxRate,
          vatPct: marketplaceShops.vatPct,
          vatIncluded: marketplaceShops.vatIncluded,
        })
        .from(marketplaceShops)
        .where(and(
          eq(marketplaceShops.workspaceId, params.workspaceId),
          eq(marketplaceShops.shopId, query.shopId),
        ))
        .limit(1);
      
      if (shopSettings[0]) {
        const s = shopSettings[0];
        shopTaxSettings = {
          taxRegime: s.taxRegime,
          // Дефолтные ставки по режиму, если не указана явно
          taxRate: s.taxRate ?? (s.taxRegime === 'usn6' ? 6 : s.taxRegime === 'usn15' ? 15 : s.taxRegime === 'osno' ? 20 : s.taxRegime === 'ausn8' ? 8 : s.taxRegime === 'ausn20' ? 20 : 0),
          vatPct: s.vatPct ?? 0,
          vatIncluded: s.vatIncluded ?? false,
        };
      }
    }
    
    // Переопределение из query-параметра (для калькулятора). Аккуратно:
    // Number(undefined) === NaN, поэтому `?? fallback` не сработает (NaN — не null).
    // Без этой проверки taxRate уходит NaN → налог/чистая прибыль рисуются
    // прочерком и Аидар видит «не считается».
    const qTaxRate = Number((req.query as any)?.taxRate);
    const taxRatePct = Number.isFinite(qTaxRate) ? qTaxRate : shopTaxSettings.taxRate;
    const taxRate = taxRatePct > 1 ? taxRatePct / 100 : taxRatePct;
    const qVatPct = Number((req.query as any)?.vatPct);
    const vatPct = Number.isFinite(qVatPct) ? qVatPct : shopTaxSettings.vatPct;
    const vatRate = vatPct > 1 ? vatPct / 100 : vatPct;
    const vatIncluded = shopTaxSettings.vatIncluded;

    const rows = finance.map(f => {
      const card = cardByNm.get(f.nmId);
      const cogsKopecks = cogsByNm.get(f.nmId) ?? 0;
      const adv = advByNm.get(f.nmId);
      const orders = ordersByNm.get(f.nmId);
      const stockData = stocksByNm.get(f.nmId) ?? { qty: 0, inWayTo: 0, inWayFrom: 0 };
      const stockQty = stockData.qty;
      const stockInWayTo = stockData.inWayTo;
      const stockInWayFrom = stockData.inWayFrom;
      const totalStockQty = stockQty + stockInWayTo + stockInWayFrom;
      const funnel = funnelByNm.get(f.nmId);
      const mature = matureByNm.get(f.nmId);
      
      const salesQty = Number(f.saleQty) || 0;
      const revenueRub = Number(f.revenueKopecks) / 100;
      const incomeRub = Number(f.incomeKopecks) / 100;
      const logisticsRub = Number(f.logisticsKopecks) / 100;
      const storageRub = Number(f.storageKopecks) / 100;
      const penaltiesRub = Number(f.penaltiesKopecks) / 100;
      const paidAcceptanceRub = Number(f.paidAcceptanceKopecks) / 100;
      const cogsRub = (cogsKopecks / 100) * salesQty;
      
      // Комиссия = revenue - income
      const commissionRub = revenueRub - incomeRub;
      
      // Эквайринг (приблизительно 2% от выручки, если нет точных данных)
      const acquiringRub = revenueRub * 0.02;
      
      // Реклама
      const advSpendRub = adv ? Number(adv.advSpendKopecks) / 100 : 0;
      const advOrdersRub = adv ? Number(adv.advOrdersRub) / 100 : 0;
      const advOrders = adv ? Number(adv.advOrders) : 0;
      
      // Заказы и выкупы
      const ordersCount = orders ? Number(orders.ordersCount) : 0;
      const ordersRub = orders ? Number(orders.ordersRub) : 0;
      const salesCount = orders ? Number(orders.salesCount) : salesQty;
      const salesRub = orders ? Number(orders.salesRub) : revenueRub;
      const returnsCount = orders ? Number(orders.returnsCount) : 0;
      const cancelCount = orders ? Number(orders.cancelCount) : 0;
      
      // Средние цены
      const avgOrderPrice = ordersCount > 0 ? ordersRub / ordersCount : 0;
      const avgSalePrice = salesCount > 0 ? salesRub / salesCount : 0;
      const avgRealizationPrice = salesQty > 0 ? revenueRub / salesQty : 0;
      
      // СПП (Скидка постоянного покупателя) ~ 40% от выручки (типичное значение WB)
      const sppRub = revenueRub * 0.4;
      const realizationRub = revenueRub - sppRub; // Сумма реализации для налога
      
      // Услуги МП (Торгстат: комиссия + логистика + хранение + штрафы + приёмка + эквайринг)
      const marketplaceCostsRub = commissionRub + logisticsRub + storageRub + penaltiesRub + paidAcceptanceRub + acquiringRub;
      
      // Валовая прибыль = Выручка - Услуги МП (Торгстат formula)
      const grossProfitRub = revenueRub - marketplaceCostsRub;
      
      // НДС расчёт (из настроек магазина: vatRate, vatIncluded)
      // Исходящий НДС = от суммы реализации
      const outgoingVat = vatRate > 0 ? realizationRub * vatRate / (1 + vatRate) : 0;
      // Входящий НДС = от себестоимости и услуг (если есть счета-фактуры)
      const incomingVat = vatIncluded && vatRate > 0 
        ? (cogsRub + marketplaceCostsRub) * vatRate / (1 + vatRate) 
        : 0;
      // НДС к уплате = Исходящий - Входящий
      const vatPayable = Math.max(0, outgoingVat - incomingVat);
      
      // Налог (прямой, от налогооблагаемой базы по режиму)
      // УСН Доходы: налог от реализации
      // УСН Д-Р: налог от (реализация - расходы)
      // ОСНО: налог на прибыль + НДС
      let taxableBase: number;
      if (shopTaxSettings.taxRegime === 'usn6' || shopTaxSettings.taxRegime === 'ausn8') {
        // УСН Доходы / АУСН Доходы — налог от суммы реализации
        taxableBase = realizationRub;
      } else {
        // УСН Д-Р / АУСН Д-Р / ОСНО — налог от прибыли
        taxableBase = grossProfitRub - cogsRub - advSpendRub;
      }
      const directTaxRub = Math.max(0, taxableBase * taxRate);
      // Общий налог: прямой + НДС (для ОСНО)
      const totalTaxRub = shopTaxSettings.taxRegime === 'osno' 
        ? directTaxRub + vatPayable 
        : directTaxRub;
      
      // Внешние расходы (пока 0, добавляется пользователем)
      const externalCostsRub = 0;
      
      // Чистая прибыль = Валовая - Себестоимость - Реклама - Налог - Внешние
      const netProfitRub = grossProfitRub - cogsRub - advSpendRub - totalTaxRub - externalCostsRub;
      
      // Все расходы (для ROI)
      const totalCostsRub = marketplaceCostsRub + cogsRub + advSpendRub + totalTaxRub + externalCostsRub;
      
      // Стоимость остатков (для ROCE) = остаток × себестоимость единицы
      const cogsPerUnit = salesQty > 0 ? cogsRub / salesQty : (cogsKopecks / 100);
      const stockMoneyRub = stockQty * cogsPerUnit;
      
      // === ОСНОВНЫЕ МЕТРИКИ (%) ===
      
      // Маржинальность = Валовая прибыль / Выручка × 100
      const marginPct = revenueRub > 0 ? (grossProfitRub / revenueRub) * 100 : 0;
      
      // Рентабельность = Чистая прибыль / Выручка × 100
      const profitabilityPct = revenueRub > 0 ? (netProfitRub / revenueRub) * 100 : 0;
      
      // ROI = Чистая прибыль / Затраты × 100 (Торгстат: ЧП / (Выручка - ЧП))
      const roiPct = totalCostsRub > 0 ? (netProfitRub / totalCostsRub) * 100 : 0;
      
      // ROCE = Чистая прибыль / Капитал в товарах × 100
      const rocePct = stockMoneyRub > 0 ? (netProfitRub / stockMoneyRub) * 100 : 0;
      
      // % выкупа = (Продажи - Возвраты) / Заказы × 100
      const buyoutPct = ordersCount > 0 ? ((salesCount - returnsCount) / ordersCount) * 100 : 0;
      
      // % выкупа для "зрелых" заказов (30+ дней) — более точный показатель
      const matureOrders = mature ? Number(mature.orderCount) : 0;
      const matureBuyouts = mature ? Number(mature.buyoutCount) : 0;
      const buyout30dPct = matureOrders > 0 ? (matureBuyouts / matureOrders) * 100 : null;
      const matureCancels = mature ? Number(mature.cancelCount) : 0;
      const buyout30dWithReturnsPct = matureOrders > 0 ? ((matureBuyouts + matureCancels) / matureOrders) * 100 : null;
      
      // % выкупа с возвратами = Продажи / Заказы × 100
      const buyoutWithReturnsPct = ordersCount > 0 ? (salesCount / ordersCount) * 100 : 0;
      
      // % отмен
      const cancelPct = ordersCount > 0 ? (cancelCount / ordersCount) * 100 : 0;
      
      // % продаж к заказам
      const salesToOrdersPct = ordersCount > 0 ? (salesCount / ordersCount) * 100 : 0;
      
      // === РЕКЛАМНЫЕ МЕТРИКИ ===
      
      // ДРР = Расходы на рекламу / Выручка × 100
      const drrPct = revenueRub > 0 ? (advSpendRub / revenueRub) * 100 : 0;
      
      // TACOO = Расходы на рекламу / Заказы (шт) — Total Advertising Cost Of Order
      const tacoo = ordersCount > 0 ? advSpendRub / ordersCount : 0;
      
      // TACOS = Расходы на рекламу / Выкупы (шт) — на выкупленные
      const buyoutCount = salesCount - returnsCount;
      const tacos = buyoutCount > 0 ? advSpendRub / buyoutCount : 0;
      
      // CTR, CR для рекламы
      const advViews = adv ? Number(adv.advViews) : 0;
      const advClicks = adv ? Number(adv.advClicks) : 0;
      const advCtrPct = advViews > 0 ? (advClicks / advViews) * 100 : 0;
      
      // === ВОРОНКА ПРОДАЖ ===
      const funnelViewCount = funnel ? Number(funnel.viewCount) : 0;
      const funnelOpenCardCount = funnel ? Number(funnel.openCardCount) : 0;
      const funnelAddToCartCount = funnel ? Number(funnel.addToCartCount) : 0;
      const funnelAddToWishlistCount = funnel ? Number(funnel.addToWishlistCount) : 0;
      const funnelOrderCount = funnel ? Number(funnel.orderCount) : 0;
      const funnelBuyoutCount = funnel ? Number(funnel.buyoutCount) : 0;
      
      // Конверсии воронки (%)
      const viewToOpenCr = funnelViewCount > 0 ? (funnelOpenCardCount / funnelViewCount) * 100 : 0;
      const openToCartCr = funnelOpenCardCount > 0 ? (funnelAddToCartCount / funnelOpenCardCount) * 100 : 0;
      const cartToOrderCr = funnelAddToCartCount > 0 ? (funnelOrderCount / funnelAddToCartCount) * 100 : 0;
      const orderToBuyoutCr = funnelOrderCount > 0 ? (funnelBuyoutCount / funnelOrderCount) * 100 : 0;
      // Сквозная конверсия: показы → выкуп
      const viewToBuyoutCr = funnelViewCount > 0 ? (funnelBuyoutCount / funnelViewCount) * 100 : 0;
      
      // === МЕТРИКИ В % (как в Торгстате) ===
      const sppPct = revenueRub > 0 ? (sppRub / revenueRub) * 100 : 0;
      const commissionPct = revenueRub > 0 ? (commissionRub / revenueRub) * 100 : 0;
      const acquiringPct = revenueRub > 0 ? (acquiringRub / revenueRub) * 100 : 0;
      const logisticsPct = revenueRub > 0 ? (logisticsRub / revenueRub) * 100 : 0;
      const storagePct = revenueRub > 0 ? (storageRub / revenueRub) * 100 : 0;
      const advPct = revenueRub > 0 ? (advSpendRub / revenueRub) * 100 : 0;
      const cogsPct = revenueRub > 0 ? (cogsRub / revenueRub) * 100 : 0;
      
      // === МЕТРИКИ НА 1 ТОВАР ===
      const netProfitPerUnit = salesQty > 0 ? netProfitRub / salesQty : 0;
      const commissionPerUnit = salesQty > 0 ? commissionRub / salesQty : 0;
      const logisticsPerUnit = salesQty > 0 ? logisticsRub / salesQty : 0;
      const storagePerUnit = salesQty > 0 ? storageRub / salesQty : 0;
      const advPerUnit = salesQty > 0 ? advSpendRub / salesQty : 0;
      const acquiringPerUnit = salesQty > 0 ? acquiringRub / salesQty : 0;
      
      return {
        nmId: f.nmId,
        vendorCode: card?.vendorCode ?? null,
        title: card?.title ?? null,
        subjectId: card?.subjectId ?? null,
        
        // === КОЛИЧЕСТВА ===
        salesQty,
        ordersCount,
        returnsCount,
        cancelCount,
        stockQty,
        stockInWayTo,
        stockInWayFrom,
        totalStockQty,
        
        // === ЦЕНЫ ===
        avgOrderPrice: Math.round(avgOrderPrice),
        avgSalePrice: Math.round(avgSalePrice),
        avgRealizationPrice: Math.round(avgRealizationPrice),
        
        // === ФИНАНСЫ (руб) ===
        revenueRub: Math.round(revenueRub),
        ordersRub: Math.round(ordersRub),
        salesRub: Math.round(salesRub),
        sppRub: Math.round(sppRub),
        realizationRub: Math.round(realizationRub),
        commissionRub: Math.round(commissionRub),
        acquiringRub: Math.round(acquiringRub),
        logisticsRub: Math.round(logisticsRub),
        storageRub: Math.round(storageRub),
        penaltiesRub: Math.round(penaltiesRub),
        paidAcceptanceRub: Math.round(paidAcceptanceRub),
        cogsRub: Math.round(cogsRub),
        advSpendRub: Math.round(advSpendRub),
        externalCostsRub: Math.round(externalCostsRub),
        
        // === НАЛОГИ ===
        outgoingVatRub: Math.round(outgoingVat),
        incomingVatRub: Math.round(incomingVat),
        vatPayableRub: Math.round(vatPayable),
        directTaxRub: Math.round(directTaxRub),
        totalTaxRub: Math.round(totalTaxRub),
        
        // === ПРИБЫЛЬ (руб) ===
        grossProfitRub: Math.round(grossProfitRub),
        netProfitRub: Math.round(netProfitRub),
        marketplaceCostsRub: Math.round(marketplaceCostsRub),
        stockMoneyRub: Math.round(stockMoneyRub),
        
        // === ОСНОВНЫЕ МЕТРИКИ (%) ===
        marginPct: Math.round(marginPct * 10) / 10,
        profitabilityPct: Math.round(profitabilityPct * 10) / 10,
        roiPct: Math.round(roiPct * 10) / 10,
        rocePct: Math.round(rocePct * 10) / 10,
        buyoutPct: Math.round(buyoutPct * 10) / 10,
        buyout30dPct: buyout30dPct !== null ? Math.round(buyout30dPct * 10) / 10 : null,
        salesWithReturnsToOrdersPct: ordersCount > 0 ? Math.round(((salesCount - returnsCount) / ordersCount) * 1000) / 10 : 0,
        buyoutWithReturnsPct: Math.round(buyoutWithReturnsPct * 10) / 10,
        cancelPct: Math.round(cancelPct * 10) / 10,
        salesToOrdersPct: Math.round(salesToOrdersPct * 10) / 10,
        
        // === РЕКЛАМНЫЕ МЕТРИКИ ===
        drrPct: Math.round(drrPct * 10) / 10,
        tacoo: Math.round(tacoo),
        tacos: Math.round(tacos),
        advCtrPct: Math.round(advCtrPct * 10) / 10,
        advViews,
        advClicks,
        advOrders,
        
        // === ВОРОНКА ПРОДАЖ ===
        funnelViewCount,
        funnelOpenCardCount,
        funnelAddToCartCount,
        funnelAddToWishlistCount,
        funnelOrderCount,
        funnelBuyoutCount,
        // Конверсии (%)
        viewToOpenCr: Math.round(viewToOpenCr * 100) / 100,
        openToCartCr: Math.round(openToCartCr * 100) / 100,
        cartToOrderCr: Math.round(cartToOrderCr * 100) / 100,
        orderToBuyoutCr: Math.round(orderToBuyoutCr * 100) / 100,
        viewToBuyoutCr: Math.round(viewToBuyoutCr * 1000) / 1000, // 3 знака — очень маленькие значения
        
        // === МЕТРИКИ В % ===
        sppPct: Math.round(sppPct * 10) / 10,
        commissionPct: Math.round(commissionPct * 10) / 10,
        acquiringPct: Math.round(acquiringPct * 10) / 10,
        logisticsPct: Math.round(logisticsPct * 10) / 10,
        storagePct: Math.round(storagePct * 10) / 10,
        advPct: Math.round(advPct * 10) / 10,
        cogsPct: Math.round(cogsPct * 10) / 10,
        
        // === МЕТРИКИ НА 1 ТОВАР ===
        netProfitPerUnit: Math.round(netProfitPerUnit),
        commissionPerUnit: Math.round(commissionPerUnit),
        logisticsPerUnit: Math.round(logisticsPerUnit),
        storagePerUnit: Math.round(storagePerUnit),
        advPerUnit: Math.round(advPerUnit),
        acquiringPerUnit: Math.round(acquiringPerUnit),
        cogsPerUnit: Math.round(cogsPerUnit),
        
        // ABC будет рассчитан ниже
        abcRevenue: '' as 'A' | 'B' | 'C' | '',
        abcProfit: '' as 'A' | 'B' | 'C' | '',
        abcGroup: '' as 'AA' | 'AB' | 'AC' | 'BA' | 'BB' | 'BC' | 'CA' | 'CB' | 'CC' | '',
      };
    });

    // Фильтруем товары без продаж (опционально оставляем для анализа убыточных)
    const activeRows = rows.filter(r => r.salesQty > 0 || r.stockQty > 0 || r.advSpendRub > 0);

    // ABC-анализ (двумерный: по выручке и прибыли)
    const totalRevenue = activeRows.reduce((s, r) => s + r.revenueRub, 0);
    const totalProfit = activeRows.reduce((s, r) => s + r.netProfitRub, 0);
    
    // Сортируем по выручке для ABC по выручке
    const byRevenue = [...activeRows].sort((a, b) => b.revenueRub - a.revenueRub);
    let cumRevenue = 0;
    for (const r of byRevenue) {
      cumRevenue += r.revenueRub;
      const pct = totalRevenue > 0 ? (cumRevenue / totalRevenue) * 100 : 0;
      r.abcRevenue = pct <= abcThresholdA ? 'A' : pct <= abcThresholdB ? 'B' : 'C';
    }
    
    // Сортируем по прибыли для ABC по прибыли
    const byProfit = [...activeRows].sort((a, b) => b.netProfitRub - a.netProfitRub);
    let cumProfit = 0;
    for (const r of byProfit) {
      cumProfit += r.netProfitRub;
      const pct = totalProfit > 0 ? (cumProfit / totalProfit) * 100 : 0;
      r.abcProfit = pct <= abcThresholdA ? 'A' : pct <= abcThresholdB ? 'B' : 'C';
    }
    
    // Двумерный ABC
    for (const r of activeRows) {
      r.abcGroup = `${r.abcRevenue}${r.abcProfit}` as typeof r.abcGroup;
    }

    // Итоги (все 79 колонок агрегаты)
    const totalAdvSpend = activeRows.reduce((s, r) => s + r.advSpendRub, 0);
    const totalCogs = activeRows.reduce((s, r) => s + r.cogsRub, 0);
    const totalMarketplaceCosts = activeRows.reduce((s, r) => s + r.marketplaceCostsRub, 0);
    const totalGrossProfit = activeRows.reduce((s, r) => s + r.grossProfitRub, 0);
    const totalNetProfit = activeRows.reduce((s, r) => s + r.netProfitRub, 0);
    const totalOrders = activeRows.reduce((s, r) => s + r.ordersCount, 0);
    const totalSales = activeRows.reduce((s, r) => s + r.salesQty, 0);
    const totalReturns = activeRows.reduce((s, r) => s + r.returnsCount, 0);
    const totalCancels = activeRows.reduce((s, r) => s + r.cancelCount, 0);
    const totalStock = activeRows.reduce((s, r) => s + r.stockQty, 0);
    const totalStockMoney = activeRows.reduce((s, r) => s + r.stockMoneyRub, 0);
    const totalOrdersRub = activeRows.reduce((s, r) => s + r.ordersRub, 0);
    const totalSalesRub = activeRows.reduce((s, r) => s + r.salesRub, 0);
    const totalSppRub = activeRows.reduce((s, r) => s + r.sppRub, 0);
    const totalCommission = activeRows.reduce((s, r) => s + r.commissionRub, 0);
    const totalLogistics = activeRows.reduce((s, r) => s + r.logisticsRub, 0);
    const totalStorage = activeRows.reduce((s, r) => s + r.storageRub, 0);
    const totalAcquiring = activeRows.reduce((s, r) => s + r.acquiringRub, 0);
    const totalTax = activeRows.reduce((s, r) => s + r.totalTaxRub, 0);
    
    // Mature (30d) buyout totals
    const totalMatureOrders = Array.from(matureByNm.values()).reduce((s, m) => s + (Number(m.orderCount) || 0), 0);
    const totalMatureBuyouts = Array.from(matureByNm.values()).reduce((s, m) => s + (Number(m.buyoutCount) || 0), 0);
    
    const totals = {
      // Количества
      productsCount: activeRows.length,
      totalOrders,
      totalSales,
      totalReturns,
      totalCancels,
      totalStock,
      
      // Суммы (руб)
      totalRevenue: Math.round(totalRevenue),
      totalOrdersRub: Math.round(totalOrdersRub),
      totalSalesRub: Math.round(totalSalesRub),
      totalSppRub: Math.round(totalSppRub),
      totalRealizationRub: Math.round(totalRevenue - totalSppRub),
      totalCommission: Math.round(totalCommission),
      totalAcquiring: Math.round(totalAcquiring),
      totalLogistics: Math.round(totalLogistics),
      totalStorage: Math.round(totalStorage),
      totalMarketplaceCosts: Math.round(totalMarketplaceCosts),
      totalCogs: Math.round(totalCogs),
      totalAdvSpend: Math.round(totalAdvSpend),
      totalTax: Math.round(totalTax),
      totalGrossProfit: Math.round(totalGrossProfit),
      totalNetProfit: Math.round(totalNetProfit),
      totalStockMoney: Math.round(totalStockMoney),
      
      // Средние цены
      avgOrderPrice: totalOrders > 0 ? Math.round(totalOrdersRub / totalOrders) : 0,
      avgSalePrice: totalSales > 0 ? Math.round(totalSalesRub / totalSales) : 0,
      
      // Метрики (%)
      avgMarginPct: totalRevenue > 0 ? Math.round((totalGrossProfit / totalRevenue) * 1000) / 10 : 0,
      avgProfitabilityPct: totalRevenue > 0 ? Math.round((totalNetProfit / totalRevenue) * 1000) / 10 : 0,
      avgRoiPct: (totalRevenue - totalNetProfit) > 0 ? Math.round((totalNetProfit / (totalRevenue - totalNetProfit)) * 1000) / 10 : 0,
      avgRocePct: totalStockMoney > 0 ? Math.round((totalNetProfit / totalStockMoney) * 1000) / 10 : 0,
      avgDrrPct: totalRevenue > 0 ? Math.round((totalAdvSpend / totalRevenue) * 1000) / 10 : 0,
      avgBuyoutPct: totalOrders > 0 ? Math.round(((totalSales - totalReturns) / totalOrders) * 1000) / 10 : 0,
      avgBuyout30dPct: totalMatureOrders > 0 ? Math.round((totalMatureBuyouts / totalMatureOrders) * 1000) / 10 : null,
      avgCancelPct: totalOrders > 0 ? Math.round((totalCancels / totalOrders) * 1000) / 10 : 0,
      
      // Метрики в %
      sppPct: totalRevenue > 0 ? Math.round((totalSppRub / totalRevenue) * 1000) / 10 : 0,
      commissionPct: totalRevenue > 0 ? Math.round((totalCommission / totalRevenue) * 1000) / 10 : 0,
      logisticsPct: totalRevenue > 0 ? Math.round((totalLogistics / totalRevenue) * 1000) / 10 : 0,
      storagePct: totalRevenue > 0 ? Math.round((totalStorage / totalRevenue) * 1000) / 10 : 0,
      cogsPct: totalRevenue > 0 ? Math.round((totalCogs / totalRevenue) * 1000) / 10 : 0,
      
      // TACOO / TACOS
      avgTacoo: totalOrders > 0 ? Math.round(totalAdvSpend / totalOrders) : 0,
      avgTacos: (totalSales - totalReturns) > 0 ? Math.round(totalAdvSpend / (totalSales - totalReturns)) : 0,
      
      // Метрики на 1 товар
      avgNetProfitPerUnit: totalSales > 0 ? Math.round(totalNetProfit / totalSales) : 0,
      avgCommissionPerUnit: totalSales > 0 ? Math.round(totalCommission / totalSales) : 0,
      avgLogisticsPerUnit: totalSales > 0 ? Math.round(totalLogistics / totalSales) : 0,
      avgStoragePerUnit: totalSales > 0 ? Math.round(totalStorage / totalSales) : 0,
      avgCogsPerUnit: totalSales > 0 ? Math.round(totalCogs / totalSales) : 0,
      
      // ABC
      abcCounts: {
        AA: activeRows.filter(r => r.abcGroup === 'AA').length,
        AB: activeRows.filter(r => r.abcGroup === 'AB').length,
        AC: activeRows.filter(r => r.abcGroup === 'AC').length,
        BA: activeRows.filter(r => r.abcGroup === 'BA').length,
        BB: activeRows.filter(r => r.abcGroup === 'BB').length,
        BC: activeRows.filter(r => r.abcGroup === 'BC').length,
        CA: activeRows.filter(r => r.abcGroup === 'CA').length,
        CB: activeRows.filter(r => r.abcGroup === 'CB').length,
        CC: activeRows.filter(r => r.abcGroup === 'CC').length,
      },
      
      // Воронка (суммы)
      funnel: {
        totalViews: activeRows.reduce((s, r) => s + r.funnelViewCount, 0),
        totalOpenCards: activeRows.reduce((s, r) => s + r.funnelOpenCardCount, 0),
        totalAddToCart: activeRows.reduce((s, r) => s + r.funnelAddToCartCount, 0),
        totalAddToWishlist: activeRows.reduce((s, r) => s + r.funnelAddToWishlistCount, 0),
        totalOrders: activeRows.reduce((s, r) => s + r.funnelOrderCount, 0),
        totalBuyouts: activeRows.reduce((s, r) => s + r.funnelBuyoutCount, 0),
        // Средние конверсии
        avgViewToOpenCr: (() => {
          const views = activeRows.reduce((s, r) => s + r.funnelViewCount, 0);
          const opens = activeRows.reduce((s, r) => s + r.funnelOpenCardCount, 0);
          return views > 0 ? Math.round((opens / views) * 10000) / 100 : 0;
        })(),
        avgOpenToCartCr: (() => {
          const opens = activeRows.reduce((s, r) => s + r.funnelOpenCardCount, 0);
          const carts = activeRows.reduce((s, r) => s + r.funnelAddToCartCount, 0);
          return opens > 0 ? Math.round((carts / opens) * 10000) / 100 : 0;
        })(),
        avgCartToOrderCr: (() => {
          const carts = activeRows.reduce((s, r) => s + r.funnelAddToCartCount, 0);
          const orders = activeRows.reduce((s, r) => s + r.funnelOrderCount, 0);
          return carts > 0 ? Math.round((orders / carts) * 10000) / 100 : 0;
        })(),
        avgOrderToBuyoutCr: (() => {
          const orders = activeRows.reduce((s, r) => s + r.funnelOrderCount, 0);
          const buyouts = activeRows.reduce((s, r) => s + r.funnelBuyoutCount, 0);
          return orders > 0 ? Math.round((buyouts / orders) * 10000) / 100 : 0;
        })(),
        avgViewToBuyoutCr: (() => {
          const views = activeRows.reduce((s, r) => s + r.funnelViewCount, 0);
          const buyouts = activeRows.reduce((s, r) => s + r.funnelBuyoutCount, 0);
          return views > 0 ? Math.round((buyouts / views) * 100000) / 1000 : 0;
        })(),
      },
    };

    // Сортировка
    const sortKey = sortBy as keyof typeof activeRows[0];
    activeRows.sort((a, b) => {
      const av = Number(a[sortKey]) || 0;
      const bv = Number(b[sortKey]) || 0;
      return sortOrder === 'desc' ? bv - av : av - bv;
    });

    const total = activeRows.length;
    const pagedRows = activeRows.slice(offset, offset + limit);

    return {
      workspaceId: params.workspaceId,
      shopId: query.shopId ?? null,
      start,
      end,
      total,
      // Настройки налогообложения (из магазина или query)
      taxSettings: {
        taxRegime: shopTaxSettings.taxRegime,
        taxRatePct: taxRatePct,
        vatPct: vatPct * 100,
        vatIncluded: vatIncluded,
      },
      totals,
      rows: pagedRows,
    };
  });


  // Subjects with commission rates for calculator
  app.get('/unit-economics/:workspaceId/subjects', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const tariffs = await getCommissionTariffs('ru');
    const subjects = tariffs
      .filter((t) => t.subjectID != null && t.subjectName)
      .map((t) => ({
        subjectId: t.subjectID!,
        subjectName: t.subjectName!,
        parentName: t.parentName ?? null,
        commissionPct: t.kgvpMarketplace ?? t.kgvpSupplier ?? 0,
      }))
      .sort((a, b) => a.subjectName.localeCompare(b.subjectName, 'ru'));

    return { subjects };
  });

  // MVP endpoint: compute model unit-economics for nmIds based on WB Analytics buyoutSum + WB tariffs.
  app.get('/unit-economics/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        nmIds: z.string().optional(),
        mergeWeeks: z.enum(['0', '1']).optional(),
        mergeProducts: z.enum(['0', '1']).optional(),
        taxRate: z.coerce.number().optional(),
        acquiringRate: z.coerce.number().optional(),
        rounding: z.enum(['standard', 'raw']).optional(),
        includeFact: z.enum(['0', '1']).optional(),
        salesModel: z.enum(['fbo', 'fbs', 'compare']).optional(),
        calcBase: z.enum(['perUnit', 'period']).optional(),
        quantity: z.coerce.number().optional(),
        sppOverride: z.coerce.number().min(0).max(100).optional(),
        cogsRub: z.coerce.number().min(0).optional(),
      })
      .parse(req.query);

    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));

    const mergeWeeks = (query.mergeWeeks ?? '0') === '1';
    const mergeProducts = (query.mergeProducts ?? '0') === '1';

    const taxRate = Math.max(0, Math.min(1, query.taxRate ?? 0.15));
    const acquiringRate = query.acquiringRate ?? 0.02;
    const rounding = query.rounding ?? 'standard';
    const includeFact = (query.includeFact ?? '1') === '1';
    const salesModel = query.salesModel ?? 'fbo';
    const calcBase = query.calcBase ?? 'perUnit';
    const requestedQuantity = query.quantity ?? 1;

    const round2 = (x: number) => Math.round(x * 100) / 100;
    const roundPct = (x: number) => Math.round(x);

    async function estimateSppPct(nmId: number, from: string, to: string): Promise<{ frac: number; lines: number }> {
      // 1) DB cache
      try {
        const cached = await db
          .select({ sppPctBp: wbSppWeekly.sppPctBp, lines: wbSppWeekly.lines })
          .from(wbSppWeekly)
          .where(
            and(
              eq(wbSppWeekly.workspaceId, params.workspaceId),
              eq(wbSppWeekly.dateFrom, from),
              eq(wbSppWeekly.dateTo, to),
              eq(wbSppWeekly.nmId, nmId)
            )
          )
          .limit(1);
        if (cached[0]) {
          return { frac: (cached[0].sppPctBp ?? 0) / 10000, lines: cached[0].lines ?? 0 };
        }
      } catch {
        // ignore
      }

      // 2) File cache (legacy)
      const { readFile, writeFile, mkdir } = await import('node:fs/promises');
      await mkdir('out', { recursive: true });
      const cachePath = `out/wb-spp-pct-${nmId}-${from}_${to}.json`;
      try {
        const raw = await readFile(cachePath, 'utf8');
        const j = JSON.parse(raw);
        if (typeof j?.pct === 'number' && Number.isFinite(j.pct)) {
          return { frac: j.pct, lines: typeof j?.lines === 'number' ? j.lines : 0 };
        }
      } catch {
        // ignore
      }

      // 3) Compute from WB statistics
      try {
        const apiKey = await getWbApiKey(params.workspaceId, extractShopId(req));
        let rrdid = 0;
        let wSum = 0;
        let w = 0;
        let lines = 0;

        while (true) {
          const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(
            from
          )}&dateTo=${encodeURIComponent(to)}&limit=100000&rrdid=${rrdid}&period=daily`;

          const rows = await wbGetJson(url, apiKey);
          if (!Array.isArray(rows) || rows.length === 0) break;

          for (const row of rows) {
            if (Number(row?.nm_id) !== nmId) continue;
            const oper = String(row?.supplier_oper_name ?? '');
            if (!oper.includes('Продажа')) continue;
            const pct = typeof row?.ppvz_spp_prc === 'number' ? row.ppvz_spp_prc : null;
            const base = typeof row?.retail_price_withdisc_rub === 'number' ? row.retail_price_withdisc_rub : 0;
            if (pct == null || !Number.isFinite(pct) || base <= 0) continue;
            wSum += pct * base;
            w += base;
            lines += 1;
            const next = row?.rrd_id;
            if (typeof next === 'number' && next > rrdid) rrdid = next;
          }

          if (rows.length < 100000) break;
        }

        const avgPct = w > 0 ? wSum / w : 0; // percent
        const frac = avgPct / 100;
        const sppPctBp = Math.round(avgPct * 100); // percent -> basis points

        // persist
        await db
          .insert(wbSppWeekly)
          .values({
            workspaceId: params.workspaceId,
            dateFrom: from,
            dateTo: to,
            nmId,
            sppPctBp,
            lines,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [wbSppWeekly.workspaceId, wbSppWeekly.dateFrom, wbSppWeekly.dateTo, wbSppWeekly.nmId],
            set: { sppPctBp, lines, updatedAt: new Date() },
          });

        await writeFile(cachePath, JSON.stringify({ pct: frac, lines, at: new Date().toISOString() }, null, 2), 'utf8');
        return { frac, lines };
      } catch {
        return { frac: 0, lines: 0 };
      }
    }

    const nmIds = (query.nmIds ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (nmIds.length === 0) {
      return { workspaceId: params.workspaceId, start, end, rows: [] };
    }

    // commission tariffs cached per request
    const commission = await getCommissionTariffs('ru');
    const commissionBySubjectByModel = {
      fbo: new Map<number, number>(),
      fbs: new Map<number, number>(),
    } as const;
    for (const r of commission) {
      const sid = typeof (r as any).subjectID === 'number' ? (r as any).subjectID : Number((r as any).subjectID);
      const pctFbo = pickCommissionPercent(r, 'marketplace');
      const pctFbs = pickCommissionPercent(r, 'supplier');
      if (Number.isFinite(sid) && sid > 0) {
        if (pctFbo != null) (commissionBySubjectByModel.fbo as Map<number, number>).set(sid, pctFbo);
        if (pctFbs != null) (commissionBySubjectByModel.fbs as Map<number, number>).set(sid, pctFbs);
      }
    }

    // group by weeks or whole range
    const buckets: Array<{ start: string; end: string }> = [];
    if (mergeWeeks) {
      // single bucket
      buckets.push({ start, end });
    } else {
      // week buckets based on start..end
      let cur = weekStart(start);
      while (cur <= end) {
        const wStart = cur;
        const wEnd = weekEnd(wStart);
        const bStart = wStart < start ? start : wStart;
        const bEnd = wEnd > end ? end : wEnd;
        buckets.push({ start: bStart, end: bEnd });
        cur = isoDate(addDays(new Date(wStart + 'T00:00:00Z'), 7));
      }
    }

    // load cards for subjectId/vendorCode + volume liters (from raw)
    const cards = await db
      .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, subjectId: wbCards.subjectId, raw: wbCards.raw })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds as any)));
    const cardByNm = new Map(cards.map((c) => [c.nmId, c] as const));

    const cogsRows = await db
      .select({ nmId: wbCogs.nmId, cogsKopecks: wbCogs.cogsKopecks })
      .from(wbCogs)
      .where(and(eq(wbCogs.workspaceId, params.workspaceId), inArray(wbCogs.nmId, nmIds as any)));
    const cogsByNm = new Map(cogsRows.map((r) => [r.nmId, r.cogsKopecks] as const));

    function volumeLitersFromRaw(raw: any): number | null {
      // Best-effort: try to find dimensions in raw.
      // Expect fields like dimensions: { length, width, height } in cm or mm; unknown for now.
      const d = raw?.dimensions || raw?.sizes?.[0]?.dimensions || raw?.data?.dimensions;
      const L = d?.length ?? d?.len ?? d?.depth;
      const W = d?.width ?? d?.w;
      const H = d?.height ?? d?.h;
      if ([L, W, H].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) {
        // assume cm^3 => liters: /1000
        return (L * W * H) / 1000;
      }
      return null;
    }

    // Logistics model: take median delivery cost across warehouses from WB box tariffs for the period.
    // This is a heuristic; later we can refine by warehouse selection rules.

    const out: any[] = [];

    for (const b of buckets) {
      const stats = await getSalesFunnelProductsStat({
        start: b.start, end: b.end, nmIds, limit: 100, offset: 0,
        workspaceId: params.workspaceId, shopId: extractShopId(req),
      });

      // Pre-load fact data in batch (avoids N+1 queries per product)
      let factByNmId = new Map<number, any>();
      if (includeFact) {
        try {
          const factRows = await db
            .select()
            .from(wbFinanceWeeklyProducts)
            .where(
              and(
                eq(wbFinanceWeeklyProducts.workspaceId, params.workspaceId),
                eq(wbFinanceWeeklyProducts.dateFrom, b.start),
                eq(wbFinanceWeeklyProducts.dateTo, b.end),
                inArray(wbFinanceWeeklyProducts.nmId, nmIds as any)
              )
            );
          for (const r of factRows) {
            factByNmId.set(r.nmId, {
              incomeFromSalesRub: r.incomeFromSalesKopecks / 100,
              revenueRub: r.revenueKopecks / 100,
              logisticsRub: r.logisticsKopecks / 100,
              paidAcceptanceRub: r.paidAcceptanceKopecks / 100,
              storageRub: r.storageKopecks / 100,
              penaltiesRub: r.penaltiesKopecks / 100,
              otherHoldRub: r.otherHoldKopecks / 100,
              additionalPaymentsRub: r.additionalPaymentsKopecks / 100,
            });
          }
        } catch {
          // ignore
        }
      }

      for (const s of stats) {
        const buyoutSum = Number(s.selected.buyoutSum ?? 0);
        const buyoutCount = Number(s.selected.buyoutCount ?? 0);
        if (!Number.isFinite(buyoutSum)) continue;

        const card = cardByNm.get(s.nmId);
        const subjectId = s.subjectId ?? card?.subjectId ?? null;

        // Unit-economics can be computed:
        // - perUnit: theoretical for `quantity` units (default 1)
        // - period: scaled to the WB Analytics period buyoutSum/buyoutCount
        const basePerUnit = buyoutCount > 0 ? buyoutSum / buyoutCount : 0;
        const quantity = calcBase === 'period' ? buyoutCount : Math.max(0, requestedQuantity);
        const base = calcBase === 'period' ? buyoutSum : basePerUnit * quantity;

        const modelsToCompute: Array<'fbo' | 'fbs'> =
          salesModel === 'fbo' ? ['fbo'] : salesModel === 'fbs' ? ['fbs'] : ['fbo', 'fbs'];

        for (const model of modelsToCompute) {
          const commissionPct = subjectId ? commissionBySubjectByModel[model].get(subjectId) ?? 0 : 0;

          const commissionRub = base * commissionPct;
          const acquiringRub = base * acquiringRate;

        // logisticsRub: tariff-model using median across warehouses (per-unit)
        let logisticsRub = 0;
        let logisticsPerUnitRub: number | null = null;
        try {
          const tariffDate = b.start;
          let box: any[] = [];
          try {
            const mod: any = await import('../integrations/wb/tariffs.js');
            box = await mod.getTariffsBox(tariffDate);
          } catch {
            // tsx dev runtime: extensionless import resolves to .ts
            const mod: any = await import('../integrations/wb/tariffs.js');
            box = await mod.getTariffsBox(tariffDate);
          }

          function parseRuNum(v: any): number {
            const x = String(v ?? '').replace(/\s/g, '').replace(',', '.');
            const n = Number.parseFloat(x);
            return Number.isFinite(n) ? n : NaN;
          }

          const dims = (card as any)?.raw?.dimensions;
          const L = dims?.length;
          const W = dims?.width;
          const H = dims?.height;
          const volLiters =
            typeof L === 'number' && typeof W === 'number' && typeof H === 'number' && L > 0 && W > 0 && H > 0
              ? (L * W * H) / 1000
              : null;

          if (volLiters && box.length) {
            const costs: number[] = [];
            for (const w of box as any[]) {
              const base = parseRuNum(w.boxDeliveryBase);
              const add = parseRuNum(w.boxDeliveryLiter);
              const coef = parseRuNum(w.boxDeliveryCoefExpr);
              if (!Number.isFinite(base) || !Number.isFinite(add) || !Number.isFinite(coef)) continue;
              const extra = Math.max(0, volLiters - 1);
              const c = (base + add * extra) * (coef / 100);
              if (Number.isFinite(c) && c >= 0) costs.push(c);
            }

            costs.sort((a, b) => a - b);
            if (costs.length) {
              const mid = costs[Math.floor((costs.length - 1) * 0.5)]!;
              logisticsPerUnitRub = mid;
              logisticsRub = mid * quantity;
            }
          }
        } catch {
          // ignore, keep 0
        }

        // cogsRub: prefer DB value, fallback to user-provided cost per unit from query param
        const dbCogsKopecks = cogsByNm.get(s.nmId) ?? 0;
        const cogsPerUnitRub = dbCogsKopecks > 0
          ? dbCogsKopecks / 100
          : (query.cogsRub ?? 0);
        const cogsRub = cogsPerUnitRub * quantity;

        // SPP: use manual override if provided, otherwise fetch from WB data
        const sppManual = query.sppOverride != null;
        const spp = sppManual
          ? { frac: query.sppOverride! / 100, lines: 0 }
          : await estimateSppPct(s.nmId, b.start, b.end);
        const sppRub = base * spp.frac;
        const buyerPriceRub = base - sppRub;

        const preTaxProfit = base - commissionRub - acquiringRub - logisticsRub - cogsRub;
        // IMPORTANT: Tax cannot be negative (no tax credit on losses)
        // For USN 15%, minimum tax is 1% of revenue, but we use 0 as floor for simplicity
        const taxRub = Math.max(0, preTaxProfit * taxRate);
        const profitRub = preTaxProfit - taxRub;

        const seg = {
          buyerPriceRub,
          sppRub,

          commissionRub,
          acquiringRub,
          logisticsRub,
          cogsRub,
          taxRub,
          profitRub,
        };

        // Use pre-loaded batch fact data
        const fact = includeFact ? (factByNmId.get(s.nmId) ?? null) : null;

        const pct = (v: number) => (base > 0 ? roundPct((v / base) * 100) : 0);

        const segments =
          rounding === 'standard'
            ? {
                buyerPriceRub: round2(seg.buyerPriceRub),
                sppRub: round2(seg.sppRub),

                commissionRub: round2(seg.commissionRub),
                acquiringRub: round2(seg.acquiringRub),
                logisticsRub: round2(seg.logisticsRub),
                cogsRub: round2(seg.cogsRub),
                taxRub: round2(seg.taxRub),
                profitRub: round2(seg.profitRub),
                pct: {
                  buyerPrice: pct(seg.buyerPriceRub),
                  spp: pct(seg.sppRub),

                  commission: pct(seg.commissionRub),
                  acquiring: pct(seg.acquiringRub),
                  logistics: pct(seg.logisticsRub),
                  cogs: pct(seg.cogsRub),
                  tax: pct(seg.taxRub),
                  profit: pct(seg.profitRub),
                },
              }
            : {
                ...seg,
                pct: {
                  buyerPrice: pct(seg.buyerPriceRub),
                  spp: pct(seg.sppRub),

                  commission: pct(seg.commissionRub),
                  acquiring: pct(seg.acquiringRub),
                  logistics: pct(seg.logisticsRub),
                  cogs: pct(seg.cogsRub),
                  tax: pct(seg.taxRub),
                  profit: pct(seg.profitRub),
                },
              };

          out.push({
            bucketStart: b.start,
            bucketEnd: b.end,
            salesModel: model,
            nmId: mergeProducts ? 0 : s.nmId,
            vendorCode: card?.vendorCode ?? s.vendorCode ?? null,
            subjectId,
            // Unit-economics is computed for `quantity` units (default 1).
            quantity,
            basePerUnit,
            baseRub: base,
            // Period context (from WB Analytics) for reference/debug.
            periodBuyoutSum: buyoutSum,
            periodBuyoutCount: buyoutCount,
            segments,
            fact,
            meta: {
              commissionPct,
              acquiringRate,
              taxRate,
              volumeLiters: volumeLitersFromRaw(card?.raw),
              logisticsModel: 'median_box_tariff',
              logisticsPerUnitRub,
              cogsPerUnitRub,
              sppPct: spp.frac,
              sppLines: spp.lines,
            },
          });
        }
      }
    }

    return {
      workspaceId: params.workspaceId,
      start,
      end,
      mergeWeeks,
      mergeProducts,
      taxRate,
      acquiringRate,
      rows: out,
    };
  });
};
