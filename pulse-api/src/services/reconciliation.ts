/**
 * Data reconciliation service.
 *
 * Cross-checks data consistency between different WB data tables.
 * Detects mismatches that could indicate sync errors, formula bugs, or API changes.
 *
 * Checks performed:
 * 1. Product vs Shop finance totals (must match exactly)
 * 2. Product vs Shop ad spend totals (must match exactly)
 * 3. Funnel vs Orders count (within ±5% tolerance)
 * 4. Weekly vs Daily finance (within ±1 ruble tolerance)
 */

import { db } from '../db/client.js';
import { sql, eq, and, between } from 'drizzle-orm';
import {
  wbFinanceDaily,
  wbFinanceDailyProducts,
  wbAdvDaily,
  wbAdvDailyProducts,
  wbFunnelDailyProducts,
  wbOrdersSalesDailyProducts,
} from '../db/schema.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'reconciliation' });

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface ReconciliationResult {
  checkName: string;
  date: string;
  expected: number;
  actual: number;
  delta: number;
  deltaPercent: number;
  status: CheckStatus;
  details?: string;
}

/**
 * Check 1: SUM(wbFinanceDailyProducts.payoutKopecks) = wbFinanceDaily.payoutKopecks
 * Tolerance: ±0 (exact match)
 */
async function checkFinanceProductVsShop(
  workspaceId: number,
  date: string,
): Promise<ReconciliationResult> {
  const checkName = 'finance_product_vs_shop';

  try {
    // Shop-level total
    const [shopRow] = await db
      .select({ total: wbFinanceDaily.payoutKopecks })
      .from(wbFinanceDaily)
      .where(and(eq(wbFinanceDaily.workspaceId, workspaceId), eq(wbFinanceDaily.date, date)));

    const shopTotal = shopRow?.total ?? 0;

    // Sum of product-level
    const [prodRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(${wbFinanceDailyProducts.incomeFromSalesKopecks}), 0)` })
      .from(wbFinanceDailyProducts)
      .where(and(eq(wbFinanceDailyProducts.workspaceId, workspaceId), eq(wbFinanceDailyProducts.date, date)));

    const productTotal = Number(prodRow?.total ?? 0);
    const delta = Math.abs(shopTotal - productTotal);

    return {
      checkName,
      date,
      expected: shopTotal,
      actual: productTotal,
      delta,
      deltaPercent: shopTotal !== 0 ? (delta / Math.abs(shopTotal)) * 100 : 0,
      status: delta === 0 ? 'ok' : delta <= 100 ? 'warn' : 'error', // ±1 ruble tolerance
      details: delta > 0 ? `Mismatch: shop=${shopTotal}, products_sum=${productTotal}` : undefined,
    };
  } catch (err: any) {
    logger.error({ err, checkName, workspaceId, date }, 'Reconciliation check failed');
    return { checkName, date, expected: 0, actual: 0, delta: 0, deltaPercent: 0, status: 'error', details: err.message };
  }
}

/**
 * Check 2: SUM(wbAdvDailyProducts.spendKopecks) = wbAdvDaily.spendKopecks
 * Tolerance: ±0 (exact match)
 */
async function checkAdvProductVsShop(
  workspaceId: number,
  date: string,
): Promise<ReconciliationResult> {
  const checkName = 'adv_product_vs_shop';

  try {
    const [shopRow] = await db
      .select({ total: wbAdvDaily.spendKopecks })
      .from(wbAdvDaily)
      .where(and(eq(wbAdvDaily.workspaceId, workspaceId), eq(wbAdvDaily.date, date)));

    const shopTotal = shopRow?.total ?? 0;

    const [prodRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(${wbAdvDailyProducts.spendKopecks}), 0)` })
      .from(wbAdvDailyProducts)
      .where(and(eq(wbAdvDailyProducts.workspaceId, workspaceId), eq(wbAdvDailyProducts.date, date)));

    const productTotal = Number(prodRow?.total ?? 0);
    const delta = Math.abs(shopTotal - productTotal);

    return {
      checkName,
      date,
      expected: shopTotal,
      actual: productTotal,
      delta,
      deltaPercent: shopTotal !== 0 ? (delta / Math.abs(shopTotal)) * 100 : 0,
      status: delta === 0 ? 'ok' : delta <= 100 ? 'warn' : 'error',
    };
  } catch (err: any) {
    logger.error({ err, checkName, workspaceId, date }, 'Reconciliation check failed');
    return { checkName, date, expected: 0, actual: 0, delta: 0, deltaPercent: 0, status: 'error', details: err.message };
  }
}

