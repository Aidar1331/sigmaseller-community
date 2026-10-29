/**
 * WB analytics reports — current (2026) endpoints.
 *
 * Replaces `asyncReportRunner.ts` which hit `/api/v1/reports/{type}/create`
 * (deprecated by WB on 2026-04-30 — returns 404 "path not found"). Each
 * report below points at its current canonical endpoint per the WB swagger
 * dated 2026-05-13 (saved in workspace's `wb-api/reports.md`).
 *
 * Two shapes are present in this file:
 *
 *   - **sync** reports (`region-sale`, `deductions`): single GET → JSON.
 *     Limits are tight (1/h common) so caller should respect the per-endpoint
 *     Redis bucket via wbGetJson.
 *
 *   - **async** reports (`warehouse-remains`): 3-step create → poll status →
 *     download. Mirrors the old runner's flow but on new paths and with new
 *     response shapes.
 *
 * Other report types (excise, antifraud, banned-products, goods-labeling,
 * acceptance) follow the same patterns — add wrappers here as needed.
 */

import { wbGetJson } from './wbClient.js';
import log from '../../lib/logger.js';

const ANALYTICS_HOST = 'https://seller-analytics-api.wildberries.ru';
const logger = log.child({ module: 'reportsV2' });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Region sales (`/api/v1/analytics/region-sale`)
// ============================================================================

export interface RegionSaleRow {
  countryName: string;
  foName: string;
  regionName: string;
  cityName: string;
  nmID: number;
  sa: string; // vendor code
  saleItemInvoiceQty: number;
  saleInvoiceCostPrice: number;
  saleInvoiceCostPricePerc: number;
}

/**
 * Returns city/region sales for the given period. Single GET, synchronous.
 *
 * WB rate limit: 1 request per hour per seller (see wbEndpointLimits.ts).
 */
export async function getRegionSales(opts: {
  apiKey: string;
  workspaceId: number;
  shopId?: number;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;
}): Promise<RegionSaleRow[]> {
  const url =
    `${ANALYTICS_HOST}/api/v1/analytics/region-sale` +
    `?dateFrom=${encodeURIComponent(opts.dateFrom)}` +
    `&dateTo=${encodeURIComponent(opts.dateTo)}`;

  const resp = await wbGetJson<{ report?: RegionSaleRow[] }>(
    url,
    opts.apiKey,
    1,
    { workspaceId: opts.workspaceId, shopId: opts.shopId },
  );

  return resp?.report ?? [];
}

// ============================================================================
// Deductions — substitutions & wrong-attachments
// (`/api/analytics/v1/deductions`)
// ============================================================================

export interface DeductionRow {
  dtBonus: string; // ISO datetime
  nmId: number;
  bonusSumm: number; // rub
  bonusType: string;
  oldVendorCode?: string;
  newVendorCode?: string;
  photoUrls?: string[];
}

/**
 * Returns substitution / wrong-attachment deductions for the period.
 * Paginated by limit+offset (max 1000). WB limit: 1 req/min.
 */
export async function getDeductions(opts: {
  apiKey: string;
  workspaceId: number;
  shopId?: number;
  dateFrom: string; // YYYY-MM-DD or ISO datetime
  dateTo: string;
  limit?: number;
  offset?: number;
}): Promise<DeductionRow[]> {
  const limit = Math.min(opts.limit ?? 1000, 1000);
  const offset = opts.offset ?? 0;
  const url =
    `${ANALYTICS_HOST}/api/analytics/v1/deductions` +
    `?dateFrom=${encodeURIComponent(opts.dateFrom)}` +
    `&dateTo=${encodeURIComponent(opts.dateTo)}` +
    `&limit=${limit}&offset=${offset}`;

  const resp = await wbGetJson<{ data?: { reports?: DeductionRow[]; total?: number } }>(
    url,
    opts.apiKey,
    1,
    { workspaceId: opts.workspaceId, shopId: opts.shopId },
  );

  return resp?.data?.reports ?? [];
}

// ============================================================================
// Warehouse remains (async, 3-step on new path)
// `/api/v1/warehouse_remains` → status → download
// ============================================================================

export interface WarehouseRemainItem {
  brand: string;
  subjectName: string;
  vendorCode: string;
  nmId: number;
  barcode: string;
  techSize: string;
  volume: number;
  inWayToClient: number;
  inWayFromClient: number;
  quantityWarehousesFull: number;
  warehouses?: Array<{ warehouseName: string; quantity: number }>;
}

interface WarehouseRemainsCreateResp {
  data?: { taskId?: string };
}

