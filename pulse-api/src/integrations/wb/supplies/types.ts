/**
 * WB FBW Supplies API Types
 * Base URL: https://supplies-api.wildberries.ru
 */

// ============================================================================
// Enums
// ============================================================================

export enum WbSupplyStatus {
  NOT_PLANNED = 1,        // Не запланировано (черновик)
  PLANNED = 2,            // Запланировано
  UNLOADING_ALLOWED = 3,  // Отгрузка разрешена
  ACCEPTING = 4,          // Идёт приёмка
  ACCEPTED = 5,           // Принято
  UNLOADED_AT_GATE = 6,   // Отгружено на воротах
}

export enum WbBoxType {
  VIRTUAL = 0,      // Без коробов (виртуальная поставка)
  BOX_V1 = 1,       // Короба (старая версия)
  BOX = 2,          // Короба
  MONOPALLET = 5,   // Монопаллеты
  SUPERSAFE = 6,    // Суперсейф
}

export enum WbVirtualType {
  STOCK_TRANSFER = 0,   // Перенос остатков
  DEPERSONALIZED = 1,   // Обезличка
  QR_SUPPLY = 4,        // QR-поставка
  ADDITIONAL = 5,       // Допринято
  SCAN_ACCEPTANCE = 6,  // Скан-приёмка
}

// ============================================================================
// Warehouses
// ============================================================================

export interface WbWarehouse {
  ID: number;
  name: string;
  address: string;
  workTime: string;
  isActive: boolean;        // Доступен как склад назначения
  isTransitActive: boolean; // Доступен как транзитный
}

// ============================================================================
// Transit Tariffs
// ============================================================================

export interface WbVolumeTariff {
  from: number;   // литров от
  to: number;     // литров до (0 = без лимита)
  value: number;  // ₽ за литр
}

export interface WbTransitTariff {
  transitWarehouseName: string;
  destinationWarehouseName: string;
  activeFrom: string;  // ISO date
  boxTariff: WbVolumeTariff[] | null;  // null = транзит коробами недоступен
  palletTariff: number;  // ₽ за паллету
}

// ============================================================================
// Acceptance Options
// ============================================================================

export interface WbAcceptanceOptionsRequest {
  barcode: string;
  quantity: number;  // 1-999999
}

export interface WbWarehouseOption {
  warehouseID: number;
  canBox: boolean;
  canMonopallet: boolean;
  canSupersafe: boolean;
  isBoxOnPallet: boolean;  // Недокументированное поле
}

export interface WbBarcodeOptions {
  barcode: string;
  warehouses: WbWarehouseOption[] | null;
  error?: { title: string; detail: string };
  isError?: boolean;
}

export interface WbAcceptanceOptionsResponse {
  result: WbBarcodeOptions[];
  requestId?: string;
}

// ============================================================================
// Supplies
// ============================================================================

export interface WbSupplyFilters {
  statusIDs?: WbSupplyStatus[];
  dates?: WbDateFilter[];
}

export interface WbDateFilter {
  from: string;  // ISO date
  till: string;  // ISO date
  type: 'factDate' | 'createDate' | 'supplyDate' | 'updatedDate';
}

export interface WbSupply {
  phone: string;
  supplyID: number | null;  // null для черновика
  preorderID: number;       // ID заказа/черновика
  createDate: string;
  supplyDate: string | null;
  factDate: string | null;
  updatedDate: string | null;
  statusID: WbSupplyStatus;
  boxTypeID?: WbBoxType;
  isBoxOnPallet?: boolean;
}

export interface WbSupplyDetails extends WbSupply {
  virtualTypeID?: WbVirtualType;
  warehouseID: number;
  warehouseName: string;
  actualWarehouseID: number | null;
  actualWarehouseName: string;
  transitWarehouseID: number | null;
  transitWarehouseName: string;
  acceptanceCost: number | null;          // ₽
  paidAcceptanceCoefficient: number | null;
  rejectReason: string | null;
  supplierAssignName: string;
  storageCoef: string | null;    // Коэффициент хранения
  deliveryCoef: string | null;   // Коэффициент логистики
  quantity: number;              // Добавлено в поставку
  readyForSaleQuantity: number;  // Поступило в продажу
  acceptedQuantity: number;      // Принято
  unloadingQuantity: number;     // На раскладке
  depersonalizedQuantity: number | null;  // Обезличено
}

// ============================================================================
// Supply Goods
// ============================================================================

export interface WbSupplyGood {
  barcode: string;
  vendorCode: string;
  nmID: number;
  needKiz: boolean;      // Требуется Честный знак
  tnved: string | null;  // Код ТН ВЭД
  techSize: string;
  color: string | null;
  supplierBoxAmount: number | null;  // В упаковке, шт
  quantity: number;                   // В поставке, шт
  readyForSaleQuantity: number | null;
  unloadingQuantity: number | null;
  acceptedQuantity: number | null;
}

// ============================================================================
// Supply Package (Boxes/Pallets)
// ============================================================================

export interface WbBoxContent {
  barcode: string;
  quantity: number;
}

export interface WbSupplyBox {
  packageCode: string;  // ШК короба/паллеты (WB_XXXXXXXXXX)
  quantity: number;     // Всего товаров в упаковке
  barcodes: WbBoxContent[];
}

// ============================================================================
// Acceptance Coefficients
// ============================================================================

export interface WbAcceptanceCoefficient {
  date: string;
  coefficient: number;  // -1 = недоступно, 0 = бесплатно, ≥1 = множитель
  warehouseID: number;
  warehouseName: string;
  allowUnload: boolean;
  boxTypeID: WbBoxType;
  storageCoef: string | null;
  deliveryCoef: string | null;
  deliveryBaseLiter: string | null;
  deliveryAdditionalLiter: string | null;
  storageBaseLiter: string | null;
  storageAdditionalLiter: string | null;
  isSortingCenter: boolean;
}
