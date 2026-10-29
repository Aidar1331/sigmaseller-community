/**
 * Stock and inventory calculations.
 * 
 * Key metrics:
 * - Turnover days: How many days current stock will last
 * - Stock value: Total value of inventory at cost price
 */

import { kopecksToRub } from './format.js';

/**
 * Calculate stock turnover in days.
 * Formula: currentStock / dailySalesRate
 * 
 * @param stockQuantity - Current stock quantity
 * @param dailySales - Average daily sales rate
 * @returns Days until stock runs out
 * 
 * @example
 * calcTurnoverDays(100, 10) // 10 days of stock
 * calcTurnoverDays(100, 0) // 0 (no sales, infinite stock)
 * calcTurnoverDays(0, 10) // 0 (out of stock)
 */
export function calcTurnoverDays(stockQuantity: number, dailySales: number): number {
  if (!dailySales || dailySales === 0) return 0;
  if (!stockQuantity || stockQuantity <= 0) return 0;
  return stockQuantity / dailySales;
}

/**
 * Calculate average daily sales from period data.
 * 
 * @param totalSales - Total sales in period
 * @param periodDays - Number of days in period
 * @returns Average daily sales
 * 
 * @example
 * calcDailySales(300, 30) // 10 per day
 */
export function calcDailySales(totalSales: number, periodDays: number): number {
  if (!periodDays || periodDays === 0) return 0;
  return (totalSales || 0) / periodDays;
}

/**
 * Calculate stock value in kopecks.
 * Formula: quantity × costPerUnit
 * 
 * @param quantity - Stock quantity
 * @param costPerUnitKopecks - Cost per unit in kopecks
 * @returns Total stock value in kopecks
 * 
 * @example
 * calcStockValue(100, 50000) // 5000000 (100 items × 500₽)
 */
export function calcStockValue(quantity: number, costPerUnitKopecks: number): number {
  return (quantity || 0) * (costPerUnitKopecks || 0);
}

/**
 * Stock breakdown for a product.
 */
export interface StockBreakdown {
  /** Items in warehouse */
  inWarehouse: number;
  /** Items being shipped to customers */
  inWayToClient: number;
  /** Items being returned from customers */
  inWayFromClient: number;
  /** Total available stock */
  totalAvailable: number;
}

/**
 * Calculate total available stock.
 * 
 * @param inWarehouse - Items in warehouse
 * @param inWayToClient - Items being shipped to customers
 * @param inWayFromClient - Items being returned
 * @returns Stock breakdown
 * 
 * @example
 * calcStockBreakdown(100, 20, 5)
 * // { inWarehouse: 100, inWayToClient: 20, inWayFromClient: 5, totalAvailable: 125 }
 */
export function calcStockBreakdown(
  inWarehouse: number,
  inWayToClient: number,
  inWayFromClient: number
): StockBreakdown {
  return {
    inWarehouse: inWarehouse || 0,
    inWayToClient: inWayToClient || 0,
    inWayFromClient: inWayFromClient || 0,
    totalAvailable: (inWarehouse || 0) + (inWayToClient || 0) + (inWayFromClient || 0),
  };
}

/**
 * Calculate supply needs.
 * Formula: (targetDays × dailySales) - currentStock
 * 
 * @param currentStock - Current stock quantity
 * @param dailySales - Average daily sales
 * @param targetDays - Target days of stock to maintain
 * @returns Units needed to reach target
 * 
 * @example
 * calcSupplyNeed(50, 10, 14) // 90 (need 140 for 14 days, have 50)
 * calcSupplyNeed(200, 10, 14) // 0 (have enough for 14+ days)
 */
export function calcSupplyNeed(
  currentStock: number,
  dailySales: number,
  targetDays: number
): number {
  const targetStock = (dailySales || 0) * (targetDays || 0);
  const need = targetStock - (currentStock || 0);
  return Math.max(0, Math.ceil(need));
}

/**
 * Evaluate stock level.
 * 
 * @param turnoverDays - Current turnover in days
 * @returns Stock status
 */
export function evaluateStock(turnoverDays: number): 'out' | 'critical' | 'low' | 'normal' | 'overstock' {
  if (turnoverDays <= 0) return 'out';
  if (turnoverDays <= 7) return 'critical';
  if (turnoverDays <= 14) return 'low';
  if (turnoverDays <= 60) return 'normal';
  return 'overstock';
}

/**
 * Calculate stock-out risk.
 * 
 * @param currentStock - Current stock
 * @param dailySales - Daily sales rate
 * @param leadTimeDays - Days to receive new stock
 * @returns Risk assessment
 */
export function calcStockOutRisk(
  currentStock: number,
  dailySales: number,
  leadTimeDays: number
): 'none' | 'low' | 'medium' | 'high' | 'imminent' {
  const turnover = calcTurnoverDays(currentStock, dailySales);
  
  if (turnover <= 0) return 'imminent';
  if (turnover <= leadTimeDays * 0.5) return 'high';
  if (turnover <= leadTimeDays) return 'medium';
  if (turnover <= leadTimeDays * 1.5) return 'low';
  return 'none';
}
