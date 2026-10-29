/**
 * Zod schema for WB Stocks API response.
 * Source: GET statistics-api.wildberries.ru/api/v1/supplier/stocks
 */

import { z } from 'zod';

/** Single stock item from supplier/stocks */
export const stockItemSchema = z.object({
  lastChangeDate: z.string().optional().nullable(),
  warehouseName: z.string().optional().nullable(),
  supplierArticle: z.string().optional().nullable(),
  nmId: z.number(),
  barcode: z.string().optional().nullable(),
  quantity: z.number().default(0),
  inWayToClient: z.number().default(0),
  inWayFromClient: z.number().default(0),
  quantityFull: z.number().optional().default(0),
  category: z.string().optional().nullable(),
  subject: z.string().optional().nullable(),
  brand: z.string().optional().nullable(),
  techSize: z.string().optional().nullable(),
  Price: z.number().optional().nullable(),
  Discount: z.number().optional().nullable(),
  isSupply: z.boolean().optional().nullable(),
  isRealization: z.boolean().optional().nullable(),
  SCCode: z.string().optional().nullable(),
}).passthrough();

/** Full response — array of stock items */
export const stocksResponseSchema = z.array(stockItemSchema);

export const CRITICAL_STOCK_FIELDS = [
  'nmId',
  'quantity',
] as const;
