/**
 * WB Search Report API (поисковые запросы и воронка)
 * Host: https://seller-analytics-api.wildberries.ru
 *
 * Rate limit: 3 req/min, 3 burst per 20 sec
 */

import { wbPostJson } from './wbClient.js';

const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface SearchReportItem {
  nmId: number;
  vendorCode: string;
  brandName: string;
  productName: string;
  avgPosition: number;
  medianPosition: number;
  viewsCount: number;
  clicksCount: number;
  ctr: number;
  addToCartCount: number;
  addToCartConversion: number;
  ordersCount: number;
  ordersConversion: number;
}

export interface ProductSearchText {
  text: string;
  nmId: number;
  frequency: number;
  avgPosition: number;
  openCardCount: number;
  addToCartCount: number;
  ordersCount: number;
}

export interface SalesFunnelProduct {
  nmId: number;
  vendorCode: string;
  brandName: string;
  productName: string;
  category: string;
  views: number;
  clicks: number;
  ctr: number;
  addToCart: number;
  addToCartConversion: number;
  orders: number;
  ordersConversion: number;
  buyoutPercent: number;
  cancelPercent: number;
}

export interface SalesFunnelHistoryItem {
  date: string;
  views: number;
  clicks: number;
  ctr: number;
  addToCart: number;
  orders: number;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get main search report
 * POST /api/v2/search-report/report
 *
 * Rate limit: 3 req/min
 */
export async function getSearchReport(
  apiKey: string,
  params: {
    dateFrom: string;  // YYYY-MM-DD
    dateTo: string;
    nmIds?: number[];
    brandNames?: string[];
    objectIds?: number[];
    limit?: number;
    offset?: number;
    positionCluster?: 'all' | 'main' | 'search' | 'recommendation';
    // NB: WB многократно ребрендил orderBy.field. Сейчас (2026-05-26) валидно
    // только `avgPosition`. Остальные (openCardCount, ordersCount,
    // addToCartCount, buyoutsCount, buyoutsPercent) дают 400 «invalid value».
    orderByField?: 'avgPosition';
    orderMode?: 'asc' | 'desc';
  }
): Promise<{ data: SearchReportItem[] }> {
  // WB Analytics v2 (April 2026) — API changed: `dateFrom/dateTo` replaced by
  // `currentPeriod: { start, end }`, plus newly required `positionCluster`
  // and `orderBy` fields. Previous call signature returned a 400 with
  // "currentPeriod (field required), positionCluster (field required),
  // orderBy (field required)".
  //
  // 2026-05-24: default `orderBy.field` switched from `openCardCount`
  // (rejected by WB with 400 "invalid value") to `ordersCount` — most
  // useful sort for sellers (top-selling products first).
  return wbPostJson<{ data: SearchReportItem[] }>(
    `${ANALYTICS_API}/api/v2/search-report/report`,
    apiKey,
    {
      currentPeriod: { start: params.dateFrom, end: params.dateTo },
      positionCluster: params.positionCluster ?? 'all',
      orderBy: {
        field: params.orderByField ?? 'avgPosition',
        mode: params.orderMode ?? 'desc',
      },
      nmIds: params.nmIds,
      brandNames: params.brandNames,
      objectIds: params.objectIds,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    }
  );
}

/**
 * Get search queries by product
 * POST /api/v2/search-report/product/search-texts
 *
 * WB Analytics v2 (2026): body schema changed — `currentPeriod/pastPeriod`
 * вместо `dateFrom/dateTo`, `nmIds[]` вместо `nmId`, обязательны `topOrderBy`,
 * `includeSubstitutedSKUs`, `includeSearchTexts`, `orderBy`, `limit`.
 * Response: `data.items[]` с вложенными объектами ({current, dynamics}) —
 * уплощаем в старую плоскую форму `ProductSearchText` для обратной совместимости.
 * @param limit - max 30 (100 для "Джем")
 */
export async function getProductSearchTexts(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    nmIds: number[];
    limit?: number;
    topOrderBy?: 'openCard' | 'addToCart' | 'openToCart' | 'orders' | 'frequency';
  }
): Promise<{ data: ProductSearchText[] }> {
  // pastPeriod — опционально, WB сравнивает dynamics. Берём тот же день за
  // -7 дней, чтобы получить осмысленные dynamics без большого окна.
  const dFrom = new Date(params.dateFrom);
  const dTo = new Date(params.dateTo);
  const pastStart = new Date(dFrom.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const pastEnd = new Date(dTo.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);

  const raw = await wbPostJson<{ data: { items: Array<Record<string, unknown>> } }>(
    `${ANALYTICS_API}/api/v2/search-report/product/search-texts`,
    apiKey,
    {
      currentPeriod: { start: params.dateFrom, end: params.dateTo },
      pastPeriod: { start: pastStart, end: pastEnd },
      nmIds: params.nmIds,
      topOrderBy: params.topOrderBy ?? 'openCard',
      includeSubstitutedSKUs: true,
      includeSearchTexts: true,
      orderBy: { field: 'avgPosition', mode: 'asc' },
      limit: params.limit ?? 30,
    }
  );

  const items = Array.isArray(raw?.data?.items) ? raw.data.items : [];
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const nested = (v: unknown): number =>
    v && typeof v === 'object' && 'current' in (v as Record<string, unknown>)
      ? num((v as { current: unknown }).current)
      : num(v);

  const data: ProductSearchText[] = items.map((it) => ({
    text: typeof it.text === 'string' ? it.text : '',
    nmId: num(it.nmId),
    frequency: nested(it.frequency),
    avgPosition: nested(it.avgPosition),
    openCardCount: nested(it.openCard),
    addToCartCount: nested(it.addToCart),
    ordersCount: nested(it.orders),
  }));
  return { data };
}

/**
 * Sales funnel by products
 * POST /api/analytics/v3/sales-funnel/products
 *
 * Статистика карточек товаров за период
 */
export async function getSalesFunnelProducts(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    nmIds?: number[];
    brandNames?: string[];
    objectIds?: number[];
    limit?: number;
    offset?: number;
    orderBy?: {
      field: 'views' | 'clicks' | 'ctr' | 'addToCart' | 'orders' | 'buyoutPercent';
      mode: 'asc' | 'desc';
    };
  }
): Promise<{ data: SalesFunnelProduct[] }> {
  return wbPostJson<{ data: SalesFunnelProduct[] }>(
    `${ANALYTICS_API}/api/analytics/v3/sales-funnel/products`,
    apiKey,
    {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      nmIds: params.nmIds,
      brandNames: params.brandNames,
      objectIds: params.objectIds,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
      orderBy: params.orderBy,
    }
  );
}

