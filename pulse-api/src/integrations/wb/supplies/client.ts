/**
 * WB FBW Supplies API Client
 * Base URL: https://supplies-api.wildberries.ru
 * 
 * Rate Limits:
 * - /acceptance/options, /warehouses, /transit-tariffs: 6 req/min
 * - /supplies/*: 30 req/min
 */

import { wbGetJson, wbPostJson, getWbApiKey } from '../wbClient.js';
import type {
  WbWarehouse,
  WbTransitTariff,
  WbAcceptanceOptionsRequest,
  WbAcceptanceOptionsResponse,
  WbSupply,
  WbSupplyDetails,
  WbSupplyGood,
  WbSupplyBox,
  WbSupplyFilters,
} from './types.js';

const SUPPLIES_API = 'https://supplies-api.wildberries.ru';

// ============================================================================
// Information for Forming Supplies
// ============================================================================

/**
 * Get list of all WB warehouses
 * Rate limit: 6 req/min
 */
export async function getWarehouses(apiKey: string): Promise<WbWarehouse[]> {
  return wbGetJson<WbWarehouse[]>(
    `${SUPPLIES_API}/api/v1/warehouses`,
    apiKey
  );
}

/**
 * Get transit directions and tariffs
 * Rate limit: 6 req/min
 */
export async function getTransitTariffs(apiKey: string): Promise<WbTransitTariff[]> {
  return wbGetJson<WbTransitTariff[]>(
    `${SUPPLIES_API}/api/v1/transit-tariffs`,
    apiKey
  );
}

/**
 * Check acceptance options for products
 * Returns available warehouses and package types for given barcodes
 * Rate limit: 6 req/min
 * 
 * @param items - Array of {barcode, quantity} (max 5000 items)
 * @param warehouseID - Optional warehouse ID to filter results
 */
export async function getAcceptanceOptions(
  apiKey: string,
  items: WbAcceptanceOptionsRequest[],
  warehouseID?: number,
): Promise<WbAcceptanceOptionsResponse> {
  const url = warehouseID
    ? `${SUPPLIES_API}/api/v1/acceptance/options?warehouseID=${warehouseID}`
    : `${SUPPLIES_API}/api/v1/acceptance/options`;
  
  return wbPostJson<WbAcceptanceOptionsResponse>(url, apiKey, items);
}

// ============================================================================
// Supplies Information
// ============================================================================

/**
 * Get list of supplies with optional filters
 * Rate limit: 30 req/min
 * 
 * @param filters - Optional filters (statusIDs, dates)
 * @param limit - Max 1000 (default 1000)
 * @param offset - Pagination offset (default 0)
 */
export async function getSupplies(
  apiKey: string,
  filters: WbSupplyFilters = {},
  limit = 1000,
  offset = 0,
): Promise<WbSupply[]> {
  return wbPostJson<WbSupply[]>(
    `${SUPPLIES_API}/api/v1/supplies?limit=${limit}&offset=${offset}`,
    apiKey,
    filters
  );
}

/**
 * Get supply details by ID
 * Rate limit: 30 req/min
 * 
 * @param id - Supply ID or Preorder ID
 * @param isPreorderID - true if id is preorderID, false if supplyID
 */
export async function getSupplyDetails(
  apiKey: string,
  id: number,
  isPreorderID = false,
): Promise<WbSupplyDetails> {
  return wbGetJson<WbSupplyDetails>(
    `${SUPPLIES_API}/api/v1/supplies/${id}?isPreorderID=${isPreorderID}`,
    apiKey
  );
}

/**
 * Get goods in a supply
 * Rate limit: 30 req/min
 * 
 * @param id - Supply ID or Preorder ID
 * @param isPreorderID - true if id is preorderID
 * @param limit - Max 1000 (default 100)
 * @param offset - Pagination offset
 */
export async function getSupplyGoods(
  apiKey: string,
  id: number,
  isPreorderID = false,
  limit = 100,
  offset = 0,
): Promise<WbSupplyGood[]> {
  return wbGetJson<WbSupplyGood[]>(
    `${SUPPLIES_API}/api/v1/supplies/${id}/goods?isPreorderID=${isPreorderID}&limit=${limit}&offset=${offset}`,
    apiKey
  );
}

