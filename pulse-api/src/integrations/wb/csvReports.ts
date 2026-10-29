/**
 * WB CSV Analytics Reports Client
 * 
 * Host: https://seller-analytics-api.wildberries.ru
 * 
 * Creates and downloads CSV reports from WB Analytics API.
 * Uses different pattern than asyncReportRunner (nm-report/downloads).
 * 
 * Report Types:
 * - STOCK_HISTORY_REPORT_CSV — без Джем ✅
 * - STOCK_HISTORY_DAILY_CSV — без Джем ✅
 * - DETAIL_HISTORY_REPORT — 🔒 Джем
 * - GROUPED_HISTORY_REPORT — 🔒 Джем
 * - SEARCH_QUERIES_PREMIUM_REPORT_GROUP — 🔒 Джем
 * - SEARCH_QUERIES_PREMIUM_REPORT_PRODUCT — 🔒 Джем
 * - SEARCH_QUERIES_PREMIUM_REPORT_TEXT — 🔒 Джем
 */

import { wbGetJson, wbPostJson, WbJamRequiredError } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'csvReports' });

const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export type CsvReportType =
  // Available without Jam
  | 'STOCK_HISTORY_REPORT_CSV'
  | 'STOCK_HISTORY_DAILY_CSV'
  // Require Jam subscription
  | 'DETAIL_HISTORY_REPORT'
  | 'GROUPED_HISTORY_REPORT'
  | 'SEARCH_QUERIES_PREMIUM_REPORT_GROUP'
  | 'SEARCH_QUERIES_PREMIUM_REPORT_PRODUCT'
  | 'SEARCH_QUERIES_PREMIUM_REPORT_TEXT';

export type CsvReportStatus = 'new' | 'processing' | 'done' | 'error' | 'deleted';

export interface CsvReportTask {
  id: string;
  reportType: CsvReportType;
  status: CsvReportStatus;
  createdAt: string;
  updatedAt?: string;
  params?: Record<string, unknown>;
}

export interface CreateCsvReportParams {
  reportType: CsvReportType;
  params: Record<string, unknown>;
}

export interface CsvReportResult {
  taskId: string;
  status: 'done';
  data: Buffer;
  filename?: string;
}

