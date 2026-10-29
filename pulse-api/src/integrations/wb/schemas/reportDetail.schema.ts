/**
 * Zod schema for WB API reportDetailByPeriod response.
 * Source: GET statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod
 *
 * Uses .passthrough() to allow new fields from WB without breaking validation.
 * Critical monetary fields are validated as numbers.
 */

import { z } from 'zod';

/** Single row from reportDetailByPeriod */
export const reportDetailRowSchema = z.object({
  // Identifiers
  realizationreport_id: z.number().optional(),
  rrd_id: z.number(),
  nm_id: z.number(),
  barcode: z.string().optional().nullable(),
  sa_name: z.string().optional().nullable(),
  ts_name: z.string().optional().nullable(),
  brand_name: z.string().optional().nullable(),
  subject_name: z.string().optional().nullable(),

  // Dates
  rr_dt: z.string().optional().nullable(),
  sale_dt: z.string().optional().nullable(),
  order_dt: z.string().optional().nullable(),
  date_from: z.string().optional().nullable(),
  date_to: z.string().optional().nullable(),

  // Operation
  supplier_oper_name: z.string().optional().nullable(),
  doc_type_name: z.string().optional().nullable(),
  quantity: z.number().optional().nullable(),

  // ---- CRITICAL MONETARY FIELDS (must be number) ----
  retail_price: z.number().optional().nullable(),
  retail_amount: z.number().optional().nullable(),
  retail_price_withdisc_rub: z.number().optional().nullable(),

  // Payout (самое важное поле — к перечислению продавцу)
  ppvz_for_pay: z.number().optional().nullable(),

  // Commission
  ppvz_sales_commission: z.number().optional().nullable(),
  ppvz_kvw_prc: z.number().optional().nullable(),
  ppvz_kvw_prc_base: z.number().optional().nullable(),
  commission_percent: z.number().optional().nullable(),

  // Logistics
  delivery_rub: z.number().optional().nullable(),
  delivery_amount: z.number().optional().nullable(),
  return_amount: z.number().optional().nullable(),

  // Fees
  storage_fee: z.number().optional().nullable(),
  penalty: z.number().optional().nullable(),
  additional_payment: z.number().optional().nullable(),
  acceptance: z.number().optional().nullable(),
  deduction: z.number().optional().nullable(),

  // Acquiring
  acquiring_fee: z.number().optional().nullable(),
  acquiring_percent: z.number().optional().nullable(),
  payment_processing: z.number().optional().nullable(),

  // Discounts
  sale_percent: z.number().optional().nullable(),
  product_discount_for_report: z.number().optional().nullable(),
  ppvz_spp_prc: z.number().optional().nullable(),
  supplier_promo: z.number().optional().nullable(),
  sup_rating_prc_up: z.number().optional().nullable(),
  is_kgvp_v2: z.number().optional().nullable(),

  // WB API v5 new fields
  cashback_amount: z.number().optional().nullable(),
  cashback_discount: z.number().optional().nullable(),
  cashback_commission_change: z.number().optional().nullable(),
  seller_promo_discount: z.number().optional().nullable(),
  loyalty_discount: z.number().optional().nullable(),
  wibes_wb_discount_percent: z.number().optional().nullable(),
  installment_cofinancing_amount: z.number().optional().nullable(),

  // Other
  rebill_logistic_cost: z.number().optional().nullable(),
  rebill_logistic_org: z.string().optional().nullable(),
  office_name: z.string().optional().nullable(),
  ppvz_office_name: z.string().optional().nullable(),
  site_country: z.string().optional().nullable(),
  srid: z.string().optional().nullable(),
  sticker_id: z.string().optional().nullable(),
  shk_id: z.number().optional().nullable(),
  gi_id: z.number().optional().nullable(),
}).passthrough(); // Allow new fields without breaking

/** Full API response (array of rows) */
export const reportDetailResponseSchema = z.array(reportDetailRowSchema);

/** Critical fields that should never be all-zero for a non-empty report */
export const CRITICAL_FINANCE_FIELDS = [
  'ppvz_for_pay',
  'delivery_rub',
  'retail_price_withdisc_rub',
  'ppvz_sales_commission',
] as const;