/**
 * Sales funnel history by days/weeks
 * POST /api/analytics/v3/sales-funnel/products/history
 *
 * Max 1 week of data
 */
export async function getSalesFunnelHistory(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    nmIds: number[];
    period?: 'day' | 'week';
  }
): Promise<{ data: SalesFunnelHistoryItem[] }> {
  return wbPostJson<{ data: SalesFunnelHistoryItem[] }>(
    `${ANALYTICS_API}/api/analytics/v3/sales-funnel/products/history`,
    apiKey,
    {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      nmIds: params.nmIds,
      period: params.period ?? 'day',
    }
  );
}

// ============================================================================
// Search Report Table API (groups & details)
// ============================================================================

export interface SearchReportGroup {
  objectId: number;
  objectName: string;
  brandName?: string;
  viewsCount: number;
  clicksCount: number;
  ctr: number;
  addToCartCount: number;
  ordersCount: number;
  avgPosition: number;
}

export interface SearchReportDetail {
  nmId: number;
  vendorCode: string;
  productName: string;
  brandName: string;
  objectId: number;
  objectName: string;
  avgPosition: number;
  medianPosition: number;
  viewsCount: number;
  clicksCount: number;
  ctr: number;
  addToCartCount: number;
  ordersCount: number;
}

/**
 * Get search report grouped by subjects/brands
 * POST /api/v2/search-report/table/groups
 *
 * Группировка статистики по предметам или брендам
 */
export async function getSearchReportGroups(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    groupBy: 'object' | 'brand';
    brandNames?: string[];
    objectIds?: number[];
    limit?: number;
    offset?: number;
    orderBy?: {
      field: 'viewsCount' | 'clicksCount' | 'ctr' | 'ordersCount' | 'avgPosition';
      mode: 'asc' | 'desc';
    };
  }
): Promise<{ data: SearchReportGroup[]; total: number }> {
  return wbPostJson<{ data: SearchReportGroup[]; total: number }>(
    `${ANALYTICS_API}/api/v2/search-report/table/groups`,
    apiKey,
    {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      groupBy: params.groupBy,
      brandNames: params.brandNames,
      objectIds: params.objectIds,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
      orderBy: params.orderBy,
    }
  );
}

