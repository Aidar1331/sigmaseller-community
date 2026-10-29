/**
 * Zod schema for WB Content API cards response.
 * Source: POST content-api.wildberries.ru/content/v2/get/cards/list
 */

import { z } from 'zod';

/** Photo object */
const photoSchema = z.object({
  big: z.string().optional(),
  c246x328: z.string().optional(),
  c516x688: z.string().optional(),
  square: z.string().optional(),
  tm: z.string().optional(),
}).passthrough();

/** Dimension object */
const dimensionSchema = z.object({
  length: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
}).passthrough();

/** Size object */
const sizeSchema = z.object({
  techSize: z.string().optional(),
  wbSize: z.string().optional(),
  price: z.number().optional(),
  discountedPrice: z.number().optional(),
  skus: z.array(z.string()).optional(),
}).passthrough();

/** Single card (product) */
export const cardSchema = z.object({
  nmID: z.number(),
  imtID: z.number().optional(),
  vendorCode: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  brandName: z.string().optional().nullable(),
  subjectID: z.number().optional().nullable(),
  subjectName: z.string().optional().nullable(),
  photos: z.array(photoSchema).optional().default([]),
  dimensions: dimensionSchema.optional(),
  sizes: z.array(sizeSchema).optional().default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/** Response for content/v2/get/cards/list */
export const cardsListResponseSchema = z.object({
  cards: z.array(cardSchema).optional().default([]),
  cursor: z.object({
    updatedAt: z.string().optional(),
    nmID: z.number().optional(),
    total: z.number().optional(),
  }).optional(),
}).passthrough();

export const CRITICAL_CARD_FIELDS = [
  'nmID',
  'vendorCode',
  'title',
] as const;
