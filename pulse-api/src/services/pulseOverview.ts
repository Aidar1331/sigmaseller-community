/**
 * Pulse Overview Service
 * 
 * Extracts business logic from pulse.ts route handler.
 * Uses lib/calc/ for all calculations.
 * 
 * Phase 3.1: Рефакторинг pulse.ts → сервис
 */

import {
  calcMarketplaceCosts,
  calcMargin,
  calcNetProfit,
  calcMarginPercent,
  calcMarginPerUnit,
  calcMarkupX,
  calcDrr,
  calcBuyoutPercent,
  calcConversionRates,
  calcTurnoverDays,
  calcDailySales,
  calcTax,
  calcRoi,
  calcRoce,
  calcOperatingProfit,
  kopecksToRub,
  roundMetric,
  detectAnomalies,
  type MarketplaceCostsInput,
  type FunnelInput,
  type Anomaly,
} from '../lib/calc/index.js';

/**
 * Raw bucket data from DB aggregations
 */
export interface RawBucket {
  key: string;
  days: number;

  // Orders/Sales
  ordersCount: number;
  salesCount: number;
  salesKopecks: number;
  ordersKopecks: number;
  discountPercentSumBp: number;
  finishedPriceKopecks: number;

  // Advertising - Total
  advKopecks: number;
  advViews: number;
  advClicks: number;
  advAtbs: number;
  advOrders: number;
  advSumPriceKopecks: number;

  // Advertising - Manual campaigns
  advManualKopecks: number;
  advManualViews: number;
  advManualClicks: number;
  advManualAtbs: number;
  advManualOrders: number;
  advManualSumPriceKopecks: number;

  // Advertising - Unified campaigns
  advUnifiedKopecks: number;
  advUnifiedViews: number;
  advUnifiedClicks: number;
  advUnifiedAtbs: number;
  advUnifiedOrders: number;
  advUnifiedSumPriceKopecks: number;

  // Finance
  retailKopecks: number;        // Валовая выручка (Torgstat: Выручка)
  sppAmountKopecks: number;     // СПП (скидка постоянного покупателя)
  payoutKopecks: number;
  additionalPaymentKopecks: number;
  commissionKopecks: number;    // ppvz_sales_commission (отрицательная)
  ppvzVwKopecks: number;        // Вознаграждение WB (часть комиссии)
  logisticsKopecks: number;
  returnLogisticsKopecks: number;
  paidAcceptanceKopecks: number;
  storageKopecks: number;
  penaltyKopecks: number;
  otherHoldKopecks: number;
  acquiringKopecks: number;
  returnsCount: number;

  // COGS
  cogsKopecks: number;

  // Stock
  stockQty: number;
  stockInWayTo: number;
  stockInWayFrom: number;
  stockValueKopecks: number;

  // Funnel
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
}

/**
 * Helper to create empty RawBucket
 */
export function createEmptyRawBucket(key: string): RawBucket {
  return {
    key,
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
    retailKopecks: 0,
    sppAmountKopecks: 0,
    payoutKopecks: 0,
    additionalPaymentKopecks: 0,
    commissionKopecks: 0,
    ppvzVwKopecks: 0,
    logisticsKopecks: 0,
    returnLogisticsKopecks: 0,
    paidAcceptanceKopecks: 0,
    storageKopecks: 0,
    penaltyKopecks: 0,
    otherHoldKopecks: 0,
    acquiringKopecks: 0,
    returnsCount: 0,
    cogsKopecks: 0,
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
  };
}

/**
 * Computed KPIs for a time bucket (full API response shape)
 */
export interface ComputedBucket {
  key: string;

  // Orders/Sales
  ordersCount: number;
  salesCount: number;
  salesRub: number;
  ordersRub: number;
  priceNoSppRub: number;
  priceWithSppRub: number;
  sppPercent: number;

  // Forecast
  forecastSalesCount: number;
  forecastSalesRub: number;

