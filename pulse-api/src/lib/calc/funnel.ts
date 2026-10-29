/**
 * Funnel and conversion rate calculations.
 * WB funnel stages: Views → Card Opens → Add to Cart → Orders → Buyouts
 */

/**
 * Calculate buyout percentage (redemption rate).
 * Formula: (buyouts / orders) * 100
 * 
 * Note: For accurate buyout %, use orders ≥30 days old (mature orders)
 * since customers have time to return items.
 * 
 * @param buyoutCount - Number of completed purchases
 * @param orderCount - Number of orders placed
 * @returns Buyout percentage
 * 
 * @example
 * calcBuyoutPercent(80, 100) // 80.0 (80% of orders were redeemed)
 * calcBuyoutPercent(0, 100) // 0
 * calcBuyoutPercent(80, 0) // 0
 */
export function calcBuyoutPercent(buyoutCount: number, orderCount: number): number {
  if (!orderCount || orderCount === 0) return 0;
  return ((buyoutCount || 0) / orderCount) * 100;
}

/**
 * Mature buyout data for accurate redemption calculation.
 * "Mature" = orders that are ≥30 days old (return period expired).
 */
export interface MatureBuyoutInput {
  /** Orders placed ≥30 days ago */
  matureOrderCount: number;
  /** Buyouts from those mature orders */
  matureBuyoutCount: number;
  /** Returns from those mature orders */
  matureReturnCount: number;
}

/**
 * Mature buyout calculation result.
 */
export interface MatureBuyoutResult {
  /** Buyout % = buyouts / orders × 100 */
  buyoutPercent: number;
  /** Return % = returns / orders × 100 */
  returnPercent: number;
  /** Cancel % = (orders - buyouts - returns) / orders × 100 */
  cancelPercent: number;
  /** Is the data reliable (enough mature orders) */
  isReliable: boolean;
}

/**
 * Calculate accurate buyout percentage from mature orders (≥30 days).
 * 
 * WB customers have up to 21 days to return items after delivery.
 * For accurate redemption rate, only count orders ≥30 days old.
 * 
 * @param input - Mature order counts
 * @param minOrders - Minimum orders for reliable calculation (default 10)
 * @returns Buyout breakdown
 * 
 * @example
 * calcMatureBuyoutPercent({
 *   matureOrderCount: 100,
 *   matureBuyoutCount: 75,
 *   matureReturnCount: 15
 * })
 * // {
 * //   buyoutPercent: 75.0,
 * //   returnPercent: 15.0,
 * //   cancelPercent: 10.0,
 * //   isReliable: true
 * // }
 */
export function calcMatureBuyoutPercent(
  input: MatureBuyoutInput,
  minOrders = 10
): MatureBuyoutResult {
  const { matureOrderCount, matureBuyoutCount, matureReturnCount } = input;
  
  if (!matureOrderCount || matureOrderCount === 0) {
    return {
      buyoutPercent: 0,
      returnPercent: 0,
      cancelPercent: 0,
      isReliable: false,
    };
  }
  
  const buyoutPercent = (matureBuyoutCount / matureOrderCount) * 100;
  const returnPercent = (matureReturnCount / matureOrderCount) * 100;
  const cancelPercent = Math.max(0, 100 - buyoutPercent - returnPercent);
  
  return {
    buyoutPercent,
    returnPercent,
    cancelPercent,
    isReliable: matureOrderCount >= minOrders,
  };
}

/**
 * Calculate the cutoff date for mature orders.
 * 
 * @param maturityDays - Days to consider order "mature" (default 30)
 * @returns ISO date string for cutoff
 * 
 * @example
 * getMatureOrderCutoff() // "2026-03-02" (if today is 2026-04-01)
 */
export function getMatureOrderCutoff(maturityDays = 30): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maturityDays);
  return cutoff.toISOString().split('T')[0];
}

/**
 * Funnel conversion rates.
 */
export interface ConversionRates {
  /** Views → Card Open (CTR from search) */
  viewToOpen: number;
  /** Card Open → Add to Cart */
  openToCart: number;
  /** Add to Cart → Order */
  cartToOrder: number;
  /** Order → Buyout (redemption rate) */
  orderToBuyout: number;
  /** Views → Order (full funnel conversion) */
  viewToOrder: number;
  /** Views → Buyout (end-to-end conversion) */
  viewToBuyout: number;
}

export interface FunnelInput {
  viewCount: number;
  openCardCount: number;
  addToCartCount: number;
  orderCount: number;
  buyoutCount: number;
}

