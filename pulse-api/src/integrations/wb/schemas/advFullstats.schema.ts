/**
 * Zod schema for WB Advertising fullstats API response.
 * Source: POST advert-api.wildberries.ru/adv/v2/fullstats
 */

import { z } from 'zod';

/** Single nm (product) stats within a campaign day */
export const advNmStatsSchema = z.object({
  nmId: z.number(),
  name: z.string().optional().nullable(),
  views: z.number().default(0),
  clicks: z.number().default(0),
  sum: z.number().default(0),          // spend in rubles
  atbs: z.number().default(0),         // add to basket
  orders: z.number().default(0),
  shks: z.number().default(0),
  sum_price: z.number().default(0),    // revenue attributed to ad
}).passthrough();

/** Daily stats for a campaign */
export const advDayStatsSchema = z.object({
  date: z.string(),
  views: z.number().default(0),
  clicks: z.number().default(0),
  sum: z.number().default(0),
  atbs: z.number().default(0),
  orders: z.number().default(0),
  shks: z.number().default(0),
  sum_price: z.number().default(0),
  nm: z.array(advNmStatsSchema).optional().default([]),
  apps: z.array(z.any()).optional().default([]),
}).passthrough();

/** Campaign-level fullstats */
export const advCampaignFullstatsSchema = z.object({
  advertId: z.number(),
  days: z.array(advDayStatsSchema).optional().default([]),
}).passthrough();

/** Full response — array of campaign stats */
export const advFullstatsResponseSchema = z.array(advCampaignFullstatsSchema);

export const CRITICAL_ADV_FIELDS = [
  'views',
  'clicks',
  'sum',
  'orders',
] as const;
