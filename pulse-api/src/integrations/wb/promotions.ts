/**
 * WB Calendar Promotions API (акции)
 * Host: https://dp-calendar-api.wildberries.ru
 */

import { wbGetJson, wbPostJson } from './wbClient.js';

const PROMO_API = 'https://dp-calendar-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface WbPromotion {
  id: number;
  name: string;
  startDateTime: string;
  endDateTime: string;
  type: string;
  description?: string;
  advantages?: string[];
  inAction: boolean;
  participationPercentage?: number;
}

export interface PromotionDetail {
  id: number;
  name: string;
  description: string;
  advantages: string[];
  startDateTime: string;
  endDateTime: string;
  type: string;
  inAction: boolean;
  exceptionProductsCount: number;
  participationPercentage: number;
  ranging?: {
    rangeFrom: number;
    rangeTo: number;
  }[];
}

export interface PromotionProduct {
  nmId: number;
  inAction: boolean;
  price: number;           // текущая розничная цена
  currencyCode: string;    // "RUB"
  planPrice: number;       // планируемая цена в акции
  discount: number;        // текущая скидка %
  planDiscount: number;    // рекомендуемая скидка %
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get promotions list
 * GET /api/v1/calendar/promotions
 */
export async function getPromotions(
  apiKey: string,
  params?: {
    startDateTime?: string;  // ISO datetime
    endDateTime?: string;
    allPromo?: boolean;
  }
): Promise<{ data: { promotions: WbPromotion[] } }> {
  const qs = new URLSearchParams();
  // WB requires startDateTime and endDateTime — default to -30d..+90d
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const defaultEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  // WB expects RFC3339 without milliseconds
  const toRfc3339 = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  qs.set('startDateTime', params?.startDateTime ?? toRfc3339(defaultStart));
  qs.set('endDateTime', params?.endDateTime ?? toRfc3339(defaultEnd));
  // WB Calendar API requires allPromo parameter — without it returns 400
  qs.set('allPromo', params?.allPromo !== undefined ? String(params.allPromo) : 'true');

  return wbGetJson<{ data: { promotions: WbPromotion[] } }>(
    `${PROMO_API}/api/v1/calendar/promotions?${qs}`,
    apiKey
  );
}

/**
 * Get promotion details
 * GET /api/v1/calendar/promotions/details
 */
export async function getPromotionDetails(
  apiKey: string,
  promotionId: number
): Promise<{ data: PromotionDetail }> {
  return wbGetJson<{ data: PromotionDetail }>(
    `${PROMO_API}/api/v1/calendar/promotions/details?id=${promotionId}`,
    apiKey
  );
}

/**
 * Get products eligible for promotion
 * GET /api/v1/calendar/promotions/nomenclatures
 */
export async function getPromotionProducts(
  apiKey: string,
  promotionId: number,
  params?: {
    inAction?: boolean;
    limit?: number;
    offset?: number;
  }
): Promise<{ data: { nomenclatures: PromotionProduct[] } }> {
  const qs = new URLSearchParams();
  qs.set('promotionID', String(promotionId));
  // inAction is REQUIRED by WB API — default to false (show all eligible products)
  qs.set('inAction', String(params?.inAction ?? false));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));

  return wbGetJson<{ data: { nomenclatures: PromotionProduct[] } }>(
    `${PROMO_API}/api/v1/calendar/promotions/nomenclatures?${qs}`,
    apiKey
  );
}

/**
 * Add products to promotion
 * POST /api/v1/calendar/promotions/upload
 */
export async function addProductsToPromotion(
  apiKey: string,
  promotionId: number,
  nmIds: number[]
): Promise<void> {
  await wbPostJson(
    `${PROMO_API}/api/v1/calendar/promotions/upload`,
    apiKey,
    {
      id: promotionId,
      nomenclatures: nmIds,
    }
  );
}

/**
 * Remove products from promotion
 * POST /api/v1/calendar/promotions/delete
 */
export async function removeProductsFromPromotion(
  apiKey: string,
  promotionId: number,
  nmIds: number[]
): Promise<void> {
  await wbPostJson(
    `${PROMO_API}/api/v1/calendar/promotions/delete`,
    apiKey,
    {
      id: promotionId,
      nomenclatures: nmIds,
    }
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if promotion is active now
 */
export function isPromotionActive(promo: WbPromotion): boolean {
  const now = Date.now();
  const start = new Date(promo.startDateTime).getTime();
  const end = new Date(promo.endDateTime).getTime();
  return now >= start && now <= end;
}

/**
 * Check if promotion is upcoming
 */
export function isPromotionUpcoming(promo: WbPromotion): boolean {
  return new Date(promo.startDateTime).getTime() > Date.now();
}

/**
 * Get days until promotion starts
 */
export function daysUntilPromotion(promo: WbPromotion): number {
  const diff = new Date(promo.startDateTime).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
