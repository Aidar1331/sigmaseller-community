/**
 * WB Marketplace API Client (FBS Orders)
 * Base URL: https://marketplace-api.wildberries.ru
 *
 * Rate Limits:
 * - Most endpoints: 100 req/min
 * - /api/v3/orders/stickers: 300 req/min (batch up to 100)
 */

import { wbGetJson, wbPostJson, wbPutJson, wbDeleteJson, getWbApiKey } from '../wbClient.js';
import type {
  WbOrder,
  WbOrdersFilter,
  WbSticker,
  WbStickersResponse,
  WbNewSupplyResponse,
  WbSupplyOrders,
} from './types.js';

const MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';

// ============================================================================
// Orders - New/Awaiting
// ============================================================================

/**
 * Get new orders (status = 0, waiting for assembly)
 * GET /api/v3/orders/new
 */
export async function getNewOrders(apiKey: string): Promise<{ orders: WbOrder[] }> {
  return wbGetJson<{ orders: WbOrder[] }>(
    `${MARKETPLACE_API}/api/v3/orders/new`,
    apiKey
  );
}

/**
 * Get all orders with pagination
 * GET /api/v3/orders?limit=&next=&dateFrom=&dateTo=
 *
 * @param limit - Max 1000
 * @param next - Cursor for pagination
 * @param dateFrom - Unix timestamp (seconds)
 * @param dateTo - Unix timestamp (seconds)
 */
export async function getOrders(
  apiKey: string,
  limit = 1000,
  next = 0,
  dateFrom?: number,
  dateTo?: number,
): Promise<{ orders: WbOrder[]; next: number }> {
  let url = `${MARKETPLACE_API}/api/v3/orders?limit=${limit}&next=${next}`;
  if (dateFrom) url += `&dateFrom=${dateFrom}`;
  if (dateTo) url += `&dateTo=${dateTo}`;

  return wbGetJson<{ orders: WbOrder[]; next: number }>(url, apiKey);
}

/**
 * Get order status by ID
 * GET /api/v3/orders/status?id=
 */
export async function getOrderStatus(
  apiKey: string,
  orderId: number,
): Promise<{ status: number }> {
  return wbGetJson<{ status: number }>(
    `${MARKETPLACE_API}/api/v3/orders/status?id=${orderId}`,
    apiKey
  );
}

/** Order status from batch request */
export interface OrderStatusBatch {
  id: number;
  supplierStatus: 'new' | 'confirm' | 'complete' | 'cancel';
  wbStatus: string;
}

/**
 * Get statuses for multiple orders (batch)
 * POST /api/v3/orders/status
 *
 * @param orderIds - Array of order IDs (max 1000)
 * Rate limit: 300 req/min, 200ms interval, 20 burst
 */
export async function getOrderStatuses(
  apiKey: string,
  orderIds: number[]
): Promise<{ orders: OrderStatusBatch[] }> {
  if (orderIds.length === 0) {
    return { orders: [] };
  }
  if (orderIds.length > 1000) {
    throw new Error('Max 1000 order IDs per request');
  }

  return wbPostJson<{ orders: OrderStatusBatch[] }>(
    `${MARKETPLACE_API}/api/v3/orders/status`,
    apiKey,
    { orders: orderIds }
  );
}

// ============================================================================
// Stickers / Labels
// ============================================================================

/** Sticker format type (pdf removed from WB API but kept for barcode) */
export type StickerType = 'png' | 'svg' | 'zplv' | 'zplh' | 'pdf';

/**
 * Get stickers (labels) for orders
 * POST /api/v3/orders/stickers
 *
 * @param orderIds - Array of order IDs (max 100)
 * @param type - png | svg | zplv | zplh (default: png)
 *               zplv = ZPL vertical (for thermal printers)
 *               zplh = ZPL horizontal (for thermal printers)
 * @param width - Label width: 40 | 58 (default: 58)
 * @param height - Label height: 40 | 30 (default: 40)
 *
 * Rate limit: 300 req/min
 */
