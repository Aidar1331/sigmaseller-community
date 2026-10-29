/**
 * WB Returns / Claims API (актуальные endpoints по доке 2026-04).
 *
 * Раньше код использовал /api/v1/returns/* — это устаревший префикс,
 * современный API под /api/v1/claims (заявки покупателей на возврат)
 * + /api/v1/feedbacks/order/return (возврат по отзыву, инициируется
 * продавцом) + /api/v1/analytics/goods-return (аналитика возвратов,
 * другой хост — seller-analytics-api).
 *
 * Срок реакции продавца на claim:
 *   DBS / EDBS — 1 день
 *   остальные — 10 дней
 * Если не ответили — заявка одобряется автоматически.
 */

import { wbGetJson, wbPostJson, wbPatchJson } from './wbClient.js';

const FEEDBACKS_API = 'https://feedbacks-api.wildberries.ru';
const RETURNS_API = 'https://returns-api.wildberries.ru';
const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

// ============================================================================
// Claims (заявки покупателя на возврат)
// ============================================================================

export interface WbClaim {
  id: string;
  orderId?: string | number;
  nmId?: number;
  vendorCode?: string;
  status: string;
  /** Возможные варианты ответа на конкретную заявку (зависит от типа). */
  actions: string[];
  reason?: string;
  reasonDetails?: string;
  buyerComment?: string;
  photoUrls?: string[];
  refundAmount?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface WbClaimsResponse {
  data: WbClaim[];
  total: number;
  hasNext?: boolean;
  next?: string | null;
}

/**
 * GET /api/v1/claims — заявки покупателей на возврат за последние 14 дней.
 *
 * WB требует обязательный параметр `is_archive` (boolean):
 *   false → активные заявки (на рассмотрении)
 *   true  → архив (уже обработанные)
 * Без него WB отдаёт 404.
 *
 * Ответ нормализуем из реальной формы `{ claims: [{ id, claim_type, status,
 * nm_id, user_comment, dt, photos, video_paths, actions, … }] }` к нашему
 * интерфейсу WbClaim.
 */
export async function getClaims(
  apiKey: string,
  params?: { isArchive?: boolean; id?: string; nmId?: number; limit?: number; offset?: number },
): Promise<WbClaimsResponse> {
  const qs = new URLSearchParams();
  qs.set('is_archive', String(params?.isArchive ?? false));
  if (params?.id) qs.set('id', params.id);
  if (params?.nmId) qs.set('nm_id', String(params.nmId));
  qs.set('limit', String(params?.limit ?? 50));
  qs.set('offset', String(params?.offset ?? 0));
  const raw = await wbGetJson<any>(`${RETURNS_API}/api/v1/claims?${qs}`, apiKey);
  const rows: any[] = Array.isArray(raw?.claims) ? raw.claims : Array.isArray(raw?.data) ? raw.data : [];
  const data: WbClaim[] = rows.map((r) => ({
    id: String(r?.id ?? ''),
    orderId: r?.order_id ?? r?.orderId ?? undefined,
    nmId: r?.nm_id ?? r?.nmId ?? undefined,
    vendorCode: r?.vendor_code ?? r?.vendorCode ?? r?.imt_name ?? undefined,
    status: String(r?.status ?? r?.status_ex ?? ''),
    actions: Array.isArray(r?.actions) ? r.actions : [],
    reason: r?.user_comment ?? r?.reason ?? undefined,
    reasonDetails: r?.wb_comment ?? r?.reasonDetails ?? undefined,
    buyerComment: r?.user_comment ?? r?.buyerComment ?? undefined,
    photoUrls: Array.isArray(r?.photos) ? r.photos.map((p: string) => (p.startsWith('http') ? p : `https:${p}`)) : undefined,
    refundAmount: r?.refund_amount ?? r?.refundAmount ?? undefined,
    createdAt: r?.dt ?? r?.createdAt ?? new Date().toISOString(),
    updatedAt: r?.dt_update ?? r?.updatedAt ?? undefined,
  }));
  return { data, total: rows.length, hasNext: rows.length === (params?.limit ?? 50) };
}

/**
 * PATCH /api/v1/claim — обработать одну заявку.
 *
 * `action` — одна из строк из claim.actions[]. WB сам валидирует — мы не
 * пытаемся угадать что разрешено для каждого типа заявки.
 */
export async function processClaim(
  apiKey: string,
  params: { id: string; action: string; comment?: string },
): Promise<{ ok: true } | Record<string, unknown>> {
  return wbPatchJson(`${RETURNS_API}/api/v1/claim`, apiKey, {
    id: params.id,
    action: params.action,
    ...(params.comment ? { comment: params.comment } : {}),
  });
}

// ============================================================================
// Return-by-review (продавец сам инициирует возврат на основании отзыва)
// ============================================================================

/**
 * POST /api/v1/feedbacks/order/return — оформить возврат по отзыву.
 *
 * Только для отзывов с признаком `isAbleReturnProductOrders: true`.
 * Если товар уже у покупателя — возврат оформляется когда товар вернётся
 * на склад. Если покупатель не вернёт товар в ПВЗ — возврат не происходит.
 */
export async function returnByReview(
  apiKey: string,
  feedbackId: string,
): Promise<{ ok: true } | Record<string, unknown>> {
  return wbPostJson(`${FEEDBACKS_API}/api/v1/feedbacks/order/return`, apiKey, {
    id: feedbackId,
  });
}

// ============================================================================
// Goods-return analytics (агрегированная аналитика возвратов)
// ============================================================================

export interface GoodsReturnStats {
  nmId: number;
  vendorCode?: string;
  totalReturns?: number;
  returnRate?: number;
  topReasons?: Array<{ reason: string; count: number }>;
}

/**
 * GET /api/v1/analytics/goods-return — аналитика возвратов на хосте
 * seller-analytics-api. Жёсткий rate-limit: 2 запроса в час (зарезервирован
 * в wbEndpointLimits.ts).
 */
export async function getGoodsReturnAnalytics(
  apiKey: string,
  params?: { dateFrom?: string; dateTo?: string; nmIds?: number[] },
): Promise<{ data: GoodsReturnStats[] }> {
  return wbPostJson(`${ANALYTICS_API}/api/v1/analytics/goods-return`, apiKey, {
    ...(params?.dateFrom ? { dateFrom: params.dateFrom } : {}),
    ...(params?.dateTo ? { dateTo: params.dateTo } : {}),
    ...(params?.nmIds && params.nmIds.length ? { nmIds: params.nmIds } : {}),
  });
}

// ============================================================================
// Backwards-compat: старые имена функций сохранены, направлены на новые
// endpoints. Существующие call-sites не сломаются.
// ============================================================================

export interface WbReturn extends WbClaim {
  // Совместимость со старой структурой
  orderId: any;
  nmId: any;
  vendorCode: any;
  brandName: any;
  size: any;
  barcode: any;
  status: any;
  reason: any;
  createdAt: string;
}

export interface WbReturnsResponse {
  data: WbReturn[];
  total: number;
  hasNext: boolean;
}

export interface ApproveReturnParams { returnId: number | string; comment?: string }
export interface RejectReturnParams { returnId: number | string; reason: string; comment?: string }

/** Старое имя → claims. */
export async function getReturns(
  apiKey: string,
  params?: Parameters<typeof getClaims>[1],
): Promise<WbReturnsResponse> {
  const res = await getClaims(apiKey, params);
  return {
    data: (res.data as any) ?? [],
    total: res.total ?? 0,
    hasNext: res.hasNext ?? false,
  };
}

/** Старое имя — единичный claim. WB современный API не имеет отдельного GET. */
export async function getReturnDetails(apiKey: string, returnId: number | string): Promise<WbReturn> {
  const list = await getClaims(apiKey);
  const hit = list.data?.find((c) => String(c.id) === String(returnId));
  if (!hit) throw new Error(`Claim ${returnId} not found in current list`);
  return hit as any;
}

/** Старое approve → PATCH /claim с action='approve'. */
export async function approveReturn(apiKey: string, params: ApproveReturnParams): Promise<{ success: boolean }> {
  await processClaim(apiKey, { id: String(params.returnId), action: 'approve', comment: params.comment });
  return { success: true };
}

export async function rejectReturn(apiKey: string, params: RejectReturnParams): Promise<{ success: boolean }> {
  await processClaim(apiKey, { id: String(params.returnId), action: 'reject', comment: params.reason });
  return { success: true };
}

export async function getReturnsStatistics(
  apiKey: string,
  params?: { dateFrom?: string; dateTo?: string },
): Promise<{ total: number; pending: number; approved: number; rejected: number; totalAmount: number }> {
  // Старый эндпоинт /returns/statistics удалён из WB. Возвращаем приближение
  // через goods-return analytics — agregated counts per nmId, sumарно.
  try {
    const res = await getGoodsReturnAnalytics(apiKey, params);
    const total = (res.data ?? []).reduce((s, r) => s + (r.totalReturns ?? 0), 0);
    return { total, pending: 0, approved: 0, rejected: 0, totalAmount: 0 };
  } catch {
    return { total: 0, pending: 0, approved: 0, rejected: 0, totalAmount: 0 };
  }
}
