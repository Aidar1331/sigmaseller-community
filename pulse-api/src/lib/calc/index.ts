/**
 * Calculation library for Pulse.
 * Pure functions for business metrics, no DB/HTTP dependencies.
 * 
 * @module lib/calc
 */

// Format utilities
export {
  kopecksToRub,
  rubToKopecks,
  basisPointsToPercent,
  percentToBasisPoints,
  roundMetric,
  formatNumber,
  formatCurrency,
  formatPercent,
} from './format.js';

// Margin calculations
export {
  calcMarketplaceCosts,
  calcMargin,
  calcNetProfit,
  calcMarginPercent,
  calcMarginPerUnit,
  calcMarkupX,
  calcFullMargin,
  type MarketplaceCostsInput,
  type MarginInput,
  type MarginBreakdown,
  type FullMarginInput,
} from './margin.js';

// DRR calculations
export {
  calcDrr,
  calcDrrByOrders,
  calcDrrByAds,
  calcDrrForecast,
  calcDrrByPayout,
  calcDrrBreakdown,
  evaluateDrr,
  calcTacoo,
  calcTacos,
  calcAdMetrics,
  type DrrBreakdown,
  type DrrInput,
  type AdMetricsBreakdown,
} from './drr.js';

// ROI & ROCE calculations
export {
  calcRoi,
  calcMarketplaceRoi,
  roiToProfit,
  evaluateRoi,
  calcRoas,
  calcRoce,
  calcOperatingProfit,
  evaluateRoce,
  type RoiInput,
  type RoceInput,
} from './roi.js';

// Funnel calculations
export {
  calcBuyoutPercent,
  calcMatureBuyoutPercent,
  getMatureOrderCutoff,
  calcConversionRates,
  calcForecastSalesCount,
  calcForecastSalesRevenue,
  calcForecastSales,
  evaluateConversion,
  type ConversionRates,
  type FunnelInput,
  type ForecastSales,
  type MatureBuyoutInput,
  type MatureBuyoutResult,
} from './funnel.js';

// Stock calculations
export {
  calcTurnoverDays,
  calcDailySales,
  calcStockValue,
  calcStockBreakdown,
  calcSupplyNeed,
  evaluateStock,
  calcStockOutRisk,
  type StockBreakdown,
} from './stock.js';

// Tax calculations
export {
  calcTax,
  calcTaxUSN,
  calcTaxUSNIncome,
  normalizeTaxRate,
  compareTaxSystems,
  calcVat,
  extractVat,
  calcNetVat,
  calcFullTax,
  type TaxComparison,
  type TaxSystem,
  type FullTaxInput,
  type FullTaxResult,
} from './tax.js';

// Anomaly detection
export {
  median,
  mad,
  detectAnomalies,
  detectAnomaliesInSeries,
  checkForAnomaly,
  classifyAnomalySeverity,
  type Anomaly,
  type AnomalyConfig,
} from './anomaly.js';

// Winsorization
export {
  winsorize,
  percentileValue,
  getPercentileBounds,
  clip,
  trimmedMean,
} from './winsorize.js';