/**
 * Calculate all funnel conversion rates.
 * 
 * @param input - Counts at each funnel stage
 * @returns Conversion rates between stages
 * 
 * @example
 * calcConversionRates({
 *   viewCount: 10000,
 *   openCardCount: 500,
 *   addToCartCount: 100,
 *   orderCount: 50,
 *   buyoutCount: 40
 * })
 * // {
 * //   viewToOpen: 5.0,
 * //   openToCart: 20.0,
 * //   cartToOrder: 50.0,
 * //   orderToBuyout: 80.0,
 * //   viewToOrder: 0.5,
 * //   viewToBuyout: 0.4
 * // }
 */
export function calcConversionRates(input: FunnelInput): ConversionRates {
  const { viewCount, openCardCount, addToCartCount, orderCount, buyoutCount } = input;
  
  return {
    viewToOpen: viewCount > 0 ? (openCardCount / viewCount) * 100 : 0,
    openToCart: openCardCount > 0 ? (addToCartCount / openCardCount) * 100 : 0,
    cartToOrder: addToCartCount > 0 ? (orderCount / addToCartCount) * 100 : 0,
    orderToBuyout: orderCount > 0 ? (buyoutCount / orderCount) * 100 : 0,
    viewToOrder: viewCount > 0 ? (orderCount / viewCount) * 100 : 0,
    viewToBuyout: viewCount > 0 ? (buyoutCount / viewCount) * 100 : 0,
  };
}

/**
 * Forecast sales based on orders and historical buyout rate.
 * 
 * @param orderCount - Current order count
 * @param buyoutPercent - Historical buyout percentage (0-100)
 * @returns Forecasted sales count
 * 
 * @example
 * calcForecastSalesCount(100, 80) // 80 (expect 80 sales from 100 orders)
 */
export function calcForecastSalesCount(orderCount: number, buyoutPercent: number): number {
  if (!orderCount || orderCount === 0) return 0;
  return Math.round((orderCount * (buyoutPercent || 0)) / 100);
}

/**
 * Forecast sales revenue based on orders and historical buyout rate.
 * 
 * @param orderSumKopecks - Total order value in kopecks
 * @param buyoutPercent - Historical buyout percentage (0-100)
 * @returns Forecasted sales revenue in kopecks
 * 
 * @example
 * calcForecastSalesRevenue(1000000, 80) // 800000
 */
export function calcForecastSalesRevenue(orderSumKopecks: number, buyoutPercent: number): number {
  if (!orderSumKopecks || orderSumKopecks === 0) return 0;
  return Math.round((orderSumKopecks * (buyoutPercent || 0)) / 100);
}

/**
 * Forecast sales (count and revenue).
 */
export interface ForecastSales {
  count: number;
  revenueKopecks: number;
}

/**
 * Calculate forecasted sales.
 * 
 * @param orderCount - Current order count
 * @param orderSumKopecks - Total order value in kopecks
 * @param buyoutPercent - Historical buyout percentage
 * @returns Forecasted count and revenue
 */
export function calcForecastSales(
  orderCount: number,
  orderSumKopecks: number,
  buyoutPercent: number
): ForecastSales {
  return {
    count: calcForecastSalesCount(orderCount, buyoutPercent),
    revenueKopecks: calcForecastSalesRevenue(orderSumKopecks, buyoutPercent),
  };
}

/**
 * Evaluate conversion rate quality at each stage.
 * Based on typical WB benchmarks.
 */
export function evaluateConversion(
  stage: keyof ConversionRates,
  rate: number
): 'poor' | 'below_average' | 'average' | 'good' | 'excellent' {
  // Benchmarks for WB (approximate)
  const benchmarks: Record<keyof ConversionRates, number[]> = {
    viewToOpen: [2, 4, 6, 10],       // <2% poor, >10% excellent
    openToCart: [5, 10, 15, 25],     // CTR to cart
    cartToOrder: [10, 20, 30, 50],   // Cart to order
    orderToBuyout: [50, 70, 80, 90], // Redemption rate
    viewToOrder: [0.1, 0.3, 0.5, 1], // End-to-end order
    viewToBuyout: [0.05, 0.2, 0.4, 0.8], // End-to-end buyout
  };

  const [poor, belowAvg, avg, good] = benchmarks[stage];
  
  if (rate < poor) return 'poor';
  if (rate < belowAvg) return 'below_average';
  if (rate < avg) return 'average';
  if (rate < good) return 'good';
  return 'excellent';
}
