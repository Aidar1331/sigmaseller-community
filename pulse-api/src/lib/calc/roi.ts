/**
 * ROI (Return on Investment) calculation utilities.
 * ROI = (Revenue / Total Costs) * 100%
 * 
 * For marketplace sellers:
 * - Revenue: payout from WB
 * - Costs: marketplace costs + COGS + taxes
 */

/**
 * Calculate ROI percentage.
 * Formula: (revenue / totalCosts) * 100
 * 
 * ROI interpretation:
 * - 100% = break-even (revenue equals costs)
 * - >100% = profit (e.g., 150% means 50% profit on costs)
 * - <100% = loss (e.g., 80% means losing 20% of costs)
 * 
 * @param revenueKopecks - Total revenue in kopecks
 * @param totalCostsKopecks - Total costs in kopecks
 * @returns ROI percentage
 * 
 * @example
 * calcRoi(150000, 100000) // 150.0 (50% profit on investment)
 * calcRoi(80000, 100000) // 80.0 (20% loss)
 * calcRoi(100000, 0) // 0 (no costs = invalid)
 */
export function calcRoi(revenueKopecks: number, totalCostsKopecks: number): number {
  if (!totalCostsKopecks || totalCostsKopecks === 0) return 0;
  return ((revenueKopecks || 0) / totalCostsKopecks) * 100;
}

/**
 * ROI input with all cost components.
 */
export interface RoiInput {
  payoutKopecks: number;
  marketplaceCostsKopecks: number;
  cogsKopecks: number;
  taxKopecks: number;
}

/**
 * Calculate ROI for marketplace seller.
 * 
 * @param input - Revenue and cost components
 * @returns ROI percentage
 * 
 * @example
 * calcMarketplaceRoi({
 *   payoutKopecks: 150000,
 *   marketplaceCostsKopecks: 30000,
 *   cogsKopecks: 50000,
 *   taxKopecks: 10000
 * }) // 166.67 (66.67% profit)
 */
export function calcMarketplaceRoi(input: RoiInput): number {
  const totalCosts = 
    (input.marketplaceCostsKopecks || 0) + 
    (input.cogsKopecks || 0) + 
    (input.taxKopecks || 0);
  
  return calcRoi(input.payoutKopecks, totalCosts);
}

/**
 * Calculate profit margin from ROI.
 * Formula: (ROI - 100) = profit percentage on costs
 * 
 * @param roiPercent - ROI percentage
 * @returns Profit percentage (can be negative for losses)
 * 
 * @example
 * roiToProfit(150) // 50 (50% profit)
 * roiToProfit(80) // -20 (20% loss)
 */
export function roiToProfit(roiPercent: number): number {
  return (roiPercent || 0) - 100;
}

/**
 * Evaluate ROI quality.
 * 
 * @param roiPercent - ROI percentage
 * @returns Quality assessment
 */
export function evaluateRoi(roiPercent: number): 'loss' | 'breakeven' | 'low' | 'moderate' | 'good' | 'excellent' {
  if (roiPercent < 100) return 'loss';
  if (roiPercent === 100) return 'breakeven';
  if (roiPercent < 120) return 'low';
  if (roiPercent < 150) return 'moderate';
  if (roiPercent < 200) return 'good';
  return 'excellent';
}

/**
 * Calculate ROAS (Return on Ad Spend).
 * Formula: (revenue attributed to ads / ad spend) * 100
 * 
 * @param adRevenueKopecks - Revenue attributed to advertising
 * @param adSpendKopecks - Advertising spend
 * @returns ROAS percentage
 * 
 * @example
 * calcRoas(50000, 10000) // 500 (5x return on ad spend)
 */
export function calcRoas(adRevenueKopecks: number, adSpendKopecks: number): number {
  if (!adSpendKopecks || adSpendKopecks === 0) return 0;
  return ((adRevenueKopecks || 0) / adSpendKopecks) * 100;
}

/**
 * ROCE input with capital components.
 */
export interface RoceInput {
  /** Operating profit = payout - marketplace costs - COGS (before tax) */
  operatingProfitKopecks: number;
  /** Stock value = quantity × cost price */
  stockValueKopecks: number;
  /** Unrealized payouts from WB (not yet transferred) */
  receivablesKopecks?: number;
}

/**
 * Calculate ROCE (Return on Capital Employed).
 * Formula: (Operating Profit / Capital Employed) * 100%
 * 
 * For marketplace sellers:
 * - Operating Profit: payout - marketplace costs - COGS (before tax)
 * - Capital Employed: stock value + unrealized payouts (receivables)
 * 
 * ROCE interpretation:
 * - Shows how efficiently capital is being used
 * - Higher = better capital efficiency
 * - Compare with cost of capital (e.g., loan rate) to evaluate
 * 
 * @param input - Operating profit and capital components
 * @returns ROCE percentage
 * 
 * @example
 * calcRoce({
 *   operatingProfitKopecks: 50000,   // 500 RUB profit
 *   stockValueKopecks: 200000,        // 2000 RUB in stock
 *   receivablesKopecks: 50000         // 500 RUB pending from WB
 * }) // 20% (20% return on capital employed)
 */
export function calcRoce(input: RoceInput): number {
  const capitalEmployed = 
    (input.stockValueKopecks || 0) + 
    (input.receivablesKopecks || 0);
  
  if (!capitalEmployed || capitalEmployed === 0) return 0;
  
  return ((input.operatingProfitKopecks || 0) / capitalEmployed) * 100;
}

/**
 * Calculate operating profit from components.
 * Formula: payout - marketplace costs - COGS
 * 
 * @param payoutKopecks - Revenue from marketplace
 * @param marketplaceCostsKopecks - All marketplace fees
 * @param cogsKopecks - Cost of goods sold
 * @returns Operating profit in kopecks
 */
export function calcOperatingProfit(
  payoutKopecks: number,
  marketplaceCostsKopecks: number,
  cogsKopecks: number
): number {
  return (payoutKopecks || 0) - (marketplaceCostsKopecks || 0) - (cogsKopecks || 0);
}

/**
 * Evaluate ROCE quality for marketplace business.
 * 
 * @param rocePercent - ROCE percentage
 * @returns Quality assessment
 */
export function evaluateRoce(rocePercent: number): 'negative' | 'poor' | 'moderate' | 'good' | 'excellent' {
  if (rocePercent < 0) return 'negative';
  if (rocePercent < 10) return 'poor';
  if (rocePercent < 20) return 'moderate';
  if (rocePercent < 35) return 'good';
  return 'excellent';
}