/**
 * Get supply package (boxes/pallets)
 * Rate limit: 30 req/min
 * 
 * @param supplyID - Supply ID (not preorderID)
 */
export async function getSupplyPackage(
  apiKey: string,
  supplyID: number,
): Promise<WbSupplyBox[]> {
  return wbGetJson<WbSupplyBox[]>(
    `${SUPPLIES_API}/api/v1/supplies/${supplyID}/package`,
    apiKey
  );
}

// ============================================================================
// Supply Creation & Management
// ============================================================================

/**
 * Create a new supply (preorder)
 * POST /api/v1/supplies
 * Rate limit: 30 req/min
 */
export async function createSupply(
  apiKey: string,
  params: {
    warehouseID: number;
    deliveryType: 'box' | 'mono_pallet' | 'super_safe';
    cargoType: 'standard' | 'fragile' | 'volumetric';
    name?: string;
    preorderID?: number;  // For returning/editing existing preorder
  }
): Promise<{ preorderID: number }> {
  // 2026-05-27: WB изменил поведение POST /api/v1/supplies — теперь это
  // «список поставок с фильтрами» (POST с body=filter), а не создание.
  // Endpoint создания preorder убран из публичного API. Если WB вернёт
  // массив (= листинг) вместо `{preorderID}` — бросаем понятный error,
  // чтобы AI не пытался дальше делать setSupplyGoods на несуществующий ID.
  const res = await wbPostJson<unknown>(
    `${SUPPLIES_API}/api/v1/supplies`,
    apiKey,
    params,
  );
  if (Array.isArray(res)) {
    throw new Error(
      'WB API больше не поддерживает создание поставки через /api/v1/supplies '
      + '(POST на этот endpoint теперь возвращает список существующих поставок). '
      + 'Создайте поставку в ЛК WB (Поставки → Запланировать поставку), затем используйте API '
      + 'для получения её ID и работы с goods/package/confirm.',
    );
  }
  const obj = res as { preorderID?: number };
  if (!obj || typeof obj.preorderID !== 'number') {
    throw new Error(`WB вернул неожиданный формат при создании поставки: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return { preorderID: obj.preorderID };
}

/**
 * Add/update goods in supply
 * PUT /api/v1/supplies/{id}/goods
 * Rate limit: 30 req/min
 */
export async function setSupplyGoods(
  apiKey: string,
  preorderID: number,
  goods: Array<{
    barcode: string;
    quantity: number;
  }>
): Promise<void> {
  const { wbPutJson } = await import('../wbClient.js');
  await wbPutJson(
    `${SUPPLIES_API}/api/v1/supplies/${preorderID}/goods?isPreorderID=true`,
    apiKey,
    goods
  );
}

/**
 * Set supply package (boxes)
 * PUT /api/v1/supplies/{id}/package
 * Rate limit: 30 req/min
 */
export async function setSupplyPackage(
  apiKey: string,
  preorderID: number,
  boxes: Array<{
    boxBarcode: string;
    barcodes: string[];
  }>
): Promise<void> {
  const { wbPutJson } = await import('../wbClient.js');
  await wbPutJson(
    `${SUPPLIES_API}/api/v1/supplies/${preorderID}/package?isPreorderID=true`,
    apiKey,
    { boxes }
  );
}

/**
 * Confirm supply (book slot)
 * POST /api/v1/supplies/{id}/confirm
 * Rate limit: 30 req/min
 */
export async function confirmSupply(
  apiKey: string,
  preorderID: number,
  params: {
    date: string;  // YYYY-MM-DD
    coefficient?: number;  // Acceptance coefficient (if known)
  }
): Promise<{ supplyID: number; date: string; coefficient: number }> {
  return wbPostJson<{ supplyID: number; date: string; coefficient: number }>(
    `${SUPPLIES_API}/api/v1/supplies/${preorderID}/confirm?isPreorderID=true`,
    apiKey,
    params
  );
}

/**
 * Cancel supply
 * DELETE /api/v1/supplies/{id}
 * Rate limit: 30 req/min
 */
export async function cancelSupply(
  apiKey: string,
  id: number,
  isPreorderID = false
): Promise<void> {
  const { wbDeleteJson } = await import('../wbClient.js');
  await wbDeleteJson(
    `${SUPPLIES_API}/api/v1/supplies/${id}?isPreorderID=${isPreorderID}`,
    apiKey
  );
}

/**
 * Get acceptance coefficients (доступность поставок) for warehouses
 * на ближайшие 14 дней.
 *
 * Текущий endpoint:
 *   GET https://common-api.wildberries.ru/api/tariffs/v1/acceptance/coefficients?warehouseIDs=N,M
 *
 * До 2026-05-27 код звал `/supplies/dates?warehouseID=N&deliveryType=box`
 * (на supplies-api), WB отвечал 400 «неверный формат id (должен быть int32)»
 * — этот legacy-эндпоинт давно удалён. Перешли на актуальный из доки 2026-04.
 *
 * Ответ нормализуем к старому формату { date, coefficient, slotsAvailable }
 * чтобы не ломать callers (queryAcceptanceCoefficients tool).
 * slotsAvailable = (coefficient === 0 || coefficient === 1) && allowUnload.
 *
 * Лимит: 6 запросов в минуту на seller.
 */
export async function getSupplyDates(
  apiKey: string,
  warehouseID: number,
  // deliveryType больше не передаётся — новый endpoint возвращает все
  // типы (box/mono_pallet/super_safe) в одном ответе разными boxTypeName.
  // Параметр оставлен для backwards-compat call-sites; фильтр применяется
  // в нашем коде ниже.
  deliveryType: 'box' | 'mono_pallet' | 'super_safe' = 'box',
): Promise<Array<{
  date: string;
  coefficient: number;
  slotsAvailable: boolean;
}>> {
  const COMMON_API = 'https://common-api.wildberries.ru';
  const raw = await wbGetJson<Array<{
    date: string;
    coefficient: number;
    warehouseID: number;
    warehouseName?: string;
    boxTypeName?: string;
    boxTypeID?: number;
    allowUnload?: boolean;
    storageBaseKoef?: number;
    storageCoef?: number;
  }>>(
    `${COMMON_API}/api/tariffs/v1/acceptance/coefficients?warehouseIDs=${warehouseID}`,
    apiKey,
  );

  // WB отдаёт записи по boxTypeID (число), boxTypeName может отсутствовать.
  // Стандартный маппинг WB:
  //   2 = Короба, 5 = Монопаллеты, 6 = Суперсейф
  const boxTypeIdMap: Record<string, number> = {
    box: 2,
    mono_pallet: 5,
    super_safe: 6,
  };
  const wantedId = boxTypeIdMap[deliveryType] ?? 2;

  return (raw ?? [])
    .filter((r) => r.warehouseID === warehouseID && (r.boxTypeID === wantedId))
    .map((r) => ({
      date: r.date,
      coefficient: r.coefficient,
      // slotsAvailable: coefficient=0 («бесплатно») или 1 («×1») И allowUnload.
      // coefficient=-1 = склад закрыт, ≥2 = платный коэффициент приёмки.
      slotsAvailable: (r.coefficient === 0 || r.coefficient === 1) && r.allowUnload !== false,
    }));
}

// ============================================================================
// High-level helpers
// ============================================================================

/**
 * Get full supply with goods and boxes
 */
export async function getFullSupply(
  apiKey: string,
  supplyID: number,
): Promise<{
  details: WbSupplyDetails;
  goods: WbSupplyGood[];
  boxes: WbSupplyBox[];
}> {
  const [details, goods, boxes] = await Promise.all([
    getSupplyDetails(apiKey, supplyID),
    getSupplyGoods(apiKey, supplyID),
    getSupplyPackage(apiKey, supplyID),
  ]);
  return { details, goods, boxes };
}

/**
 * Get active supplies (not accepted yet)
 */
export async function getActiveSupplies(apiKey: string): Promise<WbSupply[]> {
  return getSupplies(apiKey, {
    statusIDs: [1, 2, 3, 4, 6],  // All except ACCEPTED
  });
}

/**
 * Find best warehouse for products
 * Returns warehouses sorted by most products accepted
 */
export async function findBestWarehouses(
  apiKey: string,
  items: WbAcceptanceOptionsRequest[],
  boxType: 'box' | 'monopallet' | 'supersafe' = 'box',
): Promise<{
  warehouseID: number;
  acceptedBarcodes: number;
  totalBarcodes: number;
}[]> {
  const options = await getAcceptanceOptions(apiKey, items);
  
  const warehouseStats = new Map<number, { accepted: number; total: number }>();
  
  for (const item of options.result) {
    if (item.isError || !item.warehouses) continue;
    
    for (const wh of item.warehouses) {
      const canAccept = 
        (boxType === 'box' && wh.canBox) ||
        (boxType === 'monopallet' && wh.canMonopallet) ||
        (boxType === 'supersafe' && wh.canSupersafe);
      
      const stats = warehouseStats.get(wh.warehouseID) || { accepted: 0, total: 0 };
      stats.total++;
      if (canAccept) stats.accepted++;
      warehouseStats.set(wh.warehouseID, stats);
    }
  }
  
  return Array.from(warehouseStats.entries())
    .map(([warehouseID, stats]) => ({
      warehouseID,
      acceptedBarcodes: stats.accepted,
      totalBarcodes: stats.total,
    }))
    .sort((a, b) => b.acceptedBarcodes - a.acceptedBarcodes);
}

// ============================================================================
// Convenience wrapper with workspace support
// ============================================================================

export class WbSuppliesClient {
  private apiKey: string | null = null;

  // Accept both old (workspaceId-only) and new (workspaceId + shopId)
  // call-sites. shopId is optional so multi-shop workspaces can scope the
  // JWT correctly; if omitted, falls back to the default workspace key.
  constructor(private workspaceId?: number, private shopId?: number) {}

  private async getKey(): Promise<string> {
    if (!this.apiKey) {
      this.apiKey = await getWbApiKey(this.workspaceId, this.shopId);
    }
    return this.apiKey;
  }
  
  async getWarehouses() {
    return getWarehouses(await this.getKey());
  }
  
  async getTransitTariffs() {
    return getTransitTariffs(await this.getKey());
  }
  
  async getAcceptanceOptions(items: WbAcceptanceOptionsRequest[], warehouseID?: number) {
    return getAcceptanceOptions(await this.getKey(), items, warehouseID);
  }
  
  async getSupplies(filters?: WbSupplyFilters, limit?: number, offset?: number) {
    return getSupplies(await this.getKey(), filters, limit, offset);
  }
  
  async getSupplyDetails(id: number, isPreorderID?: boolean) {
    return getSupplyDetails(await this.getKey(), id, isPreorderID);
  }
  
  async getSupplyGoods(id: number, isPreorderID?: boolean, limit?: number, offset?: number) {
    return getSupplyGoods(await this.getKey(), id, isPreorderID, limit, offset);
  }
  
  async getSupplyPackage(supplyID: number) {
    return getSupplyPackage(await this.getKey(), supplyID);
  }
  
  async getFullSupply(supplyID: number) {
    return getFullSupply(await this.getKey(), supplyID);
  }
  
  async getActiveSupplies() {
    return getActiveSupplies(await this.getKey());
  }
  
  async findBestWarehouses(items: WbAcceptanceOptionsRequest[], boxType?: 'box' | 'monopallet' | 'supersafe') {
    return findBestWarehouses(await this.getKey(), items, boxType);
  }

  async createSupply(params: Parameters<typeof createSupply>[1]) {
    return createSupply(await this.getKey(), params);
  }

  async setSupplyGoods(preorderID: number, goods: Parameters<typeof setSupplyGoods>[2]) {
    return setSupplyGoods(await this.getKey(), preorderID, goods);
  }

  async setSupplyPackage(preorderID: number, boxes: Parameters<typeof setSupplyPackage>[2]) {
    return setSupplyPackage(await this.getKey(), preorderID, boxes);
  }

  async confirmSupply(preorderID: number, params: Parameters<typeof confirmSupply>[2]) {
    return confirmSupply(await this.getKey(), preorderID, params);
  }

  async cancelSupply(id: number, isPreorderID?: boolean) {
    return cancelSupply(await this.getKey(), id, isPreorderID);
  }

  async getSupplyDates(warehouseID: number, deliveryType?: Parameters<typeof getSupplyDates>[2]) {
    return getSupplyDates(await this.getKey(), warehouseID, deliveryType);
  }
}