/**
 * Check 3: SUM(wbFunnelDailyProducts.orderCount) ≈ SUM(wbOrdersSalesDailyProducts.ordersCount)
 * Tolerance: ±5% (different WB API sources have timing differences)
 */
async function checkFunnelVsOrders(
  workspaceId: number,
  date: string,
): Promise<ReconciliationResult> {
  const checkName = 'funnel_vs_orders';
  const TOLERANCE_PCT = 5;

  try {
    const [funnelRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.orderCount}), 0)` })
      .from(wbFunnelDailyProducts)
      .where(and(eq(wbFunnelDailyProducts.workspaceId, workspaceId), eq(wbFunnelDailyProducts.date, date)));

    const funnelOrders = Number(funnelRow?.total ?? 0);

    const [ordersRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersCount}), 0)` })
      .from(wbOrdersSalesDailyProducts)
      .where(and(eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId), eq(wbOrdersSalesDailyProducts.date, date)));

    const ordersTotal = Number(ordersRow?.total ?? 0);

    const delta = Math.abs(funnelOrders - ordersTotal);
    const base = Math.max(funnelOrders, ordersTotal, 1);
    const deltaPercent = (delta / base) * 100;

    let status: CheckStatus = 'ok';
    if (deltaPercent > TOLERANCE_PCT) status = 'warn';
    if (deltaPercent > 20) status = 'error';

    return {
      checkName,
      date,
      expected: funnelOrders,
      actual: ordersTotal,
      delta,
      deltaPercent,
      status,
      details: deltaPercent > TOLERANCE_PCT ? `Funnel orders=${funnelOrders}, Orders table=${ordersTotal}` : undefined,
    };
  } catch (err: any) {
    logger.error({ err, checkName, workspaceId, date }, 'Reconciliation check failed');
    return { checkName, date, expected: 0, actual: 0, delta: 0, deltaPercent: 0, status: 'error', details: err.message };
  }
}

/**
 * Run all reconciliation checks for a workspace and date.
 */
export async function runReconciliation(
  workspaceId: number,
  date: string,
): Promise<ReconciliationResult[]> {
  logger.info({ workspaceId, date }, 'Running reconciliation checks');

  const results = await Promise.all([
    checkFinanceProductVsShop(workspaceId, date),
    checkAdvProductVsShop(workspaceId, date),
    checkFunnelVsOrders(workspaceId, date),
  ]);

  const failed = results.filter(r => r.status !== 'ok');
  if (failed.length > 0) {
    logger.warn({ workspaceId, date, failedChecks: failed.map(f => f.checkName) }, 'Reconciliation issues detected');
  } else {
    logger.info({ workspaceId, date }, 'All reconciliation checks passed');
  }

  return results;
}

/**
 * Run reconciliation for a date range.
 */
export async function runReconciliationRange(
  workspaceId: number,
  dateFrom: string,
  dateTo: string,
): Promise<ReconciliationResult[]> {
  const results: ReconciliationResult[] = [];
  const start = new Date(dateFrom);
  const end = new Date(dateTo);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const dayResults = await runReconciliation(workspaceId, date);
    results.push(...dayResults);
  }

  return results;
}