  // Advertising - Total
  advSpendRub: number;
  advViews: number;
  advClicks: number;
  advAtbs: number;
  advOrders: number;
  advOrdersRub: number;
  advCtrPercent: number;
  advClickToCartPercent: number;
  advCartToOrderPercent: number;
  advCrPercent: number;
  advCpmRub: number;
  advCpcRub: number;
  advCpoRub: number;

  // Advertising - Manual campaigns
  advManualSpendRub: number;
  advManualViews: number;
  advManualClicks: number;
  advManualAtbs: number;
  advManualOrders: number;
  advManualOrdersRub: number;
  advManualCtrPercent: number;
  advManualClickToCartPercent: number;
  advManualCartToOrderPercent: number;
  advManualCrPercent: number;
  advManualCpmRub: number;
  advManualCpcRub: number;
  advManualCpoRub: number;
  advManualDrrPercent: number;

  // Advertising - Unified campaigns
  advUnifiedSpendRub: number;
  advUnifiedViews: number;
  advUnifiedClicks: number;
  advUnifiedAtbs: number;
  advUnifiedOrders: number;
  advUnifiedOrdersRub: number;
  advUnifiedCtrPercent: number;
  advUnifiedClickToCartPercent: number;
  advUnifiedCartToOrderPercent: number;
  advUnifiedCrPercent: number;
  advUnifiedCpmRub: number;
  advUnifiedCpcRub: number;
  advUnifiedCpoRub: number;
  advUnifiedDrrPercent: number;

  // DRR
  drrPercent: number;
  drrOrdersPercent: number;
  drrAdsPercent: number;

  // Finance
  retailRub: number;           // Валовая выручка (Torgstat: Выручка)
  sppAmountRub: number;        // СПП в рублях
  realizationRub: number;      // Сумма реализации = retail - spp
  payoutRub: number;
  additionalPaymentRub: number;
  commissionRub: number;       // Полная комиссия (ppvz_sales_commission + ppvz_vw)
  logisticsRub: number;
  returnLogisticsRub: number;
  paidAcceptanceRub: number;
  storageRub: number;
  penaltyRub: number;
  otherHoldRub: number;
  acquiringRub: number;
  returnsCount: number;

  marketplaceCostsRub: number;
  marginRub: number;
  netProfitRub: number;
  marginPercent: number;
  profitabilityPercent: number; // Рентабельность = ЧП / Выручка × 100 (Торгстат)
  marginPerUnitRub: number;
  markupX: number;
  roiPercent: number;
  rocePercent: number;
  taxRub: number;
  cogsRub: number;

  // Stock
  stockQty: number;
  stockInWayTo: number;
  stockInWayFrom: number;
  stockMoneyRub: number;
  turnoverDays: number;

  // Funnel
  viewCount: number;
  openCardCount: number;
  addToCartCount: number;
  addToWishlistCount: number;
  funnelOrderCount: number;
  buyoutCount: number;
  buyoutSumRub: number;
  cancelCount: number;
  cancelSumRub: number;
  buyoutPercent: number;
  viewToOpenPercent: number;
  openToCartPercent: number;
  cartToOrderPercent: number;
}

export interface ComputeKPIsOptions {
  drrBase: 'sales' | 'payout';
  taxRate: number;
}

/**
 * Compute ad metrics for a campaign type
 */
function computeAdMetrics(
  spendKopecks: number,
  views: number,
  clicks: number,
  atbs: number,
  orders: number,
  sumPriceKopecks: number
) {
  const spendRub = kopecksToRub(spendKopecks);
  const ordersRub = kopecksToRub(sumPriceKopecks);

  const ctr = views > 0 ? (clicks / views) * 100 : 0;
  const clickToCart = clicks > 0 ? (atbs / clicks) * 100 : 0;
  const cartToOrder = atbs > 0 ? (orders / atbs) * 100 : 0;
  const cr = clicks > 0 ? (orders / clicks) * 100 : 0;
  const cpm = views > 0 ? (spendRub / views) * 1000 : 0;
  const cpc = clicks > 0 ? spendRub / clicks : 0;
  const cpo = orders > 0 ? spendRub / orders : 0;
  const drr = ordersRub > 0 ? (spendRub / ordersRub) * 100 : 0;

  return {
    spendRub: roundMetric(spendRub),
    views: Math.round(views),
    clicks: Math.round(clicks),
    atbs: Math.round(atbs),
    orders: Math.round(orders),
    ordersRub: roundMetric(ordersRub),
    ctrPercent: roundMetric(ctr),
    clickToCartPercent: roundMetric(clickToCart),
    cartToOrderPercent: roundMetric(cartToOrder),
    crPercent: roundMetric(cr),
    cpmRub: roundMetric(cpm),
    cpcRub: roundMetric(cpc),
    cpoRub: roundMetric(cpo),
    drrPercent: roundMetric(drr),
  };
}

