/**
 * Margin calculation utilities.
 * All functions are pure and work with kopecks (integers) for precision.
 * 
 * Key terms:
 * - payout: Income from sales (what WB pays to seller)
 * - marketplaceCosts: All WB deductions (logistics, storage, commission, etc.)
 * - margin: payout + additionalPayments - marketplaceCosts
 * - netProfit: margin - advertising spend
 */

import { kopecksToRub } from './format.js';

/**
 * Input for marketplace costs calculation.
 * All values in kopecks.
 */
export interface MarketplaceCostsInput {
  logisticsKopecks: number;
  returnLogisticsKopecks: number;
  paidAcceptanceKopecks: number;
  storageKopecks: number;
  penaltyKopecks: number;
  otherHoldKopecks: number;
  acquiringKopecks: number;
}

/**
 * Calculate total marketplace costs.
 * Sum of all WB deductions from seller income.
 * 
 * @param input - Cost components in kopecks
 * @returns Total costs in kopecks
 * 
 * @example
 * calcMarketplaceCosts({
 *   logisticsKopecks: 10000,
 *   returnLogisticsKopecks: 2000,
 *   paidAcceptanceKopecks: 500,
 *   storageKopecks: 1500,
 *   penaltyKopecks: 0,
 *   otherHoldKopecks: 0,
 *   acquiringKopecks: 300
 * }) // 14300
 */
export function calcMarketplaceCosts(input: MarketplaceCostsInput): number {
  return (
    (input.logisticsKopecks || 0) +
    (input.returnLogisticsKopecks || 0) +
    (input.paidAcceptanceKopecks || 0) +
    (input.storageKopecks || 0) +
    (input.penaltyKopecks || 0) +
    (input.otherHoldKopecks || 0) +
    (input.acquiringKopecks || 0)
  );
}

/**
 * Input for margin calculation.
 * All values in kopecks.
 */
export interface MarginInput {
  payoutKopecks: number;
  additionalPaymentKopecks: number;
  marketplaceCostsKopecks: number;
}

/**
 * Calculate margin (operating profit before advertising).
 * Formula: payout + additionalPayments - marketplaceCosts
 * 
 * @param input - Margin components in kopecks
 * @returns Margin in kopecks (can be negative)
 * 
 * @example
 * calcMargin({
 *   payoutKopecks: 100000,
 *   additionalPaymentKopecks: 5000,
 *   marketplaceCostsKopecks: 30000
 * }) // 75000
 */
export function calcMargin(input: MarginInput): number {
  return (
    (input.payoutKopecks || 0) +
    (input.additionalPaymentKopecks || 0) -
    (input.marketplaceCostsKopecks || 0)
  );
}

/**
 * Calculate net profit after advertising.
 * Formula: margin - advSpend
 * 
 * @param marginKopecks - Margin in kopecks
 * @param advSpendKopecks - Advertising spend in kopecks
 * @returns Net profit in kopecks (can be negative)
 * 
 * @example
 * calcNetProfit(75000, 10000) // 65000
 * calcNetProfit(75000, 100000) // -25000 (loss)
 */
export function calcNetProfit(marginKopecks: number, advSpendKopecks: number): number {
  return (marginKopecks || 0) - (advSpendKopecks || 0);
}

/**
 * Calculate margin percentage.
 * Formula: (margin / revenue) * 100
 *
 * Returns 0 when revenue is missing/zero/non-finite. For UI rendering use
 * `calcMarginPercentOrNull` instead — it returns null so the page can show
 * an em-dash ("—") instead of a misleading "0%".
 *
 * @example
 * calcMarginPercent(75000, 100000) // 75.0
 * calcMarginPercent(75000, 0) // 0 (avoid division by zero)
 */
export function calcMarginPercent(marginKopecks: number, revenueKopecks: number): number {
  if (!Number.isFinite(revenueKopecks) || revenueKopecks === 0) return 0;
  if (!Number.isFinite(marginKopecks)) return 0;
  const result = (marginKopecks / revenueKopecks) * 100;
  return Number.isFinite(result) ? result : 0;
}

