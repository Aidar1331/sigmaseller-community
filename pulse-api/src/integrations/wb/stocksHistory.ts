/**
 * WB Stocks History API
 * 
 * JSON API: https://seller-analytics-api.wildberries.ru
 * CSV Reports: via csvReports.ts (STOCK_HISTORY_REPORT_CSV, STOCK_HISTORY_DAILY_CSV)
 * 
 * Rate limit: 3 req/min on seller-analytics-api
 */

import { wbPostJson } from './wbClient.js';
import { runCsvReport, isCsvReportSuccess, CsvReportType, CsvReportResult } from './csvReports.js';

const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface StockHistoryItem {
  date: string;
  nmId: number;
  vendorCode: string;
  brandName: string;
  subjectName: string;
  supplierArticle: string;
  techSize: string;
  barcode: string;
  warehouseName: string;
  quantity: number;
  inWayToClient: number;
  inWayFromClient: number;
}

export interface StockHistoryByDay {
  date: string;
  warehouses: Array<{
    warehouseId: number;
    warehouseName: string;
    quantity: number;
    inWayToClient: number;
    inWayFromClient: number;
  }>;
  total: {
    quantity: number;
    inWayToClient: number;
    inWayFromClient: number;
  };
}

// ============================================================================
// JSON API
// ============================================================================

/**
 * Get stocks history from JSON API
 * POST /api/analytics/v3/stocks-history
 * 
 * Note: This endpoint may have limited data range
 */
export async function getStocksHistory(
  apiKey: string,
  params: {
    dateFrom: string;  // YYYY-MM-DD
    dateTo: string;
    nmIds?: number[];
    warehouseIds?: number[];
    limit?: number;
    offset?: number;
  }
): Promise<{ data: StockHistoryItem[] }> {
  return wbPostJson<{ data: StockHistoryItem[] }>(
    `${ANALYTICS_API}/api/analytics/v3/stocks-history`,
    apiKey,
    {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      nmIds: params.nmIds,
      warehouseIds: params.warehouseIds,
      limit: params.limit ?? 1000,
      offset: params.offset ?? 0,
    }
  );
}

/**
 * Get stocks history by day (aggregated)
 * POST /api/analytics/v3/stocks-history/by-day
 */
export async function getStocksHistoryByDay(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    nmIds?: number[];
  }
): Promise<{ data: StockHistoryByDay[] }> {
  return wbPostJson<{ data: StockHistoryByDay[] }>(
    `${ANALYTICS_API}/api/analytics/v3/stocks-history/by-day`,
    apiKey,
    {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      nmIds: params.nmIds,
    }
  );
}

// ============================================================================
// CSV Reports (no Jam required)
// ============================================================================

export type StockHistoryCsvRow = {
  date: string;
  nmId: number;
  vendorCode: string;
  brandName: string;
  subjectName: string;
  warehouseName: string;
  quantity: number;
  inWayToClient: number;
  inWayFromClient: number;
};

/**
 * Download stocks history as CSV
 * Uses: STOCK_HISTORY_REPORT_CSV (no Jam required)
 * 
 * @returns Parsed CSV data
 */
export async function downloadStocksHistoryCsv(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    nmIds?: number[];
  }
): Promise<StockHistoryCsvRow[]> {
  const reportType: CsvReportType = 'STOCK_HISTORY_REPORT_CSV';
  
  const result = await runCsvReport(apiKey, {
    reportType,
    params: {
      currentPeriod: { start: params.dateFrom, end: params.dateTo },
      stockType: 'mp',
      skipDeletedNm: true,
      availabilityFilters: ['deficient', 'actual', 'balanced', 'nonActual', 'nonLiquid'],
      orderBy: { field: 'avgOrders', mode: 'desc' },
      ...(params.nmIds?.length ? { nmIDs: params.nmIds } : {}),
    },
  });

  if (!isCsvReportSuccess(result)) {
    throw new Error(result.message || 'Report failed');
  }

  // Parse the CSV data
  const csvString = result.data.toString('utf-8');
  return parseStocksHistoryCsv(csvString);
}

/**
 * Parse stocks history CSV.
 * Handles two formats:
 * 1. Row-per-date: columns include "date", "nmid", "quantity", etc.
 * 2. Pivot (STOCK_HISTORY_DAILY_CSV): rows are products × warehouses,
 *    date columns like "08.04.2026" contain daily stock quantities.
 *    Header: VendorCode,Name,NmID,SubjectName,BrandName,SizeName,ChrtID,OfficeName,DD.MM.YYYY,...
 */
