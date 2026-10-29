/**
 * WB FBS Meta (Marking) API
 * Host: https://marketplace-api.wildberries.ru
 * 
 * Маркировка товаров: SGTIN (Честный знак), IMEI, УИН, GTIN, срок годности, ГТД
 */

import { wbPostJson, wbPutJson, wbDeleteJson } from './wbClient.js';

const MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

/** Тип метаданных маркировки */
export type MetaKey = 'imei' | 'uin' | 'gtin' | 'sgtin' | 'expiration' | 'customsDeclaration';

/** Мета одного заказа */
export interface OrderMeta {
  imei?: { value: string };
  uin?: { value: string };
  gtin?: { value: string };
  sgtin?: { value: string[] };
  expiration?: { value: string };      // DD.MM.YYYY
  customsDeclaration?: { value: string };
}

/** Формат ответа POST /api/marketplace/v3/orders/meta */
export interface OrderMetaResponse {
  orders: Array<{
    id: number;
    meta: OrderMeta;
  }>;
}

/** Результат валидации маркировки */
export interface MetaValidationResult {
  valid: boolean;
  missingMeta: Array<{ orderId: number; missing: string[] }>;
}

// ============================================================================
// Get Meta
// ============================================================================

/**
 * Get metadata for multiple orders
 * POST /api/marketplace/v3/orders/meta
 *
 * @param orderIds - Array of order IDs (max 100)
 * Rate limit: 300 req/min, 200ms interval, 20 burst
 * ВАЖНО: 409 считается как 10 запросов
 */
export async function getOrdersMeta(
  apiKey: string,
  orderIds: number[]
): Promise<OrderMetaResponse> {
  if (orderIds.length === 0) {
    return { orders: [] };
  }
  if (orderIds.length > 100) {
    throw new Error('Max 100 order IDs per request');
  }

  return wbPostJson<OrderMetaResponse>(
    `${MARKETPLACE_API}/api/marketplace/v3/orders/meta`,
    apiKey,
    { orders: orderIds }
  );
}

// ============================================================================
// Set Meta
// ============================================================================

/**
 * Set SGTIN (Честный знак) for order
 * PUT /api/v3/orders/{orderId}/meta/sgtin
 *
 * Условие: заказ в статусе "confirm", sgtin есть в requiredMeta
 * Rate limit: 1000 req/min, 60ms interval, 20 burst
 * ВАЖНО: 409 считается как 10 запросов
 */
export async function setSgtin(
  apiKey: string,
  orderId: number,
  sgtins: string[]
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/meta/sgtin`,
    apiKey,
    { sgtins }
  );
}

/**
 * Set IMEI for order
 * PUT /api/v3/orders/{orderId}/meta/imei
 * Rate limit: 1000 req/min
 */
export async function setImei(
  apiKey: string,
  orderId: number,
  imei: string
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/meta/imei`,
    apiKey,
    { imei }
  );
}

/**
 * Set УИН for order
 * PUT /api/v3/orders/{orderId}/meta/uin
 * Rate limit: 1000 req/min
 */
export async function setUin(
  apiKey: string,
  orderId: number,
  uin: string
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/meta/uin`,
    apiKey,
    { uin }
  );
}

/**
 * Set GTIN for order (Беларусь)
 * PUT /api/v3/orders/{orderId}/meta/gtin
 * Rate limit: 1000 req/min
 */
export async function setGtin(
  apiKey: string,
  orderId: number,
  gtin: string
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/meta/gtin`,
    apiKey,
    { gtin }
  );
}

/**
 * Set expiration date for order
 * PUT /api/v3/orders/{orderId}/meta/expiration
 *
 * @param expiration - Format: DD.MM.YYYY
 * ВАЖНО: Удалить нельзя, только обновить
 * Rate limit: 1000 req/min
 */
export async function setExpiration(
  apiKey: string,
  orderId: number,
  expiration: string
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/meta/expiration`,
    apiKey,
    { expiration }
  );
}

/**
 * Set customs declaration number (ГТД)
 * PUT /api/marketplace/v3/orders/{orderId}/meta/customs-declaration
 *
 * Работает на статусах: confirm, complete
 * Rate limit: 300 req/min
 */
export async function setCustomsDeclaration(
  apiKey: string,
  orderId: number,
  customsDeclaration: string
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/marketplace/v3/orders/${orderId}/meta/customs-declaration`,
    apiKey,
    { customsDeclaration }
  );
}

// ============================================================================
// Delete Meta
// ============================================================================

/**
 * Delete metadata from order
 * DELETE /api/v3/orders/{orderId}/meta?key={key}
 *
 * @param key - One of: imei | uin | gtin | sgtin | customsDeclaration
 * ВАЖНО: expiration удалить нельзя!
 * Rate limit: 300 req/min
 */
export async function deleteMeta(
  apiKey: string,
  orderId: number,
  key: Exclude<MetaKey, 'expiration'>
): Promise<void> {
  await wbDeleteJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/meta?key=${key}`,
    apiKey
  );
}

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate SGTIN format
 * Формат GS1: 01 + 14 цифр GTIN + 21 + серийный номер
 * Общая длина: 29-34 символа
 */
export function validateSgtin(sgtin: string): boolean {
  // 01 (AI) + 14 digits (GTIN) + 21 (AI) + 6-20 chars (serial)
  // Допускаем также короткие форматы и криптохвост
  if (sgtin.length < 20 || sgtin.length > 150) return false;
  // Должен начинаться с 01 и содержать 21
  return /^01\d{14}21.+/.test(sgtin);
}

/**
 * Validate IMEI format (15 digits with Luhn check)
 */
export function validateImei(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  
  // Luhn algorithm
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = parseInt(imei[i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Validate expiration date format (DD.MM.YYYY) and logical validity
 */
export function validateExpiration(exp: string): boolean {
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(exp)) return false;
  
  const [day, month, year] = exp.split('.').map(Number);
  const date = new Date(year, month - 1, day);
  
  // Check if date is valid
  if (date.getDate() !== day || date.getMonth() !== month - 1 || date.getFullYear() !== year) {
    return false;
  }
  
  // Expiration should be in the future
  return date.getTime() > Date.now();
}

/**
 * Validate GTIN format (8, 12, 13, or 14 digits)
 */
export function validateGtin(gtin: string): boolean {
  return /^\d{8}$|^\d{12,14}$/.test(gtin);
}

/**
 * Extract filled meta keys from OrderMeta
 */
export function getFilledMetaKeys(meta: OrderMeta): MetaKey[] {
  const filled: MetaKey[] = [];
  if (meta.imei?.value) filled.push('imei');
  if (meta.uin?.value) filled.push('uin');
  if (meta.gtin?.value) filled.push('gtin');
  if (meta.sgtin?.value?.length) filled.push('sgtin');
  if (meta.expiration?.value) filled.push('expiration');
  if (meta.customsDeclaration?.value) filled.push('customsDeclaration');
  return filled;
}

/**
 * Check if order has all required meta filled
 */
export function isMetaComplete(requiredMeta: string[], filledMeta: MetaKey[]): boolean {
  const filledSet = new Set(filledMeta);
  return requiredMeta.every(key => filledSet.has(key as MetaKey));
}

/**
 * Get human-readable label for meta key
 */
export function getMetaLabel(key: MetaKey): string {
  const labels: Record<MetaKey, string> = {
    sgtin: 'Честный знак',
    imei: 'IMEI',
    uin: 'УИН',
    gtin: 'GTIN',
    expiration: 'Срок годности',
    customsDeclaration: 'ГТД',
  };
  return labels[key] || key;
}
