/**
 * Zod validation schemas for WB API response data.
 *
 * Used during sync to validate each row before storing to DB.
 * Catches API schema changes, corrupt data, and unrealistic values early.
 */

import { z } from 'zod';

/** Safe numeric — coerces nullish/NaN to 0 */
const safeNum = z.preprocess(
  (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0),
  z.number()
);

/** Positive integer or 0 */
const posInt = z.preprocess(
  (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  },
  z.number().int().min(0)
);

/** nmId — positive integer, WB product article */
const nmIdField = z.preprocess(
  (v) => Number(v) || 0,
  z.number().int().min(0)
);

/** Date string in ISO-like format */
const dateField = z.preprocess(
  (v) => (typeof v === 'string' ? v : ''),
  z.string().min(1)
);

// ── Finance report row (reportDetailByPeriod) ────────────────

export const wbFinanceRowSchema = z.object({
  rrd_id: z.number().optional(),
  rr_dt: z.string().optional(),
  sale_dt: z.string().optional(),
  date_from: z.string().optional(),

  nm_id: nmIdField,
  supplier_oper_name: z.string().default(''),
  doc_type_name: z.string().optional(),

  retail_price_withdisc_rub: safeNum,
  ppvz_for_pay: safeNum,
  ppvz_sales_commission: safeNum,
  ppvz_vw: safeNum,
  ppvz_reward: safeNum,
  ppvz_spp_prc: safeNum,

  delivery_rub: safeNum,
  return_amount: safeNum,
  acceptance: safeNum,
  storage_fee: safeNum,
  penalty: safeNum,
  deduction: safeNum,
  acquiring_fee: safeNum,
  additional_payment: safeNum,

  cashback_amount: safeNum.optional(),
  cashback_discount: safeNum.optional(),
  cashback_commission_change: safeNum.optional(),
  seller_promo_discount: safeNum.optional(),
  loyalty_discount: safeNum.optional(),
  wibes_wb_discount_percent: safeNum.optional(),
  installment_cofinancing_amount: safeNum.optional(),
  supplier_promo: safeNum.optional(),
  product_discount_for_report: safeNum.optional(),

  quantity: z.number().optional(),
  quantity_full: z.number().optional(),
}).passthrough();

// ── Orders row (/api/v1/supplier/orders) ─────────────────────

export const wbOrderRowSchema = z.object({
  nmId: nmIdField,
  date: dateField.optional(),
  lastChangeDate: z.string().optional(),

  priceWithDisc: safeNum,
  finishedPrice: safeNum.optional(),
  totalPrice: safeNum.optional(),
  discountPercent: safeNum.optional(),

  isCancel: z.boolean().optional(),

  warehouseName: z.string().optional(),
  regionName: z.string().optional(),
  oblast: z.string().optional(),
  countryName: z.string().optional(),

  srid: z.string().optional(),
  orderType: z.string().optional(),
}).passthrough();

// ── Sales row (/api/v1/supplier/sales) ───────────────────────

export const wbSaleRowSchema = z.object({
  nmId: nmIdField,
  date: dateField.optional(),
  lastChangeDate: z.string().optional(),

  priceWithDisc: safeNum,
  forPay: safeNum,
  finishedPrice: safeNum.optional(),

  warehouseName: z.string().optional(),
  regionName: z.string().optional(),

  saleID: z.string().optional(),
  srid: z.string().optional(),
}).passthrough();

// ── Adv stats row (/adv/v2/fullstats) ────────────────────────

export const wbAdvDaySchema = z.object({
  date: z.string(),
  sum: safeNum,
  views: posInt,
  clicks: posInt,
  atbs: posInt,
  orders: posInt,
  sum_price: safeNum.optional(),
}).passthrough();

export const wbAdvStatsSchema = z.object({
  advertId: z.number().optional(),
  advertType: z.number().optional(),
  days: z.array(wbAdvDaySchema).optional(),
}).passthrough();

// ── Funnel row (/api/analytics/v3/sales-funnel/products) ─────

export const wbFunnelProductSchema = z.object({
  nmID: nmIdField.optional(),
  nmId: nmIdField.optional(),
  vendorCode: z.string().optional(),

  statistic: z.object({
    selected: z.object({
      viewCount: posInt.optional(),
      openCount: posInt.optional(),
      openCardCount: posInt.optional(),
      addToCartCount: posInt.optional(),
      cartCount: posInt.optional(),
      addToWishlist: posInt.optional(),
      addToWishlistCount: posInt.optional(),
      orderCount: posInt.optional(),
      orderSumRub: safeNum.optional(),
      buyoutCount: posInt.optional(),
      buyoutSumRub: safeNum.optional(),
      cancelCount: posInt.optional(),
      cancelSumRub: safeNum.optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

// ── Stocks row (/api/v5/supplier/stocks) ─────────────────────

export const wbStockRowSchema = z.object({
  nmId: nmIdField.optional(),
  warehouseName: z.string().optional(),
  warehouseID: z.number().optional(),
  quantity: posInt,
  inWayToClient: posInt.optional(),
  inWayFromClient: posInt.optional(),
}).passthrough();

// ── Validation helpers ───────────────────────────────────────

export interface ValidationStats {
  total: number;
  valid: number;
  invalid: number;
  errors: Array<{ index: number; error: string }>;
}

/**
 * Validate an array of WB API rows against a schema.
 * Returns stats and logs first N errors.
 *
 * @param rows - Array of raw API rows
 * @param schema - Zod schema to validate against
 * @param maxErrors - Maximum errors to collect (default 10)
 * @returns Validation statistics
 */
export function validateRows<T>(
  rows: unknown[],
  schema: z.ZodType<T>,
  maxErrors = 10
): ValidationStats {
  const stats: ValidationStats = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    errors: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const result = schema.safeParse(rows[i]);
    if (result.success) {
      stats.valid++;
    } else {
      stats.invalid++;
      if (stats.errors.length < maxErrors) {
        stats.errors.push({
          index: i,
          error: result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
        });
      }
    }
  }

  return stats;
}

/**
 * Validate a single finance row for logical invariants.
 * Returns list of issues found.
 */
export function checkFinanceRowInvariants(row: z.infer<typeof wbFinanceRowSchema>): string[] {
  const issues: string[] = [];

  // payout should not exceed retail (fundamental invariant)
  if (row.retail_price_withdisc_rub > 0 && row.ppvz_for_pay > row.retail_price_withdisc_rub * 1.05) {
    issues.push(`payout (${row.ppvz_for_pay}) > retail (${row.retail_price_withdisc_rub}) — нарушение инварианта`);
  }

  // Commission should be between 0% and 100% of retail
  if (row.retail_price_withdisc_rub > 0) {
    const commissionPct = (row.ppvz_sales_commission / row.retail_price_withdisc_rub) * 100;
    if (commissionPct < 0 || commissionPct > 100) {
      issues.push(`commission ${commissionPct.toFixed(1)}% вне [0%, 100%]`);
    }
  }

  // SPP % should be 0-100
  if (row.ppvz_spp_prc < 0 || row.ppvz_spp_prc > 100) {
    issues.push(`SPP ${row.ppvz_spp_prc}% вне [0%, 100%]`);
  }

  return issues;
}
