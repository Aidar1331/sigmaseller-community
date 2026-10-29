import { eq, and, or, ilike, inArray, isNull, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { wbCards, wbTagProducts, wbFunnelDailyProducts } from '../../db/schema.js';

/**
 * Escape ILIKE wildcards in user input
 */
export function escapeIlike(input: string): string {
  return input.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Parse comma-separated nmIds from query param
 */
export function parseNmIdsParam(raw?: string): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Split comma-separated multi-value filter param into individual trimmed non-empty strings.
 */
export function parseMultiParam(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * Intersect two arrays of numbers
 */
export function intersect(a: number[], b: number[]): number[] {
  if (!a.length || !b.length) return [];
  const set = new Set(a);
  return b.filter((x) => set.has(x));
}

/**
 * Parse YYYY-MM-DD string to Date
 */
export function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

/**
 * Format Date to YYYY-MM-DD
 */
export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Add days to a date
 */
export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

/**
 * Calculate number of days between two dates (inclusive)
 */
export function daysBetweenInclusive(a: string, b: string): number {
  const da = parseDate(a);
  const db = parseDate(b);
  const ms = db.getTime() - da.getTime();
  return Math.floor(ms / 86400000) + 1;
}

/**
 * Get ISO week number for a date
 */
export function getISOWeek(dateStr: string): string {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Get start of week (Monday) for a date
 */
export function weekStart(iso: string): string {
  const d = parseDate(iso);
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return fmtDate(d);
}

/**
 * Calculate percentage delta between two values
 */
export function pctDelta(cur: number, prev: number): number {
  if (prev === 0) return cur === 0 ? 0 : 100;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/**
 * Safe division with default value
 */
export function safeDiv(a: number, b: number, def = 0): number {
  return b === 0 ? def : a / b;
}

/**
 * Get today's date as YYYY-MM-DD
 */
export function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Filter options for Pulse queries
 */
export interface PulseFilterOptions {
  tagId?: number;
  nmIds?: string;
  vendorCode?: string;
  brandName?: string;
  subjectId?: number;
  subjectName?: string;
  shopId?: number;
}

/**
 * Build shop filter condition for multi-shop support
 * - If shopId is provided, filter by that shop
 * - If shopId is not provided, return all data (backward compatibility)
 * 
 * @param shopIdColumn - The shop_id column from the table
 * @param shopId - Optional shop ID from query params
 * @returns SQL condition or undefined (to include all shops)
 */
export function buildShopFilter(
  shopIdColumn: PgColumn,
  shopId: number | undefined
): SQL | undefined {
  if (shopId && Number.isFinite(shopId) && shopId > 0) {
    return eq(shopIdColumn, shopId);
  }
  // No shopId filter = show all data (backward compatibility)
  return undefined;
}

/**
 * Build array of conditions including optional shop filter
 */
export function withShopFilter(
  conditions: (SQL | undefined)[],
  shopIdColumn: PgColumn,
  shopId: number | undefined
): SQL[] {
  const shopFilter = buildShopFilter(shopIdColumn, shopId);
  const result = conditions.filter((c): c is SQL => c !== undefined);
  if (shopFilter) {
    result.push(shopFilter);
  }
  return result;
}

/**
 * Get filtered nmIds based on tag and card filters
 */
export async function getFilteredNmIds(
  workspaceId: number,
  options: PulseFilterOptions
): Promise<number[] | null> {
  let filteredNmIds: number[] | null = null;
  let tagNmIds: number[] | null = null;

  // Filter by tag
  if (options.tagId) {
    const links = await db
      .select({ nmId: wbTagProducts.nmId })
      .from(wbTagProducts)
      .where(
        and(
          eq(wbTagProducts.workspaceId, workspaceId),
          eq(wbTagProducts.tagId, options.tagId)
        )
      );
    tagNmIds = links.map((r) => Number(r.nmId));
  }

  // Filter by card attributes
  const vendorCodes = parseMultiParam(options.vendorCode);
  const brandNames = parseMultiParam(options.brandName);
  const subjectNames = parseMultiParam(options.subjectName);
  const hasCardFilter = vendorCodes.length || brandNames.length || options.subjectId || subjectNames.length;

  if (hasCardFilter) {
    const conditions = [eq(wbCards.workspaceId, workspaceId)];
    
    const orConditions: any[] = [];
    if (vendorCodes.length) {
      orConditions.push(...vendorCodes.map((vc) => ilike(wbCards.vendorCode, `%${escapeIlike(vc)}%`)));
    }
    if (brandNames.length) {
      orConditions.push(...brandNames.map((bn) => ilike(wbCards.brandName, `%${escapeIlike(bn)}%`)));
    }
    if (options.subjectId) {
      orConditions.push(eq(wbCards.subjectId, options.subjectId));
    }
    if (subjectNames.length) {
      orConditions.push(...subjectNames.map((sn) => ilike(wbCards.subjectName, `%${escapeIlike(sn)}%`)));
    }

    if (orConditions.length) {
      conditions.push(or(...orConditions)!);
    }

    const cards = await db
      .select({ nmId: wbCards.nmId })
      .from(wbCards)
      .where(and(...conditions));
    
    const cardNmIds = cards.map((c) => Number(c.nmId));
    filteredNmIds = tagNmIds ? intersect(tagNmIds, cardNmIds) : cardNmIds;
  } else if (tagNmIds) {
    filteredNmIds = tagNmIds;
  }

  // Explicit nmIds filter
  const explicitNmIds = parseNmIdsParam(options.nmIds);
  if (explicitNmIds.length) {
    filteredNmIds = filteredNmIds ? intersect(filteredNmIds, explicitNmIds) : explicitNmIds;
  }

  return filteredNmIds;
}

// ---------------------------------------------------------------------------
// Funnel API helper — fetches order KPIs directly from WB Analytics API
// (matches WB personal cabinet exactly)
// ---------------------------------------------------------------------------

import { marketplaceShops } from '../../db/schema.js';
import { safeDecrypt } from '../../lib/crypto.js';

export interface FunnelOrdersKpi {
  ordersCount: number;
  ordersRub: number;
  buyoutsCount: number;
  buyoutsRub: number;
  cancelsCount: number;
  cancelsRub: number;
}

async function getShopApiKeyDecrypted(workspaceId: number, shopId?: number): Promise<string | null> {
  const conds = [
    eq(marketplaceShops.workspaceId, workspaceId),
    eq(marketplaceShops.platform, 'wb'),
    eq(marketplaceShops.isActive, true),
  ];
  if (shopId) conds.push(eq(marketplaceShops.shopId, shopId));

  const [shop] = await db
    .select({ apiKey: marketplaceShops.apiKey })
    .from(marketplaceShops)
    .where(and(...conds))
    .limit(1);

  if (!shop?.apiKey) return null;
  return safeDecrypt(shop.apiKey);
}

/**
 * KPI заказов/выкупов из `wb_funnel_daily_products` (БД-агрегаты WB Analytics).
 *
 * Раньше эта функция дёргала live API `/sales-funnel/products` при каждом
 * запросе /pulse — это давало максимально свежие числа, но создавало:
 *   1) расхождение с /plan и /finance, которые читают из БД (оператор 2026-06-04);
 *   2) timeout/5xx → молчаливый fallback на Statistics-источник (orders_sales_daily),
 *      который у WB давно расходится с Analytics в среднем на 5–15%;
 *   3) лимит 1000 nmIds в одном POST → пропуски в крупных магазинах.
 *
 * Финансовые API — авторитетный источник: переключили /pulse на тот же
 * `wb_funnel_daily_products`, что /plan и /finance, чтобы числа в Pulse
 * совпадали с ЛК ВБ и между всеми страницами.
 *
 * Cron `funnel-daily:products` обновляет таблицу каждые ~15 минут.
 */
export async function fetchFunnelOrdersKpi(
  workspaceId: number,
  from: string,
  to: string,
  shopId?: number,
  nmIds?: number[] | null,
): Promise<FunnelOrdersKpi | null> {
  const conditions: any[] = [
    eq(wbFunnelDailyProducts.workspaceId, workspaceId),
    gte(wbFunnelDailyProducts.date, from),
    lte(wbFunnelDailyProducts.date, to),
  ];
  if (shopId) conditions.push(eq(wbFunnelDailyProducts.shopId, shopId));
  if (nmIds && nmIds.length > 0) conditions.push(inArray(wbFunnelDailyProducts.nmId, nmIds));

  const [agg] = await db
    .select({
      ordersCount: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      ordersRub:   sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.orderSum}), 0)`.mapWith(Number),
      buyoutsCount:sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
      buyoutsRub:  sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.buyoutSum}), 0)`.mapWith(Number),
      cancelsCount:sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.cancelCount}), 0)`.mapWith(Number),
      cancelsRub:  sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.cancelSum}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(...conditions));

  return {
    ordersCount: Number(agg?.ordersCount ?? 0),
    ordersRub:   Number(agg?.ordersRub ?? 0),
    buyoutsCount:Number(agg?.buyoutsCount ?? 0),
    buyoutsRub:  Number(agg?.buyoutsRub ?? 0),
    cancelsCount:Number(agg?.cancelsCount ?? 0),
    cancelsRub:  Number(agg?.cancelsRub ?? 0),
  };
}