/**
 * UI-friendly variant: returns `null` when revenue is missing instead of
 * silently displaying "0%". Renderers should map null → "—".
 */
export function calcMarginPercentOrNull(marginKopecks: number, revenueKopecks: number): number | null {
  if (!Number.isFinite(revenueKopecks) || revenueKopecks === 0) return null;
  if (!Number.isFinite(marginKopecks)) return null;
  const result = (marginKopecks / revenueKopecks) * 100;
  return Number.isFinite(result) ? result : null;
}

/**
 * Calculate margin per unit sold.
 * Formula: margin / salesCount
 * 
 * @param marginKopecks - Total margin in kopecks
 * @param salesCount - Number of items sold (buyouts)
 * @returns Margin per unit in rubles (for display)
 * 
 * @example
 * calcMarginPerUnit(750000, 10) // 750.00 (rubles per item)
 * calcMarginPerUnit(750000, 0) // 0
 */
export function calcMarginPerUnit(marginKopecks: number, salesCount: number): number {
  if (!salesCount || salesCount === 0) return 0;
  return kopecksToRub((marginKopecks || 0) / salesCount);
}

/**
 * Calculate markup multiplier (X times).
 * Formula: sellingPrice / costPrice
 * 
 * @param sellingPriceRub - Selling price in rubles
 * @param costPriceRub - Cost price (COGS) in rubles
 * @returns Markup multiplier (e.g., 2.5x means 250% of cost)
 * 
 * @example
 * calcMarkupX(1000, 400) // 2.5 (selling at 2.5x cost)
 * calcMarkupX(1000, 0) // 0
 */
export function calcMarkupX(sellingPriceRub: number, costPriceRub: number): number {
  if (!costPriceRub || costPriceRub === 0) return 0;
  return (sellingPriceRub || 0) / costPriceRub;
}

/**
 * Full margin breakdown calculation.
 * Combines all margin-related calculations.
 */
export interface MarginBreakdown {
  marketplaceCostsKopecks: number;
  marginKopecks: number;
  netProfitKopecks: number;
  marginPercent: number;
  marginPerUnitRub: number;
  markupX: number;
}

export interface FullMarginInput {
  payoutKopecks: number;
  additionalPaymentKopecks: number;
  costs: MarketplaceCostsInput;
  advSpendKopecks: number;
  ordersKopecks: number;
  buyoutCount: number;
  cogsPerUnitRub: number;
  pricePerUnitRub: number;
}

/**
 * Calculate full margin breakdown.
 * 
 * @param input - All inputs for margin calculation
 * @returns Complete margin breakdown
 */
export function calcFullMargin(input: FullMarginInput): MarginBreakdown {
  const marketplaceCostsKopecks = calcMarketplaceCosts(input.costs);
  
  // Calculate COGS (cost of goods sold) in kopecks
  // cogsPerUnitRub * buyoutCount * 100 (convert to kopecks)
  const totalCogsKopecks = Math.round((input.cogsPerUnitRub || 0) * (input.buyoutCount || 0) * 100);
  
  const grossMarginKopecks = calcMargin({
    payoutKopecks: input.payoutKopecks,
    additionalPaymentKopecks: input.additionalPaymentKopecks,
    marketplaceCostsKopecks,
  });
  
  // Subtract COGS from gross margin to get true margin
  const marginKopecks = grossMarginKopecks - totalCogsKopecks;
  
  const netProfitKopecks = calcNetProfit(marginKopecks, input.advSpendKopecks);
  const marginPercent = calcMarginPercent(marginKopecks, input.ordersKopecks);
  const marginPerUnitRub = calcMarginPerUnit(marginKopecks, input.buyoutCount);
  const markupX = calcMarkupX(input.pricePerUnitRub, input.cogsPerUnitRub);

  return {
    marketplaceCostsKopecks,
    marginKopecks,
    netProfitKopecks,
    marginPercent,
    marginPerUnitRub,
    markupX,
  };
}