export interface CsvReportError {
  taskId?: string;
  status: 'error' | 'timeout' | 'jam_required';
  message: string;
  retryable: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const JAM_REQUIRED_TYPES: CsvReportType[] = [
  'DETAIL_HISTORY_REPORT',
  'GROUPED_HISTORY_REPORT',
  'SEARCH_QUERIES_PREMIUM_REPORT_GROUP',
  'SEARCH_QUERIES_PREMIUM_REPORT_PRODUCT',
  'SEARCH_QUERIES_PREMIUM_REPORT_TEXT',
];

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if report type requires Jam subscription
 */
export function requiresJam(reportType: CsvReportType): boolean {
  return JAM_REQUIRED_TYPES.includes(reportType);
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Create a new CSV report
 * POST /api/v2/nm-report/downloads
 */
export async function createCsvReport(
  apiKey: string,
  params: CreateCsvReportParams
): Promise<{ id: string }> {
  const url = `${ANALYTICS_API}/api/v2/nm-report/downloads`;
  
  logger.info({ reportType: params.reportType }, 'Creating CSV report');
  
  try {
    const { randomUUID } = await import('node:crypto');
    const requestId = randomUUID();
    const body = {
      id: requestId,
      reportType: params.reportType,
      userReportName: `${params.reportType}-${Date.now()}`,
      params: params.params,
    };
    const result = await wbPostJson<{ data: { id: string } }>(url, apiKey, body);

    const reportId = result?.data?.id ?? requestId;

    logger.info({ reportType: params.reportType, id: reportId }, 'Report created');
    return { id: reportId };
  } catch (err) {
    if (err instanceof WbJamRequiredError) {
      throw err; // Re-throw Jam errors
    }
    throw err;
  }
}

/**
 * Get list of CSV reports with status
 * GET /api/v2/nm-report/downloads
 */
export async function listCsvReports(
  apiKey: string,
  params?: { downloadId?: string }
): Promise<CsvReportTask[]> {
  let url = `${ANALYTICS_API}/api/v2/nm-report/downloads`;
  
  if (params?.downloadId) {
    url += `?downloadId=${params.downloadId}`;
  }
  
  const result = await wbGetJson<{ data: CsvReportTask[] }>(url, apiKey);
  return result?.data || [];
}

/**
 * Get status of a specific report
 */
export async function getCsvReportStatus(
  apiKey: string,
  downloadId: string
): Promise<CsvReportTask | null> {
  const reports = await listCsvReports(apiKey, { downloadId });
  return reports.find(r => r.id === downloadId) || null;
}

// retryCsvReport уже определён ниже (был добавлен в более ранней итерации).
// Оставлен как есть — реализация корректная (POST /api/v2/nm-report/downloads/retry).

/**
 * Download completed CSV report (WB returns ZIP archive containing CSV)
 * GET /api/v2/nm-report/downloads/file/{downloadId}
 */
export async function downloadCsvReport(
  apiKey: string,
  downloadId: string
): Promise<Buffer> {
  const url = `${ANALYTICS_API}/api/v2/nm-report/downloads/file/${downloadId}`;

  logger.info({ downloadId }, 'Downloading CSV report');

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    if (response.status === 402) {
      throw new WbJamRequiredError();
    }
    throw new Error(`Download failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);

  // WB returns ZIP archive — extract the first CSV file inside
  if (buf[0] === 0x50 && buf[1] === 0x4B) {
    // ZIP magic bytes (PK). Extract using basic ZIP parsing.
    const csv = await extractFirstFileFromZip(buf);
    if (csv) {
      logger.info({ downloadId, zipBytes: buf.length, csvBytes: csv.length }, 'Extracted CSV from ZIP');
      return csv;
    }
    logger.warn({ downloadId }, 'ZIP detected but extraction failed, returning raw');
  }

  return buf;
}

/**
 * Extract the first file from a ZIP archive using adm-zip.
 */
async function extractFirstFileFromZip(zipBuf: Buffer): Promise<Buffer | null> {
  try {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(zipBuf);
    const entries = zip.getEntries();
    const csvEntry = entries.find((e: any) => e.entryName.endsWith('.csv')) ?? entries[0];
    if (!csvEntry) return null;
    return csvEntry.getData();
  } catch (e: any) {
    logger.warn({ err: e }, 'ZIP extraction failed');
    return null;
  }
}

/**
 * Retry failed report generation
 * POST /api/v2/nm-report/downloads/retry
 */
export async function retryCsvReport(
  apiKey: string,
  downloadId: string
): Promise<{ id: string }> {
  const url = `${ANALYTICS_API}/api/v2/nm-report/downloads/retry`;
  
  const result = await wbPostJson<{ data: { id: string } }>(url, apiKey, { downloadId });
  return { id: result?.data?.id || downloadId };
}

/**
 * Run complete CSV report workflow: create → poll → download
 * 
 * @returns Result with Buffer data or error with jamRequired flag
 */
export async function runCsvReport(
  apiKey: string,
  params: CreateCsvReportParams,
  options?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
  }
): Promise<CsvReportResult | CsvReportError> {
  const { pollIntervalMs = 5000, timeoutMs = 300000 } = options || {};
  const startTime = Date.now();
  
  // Check if Jam is required and warn
  if (requiresJam(params.reportType)) {
    logger.warn({ reportType: params.reportType }, 'Report requires Jam subscription');
  }
  
  // Step 1: Create report
  let taskId: string;
  try {
    const created = await createCsvReport(apiKey, params);
    taskId = created.id;
  } catch (err) {
    if (err instanceof WbJamRequiredError) {
      return {
        status: 'jam_required',
        message: 'Для этого типа отчёта требуется подписка «Джем» на Wildberries',
        retryable: false,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      message: `Failed to create report: ${message}`,
      retryable: true,
    };
  }
  
  // Step 2: Poll for completion
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - startTime;
    
    try {
      const status = await getCsvReportStatus(apiKey, taskId);
      
      if (!status) {
        logger.warn({ taskId }, 'Report not found');
        await sleep(pollIntervalMs);
        continue;
      }
      
      const statusLower = String(status.status).toLowerCase();
      logger.info({ reportType: params.reportType, taskId, status: statusLower, attempt, elapsedMs: elapsed }, 'Report poll status');

      if (statusLower === 'done' || statusLower === 'success') {
        // Step 3: Download
        try {
          const data = await downloadCsvReport(apiKey, taskId);
          logger.info({ reportType: params.reportType, taskId, bytes: data.length }, 'Report downloaded');
          return {
            taskId,
            status: 'done',
            data,
          };
        } catch (err) {
          if (err instanceof WbJamRequiredError) {
            return {
              taskId,
              status: 'jam_required',
              message: 'Для скачивания этого отчёта требуется подписка «Джем»',
              retryable: false,
            };
          }
          const message = err instanceof Error ? err.message : String(err);
          return {
            taskId,
            status: 'error',
            message: `Download failed: ${message}`,
            retryable: true,
          };
        }
      } else if (statusLower === 'error' || statusLower === 'failed') {
        return {
          taskId,
          status: 'error',
          message: 'Report generation failed on WB side',
          retryable: true,
        };
      } else if (statusLower === 'deleted') {
        return {
          taskId,
          status: 'error',
          message: 'Report was deleted before download',
          retryable: true,
        };
      } else {
        // 'new', 'processing', 'PROCESSING', etc.
        await sleep(pollIntervalMs);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ taskId, err: message }, 'Error polling report');
      
      if (attempt < maxAttempts) {
        await sleep(pollIntervalMs);
      }
    }
  }
  
  return {
    taskId,
    status: 'timeout',
    message: `Report generation timed out after ${timeoutMs}ms`,
    retryable: true,
  };
}

/**
 * Check if result is successful
 */
export function isCsvReportSuccess(result: CsvReportResult | CsvReportError): result is CsvReportResult {
  return result.status === 'done';
}

/**
 * Check if error is Jam-related
 */
export function isJamRequired(result: CsvReportError): boolean {
  return result.status === 'jam_required';
}
