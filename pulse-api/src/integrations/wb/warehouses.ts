/**
 * WB Marketplace API: склады продавца (FBS) + остатки.
 * Хост: https://marketplace-api.wildberries.ru
 *
 * Делятся на 4 группы:
 *   - GET /api/v3/offices            — справочник физических складов WB
 *   - CRUD /api/v3/warehouses        — виртуальные склады продавца, привязка к WB office
 *   - CRUD /api/v3/stocks/{whId}     — остатки товаров на складе продавца
 *
 * Используется для FBS-модели продаж: продавец создаёт виртуальный склад,
 * привязывает к физическому WB office, заливает остатки.
 */

import { wbGetJson, wbPostJson } from './wbClient.js';

const MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface WbOffice {
  id: number;
  name: string;
  address?: string;
  city?: string;
}

export interface WbSellerWarehouse {
  id: number;
  name: string;
  officeId: number;
  cargoType?: 'mgt' | 'kgt' | 'sgt';
  deliveryType?: 'fbs' | 'dbs' | 'edbs' | 'dbw' | 'pickup';
}

export interface WbStock {
  sku: string;
  amount: number;
}

// ============================================================================
// Offices (WB physical warehouses — справочник)
// ============================================================================

/** GET /api/v3/offices — список физических складов WB. */
export async function getWbOffices(apiKey: string): Promise<WbOffice[]> {
  return wbGetJson<WbOffice[]>(`${MARKETPLACE_API}/api/v3/offices`, apiKey);
}

// ============================================================================
// Seller warehouses (виртуальные склады продавца, FBS only)
// ============================================================================

/** GET /api/v3/warehouses — список виртуальных складов продавца. */
export async function getSellerWarehouses(apiKey: string): Promise<WbSellerWarehouse[]> {
  return wbGetJson<WbSellerWarehouse[]>(`${MARKETPLACE_API}/api/v3/warehouses`, apiKey);
}

/**
 * POST /api/v3/warehouses — создать виртуальный склад продавца.
 *
 * Для FBS-модели. Привязывается к физическому WB office (см. getWbOffices).
 * name — пользовательское понятное имя для UI.
 */
export async function createSellerWarehouse(
  apiKey: string,
  params: { name: string; officeId: number },
): Promise<{ id: number }> {
  return wbPostJson<{ id: number }>(
    `${MARKETPLACE_API}/api/v3/warehouses`,
    apiKey,
    { name: params.name, officeId: params.officeId },
  );
}

/** PUT /api/v3/warehouses/{id} — обновить имя/привязку склада. */
export async function updateSellerWarehouse(
  apiKey: string,
  warehouseId: number,
  patch: { name?: string; officeId?: number },
): Promise<void> {
  const res = await fetch(`${MARKETPLACE_API}/api/v3/warehouses/${warehouseId}`, {
    method: 'PUT',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB updateSellerWarehouse failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** DELETE /api/v3/warehouses/{id} — удалить виртуальный склад. */
export async function deleteSellerWarehouse(apiKey: string, warehouseId: number): Promise<void> {
  const res = await fetch(`${MARKETPLACE_API}/api/v3/warehouses/${warehouseId}`, {
    method: 'DELETE',
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB deleteSellerWarehouse failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ============================================================================
// Stocks (остатки товаров на FBS-складе продавца)
// ============================================================================

/**
 * POST /api/v3/stocks/{warehouseId} — получить остатки по списку SKU.
 *
 * SKU = баркод размера товара (chrtIds в карточке). За один запрос —
 * остатки только по одному складу.
 */
export async function getStocksByWarehouse(
  apiKey: string,
  warehouseId: number,
  skus: string[],
): Promise<{ stocks: WbStock[] }> {
  return wbPostJson(
    `${MARKETPLACE_API}/api/v3/stocks/${warehouseId}`,
    apiKey,
    { skus },
  );
}

/**
 * PUT /api/v3/stocks/{warehouseId} — обновить остатки. Можно добавить
 * новые SKU на склад. Передаются пары sku + amount.
 */
export async function updateStocks(
  apiKey: string,
  warehouseId: number,
  stocks: WbStock[],
): Promise<void> {
  const res = await fetch(`${MARKETPLACE_API}/api/v3/stocks/${warehouseId}`, {
    method: 'PUT',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stocks }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB updateStocks failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** DELETE /api/v3/stocks/{warehouseId} — удалить SKU со склада. */
export async function deleteStocks(
  apiKey: string,
  warehouseId: number,
  skus: string[],
): Promise<void> {
  const res = await fetch(`${MARKETPLACE_API}/api/v3/stocks/${warehouseId}`, {
    method: 'DELETE',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ skus }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB deleteStocks failed: ${res.status} ${text.slice(0, 200)}`);
  }
}
