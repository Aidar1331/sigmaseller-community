/**
 * Async Report Runner for WB Statistics API
 * 
 * Universal service for all async reports (create → poll → download)
 * Host: https://statistics-api.wildberries.ru
 * 
 * Supported report types:
 * - warehouse-remains
 * - deductions
 * - storage
 * - region-sales
 * - brand-share
 * - hidden-products
 * - excise-goods
 * - returns
 * - acceptance (платная приёмка)
 */

import { wbGetJson, wbPostJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'asyncReportRunner' });

const STATISTICS_API = 'https://statistics-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export type ReportType =
  | 'warehouse-remains'
  | 'deductions'
  | 'storage'
  | 'region-sales'
  | 'brand-share'
  | 'hidden-products'
  | 'excise-goods'
  | 'returns'
  | 'acceptance';

export type ReportStatus = 'new' | 'processing' | 'done' | 'purged' | 'canceled';

export interface ReportRequest {
  apiKey: string;
  type: ReportType;
  params?: Record<string, unknown>;
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs?: number;
  /** Max wait time in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
}

export interface ReportTaskStatus {
  taskId: string;
  status: ReportStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReportResult<T = unknown> {
  taskId: string;
  status: 'done';
  data: T[];
}

export interface ReportError {
  taskId?: string;
  status: 'error' | 'timeout' | 'purged' | 'canceled';
  message: string;
  retryable: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getReportEndpoint(type: ReportType): string {
  // Map report type to API endpoint
  const endpoints: Record<ReportType, string> = {
    'warehouse-remains': 'warehouse-remains',
    'deductions': 'deductions',
    'storage': 'storage',
    'region-sales': 'region-sales',
    'brand-share': 'brand-share',
    'hidden-products': 'hidden-products',
    'excise-goods': 'excise-goods',
    'returns': 'returns',
    'acceptance': 'acceptance',
  };
  return endpoints[type];
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Create a new report task
 * POST /api/v1/reports/{type}/create
 */
export async function createReport(
  apiKey: string,
  type: ReportType,
  params?: Record<string, unknown>
): Promise<{ taskId: string }> {
  const endpoint = getReportEndpoint(type);
  const url = `${STATISTICS_API}/api/v1/reports/${endpoint}/create`;
  
  logger.info({ type }, 'Creating report');
  
  const body = params || {};
  const result = await wbPostJson<{ data: { taskId: string } }>(url, apiKey, body);
  
  if (!result?.data?.taskId) {
    throw new Error(`Failed to create report ${type}: no taskId in response`);
  }
  
  logger.info({ type, taskId: result.data.taskId }, 'Report created');
  return { taskId: result.data.taskId };
}

/**
 * Get report task status
 * GET /api/v1/reports/{type}/tasks/{taskId}/status
 */
export async function getReportStatus(
  apiKey: string,
  type: ReportType,
  taskId: string
): Promise<ReportTaskStatus> {
  const endpoint = getReportEndpoint(type);
  const url = `${STATISTICS_API}/api/v1/reports/${endpoint}/tasks/${taskId}/status`;
  
  const result = await wbGetJson<{ data: { status: ReportStatus } }>(url, apiKey);
  
  return {
    taskId,
    status: result?.data?.status || 'new',
  };
}

/**
 * Download completed report
 * GET /api/v1/reports/{type}/tasks/{taskId}/download
 */
export async function downloadReport<T = unknown>(
  apiKey: string,
  type: ReportType,
  taskId: string
): Promise<T[]> {
  const endpoint = getReportEndpoint(type);
  const url = `${STATISTICS_API}/api/v1/reports/${endpoint}/tasks/${taskId}/download`;
  
  logger.info({ type, taskId }, 'Downloading report');
  
  const result = await wbGetJson<T[] | { data: T[] }>(url, apiKey);
  
  // Handle both array response and wrapped response
  if (Array.isArray(result)) {
    return result;
  }
  if (result && typeof result === 'object' && 'data' in result && Array.isArray(result.data)) {
    return result.data;
  }
  
  logger.warn({ type, result }, 'Unexpected response format');
  return [];
}

/**
 * Run a complete report workflow: create → poll → download
 * 
 * @example
 * const data = await runReport({
 *   apiKey: 'xxx',
 *   type: 'hidden-products',
 *   params: { dateFrom: '2024-01-01', dateTo: '2024-01-31' }
 * });
 */
export async function runReport<T = unknown>(
  request: ReportRequest
): Promise<ReportResult<T> | ReportError> {
  const {
    apiKey,
    type,
    params,
    pollIntervalMs = 5000,
    timeoutMs = 300000, // 5 minutes
  } = request;

  const startTime = Date.now();
  let taskId: string;

  // Step 1: Create report
  try {
    const created = await createReport(apiKey, type, params);
    taskId = created.taskId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ type, err: message }, 'Failed to create report');
    return {
      status: 'error',
      message: `Failed to create report: ${message}`,
      retryable: true,
    };
  }

  // Step 2: Poll for completion
  let attempts = 0;
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);

  while (attempts < maxAttempts) {
    attempts++;
    const elapsed = Date.now() - startTime;

    try {
      const status = await getReportStatus(apiKey, type, taskId);
      
      logger.info({ type, taskId, status: status.status, attempt: attempts, elapsedMs: elapsed }, 'Report poll status');

      switch (status.status) {
        case 'done':
          // Step 3: Download
          try {
            const data = await downloadReport<T>(apiKey, type, taskId);
            logger.info({ type, taskId, items: data.length }, 'Report completed');
            return {
              taskId,
              status: 'done',
              data,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              taskId,
              status: 'error',
              message: `Download failed: ${message}`,
              retryable: true,
            };
          }

        case 'purged':
          // Report was purged (expired), need to retry
          logger.warn({ type, taskId }, 'Report was purged, retrying');
          return {
            taskId,
            status: 'purged',
            message: 'Report was purged before download. Retry the request.',
            retryable: true,
          };

        case 'canceled':
          return {
            taskId,
            status: 'canceled',
            message: 'Report was canceled',
            retryable: false,
          };

        case 'new':
        case 'processing':
          // Still processing, wait and retry
          await sleep(pollIntervalMs);
          break;

        default:
          logger.warn({ type, taskId, status: status.status }, 'Unknown report status');
          await sleep(pollIntervalMs);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ type, taskId, err: message }, 'Error polling report');
      
      // Continue polling on transient errors
      if (attempts < maxAttempts) {
        await sleep(pollIntervalMs);
      }
    }
  }

  // Timeout
  logger.error({ type, taskId, timeoutMs }, 'Report timed out');
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
export function isReportSuccess<T>(result: ReportResult<T> | ReportError): result is ReportResult<T> {
  return result.status === 'done';
}

/**
 * Check if error is retryable
 */
export function isRetryable(result: ReportError): boolean {
  return result.retryable;
}
