/**
 * WB Marketplace API Types (FBS Orders)
 * Base URL: https://marketplace-api.wildberries.ru
 */

// ============================================================================
// Order Status
// ============================================================================

export enum WbOrderStatus {
  WAITING = 0,           // В ожидании (новый заказ)
  SORTED = 1,            // На сборке
  COMPLETE = 2,          // Собран
  CANCEL = 3,            // Отменён
  DECLINED_BY_CLIENT = 5,  // Отклонён клиентом
  DEFECT = 6,            // Брак
  READY_FOR_PICKUP = 7,  // Готов к выдаче
  ACCEPTED = 8,          // Передан в доставку
  DELIVERED = 9,         // Получен
  AWAITING_PAYMENT = 10, // Ожидает оплату
}

// ============================================================================
// Order Types
// ============================================================================

export interface WbOrder {
  id: number;                    // ID сборочного задания
  rid: string;                   // ID корзины
  createdAt: string;             // ISO datetime
  warehouseId: number;           // ID склада WB
  supplyId?: string;             // ID поставки
  offices?: string[];            // ПВЗ
  address?: WbDeliveryAddress;   // Адрес доставки
  user?: WbUserInfo;             // Информация о покупателе
  skus: string[];                // Штрихкоды товара
  price: number;                 // Цена в копейках
  convertedPrice: number;        // Конвертированная цена
  currencyCode: number;          // Код валюты (643 = RUB)
  convertedCurrencyCode: number;
  orderUid: string;              // UID заказа
  deliveryType: string;          // fbs, dbs и т.д.
  nmId: number;                  // Артикул WB
  chrtId: number;                // ID характеристики
  article: string;               // Артикул продавца
  colorCode?: string;
  isLargeCargo?: boolean;        // Крупногабарит
  cargoType?: number;
  isZeroOrder?: boolean;         // Нулевой заказ
  
  // Маркировка
  requiredMeta?: string[];       // Обязательные: "uin", "sgtin", "imei", "gtin", "expiration"
  optionalMeta?: string[];       // Опциональные мета-данные
}

export interface WbDeliveryAddress {
  fullAddress?: string;
  province?: string;
  area?: string;
  city?: string;
  street?: string;
  home?: string;
  flat?: string;
  entrance?: string;
  longitude?: number;
  latitude?: number;
}

export interface WbUserInfo {
  fio?: string;
  phone?: string;
}

// ============================================================================
// Stickers (Labels)
// ============================================================================

export interface WbStickerRequest {
  orderId: number;
}

export interface WbSticker {
  orderId: number;
  partA: number;             // Часть А наклейки (первые 8 цифр)
  partB: number;             // Часть B (остальные цифры)
  barcode: string;           // Баркод для наклейки
  file: string;              // Base64-encoded PNG/SVG/PDF
}

export interface WbStickersResponse {
  stickers: WbSticker[];
  error?: string;
}

// ============================================================================
// Supplies
// ============================================================================

export interface WbNewSupplyResponse {
  id: string;                // ID поставки (WB-...)
}

export interface WbSupplyOrder {
  id: number;              // ID заказа
  status: number;          // Статус
  requiredMeta?: string[]; // Обязательная маркировка
  optionalMeta?: string[]; // Опциональная маркировка
}

export interface WbSupplyOrders {
  orders: WbSupplyOrder[];
}

// ============================================================================
// Filters
// ============================================================================

export interface WbOrdersFilter {
  dateFrom?: number;         // Unix timestamp
  dateTo?: number;
  status?: number;           // Фильтр по статусу
}

// ============================================================================
// Cargo Types
// ============================================================================

export enum WbCargoType {
  UNKNOWN = 0,
  BOX = 1,                   // Короба
  MONOPALLET = 2,            // Монопаллеты
  SUPERSAFE = 3,             // Суперсейф
}