export async function getOrderStickers(
  apiKey: string,
  orderIds: number[],
  options: {
    type?: StickerType;
    width?: 40 | 58;
    height?: 40 | 30;
  } = {},
): Promise<WbStickersResponse> {
  const { type = 'png', width = 58, height = 40 } = options;

  return wbPostJson<WbStickersResponse>(
    `${MARKETPLACE_API}/api/v3/orders/stickers?type=${type}&width=${width}&height=${height}`,
    apiKey,
    { orders: orderIds.map((id) => ({ id })) }
  );
}

/**
 * Get single sticker as base64
 * Convenience wrapper for getOrderStickers
 */
export async function getOrderStickerBase64(
  apiKey: string,
  orderId: number,
  type: 'png' | 'svg' | 'pdf' = 'png',
): Promise<string | null> {
  const resp = await getOrderStickers(apiKey, [orderId], { type });
  const sticker = resp.stickers?.find((s) => s.orderId === orderId);
  return sticker?.file ?? null;
}

// ============================================================================
// Supplies Management
// ============================================================================

/**
 * Create new supply
 * POST /api/v3/supplies
 *
 * @param name - Supply name (optional)
 */
export async function createSupply(
  apiKey: string,
  name?: string,
): Promise<WbNewSupplyResponse> {
  const body = name ? { name } : {};
  return wbPostJson<WbNewSupplyResponse>(
    `${MARKETPLACE_API}/api/v3/supplies`,
    apiKey,
    body
  );
}

/**
 * Add order to supply
 * PATCH /api/v3/supplies/{supplyId}/orders/{orderId}
 */
export async function addOrderToSupply(
  apiKey: string,
  supplyId: string,
  orderId: number,
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/orders/${orderId}`,
    apiKey,
    {}
  );
}

/**
 * Get orders in supply
 * GET /api/v3/supplies/{supplyId}/orders
 */
export async function getSupplyOrders(
  apiKey: string,
  supplyId: string,
): Promise<WbSupplyOrders> {
  return wbGetJson<WbSupplyOrders>(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/orders`,
    apiKey
  );
}

/**
 * Close supply for delivery
 * PATCH /api/v3/supplies/{supplyId}/deliver
 */
export async function closeSupply(
  apiKey: string,
  supplyId: string,
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/deliver`,
    apiKey,
    {}
  );
}

/**
 * Delete supply (only if empty)
 * DELETE /api/v3/supplies/{supplyId}
 */
export async function deleteSupply(
  apiKey: string,
  supplyId: string,
): Promise<void> {
  await wbDeleteJson(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}`,
    apiKey
  );
}

/**
 * Get supply barcode (QR code)
 * GET /api/v3/supplies/{supplyId}/barcode?type=
 *
 * @param type - png | svg | pdf
 */
export async function getSupplyBarcode(
  apiKey: string,
  supplyId: string,
  type: 'png' | 'svg' | 'pdf' = 'pdf',
): Promise<{ file: string }> {
  return wbGetJson<{ file: string }>(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/barcode?type=${type}`,
    apiKey
  );
}

// ============================================================================
// Supply Boxes (Trbx) — Короба поставки
// ============================================================================

export interface SupplyBox {
  id: string;
}

export interface BoxSticker {
  barcode: string;
  file: string; // base64
}

/**
 * Get boxes in supply
 * GET /api/v3/supplies/{supplyId}/trbx
 * Rate limit: 300 req/min
 */
export async function getSupplyBoxes(
  apiKey: string,
  supplyId: string
): Promise<{ trbxes: SupplyBox[] }> {
  return wbGetJson<{ trbxes: SupplyBox[] }>(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/trbx`,
    apiKey
  );
}

/**
 * Create boxes in supply
 * POST /api/v3/supplies/{supplyId}/trbx
 *
 * Условие: поставка открыта, тип = ПВЗ
 * Rate limit: 300 req/min
 */