/**
 * Get search report details by products
 * POST /api/v2/search-report/table/details
 *
 * Детальная статистика по товарам внутри группы
 */
export async function getSearchReportDetails(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    objectId?: number;
    brandName?: string;
    nmIds?: number[];
    limit?: number;
    offset?: number;
    orderBy?: {
      field: 'viewsCount' | 'clicksCount' | 'ctr' | 'ordersCount' | 'avgPosition';
      mode: 'asc' | 'desc';
    };
  }
): Promise<{ data: SearchReportDetail[]; total: number }> {
  return wbPostJson<{ data: SearchReportDetail[]; total: number }>(
    `${ANALYTICS_API}/api/v2/search-report/table/details`,
    apiKey,
    {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      objectId: params.objectId,
      brandName: params.brandName,
      nmIds: params.nmIds,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
      orderBy: params.orderBy,
    }
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate conversion rates
 */
export function calculateConversions(data: SalesFunnelProduct): {
  viewToClick: number;
  clickToCart: number;
  cartToOrder: number;
  viewToOrder: number;
} {
  return {
    viewToClick: data.views > 0 ? (data.clicks / data.views) * 100 : 0,
    clickToCart: data.clicks > 0 ? (data.addToCart / data.clicks) * 100 : 0,
    cartToOrder: data.addToCart > 0 ? (data.orders / data.addToCart) * 100 : 0,
    viewToOrder: data.views > 0 ? (data.orders / data.views) * 100 : 0,
  };
}

// ============================================================================
// WB Club Analytics
// ============================================================================

export interface WbClubStats {
  totalOrders: number;
  wbClubOrders: number;
  wbClubPercent: number;
  totalRevenue: number;
  wbClubRevenue: number;
  wbClubRevenuePercent: number;
  avgOrderValue: number;
  wbClubAvgOrderValue: number;
}

export interface WbClubProduct {
  nmId: number;
  vendorCode: string;
  brandName: string;
  productName: string;
  orders: number;
  wbClubOrders: number;
  wbClubPercent: number;
  revenue: number;
  wbClubRevenue: number;
}

/**
 * Get WB Club sales funnel analytics
 * POST /api/analytics/v3/sales-funnel/wb-club
 */
export async function getWbClubAnalytics(
  apiKey: string,
  params: {
    dateFrom: string;
    dateTo: string;
    nmIds?: number[];
    brandNames?: string[];
    objectIds?: number[];
    limit?: number;
    offset?: number;
  }
): Promise<{ data: WbClubProduct[]; totals: WbClubStats }> {
  const response = await wbPostJson<{ data: WbClubProduct[] }>(
    `${ANALYTICS_API}/api/analytics/v3/sales-funnel/wb-club`,
    apiKey,
    {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      nmIds: params.nmIds,
      brandNames: params.brandNames,
      objectIds: params.objectIds,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    }
  );

  // Calculate totals
  const data = response.data ?? [];
  const totals: WbClubStats = {
    totalOrders: data.reduce((s, p) => s + p.orders, 0),
    wbClubOrders: data.reduce((s, p) => s + p.wbClubOrders, 0),
    wbClubPercent: 0,
    totalRevenue: data.reduce((s, p) => s + p.revenue, 0),
    wbClubRevenue: data.reduce((s, p) => s + p.wbClubRevenue, 0),
    wbClubRevenuePercent: 0,
    avgOrderValue: 0,
    wbClubAvgOrderValue: 0,
  };

  if (totals.totalOrders > 0) {
    totals.wbClubPercent = (totals.wbClubOrders / totals.totalOrders) * 100;
    totals.avgOrderValue = totals.totalRevenue / totals.totalOrders;
  }
  if (totals.wbClubOrders > 0) {
    totals.wbClubAvgOrderValue = totals.wbClubRevenue / totals.wbClubOrders;
  }
  if (totals.totalRevenue > 0) {
    totals.wbClubRevenuePercent = (totals.wbClubRevenue / totals.totalRevenue) * 100;
  }

  return { data, totals };
}
