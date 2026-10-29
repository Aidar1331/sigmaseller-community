/**
 * Zod schema for WB Sales Funnel API responses.
 * Source: POST seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products
 */

import { z } from 'zod';

/** Single product in sales funnel response */
export const funnelProductSchema = z.object({
  nmID: z.number(),
  vendorCode: z.string().optional().nullable(),
  brandName: z.string().optional().nullable(),

  // Funnel metrics (critical)
  openCardCount: z.number().default(0),
  addToCartCount: z.number().default(0),
  ordersCount: z.number().default(0),
  ordersSumRub: z.number().default(0),
  buyoutsCount: z.number().default(0),
  buyoutsSumRub: z.number().default(0),
  cancelCount: z.number().default(0),
  cancelSumRub: z.number().default(0),

  // Additional
  addToCartConversion: z.number().optional().nullable(),
  cartToOrderConversion: z.number().optional().nullable(),
}).passthrough();

/** History item (daily/weekly breakdown) */
export const funnelHistoryItemSchema = z.object({
  dt: z.string(),
  openCardCount: z.number().default(0),
  addToCartCount: z.number().default(0),
  ordersCount: z.number().default(0),
  ordersSumRub: z.number().default(0),
  buyoutsCount: z.number().default(0),
  buyoutsSumRub: z.number().default(0),
  cancelCount: z.number().default(0),
  cancelSumRub: z.number().default(0),
}).passthrough();

/** Response for sales-funnel/products */
export const funnelProductsResponseSchema = z.object({
  data: z.object({
    products: z.array(funnelProductSchema).optional().default([]),
    currency: z.string().optional(),
  }),
}).passthrough();

/** Response for sales-funnel/products/history */
export const funnelHistoryResponseSchema = z.object({
  data: z.object({
    product: funnelProductSchema.optional(),
    history: z.array(funnelHistoryItemSchema).optional().default([]),
    currency: z.string().optional(),
  }).optional(),
}).passthrough();

export const CRITICAL_FUNNEL_FIELDS = [
  'openCardCount',
  'addToCartCount',
  'ordersCount',
  'buyoutsCount',
] as const;