export async function createSupplyBoxes(
  apiKey: string,
  supplyId: string,
  quantity: number
): Promise<{ trbxIds: string[] }> {
  if (quantity < 1 || quantity > 100) {
    throw new Error('Quantity must be 1-100');
  }
  return wbPostJson<{ trbxIds: string[] }>(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/trbx`,
    apiKey,
    { quantity }
  );
}

/**
 * Add orders to box
 * PATCH /api/v3/supplies/{supplyId}/trbx/{trbxId}
 */
export async function addOrdersToBox(
  apiKey: string,
  supplyId: string,
  trbxId: string,
  orderIds: number[]
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/trbx/${trbxId}`,
    apiKey,
    { orderIds }
  );
}

/**
 * Remove order from box
 * DELETE /api/v3/supplies/{supplyId}/trbx/{trbxId}/orders/{orderId}
 */
export async function removeOrderFromBox(
  apiKey: string,
  supplyId: string,
  trbxId: string,
  orderId: number
): Promise<void> {
  await wbDeleteJson(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/trbx/${trbxId}/orders/${orderId}`,
    apiKey
  );
}

/**
 * Delete box from supply
 * DELETE /api/v3/supplies/{supplyId}/trbx/{trbxId}
 *
 * Условие: короб пустой
 */
export async function deleteSupplyBox(
  apiKey: string,
  supplyId: string,
  trbxId: string
): Promise<void> {
  await wbDeleteJson(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/trbx/${trbxId}`,
    apiKey
  );
}

/**
 * Get stickers for boxes
 * POST /api/v3/supplies/{supplyId}/trbx/stickers
 *
 * Размер стикера: 580x400 px (фиксированный)
 * Rate limit: 300 req/min
 */
export async function getBoxStickers(
  apiKey: string,
  supplyId: string,
  trbxIds: string[],
  type: StickerType = 'png'
): Promise<{ stickers: BoxSticker[] }> {
  return wbPostJson<{ stickers: BoxSticker[] }>(
    `${MARKETPLACE_API}/api/v3/supplies/${supplyId}/trbx/stickers?type=${type}`,
    apiKey,
    { trbxIds }
  );
}

// ============================================================================
// Reshipments (Переотгрузки)
// ============================================================================

export interface ReshipmentOrder {
  supplyID: string;  // Note: camelCase with capital D (WB API)
  orderID: number;
}

/**
 * Get orders requiring reshipment
 * GET /api/v3/supplies/orders/reshipment
 *
 * Возвращает заказы для переотгрузки (поставка досканирована, но не все товары в ней)
 * Rate limit: 300 req/min
 */
export async function getReshipmentOrders(
  apiKey: string
): Promise<{ orders: ReshipmentOrder[] }> {
  return wbGetJson<{ orders: ReshipmentOrder[] }>(
    `${MARKETPLACE_API}/api/v3/supplies/orders/reshipment`,
    apiKey
  );
}

// ============================================================================
// Order Status Updates
// ============================================================================

/**
 * Mark order as assembled (ready for pickup by WB)
 * PATCH /api/v3/orders/{orderId}/confirm
 */