/**
 * Compute KPIs for a single time bucket
 */
export function computeBucketKPIs(
  raw: RawBucket,
  options: ComputeKPIsOptions
): ComputedBucket {
  const { drrBase, taxRate } = options;

  // Marketplace costs (Torgstat methodology: commission + logistics + storage + ...)
  const costsInput: MarketplaceCostsInput = {
    logisticsKopecks: raw.logisticsKopecks,
    returnLogisticsKopecks: raw.returnLogisticsKopecks,
    paidAcceptanceKopecks: raw.paidAcceptanceKopecks,
    storageKopecks: raw.storageKopecks,
    penaltyKopecks: raw.penaltyKopecks,
    otherHoldKopecks: raw.otherHoldKopecks,
    acquiringKopecks: raw.acquiringKopecks,
  };
  const operationalCostsKopecks = calcMarketplaceCosts(costsInput);
  
  // ИСПРАВЛЕНО: Реальная комиссия = retail - ppvz_for_pay
  // WB API не возвращает все удержания в отдельных полях, но ppvz_for_pay уже их учитывает
  // Это совпадает с "Комиссией" из еженедельного отчёта WB
  const fullCommissionKopecks = raw.retailKopecks > 0
    ? raw.retailKopecks - raw.payoutKopecks  // Правильно: retail - payout = комиссия WB
    : Math.abs(raw.commissionKopecks) + Math.abs(raw.ppvzVwKopecks);  // Fallback если нет retail
  
  // Total marketplace costs = commission + operational costs
  const marketplaceCostsKopecks = fullCommissionKopecks + operationalCostsKopecks;

  // Gross profit = Revenue - Marketplace costs (Torgstat formula)
  // Using retail as revenue base for Torgstat compatibility
  const grossProfitKopecks = raw.retailKopecks > 0 
    ? raw.retailKopecks - marketplaceCostsKopecks
    : raw.payoutKopecks + raw.additionalPaymentKopecks; // fallback if no retail data
  
  // For backward compatibility, keep marginKopecks as grossProfit
  const marginKopecks = grossProfitKopecks;
  const netProfitKopecks = calcNetProfit(marginKopecks, raw.advKopecks);
  // Margin % based on retail (Torgstat methodology), fallback to orders if no retail
  const marginPercent = raw.retailKopecks > 0 
    ? calcMarginPercent(marginKopecks, raw.retailKopecks)
    : calcMarginPercent(marginKopecks, raw.ordersKopecks);
  const marginPerUnitRub = calcMarginPerUnit(marginKopecks, raw.buyoutCount);

  // COGS and markup
  const cogsPerUnitRub = raw.buyoutCount > 0 ? raw.cogsKopecks / raw.buyoutCount / 100 : 0;
  const priceNoSppRub = raw.ordersCount > 0 ? kopecksToRub(raw.ordersKopecks / raw.ordersCount) : 0;
  const markupX = calcMarkupX(priceNoSppRub, cogsPerUnitRub);

  // Tax and ROI
  const taxableBase = raw.payoutKopecks - marketplaceCostsKopecks - raw.cogsKopecks;
  const taxKopecks = taxableBase > 0 ? calcTax(taxableBase, taxRate) : 0;
  const totalCosts = marketplaceCostsKopecks + raw.cogsKopecks + taxKopecks;
  const roiPercent = calcRoi(raw.payoutKopecks, totalCosts);
  
  // ROCE (Return on Capital Employed)
  const operatingProfitKopecks = calcOperatingProfit(
    raw.payoutKopecks, 
    marketplaceCostsKopecks, 
    raw.cogsKopecks
  );
  const rocePercent = calcRoce({
    operatingProfitKopecks,
    stockValueKopecks: raw.stockValueKopecks || 0,
    // receivablesKopecks: можно добавить неоплаченные выплаты WB
  });
  
  // Рентабельность = Чистая прибыль / Выручка × 100 (Торгстат methodology)
  const profitabilityPercent = raw.retailKopecks > 0 
    ? (netProfitKopecks / raw.retailKopecks) * 100
    : raw.ordersKopecks > 0 ? (netProfitKopecks / raw.ordersKopecks) * 100 : 0;

  // Funnel
  const funnelInput: FunnelInput = {
    viewCount: raw.viewCount,
    openCardCount: raw.openCardCount,
    addToCartCount: raw.addToCartCount,
    orderCount: raw.orderCount,
    buyoutCount: raw.buyoutCount,
  };
  const conversionRates = calcConversionRates(funnelInput);
  const buyoutPercent = calcBuyoutPercent(raw.buyoutCount, raw.orderCount);

  // Forecast
  const forecastSalesCount = raw.orderCount > 0 
    ? Math.round((raw.orderCount * buyoutPercent) / 100) 
    : 0;
  const forecastSalesRub = raw.orderCount > 0 
    ? roundMetric((raw.orderSum * buyoutPercent) / 100) 
    : 0;

  // DRR
  const drrSales = calcDrr(raw.advKopecks, raw.salesKopecks);
  const drrPayout = calcDrr(raw.advKopecks, raw.payoutKopecks);
  const drrPercent = drrBase === 'payout' ? drrPayout : drrSales;
  const drrOrdersPercent = calcDrr(raw.advKopecks, raw.ordersKopecks);
  const drrAdsPercent = calcDrr(raw.advKopecks, raw.advSumPriceKopecks);

  // Ad metrics - Total
  const adTotal = computeAdMetrics(
    raw.advKopecks,
    raw.advViews,
    raw.advClicks,
    raw.advAtbs,
    raw.advOrders,
    raw.advSumPriceKopecks
  );

  // Ad metrics - Manual
  const adManual = computeAdMetrics(
    raw.advManualKopecks,
    raw.advManualViews,
    raw.advManualClicks,
    raw.advManualAtbs,
    raw.advManualOrders,
    raw.advManualSumPriceKopecks
  );

  // Ad metrics - Unified
  const adUnified = computeAdMetrics(
    raw.advUnifiedKopecks,
    raw.advUnifiedViews,
    raw.advUnifiedClicks,
    raw.advUnifiedAtbs,
    raw.advUnifiedOrders,
    raw.advUnifiedSumPriceKopecks
  );

  // Stock
  const dailySales = calcDailySales(raw.salesCount, raw.days);
  const turnoverDays = calcTurnoverDays(raw.stockQty, dailySales);

  // SPP
  const priceWithSppRub = raw.ordersCount > 0 
    ? kopecksToRub(raw.finishedPriceKopecks / raw.ordersCount) 
    : 0;
  const sppPercent = raw.ordersCount > 0 
    ? roundMetric((raw.discountPercentSumBp / raw.ordersCount) / 100) 
    : 0;

  return {
    key: raw.key,

    // Orders/Sales
    ordersCount: raw.ordersCount,
    salesCount: raw.salesCount,
    salesRub: kopecksToRub(raw.salesKopecks),
    ordersRub: kopecksToRub(raw.ordersKopecks),
    priceNoSppRub: roundMetric(priceNoSppRub),
    priceWithSppRub: roundMetric(priceWithSppRub),
    sppPercent,

    // Forecast
    forecastSalesCount,
    forecastSalesRub,

    // Advertising - Total
    advSpendRub: adTotal.spendRub,
    advViews: adTotal.views,
    advClicks: adTotal.clicks,
    advAtbs: adTotal.atbs,
    advOrders: adTotal.orders,
    advOrdersRub: adTotal.ordersRub,
    advCtrPercent: adTotal.ctrPercent,
    advClickToCartPercent: adTotal.clickToCartPercent,
    advCartToOrderPercent: adTotal.cartToOrderPercent,
    advCrPercent: adTotal.crPercent,
    advCpmRub: adTotal.cpmRub,
    advCpcRub: adTotal.cpcRub,
    advCpoRub: adTotal.cpoRub,

    // Advertising - Manual
    advManualSpendRub: adManual.spendRub,
    advManualViews: adManual.views,
    advManualClicks: adManual.clicks,
    advManualAtbs: adManual.atbs,
    advManualOrders: adManual.orders,
    advManualOrdersRub: adManual.ordersRub,
    advManualCtrPercent: adManual.ctrPercent,
    advManualClickToCartPercent: adManual.clickToCartPercent,
    advManualCartToOrderPercent: adManual.cartToOrderPercent,
    advManualCrPercent: adManual.crPercent,
    advManualCpmRub: adManual.cpmRub,
    advManualCpcRub: adManual.cpcRub,
    advManualCpoRub: adManual.cpoRub,
    advManualDrrPercent: adManual.drrPercent,

    // Advertising - Unified
    advUnifiedSpendRub: adUnified.spendRub,
    advUnifiedViews: adUnified.views,
    advUnifiedClicks: adUnified.clicks,
    advUnifiedAtbs: adUnified.atbs,
    advUnifiedOrders: adUnified.orders,
    advUnifiedOrdersRub: adUnified.ordersRub,
    advUnifiedCtrPercent: adUnified.ctrPercent,
    advUnifiedClickToCartPercent: adUnified.clickToCartPercent,
    advUnifiedCartToOrderPercent: adUnified.cartToOrderPercent,
    advUnifiedCrPercent: adUnified.crPercent,
    advUnifiedCpmRub: adUnified.cpmRub,
    advUnifiedCpcRub: adUnified.cpcRub,
    advUnifiedCpoRub: adUnified.cpoRub,
    advUnifiedDrrPercent: adUnified.drrPercent,

    // DRR
    drrPercent: roundMetric(drrPercent),
    drrOrdersPercent: roundMetric(drrOrdersPercent),
    drrAdsPercent: roundMetric(drrAdsPercent),

    // Finance (Torgstat methodology)
    retailRub: kopecksToRub(raw.retailKopecks),
    sppAmountRub: kopecksToRub(raw.sppAmountKopecks),
    realizationRub: kopecksToRub(raw.retailKopecks - raw.sppAmountKopecks),
    payoutRub: kopecksToRub(raw.payoutKopecks),
    additionalPaymentRub: kopecksToRub(raw.additionalPaymentKopecks),
    commissionRub: kopecksToRub(fullCommissionKopecks), // Full commission (ppvz_sales_commission + ppvz_vw)
    logisticsRub: kopecksToRub(raw.logisticsKopecks),
    returnLogisticsRub: kopecksToRub(raw.returnLogisticsKopecks),
    paidAcceptanceRub: kopecksToRub(raw.paidAcceptanceKopecks),
    storageRub: kopecksToRub(raw.storageKopecks),
    penaltyRub: kopecksToRub(raw.penaltyKopecks),
    otherHoldRub: kopecksToRub(raw.otherHoldKopecks),
    acquiringRub: kopecksToRub(raw.acquiringKopecks),
    returnsCount: Math.round(raw.returnsCount),

    marketplaceCostsRub: kopecksToRub(marketplaceCostsKopecks),
    marginRub: kopecksToRub(marginKopecks),
    netProfitRub: kopecksToRub(netProfitKopecks),
    marginPercent: roundMetric(marginPercent),
    profitabilityPercent: roundMetric(profitabilityPercent),
    marginPerUnitRub: roundMetric(marginPerUnitRub),
    markupX: roundMetric(markupX),
    roiPercent: roundMetric(roiPercent),
    rocePercent: roundMetric(rocePercent),
    taxRub: kopecksToRub(taxKopecks),
    cogsRub: kopecksToRub(raw.cogsKopecks),

    // Stock
    stockQty: Math.round(raw.stockQty),
    stockInWayTo: Math.round(raw.stockInWayTo),
    stockInWayFrom: Math.round(raw.stockInWayFrom),
    stockMoneyRub: kopecksToRub(raw.stockValueKopecks),
    turnoverDays: roundMetric(turnoverDays),

    // Funnel
    viewCount: Math.round(raw.viewCount),
    openCardCount: Math.round(raw.openCardCount),
    addToCartCount: Math.round(raw.addToCartCount),
    addToWishlistCount: Math.round(raw.addToWishlistCount),
    funnelOrderCount: Math.round(raw.orderCount),
    buyoutCount: Math.round(raw.buyoutCount),
    buyoutSumRub: roundMetric(raw.buyoutSum),
    cancelCount: Math.round(raw.cancelCount),
    cancelSumRub: roundMetric(raw.cancelSum),
    buyoutPercent: roundMetric(buyoutPercent),
    viewToOpenPercent: roundMetric(conversionRates.viewToOpen),
    openToCartPercent: roundMetric(conversionRates.openToCart),
    cartToOrderPercent: roundMetric(conversionRates.cartToOrder),
  };
}

