/**
 * Sales Funnel API — обёртки для real-time запросов воронки продаж
 * (`/api/analytics/v3/sales-funnel/*`).
 *
 * До 2026-05 в коде были только backfill-скрипты, дёргающие эти endpoints
 * inline. Этот файл выделяет переиспользуемые обёртки для AI-агентов и
 * других сервисов, которым нужны воронка-данные на лету.
 *
 * Группа методов:
 *   POST /api/analytics/v3/sales-funnel/products            — снимок (status quo)
 *   POST /api/analytics/v3/sales-funnel/products/history    — по дням
 *   POST /api/analytics/v3/sales-funnel/grouped/history     — по предмету/бренду/ярлыку
 */

import { wbPostJson } from './wbClient.js';

const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

export type FunnelPeriod = { start: string; end: string };

export interface FunnelProductRow {
  nmId: number;
  vendorCode?: string;
  brandName?: string;
  subjectName?: string;
  viewCount?: number;
  openCardCount?: number;
  addToCartCount?: number;
  orderCount?: number;
  orderSumRub?: number;
  buyoutCount?: number;
  buyoutSumRub?: number;
  buyoutPercent?: number;
  cancelCount?: number;
  cancelSumRub?: number;
}

export interface FunnelHistoryRow {
  date: string;
  viewCount?: number;
  openCardCount?: number;
  addToCartCount?: number;
  orderCount?: number;
  orderSumRub?: number;
  buyoutCount?: number;
  buyoutSumRub?: number;
}

/**
 * POST /sales-funnel/products — снимок на период (с сравнением с прошлым).
 */
export async function getFunnelProducts(
  apiKey: string,
  body: {
    selectedPeriod: FunnelPeriod;
    pastPeriod?: FunnelPeriod;
    nmIds?: number[];
    brandNames?: string[];
    subjectIds?: number[];
    tagIds?: number[];
    skipDeletedNm?: boolean;
  },
): Promise<{ data: FunnelProductRow[] } | FunnelProductRow[]> {
  return wbPostJson(`${ANALYTICS_API}/api/analytics/v3/sales-funnel/products`, apiKey, body);
}

/**
 * POST /sales-funnel/products/history — по дням для конкретных nmIds.
 * aggregationLevel: 'day' (по умолчанию) или 'week'.
 */
export async function getFunnelProductsHistory(
  apiKey: string,
  body: {
    selectedPeriod: FunnelPeriod;
    nmIds: number[];
    aggregationLevel?: 'day' | 'week';
    skipDeletedNm?: boolean;
  },
): Promise<Array<{ nmId: number; history: FunnelHistoryRow[] }>> {
  return wbPostJson(
    `${ANALYTICS_API}/api/analytics/v3/sales-funnel/products/history`,
    apiKey,
    body,
  );
}

/**
 * POST /sales-funnel/grouped/history — категорийная аналитика по группе
 * (предмет / бренд / ярлык) с агрегацией по дням/неделям.
 *
 * Это новый эндпоинт для realtime — раньше группировки были доступны
 * только через CSV-выгрузку (GROUPED_HISTORY_REPORT, ZIP, до 2 минут на
 * генерацию). Для AI-помощника «бренд X растёт, бренд Y проседает»
 * быстрый JSON-ответ намного полезнее.
 *
 * Передавай ровно одну из brandNames / subjectIds / tagIds — иначе WB
 * фильтрует по их пересечению и группа может оказаться пустой.
 */
export async function getFunnelGroupedHistory(
  apiKey: string,
  body: {
    selectedPeriod: FunnelPeriod;
    brandNames?: string[];
    subjectIds?: number[];
    tagIds?: number[];
    aggregationLevel?: 'day' | 'week';
    skipDeletedNm?: boolean;
  },
): Promise<Array<{ groupName: string; history: FunnelHistoryRow[] }>> {
  return wbPostJson(
    `${ANALYTICS_API}/api/analytics/v3/sales-funnel/grouped/history`,
    apiKey,
    body,
  );
}
