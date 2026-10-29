/**
 * WB Documents API (акты, УПД, уведомления)
 * Host: https://documents-api.wildberries.ru
 *
 * Rate limit: 1 req/10 sec, 5 burst
 * Массовое скачивание: 1 req/5 min, 5 burst
 */

import { wbGetJson, wbPostJson } from './wbClient.js';

const DOCS_API = 'https://documents-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface DocumentCategory {
  name: string;   // "redeem-notification"
  title: string;  // "Уведомление о выкупе"
}

export interface DocumentItem {
  serviceName: string;
  name: string;
  category: string;
  extensions: string[];  // ["zip"]
  creationTime: string;  // ISO datetime
  viewed: boolean;
}

export interface DocumentDownload {
  fileName: string;
  extension: string;
  document: string;  // Base64
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get document categories
 * GET /api/v1/documents/categories
 */
export async function getDocumentCategories(
  apiKey: string,
  locale: 'ru' | 'en' | 'zh' = 'ru'
): Promise<{ data: { categories: DocumentCategory[] } }> {
  return wbGetJson<{ data: { categories: DocumentCategory[] } }>(
    `${DOCS_API}/api/v1/documents/categories?locale=${locale}`,
    apiKey
  );
}

/**
 * Get documents list
 * GET /api/v1/documents/list
 *
 * @param limit - max 50
 */
export async function getDocumentsList(
  apiKey: string,
  params: {
    beginTime: string;   // "2024-07-09"
    endTime: string;     // "2024-07-15"
    category?: string;
    sort?: 'date' | 'category';
    order?: 'asc' | 'desc';
    limit?: number;      // max 50
    offset?: number;
  }
): Promise<{ data: { documents: DocumentItem[] } }> {
  const qs = new URLSearchParams();
  qs.set('locale', 'ru');
  qs.set('beginTime', params.beginTime);
  qs.set('endTime', params.endTime);
  if (params.category) qs.set('category', params.category);
  qs.set('sort', params.sort ?? 'date');
  qs.set('order', params.order ?? 'desc');
  qs.set('limit', String(Math.min(params.limit ?? 50, 50)));
  if (params.offset) qs.set('offset', String(params.offset));

  return wbGetJson<{ data: { documents: DocumentItem[] } }>(
    `${DOCS_API}/api/v1/documents/list?${qs}`,
    apiKey
  );
}

/**
 * Download single document
 * GET /api/v1/documents/download
 *
 * @returns Base64 encoded file
 */
export async function downloadDocument(
  apiKey: string,
  serviceName: string,
  extension: string
): Promise<{ data: DocumentDownload }> {
  const qs = new URLSearchParams({ serviceName, extension });
  return wbGetJson<{ data: DocumentDownload }>(
    `${DOCS_API}/api/v1/documents/download?${qs}`,
    apiKey
  );
}

/**
 * Download multiple documents (zip)
 * POST /api/v1/documents/download/all
 *
 * Rate limit: 1 req/5 min (!)
 * Max 50 documents per request
 */
export async function downloadDocumentsBatch(
  apiKey: string,
  items: Array<{ extension: string; serviceName: string }>
): Promise<{ data: DocumentDownload }> {
  if (items.length > 50) {
    throw new Error('Max 50 documents per batch download');
  }
  return wbPostJson<{ data: DocumentDownload }>(
    `${DOCS_API}/api/v1/documents/download/all`,
    apiKey,
    { params: items },
    1,
    { maxRetries: 1 } // Strict rate limit
  );
}

// ============================================================================
// Category mapping
// ============================================================================

export const DOCUMENT_CATEGORIES: Record<string, string> = {
  'redeem-notification': 'Уведомление о выкупе',
  'fine': 'Штраф',
  'act': 'Акт',
  'upd': 'УПД',
  'invoice': 'Счёт',
  'report': 'Отчёт',
};

/**
 * Get human-readable category name
 */
export function getCategoryTitle(category: string): string {
  return DOCUMENT_CATEGORIES[category] || category;
}