/**
 * Compute KPIs for all buckets in a series
 */
export function computeSeriesKPIs(
  rawBuckets: RawBucket[],
  options: ComputeKPIsOptions
): ComputedBucket[] {
  return rawBuckets.map((raw) => computeBucketKPIs(raw, options));
}

/**
 * Detect anomalies in a metric series
 */
export function detectMetricAnomalies(
  series: ComputedBucket[],
  metricName: keyof ComputedBucket,
  config: { windowSize?: number; thresholdPercent?: number } = {}
): Anomaly[] {
  const values = series.map((b) => Number(b[metricName]) || 0);
  const keys = series.map((b) => b.key);

  return detectAnomalies(values, {
    windowSize: config.windowSize ?? 7,
    thresholdPercent: config.thresholdPercent ?? 20,
    keys,
  });
}

/**
 * Calculate percentage delta between current and previous period
 */
export function calcPeriodDelta(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Aggregate totals from bucket series
 */
export interface PeriodTotals {
  ordersCount: number;
  salesCount: number;
  salesRub: number;
  advSpendRub: number;
  marginRub: number;
  netProfitRub: number;
  drrPercent: number;
}

export function aggregatePeriodTotals(series: ComputedBucket[]): PeriodTotals {
  const totals = series.reduce(
    (acc, b) => ({
      ordersCount: acc.ordersCount + b.ordersCount,
      salesCount: acc.salesCount + b.salesCount,
      salesRub: acc.salesRub + b.salesRub,
      advSpendRub: acc.advSpendRub + b.advSpendRub,
      marginRub: acc.marginRub + b.marginRub,
      netProfitRub: acc.netProfitRub + b.netProfitRub,
    }),
    {
      ordersCount: 0,
      salesCount: 0,
      salesRub: 0,
      advSpendRub: 0,
      marginRub: 0,
      netProfitRub: 0,
    }
  );

  const drrPercent = totals.salesRub > 0 
    ? (totals.advSpendRub / totals.salesRub) * 100 
    : 0;

  return { ...totals, drrPercent: roundMetric(drrPercent) };
}

/**
 * Aggregate raw buckets from Maps of daily data
 */
export interface DailyDataMaps {
  ordersSales: Map<string, {
    ordersCount: number;
    salesCount: number;
    salesRub: number;
    ordersRub: number;
    discountPercentSumBp: number;
    finishedPriceRub: number;
  }>;
  adv: Map<string, {
    spendKopecks: number;
    viewsCount: number;
    clicksCount: number;
    atbsCount: number;
    ordersCount: number;
    sumPriceKopecks: number;
    spendManualKopecks: number;
    viewsManualCount: number;
    clicksManualCount: number;
    atbsManualCount: number;
    ordersManualCount: number;
    sumPriceManualKopecks: number;
    spendUnifiedKopecks: number;
    viewsUnifiedCount: number;
    clicksUnifiedCount: number;
    atbsUnifiedCount: number;
    ordersUnifiedCount: number;
    sumPriceUnifiedKopecks: number;
  }>;
  finance: Map<string, {
    retailKopecks: number;
    sppAmountKopecks: number;
    payoutKopecks: number;
    additionalPaymentKopecks: number;
    commissionKopecks: number;
    ppvzVwKopecks: number;
    logisticsKopecks: number;
    returnLogisticsKopecks: number;
    paidAcceptanceKopecks: number;
    storageKopecks: number;
    penaltyKopecks: number;
    otherHoldKopecks: number;
    acquiringKopecks: number;
    returnsCount: number;
  }>;
  stock: Map<string, {
    quantity: number;
    inWayToClient: number;
    inWayFromClient: number;
  }>;
  cogs: Map<string, number>;
  stockValue: Map<string, number>;
  funnel: Map<string, {
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
  }>;
}

/**
 * Build raw buckets from daily data maps
 */
export function buildRawBuckets(
  dates: string[],
  groupBy: 'day' | 'week',
  data: DailyDataMaps,
  weekStartFn: (iso: string) => string
): RawBucket[] {
  // Determine bucket keys
  const keys: string[] = [];
  for (const date of dates) {
    keys.push(groupBy === 'week' ? weekStartFn(date) : date);
  }
  const uniqueKeys = Array.from(new Set(keys)).sort();

  // Initialize buckets
  const buckets = new Map<string, RawBucket>();
  for (const k of uniqueKeys) {
    buckets.set(k, createEmptyRawBucket(k));
  }

  // Aggregate data into buckets
  for (const date of dates) {
    const k = groupBy === 'week' ? weekStartFn(date) : date;
    const b = buckets.get(k)!;
    b.days += 1;

    const os = data.ordersSales.get(date);
    if (os) {
      b.ordersCount += os.ordersCount;
      b.salesCount += os.salesCount;
      b.salesKopecks += os.salesRub;
      b.ordersKopecks += os.ordersRub ?? 0;
      b.discountPercentSumBp += os.discountPercentSumBp ?? 0;
      b.finishedPriceKopecks += os.finishedPriceRub ?? 0;
    }

    const a = data.adv.get(date);
    if (a) {
      b.advKopecks += a.spendKopecks;
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

    const f = data.finance.get(date);
    if (f) {
      b.retailKopecks += f.retailKopecks ?? 0;
      b.sppAmountKopecks += f.sppAmountKopecks ?? 0;
      b.payoutKopecks += f.payoutKopecks;
      b.additionalPaymentKopecks += f.additionalPaymentKopecks;
      b.commissionKopecks += f.commissionKopecks;
      b.ppvzVwKopecks += f.ppvzVwKopecks ?? 0;
      b.logisticsKopecks += f.logisticsKopecks;
      b.returnLogisticsKopecks += f.returnLogisticsKopecks ?? 0;
      b.paidAcceptanceKopecks += f.paidAcceptanceKopecks ?? 0;
      b.storageKopecks += f.storageKopecks;
      b.penaltyKopecks += f.penaltyKopecks;
      b.otherHoldKopecks += f.otherHoldKopecks ?? 0;
      b.acquiringKopecks += f.acquiringKopecks;
      b.returnsCount += f.returnsCount ?? 0;
    }

    const st = data.stock.get(date);
    if (st) {
      b.stockQty += st.quantity ?? 0;
      b.stockInWayTo += st.inWayToClient ?? 0;
      b.stockInWayFrom += st.inWayFromClient ?? 0;
    }

    const cogs = data.cogs.get(date);
    if (cogs) b.cogsKopecks += cogs;

    const stockValue = data.stockValue.get(date);
    if (stockValue) b.stockValueKopecks += stockValue;

    const fu = data.funnel.get(date);
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
  }

  return Array.from(buckets.values()).sort((a, b) => (a.key < b.key ? -1 : 1));
}
