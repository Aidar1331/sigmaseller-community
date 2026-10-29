/**
 * WB Penalties API (штрафы и удержания)
 * Host: https://seller-analytics-api.wildberries.ru
 *
 * ⚠️ Rate limit: 1 запрос в МИНУТУ!
 */

import { wbGetJson } from './wbClient.js';

const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface MeasurementPenalty {
  nmId: number;
  supplierArticle: string;
  barcode: string;
  subject: string;
  brand: string;
  penaltyDate: string;
  penaltySum: number;
  warehouseId: number;
  warehouseName: string;
}

export interface WarehouseMeasurement {
  nmId: number;
  supplierArticle: string;
  barcode: string;
  length: number;
  width: number;
  height: number;
  volume: number;
  measurementDate: string;
  warehouseId: number;
  warehouseName: string;
}

export interface Deduction {
  nmId: number;
  supplierArticle: string;
  barcode: string;
  dtBonus: string;
  bonusSumm: number;
  bonusType: string;
  bonusTypeName: string;
}

export interface PenaltiesParams {
  dateFrom?: string;  // ISO 8601
  dateTo: string;
  limit?: number;     // max 1000
  offset?: number;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get measurement penalties (штрафы за занижение габаритов)
 * GET /api/analytics/v1/measurement-penalties
 *
 * ⚠️ Rate limit: 1 req/min
 */
export async function getMeasurementPenalties(
  apiKey: string,
  params: PenaltiesParams
): Promise<{ data: MeasurementPenalty[] }> {
  const qs = new URLSearchParams();
  if (params.dateFrom) qs.set('dateFrom', params.dateFrom);
  qs.set('dateTo', params.dateTo);
  qs.set('limit', String(Math.min(params.limit ?? 100, 1000)));
  if (params.offset) qs.set('offset', String(params.offset));

  return wbGetJson<{ data: MeasurementPenalty[] }>(
    `${ANALYTICS_API}/api/analytics/v1/measurement-penalties?${qs}`,
    apiKey,
    1,
    { maxRetries: 1 }  // Don't retry - strict rate limit
  );
}

/**
 * Get warehouse measurements
 * GET /api/analytics/v1/warehouse-measurements
 * ⚠️ Rate limit: 1 req/min
 */
export async function getWarehouseMeasurements(
  apiKey: string,
  params: PenaltiesParams
): Promise<{ data: WarehouseMeasurement[] }> {
  const qs = new URLSearchParams();
  if (params.dateFrom) qs.set('dateFrom', params.dateFrom);
  qs.set('dateTo', params.dateTo);
  qs.set('limit', String(Math.min(params.limit ?? 100, 1000)));
  if (params.offset) qs.set('offset', String(params.offset));

  return wbGetJson<{ data: WarehouseMeasurement[] }>(
    `${ANALYTICS_API}/api/analytics/v1/warehouse-measurements?${qs}`,
    apiKey,
    1,
    { maxRetries: 1 }
  );
}

/**
 * Get deductions (удержания/начисления)
 * GET /api/analytics/v1/deductions
 * ⚠️ Rate limit: 1 req/min
 */
export async function getDeductions(
  apiKey: string,
  params: PenaltiesParams & {
    sort?: 'nmId' | 'dtBonus' | 'bonusSumm';
    order?: 'asc' | 'desc';
  }
): Promise<{ data: Deduction[] }> {
  const qs = new URLSearchParams();
  if (params.dateFrom) qs.set('dateFrom', params.dateFrom);
  qs.set('dateTo', params.dateTo);
  if (params.sort) qs.set('sort', params.sort);
  if (params.order) qs.set('order', params.order);
  qs.set('limit', String(Math.min(params.limit ?? 100, 1000)));
  if (params.offset) qs.set('offset', String(params.offset));

  return wbGetJson<{ data: Deduction[] }>(
    `${ANALYTICS_API}/api/analytics/v1/deductions?${qs}`,
    apiKey,
    1,
    { maxRetries: 1 }
  );
}

// ============================================================================
// Aggregation helpers
// ============================================================================

/**
 * Calculate total penalties sum
 */
export function sumPenalties(penalties: MeasurementPenalty[]): number {
  return penalties.reduce((sum, p) => sum + (p.penaltySum || 0), 0);
}

/**
 * Calculate total deductions sum
 */
export function sumDeductions(deductions: Deduction[]): number {
  return deductions.reduce((sum, d) => sum + (d.bonusSumm || 0), 0);
}

/**
 * Group penalties by nmId
 */
export function groupPenaltiesByNmId(penalties: MeasurementPenalty[]): Map<number, MeasurementPenalty[]> {
  const map = new Map<number, MeasurementPenalty[]>();
  for (const p of penalties) {
    const arr = map.get(p.nmId) || [];
    arr.push(p);
    map.set(p.nmId, arr);
  }
  return map;
}