export async function confirmOrder(
  apiKey: string,
  orderId: number,
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/confirm`,
    apiKey,
    {}
  );
}

/**
 * Cancel order
 * PATCH /api/v3/orders/{orderId}/cancel
 */
export async function cancelOrder(
  apiKey: string,
  orderId: number,
): Promise<void> {
  await wbPutJson(
    `${MARKETPLACE_API}/api/v3/orders/${orderId}/cancel`,
    apiKey,
    {}
  );
}

// ============================================================================
// High-level helpers
// ============================================================================

/**
 * Get all new orders with their stickers
 * Returns orders + stickers in one call
 */
export async function getNewOrdersWithStickers(
  apiKey: string,
  stickerType: 'png' | 'svg' | 'pdf' = 'png',
): Promise<{
  orders: WbOrder[];
  stickers: Map<number, string>; // orderId -> base64 file
}> {
  const { orders } = await getNewOrders(apiKey);

  if (orders.length === 0) {
    return { orders: [], stickers: new Map() };
  }

  // Batch stickers (max 100 per request)
  const stickers = new Map<number, string>();
  const chunks = [];
  for (let i = 0; i < orders.length; i += 100) {
    chunks.push(orders.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const resp = await getOrderStickers(
      apiKey,
      chunk.map((o) => o.id),
      { type: stickerType }
    );
    for (const s of resp.stickers ?? []) {
      stickers.set(s.orderId, s.file);
    }
  }

  return { orders, stickers };
}

/**
 * Create supply and add all new orders
 */
export async function createSupplyWithNewOrders(
  apiKey: string,
  supplyName?: string,
): Promise<{
  supplyId: string;
  orderIds: number[];
  errors: Array<{ orderId: number; error: string }>;
}> {
  const { orders } = await getNewOrders(apiKey);

  if (orders.length === 0) {
    throw new Error('No new orders to add to supply');
  }

  const supply = await createSupply(apiKey, supplyName);
  const errors: Array<{ orderId: number; error: string }> = [];
  const addedOrderIds: number[] = [];

  for (const order of orders) {
    try {
      await addOrderToSupply(apiKey, supply.id, order.id);
      addedOrderIds.push(order.id);
    } catch (e: any) {
      errors.push({ orderId: order.id, error: String(e?.message ?? e) });
    }
  }

  return {
    supplyId: supply.id,
    orderIds: addedOrderIds,
    errors,
  };
}

// ============================================================================
// Convenience wrapper with workspace support
// ============================================================================

export class WbMarketplaceClient {
  private apiKey: string | null = null;

  constructor(private workspaceId?: number, private shopId?: number) {}

  private async getKey(): Promise<string> {
    if (!this.apiKey) {
      this.apiKey = await getWbApiKey(this.workspaceId, this.shopId);
    }
    return this.apiKey;
  }

  // Orders
  async getNewOrders() {
    return getNewOrders(await this.getKey());
  }

  async getOrders(limit?: number, next?: number, dateFrom?: number, dateTo?: number) {
    return getOrders(await this.getKey(), limit, next, dateFrom, dateTo);
  }

  async getOrderStatus(orderId: number) {
    return getOrderStatus(await this.getKey(), orderId);
  }

  // Stickers
  async getOrderStickers(orderIds: number[], options?: { type?: 'png' | 'svg' | 'pdf'; width?: 40 | 58; height?: 40 | 30 }) {
    return getOrderStickers(await this.getKey(), orderIds, options);
  }

  async getOrderStickerBase64(orderId: number, type?: 'png' | 'svg' | 'pdf') {
    return getOrderStickerBase64(await this.getKey(), orderId, type);
  }

  // Supplies
  async createSupply(name?: string) {
    return createSupply(await this.getKey(), name);
  }

  async addOrderToSupply(supplyId: string, orderId: number) {
    return addOrderToSupply(await this.getKey(), supplyId, orderId);
  }

  async getSupplyOrders(supplyId: string) {
    return getSupplyOrders(await this.getKey(), supplyId);
  }

  async closeSupply(supplyId: string) {
    return closeSupply(await this.getKey(), supplyId);
  }

  async deleteSupply(supplyId: string) {
    return deleteSupply(await this.getKey(), supplyId);
  }

  async getSupplyBarcode(supplyId: string, type?: 'png' | 'svg' | 'pdf') {
    return getSupplyBarcode(await this.getKey(), supplyId, type);
  }

  // Order status
  async confirmOrder(orderId: number) {
    return confirmOrder(await this.getKey(), orderId);
  }

  async cancelOrder(orderId: number) {
    return cancelOrder(await this.getKey(), orderId);
  }

  // Helpers
  async getNewOrdersWithStickers(stickerType?: 'png' | 'svg' | 'pdf') {
    return getNewOrdersWithStickers(await this.getKey(), stickerType);
  }

  async createSupplyWithNewOrders(supplyName?: string) {
    return createSupplyWithNewOrders(await this.getKey(), supplyName);
  }
}
