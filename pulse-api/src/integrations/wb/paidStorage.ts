/**
 * WB Paid Storage Report (фактическая стоимость платного хранения по товарам)
 * Host: https://seller-analytics-api.wildberries.ru
 *
 * Async flow:
 *   1. POST /api/v1/paid_storage?dateFrom&dateTo  → { data: { taskId } }
 *   2. GET  /api/v1/paid_storage/tasks/{id}/status → { data: { status } }
 *   3. GET  /api/v1/paid_storage/tasks/{id}/download → PaidStorageRow[]
 *
 * Constraints:
 *   - Max period per task: 8 days.
 *   - Rate limit: 3 req/min per key (see wbRateLimiter).
 *
 * Replaces legacy `statistics-api` /reports/storage (deprecated 2026-03).
 */

import { wbGetJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'paidStorage' });

const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';
const MAX_PERIOD_DAYS = 8;

export type PaidStorageStatus = 'new' | 'processing' | 'done' | 'purged' | 'canceled';

export interface PaidStorageRow {
  date: string;
  logWarehouseCoef?: number;
  officeId?: number;
  warehouse: string;
  warehouseCoef?: number;
  giId?: number;
  chrtId?: number;
  size?: string;
  barcode?: string;
  subject?: string;
  brand?: string;
  vendorCode?: string;
  nmId: number;
  volume: number;          // литры
  calcType?: string;
  warehousePrice: number;  // рубли
  barcodesCount?: number;
  palletPlaceCode?: number;
  palletCount?: number;
  originalDate?: string;
  loyaltyDiscount?: number;
  tariffFixDate?: string;
  tariffLowerDate?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Create a paid_storage task for a given date range (≤ 8 days).
 */
export async function createPaidStorageTask(
  apiKey: string,
  dateFrom: string,
  dateTo: string,
): Promise<string> {
  const url = `${ANALYTICS_API}/api/v1/paid_storage?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await wbGetJson<{ data: { taskId: string } }>(url, apiKey);
  if (!res?.data?.taskId) {
    throw new Error('paid_storage: no taskId in create response');
  }
  logger.info({ dateFrom, dateTo, taskId: res.data.taskId }, 'paid_storage task created');
  return res.data.taskId;
}

export async function getPaidStorageStatus(apiKey: string, taskId: string): Promise<PaidStorageStatus> {
  const url = `${ANALYTICS_API}/api/v1/paid_storage/tasks/${taskId}/status`;
  const res = await wbGetJson<{ data: { status: PaidStorageStatus } }>(url, apiKey);
  return res?.data?.status ?? 'new';
}

export async function downloadPaidStorage(apiKey: string, taskId: string): Promise<PaidStorageRow[]> {
  const url = `${ANALYTICS_API}/api/v1/paid_storage/tasks/${taskId}/download`;
  const res = await wbGetJson<PaidStorageRow[] | { data: PaidStorageRow[] }>(url, apiKey);
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object' && 'data' in res && Array.isArray(res.data)) return res.data;
  logger.warn({ taskId }, 'paid_storage: unexpected download shape');
  return [];
}

/**
 * Create → poll → download for a single period (≤ 8 days).
 * Returns [] if the task never completes within timeoutMs.
 */
export async function runPaidStorageReport(
  apiKey: string,
  dateFrom: string,
  dateTo: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<PaidStorageRow[]> {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  const taskId = await createPaidStorageTask(apiKey, dateFrom, dateTo);

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(pollIntervalMs);
    let status: PaidStorageStatus;
    try {
      status = await getPaidStorageStatus(apiKey, taskId);
    } catch (err) {
      logger.warn({ taskId, err: (err as Error).message }, 'paid_storage: status poll error, retrying');
      continue;
    }

    if (status === 'done') {
      return downloadPaidStorage(apiKey, taskId);
    }
    if (status === 'purged' || status === 'canceled') {
      logger.warn({ taskId, status }, 'paid_storage: terminal non-success status');
      return [];
    }
  }

  logger.error({ taskId, dateFrom, dateTo }, 'paid_storage: timed out');
  return [];
}

/**
 * Split a [dateFrom, dateTo] range into ≤8-day chunks so each fits a single task.
 */
export function chunkDateRange(dateFrom: string, dateTo: string, maxDays = MAX_PERIOD_DAYS): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  const start = new Date(dateFrom);
  const end = new Date(dateTo);
  let cur = new Date(start);
  while (cur <= end) {
    const stop = new Date(cur);
    stop.setUTCDate(stop.getUTCDate() + maxDays - 1);
    const boundedStop = stop > end ? end : stop;
    chunks.push({ from: isoDay(cur), to: isoDay(boundedStop) });
    cur = new Date(boundedStop);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return chunks;
}
