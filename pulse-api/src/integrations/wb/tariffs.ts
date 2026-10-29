import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { getWbApiKey, wbGetJson } from './wbClient.js';

export type CommissionRow = {
  parentID?: number;
  parentName?: string;
  subjectID?: number;
  subjectName?: string;

  // WB commission fields (vary by sales model)
  kgvpBooking?: number;
  kgvpMarketplace?: number;
  kgvpPickup?: number;
  kgvpSupplier?: number;
  kgvpSupplierExpress?: number;
  paidStorageKgvp?: number;
} & Record<string, any>;

export async function getCommissionTariffs(locale: 'ru' | 'en' | 'zh' = 'ru'): Promise<CommissionRow[]> {
  const cached = mem.commission.get(locale);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rows;

  const cachePath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-tariffs-commission-${locale}.json`;

  try {
    const apiKey = await getWbApiKey();
    const url = `https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=${encodeURIComponent(locale)}`;
    const resp = await wbGetJson<{ report?: CommissionRow[] }>(url, apiKey);
    const report = resp?.report;
    const rows = Array.isArray(report) ? (report as CommissionRow[]) : [];

    mem.commission.set(locale, { at: Date.now(), rows });
    await writeFile(cachePath, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2), 'utf8');
    return rows;
  } catch {
    try {
      const raw = await readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed?.rows) ? (parsed.rows as CommissionRow[]) : [];
      mem.commission.set(locale, { at: Date.now(), rows });
      return rows;
    } catch {
      return [];
    }
  }
}

export type TariffsBoxRow = {
  date?: string;
  warehouseID?: number;
  warehouseName?: string;
  boxTypeID?: number;
  coefficient?: number;

  storageCoef?: number | null;
  deliveryCoef?: number | null;

  deliveryBaseLiter?: number | null;
  deliveryAdditionalLiter?: number | null;
  storageBaseLiter?: number | null;
  storageAdditionalLiter?: number | null;
} & Record<string, any>;

const mem = {
  commission: new Map<string, { at: number; rows: CommissionRow[] }>(),
  box: new Map<string, { at: number; rows: any[] }>(),
};

const TTL_MS = 6 * 60 * 60 * 1000; // 6h

export async function getTariffsBox(date: string): Promise<any[]> {
  const cached = mem.box.get(date);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rows;

  const cachePath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-tariffs-box-${date}.json`;

  try {
    const apiKey = await getWbApiKey();
    const url = `https://common-api.wildberries.ru/api/v1/tariffs/box?date=${encodeURIComponent(date)}`;
    const resp = await wbGetJson<{ response?: { data?: { warehouseList?: any[] } } }>(url, apiKey);

    // Actual shape (as seen in practice): response.data.warehouseList[]
    const wl = resp?.response?.data?.warehouseList;
    const rows = Array.isArray(wl) ? wl : [];

    mem.box.set(date, { at: Date.now(), rows });
    await writeFile(cachePath, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2), 'utf8');
    return rows;
  } catch {
    try {
      const raw = await readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed?.rows) ? (parsed.rows as any[]) : [];
      mem.box.set(date, { at: Date.now(), rows });
      return rows;
    } catch {
      return [];
    }
  }
}

export async function getTariffsPallet(date: string): Promise<any> {
  const apiKey = await getWbApiKey();
  const url = `https://common-api.wildberries.ru/api/v1/tariffs/pallet?date=${encodeURIComponent(date)}`;
  return wbGetJson(url, apiKey);
}

export async function getTariffsReturn(date: string): Promise<any> {
  const apiKey = await getWbApiKey();
  const url = `https://common-api.wildberries.ru/api/v1/tariffs/return?date=${encodeURIComponent(date)}`;
  return wbGetJson(url, apiKey);
}

// ===========================================================================
// Acceptance coefficients per warehouse (для мониторинга «Ловец приёмки» F-13).
// WB rate limit: 1 req/hour per seller token (см. wbEndpointLimits.ts).
// ===========================================================================

export interface AcceptanceCoeffRow {
  warehouseID: number;
  warehouseName: string;
  date: string;          // YYYY-MM-DD
  coefficient: number;   // -1 = недоступно, 0 = бесплатно, ≥1 = множитель
  boxTypeID?: number;
  boxTypeName?: string;
  allowUnload?: boolean;
}

/**
 * Fetch acceptance coefficients across all warehouses for the next ~14 days.
 * Requires a valid seller token; coefficients depend on the seller account.
 */
export async function getAcceptanceCoefficients(
  apiKey: string,
  warehouseIDs?: number[],
): Promise<AcceptanceCoeffRow[]> {
  const params = new URLSearchParams();
  if (warehouseIDs && warehouseIDs.length > 0) {
    for (const id of warehouseIDs) params.append('warehouseIDs', String(id));
  }
  const qs = params.toString();
  // URL matches the entry in wbEndpointLimits.ts (1 req/hour per token).
  const url =
    `https://common-api.wildberries.ru/api/tariffs/v1/acceptance/coefficients` +
    (qs ? `?${qs}` : '');
  const resp = await wbGetJson<AcceptanceCoeffRow[] | { data?: AcceptanceCoeffRow[] }>(url, apiKey);
  // WB sometimes returns either bare array or { data: [...] }
  if (Array.isArray(resp)) return resp;
  if (resp && Array.isArray((resp as any).data)) return (resp as any).data;
  return [];
}

export function pickCommissionPercent(row: CommissionRow, model: 'marketplace' | 'booking' | 'pickup' | 'supplier' = 'marketplace'): number | null {
  const v =
    model === 'booking'
      ? row.kgvpBooking
      : model === 'pickup'
        ? row.kgvpPickup
        : model === 'supplier'
          ? row.kgvpSupplier
          : row.kgvpMarketplace;

  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v / 100;
}