function parseStocksHistoryCsv(csvData: string): StockHistoryCsvRow[] {
  const lines = csvData.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];

  // Detect delimiter (comma or semicolon)
  const firstLine = lines[0];
  const sep = firstLine.includes('\t') ? '\t' : firstLine.split(',').length > firstLine.split(';').length ? ',' : ';';
  const headers = firstLine.split(sep).map(h => h.trim());
  const headersLower = headers.map(h => h.toLowerCase());

  // Detect pivot format: date columns like "DD.MM.YYYY"
  const dateColRegex = /^\d{2}\.\d{2}\.\d{4}$/;
  const dateColumns: Array<{ idx: number; isoDate: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    if (dateColRegex.test(headers[i])) {
      const [dd, mm, yyyy] = headers[i].split('.');
      dateColumns.push({ idx: i, isoDate: `${yyyy}-${mm}-${dd}` });
    }
  }

  const rows: StockHistoryCsvRow[] = [];

  if (dateColumns.length > 0) {
    // PIVOT format: transpose date columns into rows
    const nmIdIdx = headersLower.indexOf('nmid');
    const vendorIdx = headersLower.indexOf('vendorcode');
    const brandIdx = headersLower.indexOf('brandname');
    const subjectIdx = headersLower.indexOf('subjectname');
    const officeIdx = headersLower.indexOf('officename');

    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(sep);
      const nmId = parseInt(vals[nmIdIdx] ?? '0', 10);
      if (!Number.isFinite(nmId) || nmId <= 0) continue;

      const vendorCode = vals[vendorIdx]?.trim() ?? '';
      const brandName = vals[brandIdx]?.trim() ?? '';
      const subjectName = vals[subjectIdx]?.trim() ?? '';
      const warehouseName = vals[officeIdx]?.trim() ?? '';

      for (const dc of dateColumns) {
        const qty = parseInt(vals[dc.idx] ?? '0', 10);
        rows.push({
          date: dc.isoDate,
          nmId,
          vendorCode,
          brandName,
          subjectName,
          warehouseName,
          quantity: Number.isFinite(qty) ? qty : 0,
          inWayToClient: 0,
          inWayFromClient: 0,
        });
      }
    }
  } else {
    // Row-per-date format
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(sep);
      const row: any = {};
      headersLower.forEach((header, idx) => { row[header] = values[idx]?.trim() ?? ''; });

      rows.push({
        date: row.date || row['дата'] || '',
        nmId: parseInt(row.nmid || row.nm_id || row['артикул wb'] || '0', 10),
        vendorCode: row.vendorcode || row.vendor_code || row['артикул продавца'] || '',
        brandName: row.brandname || row.brand_name || row['бренд'] || '',
        subjectName: row.subjectname || row.subject_name || row['предмет'] || '',
        warehouseName: row.warehousename || row.warehouse_name || row['склад'] || row.officename || '',
        quantity: parseInt(row.quantity || row['количество'] || '0', 10),
        inWayToClient: parseInt(row.inwaytoclient || row.in_way_to_client || row['в пути к клиенту'] || '0', 10),
        inWayFromClient: parseInt(row.inwayfromclient || row.in_way_from_client || row['в пути от клиента'] || '0', 10),
      });
    }
  }

  return rows.filter(r => r.nmId > 0 && r.date);
}

/**
 * Download daily stock history (per-product, per-day, per-warehouse)
 * Uses: STOCK_HISTORY_DAILY_CSV (no Jam required)
 */
export async function downloadStocksHistoryDailyCsv(
  apiKey: string,
  params: { dateFrom: string; dateTo: string; nmIds?: number[] }
): Promise<StockHistoryCsvRow[]> {
  const reportType: CsvReportType = 'STOCK_HISTORY_DAILY_CSV';

  const result = await runCsvReport(apiKey, {
    reportType,
    params: {
      currentPeriod: { start: params.dateFrom, end: params.dateTo },
      stockType: '',
      skipDeletedNm: true,
      ...(params.nmIds?.length ? { nmIds: params.nmIds } : {}),
    },
  });

  if (!isCsvReportSuccess(result)) {
    throw new Error(result.message || 'STOCK_HISTORY_DAILY_CSV report failed');
  }

  const csvString = result.data.toString('utf-8');
  return parseStocksHistoryCsv(csvString);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate days until out of stock based on history trend
 */
export function calculateDaysUntilOos(
  history: StockHistoryByDay[],
  currentQuantity: number
): number | null {
  if (history.length < 7) return null;
  
  // Calculate average daily consumption
  let totalConsumed = 0;
  for (let i = 1; i < history.length; i++) {
    const diff = history[i - 1].total.quantity - history[i].total.quantity;
    if (diff > 0) totalConsumed += diff;
  }
  
  const avgDailyConsumption = totalConsumed / (history.length - 1);
  
  if (avgDailyConsumption <= 0) return null;
  
  return Math.floor(currentQuantity / avgDailyConsumption);
}
