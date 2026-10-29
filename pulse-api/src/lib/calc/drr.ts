/**
 * DRR (Доля Рекламных Расходов) calculation utilities.
 * DRR = (Ad Spend / Revenue) * 100%
 * 
 * Different DRR bases:
 * - Sales-based: adSpend / salesRevenue (actual sales)
 * - Payout-based: adSpend / payoutRevenue (what WB pays)
 * - Orders-based: adSpend / ordersRevenue (ordered, not yet delivered)
 * - Ads-based: adSpend / adsAttributedRevenue (sales attributed to ads)
 * - Forecast-based: adSpend / forecastedRevenue (expected sales from orders)
 */

/**
 * Calculate DRR (ad spend ratio).
 * Generic formula: (adSpend / revenue) * 100
 * 
 * @param adSpendKopecks - Advertising spend in kopecks
 * @param revenueKopecks - Revenue base in kopecks
 * @returns DRR percentage
 * 
 * @example
 * calcDrr(10000, 100000) // 10.0 (10% DRR)
 * calcDrr(50000, 100000) // 50.0 (50% DRR - likely unprofitable)
 * calcDrr(10000, 0) // 0 (avoid division by zero)
 */
export function calcDrr(adSpendKopecks: number, revenueKopecks: number): number {
  if (!revenueKopecks || revenueKopecks === 0) return 0;
  return ((adSpendKopecks || 0) / revenueKopecks) * 100;
}

/**
 * Calculate DRR based on orders revenue.
 * Uses total order value as the base.
 * 
 * @param adSpendKopecks - Advertising spend in kopecks
 * @param ordersKopecks - Orders revenue in kopecks
 * @returns DRR percentage
 * 
 * @example
 * calcDrrByOrders(10000, 200000) // 5.0
 */
export function calcDrrByOrders(adSpendKopecks: number, ordersKopecks: number): number {
  return calcDrr(adSpendKopecks, ordersKopecks);
}

/**
 * Calculate DRR based on ad-attributed revenue.
 * Uses revenue from orders attributed to advertising.
 * 
 * @param adSpendKopecks - Advertising spend in kopecks
 * @param adAttributedKopecks - Revenue attributed to ads in kopecks
 * @returns DRR percentage
 * 
 * @example
 * calcDrrByAds(10000, 50000) // 20.0 (20% of ad revenue spent on ads)
 */
export function calcDrrByAds(adSpendKopecks: number, adAttributedKopecks: number): number {
  return calcDrr(adSpendKopecks, adAttributedKopecks);
}

/**
 * Calculate DRR based on forecasted sales.
 * Uses forecasted revenue (orders * buyout rate).
 * 
 * @param adSpendKopecks - Advertising spend in kopecks
 * @param forecastSalesKopecks - Forecasted sales revenue in kopecks
 * @returns DRR percentage
 * 
 * @example
 * calcDrrForecast(10000, 80000) // 12.5
 */
export function calcDrrForecast(adSpendKopecks: number, forecastSalesKopecks: number): number {
  return calcDrr(adSpendKopecks, forecastSalesKopecks);
}

/**
 * Calculate DRR based on payout revenue.
 * Uses actual payout from WB (after returns).
 * 
 * @param adSpendKopecks - Advertising spend in kopecks
 * @param payoutKopecks - Payout revenue in kopecks
 * @returns DRR percentage
 */
export function calcDrrByPayout(adSpendKopecks: number, payoutKopecks: number): number {
  return calcDrr(adSpendKopecks, payoutKopecks);
}

/**
 * DRR calculation result with multiple bases.
 */
export interface DrrBreakdown {
  /** DRR based on orders revenue */
  drrOrders: number;
  /** DRR based on forecasted sales */
  drrForecast: number;
  /** DRR based on ad-attributed revenue */
  drrAds: number;
  /** DRR based on payout */
  drrPayout: number;
}

export interface DrrInput {
  adSpendKopecks: number;
  ordersKopecks: number;
  forecastSalesKopecks: number;
  adAttributedKopecks: number;
  payoutKopecks: number;
}

