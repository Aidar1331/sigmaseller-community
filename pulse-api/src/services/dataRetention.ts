/**
 * Data retention service.
 *
 * Manages database growth by aggregating old daily data into weekly summaries
 * and cleaning up raw data beyond retention thresholds.
 *
 * Retention Policy:
 * - Core daily tables (funnel, orders, finance, ads, stocks): Keep forever
 * - Product×Warehouse breakdowns: Daily for 90 days, then delete (aggregated to core)
 * - Product×Region breakdowns: Daily for 90 days, then delete
 * - Search queries: Daily for 90 days, then delete
 * - Stocks by warehouse: Daily for 90 days, then delete
 * - Storage costs by warehouse: Daily for 90 days, then delete
 * - wbCards.raw jsonb: Clear after 30 days (keep card metadata, clear raw API response)
 *
 * Expected savings: ~50-60% of DB space for data older than 90 days.
 *
 * Usage:
 *   Schedule via pg-boss: daily at 04:00 MSK
 *   Or run manually: npx tsx src/services/dataRetention.ts
 */

import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';
import log from '../lib/logger.js';

const logger = log.child({ module: 'data-retention' });

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

interface CleanupResult {
  table: string;
  deletedRows: number;
  cutoffDate: string;
}

/**
 * Delete old rows from a table where date < cutoff.
 * Uses text date column (YYYY-MM-DD format).
 */
async function cleanupTextDateTable(
  tableName: string,
  dateColumn: string,
  cutoffDate: string,
): Promise<CleanupResult> {
  try {
    const result = await db.execute(
      sql.raw(`DELETE FROM "${tableName}" WHERE "${dateColumn}" < '${cutoffDate}'`)
    );
    const deletedRows = Number((result as any)?.rowCount ?? 0);
    logger.info({ table: tableName, cutoffDate, deletedRows }, 'Retention cleanup completed');
    return { table: tableName, deletedRows, cutoffDate };
  } catch (err: any) {
    logger.error({ err, table: tableName, cutoffDate }, 'Retention cleanup failed');
    return { table: tableName, deletedRows: 0, cutoffDate };
  }
}

/**
 * Delete old rows from a table where timestamp date < cutoff.
 * Uses timestamptz column.
 */
async function cleanupTimestampTable(
  tableName: string,
  dateColumn: string,
  cutoffDate: string,
): Promise<CleanupResult> {
  try {
    const result = await db.execute(
      sql.raw(`DELETE FROM "${tableName}" WHERE "${dateColumn}" < '${cutoffDate}T00:00:00Z'`)
    );
    const deletedRows = Number((result as any)?.rowCount ?? 0);
    logger.info({ table: tableName, cutoffDate, deletedRows }, 'Retention cleanup completed');
    return { table: tableName, deletedRows, cutoffDate };
  } catch (err: any) {
    logger.error({ err, table: tableName, cutoffDate }, 'Retention cleanup failed');
    return { table: tableName, deletedRows: 0, cutoffDate };
  }
}

/**
 * Clear raw JSONB from old wbCards rows (keep card metadata, remove heavy raw field).
 */
async function clearOldCardsRaw(cutoffDays: number = 30): Promise<CleanupResult> {
  const cutoff = daysAgo(cutoffDays);
  try {
    const result = await db.execute(
      sql.raw(`UPDATE wb_cards SET raw = '{}' WHERE raw != '{}' AND updated_at < '${cutoff}T00:00:00Z'`)
    );
    const updatedRows = Number((result as any)?.rowCount ?? 0);
    logger.info({ cutoffDate: cutoff, updatedRows }, 'Cleared old wbCards.raw');
    return { table: 'wb_cards (raw clear)', deletedRows: updatedRows, cutoffDate: cutoff };
  } catch (err: any) {
    logger.error({ err }, 'Failed to clear old wbCards.raw');
    return { table: 'wb_cards (raw clear)', deletedRows: 0, cutoffDate: cutoff };
  }
}

/**
 * Run full retention policy.
 *
 * @param retentionDays - Days to keep detailed breakdown data (default: 90)
 */
export async function runRetention(retentionDays: number = 90): Promise<CleanupResult[]> {
  logger.info({ retentionDays }, 'Starting data retention cleanup');

  const cutoff90 = daysAgo(retentionDays);
  const results: CleanupResult[] = [];

  // Tables with text 'date' column, 90-day retention
  const textDateTables = [
    { table: 'wb_orders_sales_daily_product_warehouses', column: 'date' },
    { table: 'wb_orders_sales_daily_product_regions', column: 'date' },
  ];

  for (const { table, column } of textDateTables) {
    results.push(await cleanupTextDateTable(table, column, cutoff90));
  }

  // Tables with timestamptz 'date' column, 90-day retention
  const timestampTables = [
    { table: 'wb_stocks_daily', column: 'date' },
    { table: 'wb_storage_daily', column: 'date' },
    { table: 'wb_search_queries', column: 'date' },
    { table: 'wb_region_sales', column: 'date' },
  ];

  for (const { table, column } of timestampTables) {
    results.push(await cleanupTimestampTable(table, column, cutoff90));
  }

  // Clear old raw JSONB (30 days)
  results.push(await clearOldCardsRaw(30));

  // Clean old reconciliation logs (180 days)
  results.push(await cleanupTimestampTable('wb_reconciliation_log', 'created_at', daysAgo(180)));

  const totalDeleted = results.reduce((sum, r) => sum + r.deletedRows, 0);
  logger.info({ totalDeleted, tables: results.length }, 'Data retention cleanup finished');

  return results;
}

// Allow running as standalone script
if (process.argv[1]?.includes('dataRetention')) {
  runRetention().then(results => {
    console.table(results);
    process.exit(0);
  }).catch(err => {
    logger.error({ err }, 'Retention failed');
    process.exit(1);
  });
}