interface WarehouseRemainsStatusResp {
  data?: { status?: 'new' | 'processing' | 'done' | 'purged' | 'canceled' };
}

// ============================================================================
// Banned products — blocked & shadowed
// `/api/v1/analytics/banned-products/{blocked,shadowed}`
// ============================================================================

export interface BannedProductRow {
  brand?: string;
  nmId: number;
  title?: string;
  vendorCode?: string;
  reason?: string;
  /** Type added by getBannedProducts caller — 'blocked' or 'shadowed'. */
  kind?: 'blocked' | 'shadowed';
}

/**
 * Fetches both blocked and shadowed banned products. WB returns separate
 * lists at two endpoints; we union them and tag with `kind` so the caller
 * can route into the right downstream UI/alert. Both endpoints are sync GET.
 */
export async function getBannedProducts(opts: {
  apiKey: string;
  workspaceId: number;
  shopId?: number;
}): Promise<BannedProductRow[]> {
  const reqOpts = { workspaceId: opts.workspaceId, shopId: opts.shopId };
  const base = `${ANALYTICS_HOST}/api/v1/analytics/banned-products`;
  const qs = 'sort=nmId&order=asc';

  const out: BannedProductRow[] = [];
  for (const kind of ['blocked', 'shadowed'] as const) {
    try {
      const resp = await wbGetJson<{ report?: BannedProductRow[] }>(
        `${base}/${kind}?${qs}`,
        opts.apiKey,
        1,
        reqOpts,
      );
      for (const row of resp?.report ?? []) {
        out.push({ ...row, kind });
      }
    } catch (e: any) {
      logger.warn({ kind, err: e?.message }, 'getBannedProducts: failed one shard');
    }
  }
  return out;
}

/**
 * Run the warehouse-remains report end-to-end: create → poll → download.
 * Returns parsed JSON rows. Polls every 5s up to `timeoutMs` (default 10 min).
 *
 * WB rate limits the create-call to 4/hour per seller (see wbEndpointLimits).
 */
export async function runWarehouseRemains(opts: {
  apiKey: string;
  workspaceId: number;
  shopId?: number;
  groupByBrand?: boolean;
  groupBySubject?: boolean;
  groupBySa?: boolean;
  groupByNm?: boolean;
  groupByBarcode?: boolean;
  groupBySize?: boolean;
  filterPics?: number; // -1 / 0 / 1
  filterVolume?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<WarehouseRemainItem[]> {
  const reqOpts = { workspaceId: opts.workspaceId, shopId: opts.shopId };
  const qs = new URLSearchParams({
    locale: 'ru',
    groupByBrand: String(opts.groupByBrand ?? false),
    groupBySubject: String(opts.groupBySubject ?? false),
    groupBySa: String(opts.groupBySa ?? false),
    groupByNm: String(opts.groupByNm ?? true),
    groupByBarcode: String(opts.groupByBarcode ?? false),
    groupBySize: String(opts.groupBySize ?? false),
  });
  if (opts.filterPics !== undefined) qs.set('filterPics', String(opts.filterPics));
  if (opts.filterVolume !== undefined) qs.set('filterVolume', String(opts.filterVolume));

  // Step 1: create task
  const createUrl = `${ANALYTICS_HOST}/api/v1/warehouse_remains?${qs.toString()}`;
  const created = await wbGetJson<WarehouseRemainsCreateResp>(createUrl, opts.apiKey, 1, reqOpts);
  const taskId = created?.data?.taskId;
  if (!taskId) throw new Error('warehouse_remains: no taskId in create response');
  logger.info({ taskId }, 'warehouse_remains: task created');

  // Step 2: poll status
  const pollMs = opts.pollIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const statusUrl = `${ANALYTICS_HOST}/api/v1/warehouse_remains/tasks/${taskId}/status`;
    const status = await wbGetJson<WarehouseRemainsStatusResp>(statusUrl, opts.apiKey, 1, reqOpts);
    const s = status?.data?.status;
    logger.info({ taskId, status: s }, 'warehouse_remains: poll');
    if (s === 'done') break;
    if (s === 'purged' || s === 'canceled') {
      throw new Error(`warehouse_remains: task ${taskId} ended with status=${s}`);
    }
  }

  // Step 3: download
  const downloadUrl = `${ANALYTICS_HOST}/api/v1/warehouse_remains/tasks/${taskId}/download`;
  const rows = await wbGetJson<WarehouseRemainItem[]>(downloadUrl, opts.apiKey, 1, reqOpts);
  return Array.isArray(rows) ? rows : [];
}