/**
 * Calculate all DRR variants.
 * 
 * @param input - Revenue bases for DRR calculation
 * @returns DRR breakdown for all bases
 */
export function calcDrrBreakdown(input: DrrInput): DrrBreakdown {
  return {
    drrOrders: calcDrrByOrders(input.adSpendKopecks, input.ordersKopecks),
    drrForecast: calcDrrForecast(input.adSpendKopecks, input.forecastSalesKopecks),
    drrAds: calcDrrByAds(input.adSpendKopecks, input.adAttributedKopecks),
    drrPayout: calcDrrByPayout(input.adSpendKopecks, input.payoutKopecks),
  };
}

/**
 * Evaluate DRR quality.
 * General guidelines for WB marketplace.
 * 
 * @param drrPercent - DRR percentage
 * @returns Quality assessment
 */
export function evaluateDrr(drrPercent: number): 'excellent' | 'good' | 'moderate' | 'high' | 'critical' {
  if (drrPercent <= 5) return 'excellent';
  if (drrPercent <= 10) return 'good';
  if (drrPercent <= 20) return 'moderate';
  if (drrPercent <= 35) return 'high';
  return 'critical';
}

/**
 * Calculate TACOO (Total Advertising Cost of Organic Orders).
 * Formula: (adSpend / ordersRevenue) × 100
 * 
 * Measures ad efficiency relative to all orders (including organic).
 * Lower is better - means ads cost less per order.
 * 
 * @param adSpendKopecks - Total advertising spend
 * @param ordersKopecks - Total orders revenue (all orders, not just from ads)
 * @returns TACOO percentage
 * 
 * @example
 * calcTacoo(10000, 200000) // 5.0 (5% of order value spent on ads)
 */
export function calcTacoo(adSpendKopecks: number, ordersKopecks: number): number {
  return calcDrr(adSpendKopecks, ordersKopecks);
}

/**
 * Calculate TACOS (Total Advertising Cost of Sales).
 * Formula: (adSpend / salesRevenue) × 100
 * 
 * Measures ad efficiency relative to actual sales (buyouts).
 * More accurate than TACOO as it excludes returns and cancellations.
 * 
 * Note: For accurate TACOS, use sales from orders ≥30 days old
 * (mature orders with expired return period).
 * 
 * @param adSpendKopecks - Total advertising spend
 * @param salesKopecks - Total sales revenue (buyouts)
 * @returns TACOS percentage
 * 
 * @example
 * calcTacos(10000, 160000) // 6.25 (6.25% of sales spent on ads)
 */
export function calcTacos(adSpendKopecks: number, salesKopecks: number): number {
  return calcDrr(adSpendKopecks, salesKopecks);
}

/**
 * Advertising metrics breakdown.
 */
export interface AdMetricsBreakdown {
  /** DRR based on payout */
  drrPercent: number;
  /** TACOO - ad cost % of orders */
  tacooPercent: number;
  /** TACOS - ad cost % of sales */
  tacosPercent: number;
  /** ROAS - return on ad spend (revenue/adSpend × 100) */
  roasPercent: number;
}

/**
 * Calculate all advertising efficiency metrics.
 * 
 * @param adSpendKopecks - Total advertising spend
 * @param ordersKopecks - Orders revenue
 * @param salesKopecks - Sales (buyouts) revenue  
 * @param payoutKopecks - Payout from marketplace
 * @returns All ad metrics
 */
export function calcAdMetrics(
  adSpendKopecks: number,
  ordersKopecks: number,
  salesKopecks: number,
  payoutKopecks: number
): AdMetricsBreakdown {
  return {
    drrPercent: calcDrrByPayout(adSpendKopecks, payoutKopecks),
    tacooPercent: calcTacoo(adSpendKopecks, ordersKopecks),
    tacosPercent: calcTacos(adSpendKopecks, salesKopecks),
    roasPercent: adSpendKopecks > 0 ? (salesKopecks / adSpendKopecks) * 100 : 0,
  };
}
