/**
 * WB API per-endpoint rate limits (token-bucket keys).
 *
 * Source of truth: wb-api/limits.md (snapshot 2026-05-13 from WB docs).
 * These are the limits WB enforces per Base API token after 2026-03-30.
 * Persistent/Service tokens have higher limits but the same per-endpoint shape.
 *
 * Per-domain RPM in wbRateLimiter.ts is a coarse first-line defence;
 * the entries below are the precise per-endpoint quotas. The acquire()
 * path checks the per-endpoint bucket first, then the per-domain bucket.
 *
 * Bucket key includes workspaceId so we never share quota across tenants
 * (each workspace has its own WB token).
 */

export interface EndpointLimit {
  /** Max requests in the window. */
  count: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Human label for logs. */
  label: string;
}

/** Map of `<domain>:<path-template>` → limit. */
export const ENDPOINT_LIMITS: Record<string, EndpointLimit> = {
  // ====== Общее (common-api) ======
  'common-api.wildberries.ru:/api/communications/v2/news': { count: 1, windowSec: 3600, label: 'news/1h' },
  'common-api.wildberries.ru:/api/v1/seller-info': { count: 1, windowSec: 86400, label: 'seller-info/24h' },

  // ====== Тарифы (common-api) ======
  'common-api.wildberries.ru:/api/v1/tariffs/box': { count: 1, windowSec: 3600, label: 'tariffs-box/1h' },
  'common-api.wildberries.ru:/api/v1/tariffs/pallet': { count: 1, windowSec: 3600, label: 'tariffs-pallet/1h' },
  'common-api.wildberries.ru:/api/v1/tariffs/commission': { count: 5, windowSec: 3600, label: 'tariffs-commission/1h' },
  'common-api.wildberries.ru:/api/v1/tariffs/return': { count: 1, windowSec: 3600, label: 'tariffs-return/1h' },
  'common-api.wildberries.ru:/api/tariffs/v1/acceptance/coefficients': { count: 1, windowSec: 3600, label: 'tariffs-acceptance/1h' },

  // ====== Статистика (statistics-api) — самые жёсткие ======
  'statistics-api.wildberries.ru:/api/v1/supplier/incomes': { count: 1, windowSec: 3600, label: 'sup-incomes/1h' },
  'statistics-api.wildberries.ru:/api/v1/supplier/orders': { count: 1, windowSec: 10800, label: 'sup-orders/3h' },
  'statistics-api.wildberries.ru:/api/v1/supplier/sales': { count: 1, windowSec: 7200, label: 'sup-sales/2h' },
  'statistics-api.wildberries.ru:/api/v1/supplier/stocks': { count: 1, windowSec: 10800, label: 'sup-stocks/3h' },
  'statistics-api.wildberries.ru:/api/v5/supplier/reportDetailByPeriod': { count: 2, windowSec: 86400, label: 'sup-realisation/24h' },

  // ====== Финансы / документы ======
  'finance-api.wildberries.ru:/api/v1/account/balance': { count: 1, windowSec: 86400, label: 'fin-balance/24h' },
  'documents-api.wildberries.ru:/api/v1/documents/categories': { count: 1, windowSec: 86400, label: 'docs-categories/24h' },
  'documents-api.wildberries.ru:/api/v1/documents/list': { count: 1, windowSec: 86400, label: 'docs-list/24h' },
  'documents-api.wildberries.ru:/api/v1/documents/download': { count: 1, windowSec: 86400, label: 'docs-download/24h' },
  'documents-api.wildberries.ru:/api/v1/documents/download/all': { count: 1, windowSec: 86400, label: 'docs-download-all/24h' },

  // ====== Поставки (supplies-api) ======
  'supplies-api.wildberries.ru:/api/v1/supplies/:id': { count: 2, windowSec: 3600, label: 'supplies-by-id/1h' },
  'supplies-api.wildberries.ru:/api/v1/supplies/:id/goods': { count: 2, windowSec: 3600, label: 'supplies-goods/1h' },
  'supplies-api.wildberries.ru:/api/v1/supplies/:id/package': { count: 2, windowSec: 3600, label: 'supplies-package/1h' },
  'supplies-api.wildberries.ru:/api/v1/supplies': { count: 2, windowSec: 3600, label: 'supplies-list-or-create/1h' },
  'supplies-api.wildberries.ru:/api/v1/acceptance/options': { count: 2, windowSec: 3600, label: 'supplies-accept-opts/1h' },
  'supplies-api.wildberries.ru:/api/v1/transit-tariffs': { count: 1, windowSec: 43200, label: 'supplies-transit/12h' },
  'supplies-api.wildberries.ru:/api/v1/warehouses': { count: 1, windowSec: 43200, label: 'supplies-warehouses/12h' },

  // ====== Реклама (advert-api) — самые опасные при cron ======
  'advert-api.wildberries.ru:/adv/v1/balance': { count: 2, windowSec: 3600, label: 'adv-balance/1h' },
  'advert-api.wildberries.ru:/adv/v1/upd': { count: 1, windowSec: 3600, label: 'adv-history-upd/1h' },
  'advert-api.wildberries.ru:/adv/v1/payments': { count: 1, windowSec: 3600, label: 'adv-payments/1h' },
  'advert-api.wildberries.ru:/adv/v1/promotion/count': { count: 4, windowSec: 3600, label: 'adv-promo-count/1h' },
  'advert-api.wildberries.ru:/adv/v1/budget': { count: 4, windowSec: 3600, label: 'adv-budget/1h' },
  'advert-api.wildberries.ru:/adv/v1/count': { count: 1, windowSec: 3600, label: 'adv-media-count/1h' },
  'advert-api.wildberries.ru:/adv/v1/adverts': { count: 1, windowSec: 3600, label: 'adv-media-list/1h' },
  'advert-api.wildberries.ru:/adv/v1/advert': { count: 5, windowSec: 3600, label: 'adv-media-detail/1h' },
  'advert-api.wildberries.ru:/adv/v3/fullstats': { count: 1, windowSec: 3600, label: 'adv-fullstats/1h' },
  'advert-api.wildberries.ru:/adv/v1/stats': { count: 1, windowSec: 3600, label: 'adv-media-stats/1h' },
  'advert-api.wildberries.ru:/api/advert/v2/adverts': { count: 1, windowSec: 3600, label: 'adv-camp-info/1h' },
  'advert-api.wildberries.ru:/api/v1/calendar/promotions': { count: 1, windowSec: 3600, label: 'adv-calendar/1h' },

  // ====== Контент / медиа (content-api) ======
  // /content/v3/media/save — WB лимит 50/час на токен. Берём подушку 40/час
  // чтобы AB-photo cron + ручные обновления не вылетали на 429 и не накапливались
  // тейловыми ретраями. Это ключевая защита от bans при включённой WB-синхронизации.
  'content-api.wildberries.ru:/content/v3/media/save': { count: 40, windowSec: 3600, label: 'media-save/1h' },

  // ====== Аналитика (seller-analytics-api) — комбинация мин/час ======
  // Most are 3/min — we encode as 3 per 60s. Heavy reports are 1/h or 24h.
  // POST creates the report, GET polls status — WB tracks them in separate 1/h buckets, so we model them separately.
  // Sharing one key broke stocks-history: POST consumed the slot, GET was blocked for 1h, report sat undownloaded forever.
  'seller-analytics-api.wildberries.ru:POST /api/v2/nm-report/downloads': { count: 1, windowSec: 3600, label: 'csv-report-create-post/1h' },
  'seller-analytics-api.wildberries.ru:GET /api/v2/nm-report/downloads': { count: 1, windowSec: 3600, label: 'csv-report-poll-get/1h' },
  'seller-analytics-api.wildberries.ru:POST /api/v2/nm-report/downloads/retry': { count: 1, windowSec: 3600, label: 'csv-report-retry/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/paid_storage': { count: 1, windowSec: 3600, label: 'paid-storage-create/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/acceptance_report': { count: 1, windowSec: 10800, label: 'acceptance-report-create/3h' },
  'seller-analytics-api.wildberries.ru:/api/v1/warehouse_remains': { count: 4, windowSec: 3600, label: 'warehouse-remains-create/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/excise-report': { count: 2, windowSec: 86400, label: 'excise-report/24h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/antifraud-details': { count: 1, windowSec: 3600, label: 'antifraud/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/banned-products/blocked': { count: 1, windowSec: 3600, label: 'banned-blocked/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/banned-products/shadowed': { count: 1, windowSec: 3600, label: 'banned-shadowed/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/brand-share': { count: 1, windowSec: 3600, label: 'brand-share/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/goods-labeling': { count: 1, windowSec: 3600, label: 'goods-labeling/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/goods-return': { count: 2, windowSec: 3600, label: 'goods-return/1h' },
  'seller-analytics-api.wildberries.ru:/api/v1/analytics/region-sale': { count: 1, windowSec: 3600, label: 'region-sale/1h' },
};

/**
 * Normalize a fully-qualified URL into a `<host>:<path-template>` key for
 * ENDPOINT_LIMITS lookup. Replaces numeric path segments with `:id` so that
 * routes with IDs still match (`/supplies/12345/goods` → `/supplies/:id/goods`).
 */
export function urlToEndpointKey(url: string): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
    return `${u.host}:${path}`;
  } catch {
    return null;
  }
}

/**
 * When the request is signed with X-Client-Secret (WB Partner API), the WB
 * server-side limits become Service-tier ("как до 30 марта 2026"). Our hard-
 * coded Basic-tier numbers above are then far too tight and produce spurious
 * `WbQuotaExceededError` from our own Redis bucket while WB would gladly
 * accept the request. We multiply the Basic count by this factor when the
 * env flag is on so backfills don't choke on our own throttle.
 *
 * 30x is conservative — WB never publishes exact Service numbers, but
 * historically the gap was 10x-100x on the heaviest endpoints. 30x for a
 * 1/3h endpoint = ~10/hour; for 2/24h = ~2.5/hour; for 1/1h = 30/hour.
 * All well below what WB rejected for any seller pre-30-March-2026.
 */
const EXTENDED_LIMIT_FACTOR = 30;

function applyExtendedFactor(limit: EndpointLimit): EndpointLimit {
  if (process.env.WB_PARTNER_SECRET_INJECT !== '1') return limit;
  return { count: limit.count * EXTENDED_LIMIT_FACTOR, windowSec: limit.windowSec, label: limit.label };
}

/**
 * Lookup endpoint-specific limit. When `method` is given, tries the
 * method-scoped key first (`host:METHOD /path`) — needed for WB endpoints
 * where POST and GET have independent 1/h buckets (e.g. nm-report/downloads).
 * Falls back to the method-agnostic key, then to null (per-domain only).
 */
export function findEndpointLimit(url: string, method?: string): EndpointLimit | null {
  const key = urlToEndpointKey(url);
  if (!key) return null;
  if (method) {
    const m = method.toUpperCase();
    const [host, path] = key.split(':', 2);
    const methodScoped = `${host}:${m} ${path}`;
    if (ENDPOINT_LIMITS[methodScoped]) return applyExtendedFactor(ENDPOINT_LIMITS[methodScoped]);
  }
  const hit = ENDPOINT_LIMITS[key];
  return hit ? applyExtendedFactor(hit) : null;
}
