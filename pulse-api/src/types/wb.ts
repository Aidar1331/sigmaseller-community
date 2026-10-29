/**
 * Wildberries API type definitions
 * 
 * These types improve type safety when working with WB API responses.
 * Use with wbGetJson<Type>() and wbPostJson<Type>() for full type checking.
 */

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export interface WbApiError {
  error: boolean;
  errorText: string;
  additionalErrors?: string | null;
}

// ---------------------------------------------------------------------------
// Orders & Sales
// ---------------------------------------------------------------------------

export interface WbOrder {
  date: string;
  lastChangeDate: string;
  warehouseName: string;
  countryName: string;
  oblastOkrugName: string;
  regionName: string;
  supplierArticle: string;
  nmId: number;
  barcode: string;
  category: string;
  subject: string;
  brand: string;
  techSize: string;
  incomeID: number;
  isSupply: boolean;
  isRealization: boolean;
  totalPrice: number;
  discountPercent: number;
  spp: number;
  finishedPrice: number;
  priceWithDisc: number;
  isCancel: boolean;
  cancelDate: string;
  orderType: string;
  sticker: string;
  gNumber: string;
  srid: string;
}

export interface WbSale {
  date: string;
  lastChangeDate: string;
  warehouseName: string;
  countryName: string;
  oblastOkrugName: string;
  regionName: string;
  supplierArticle: string;
  nmId: number;
  barcode: string;
  category: string;
  subject: string;
  brand: string;
  techSize: string;
  incomeID: number;
  isSupply: boolean;
  isRealization: boolean;
  totalPrice: number;
  discountPercent: number;
  spp: number;
  forPay: number;
  finishedPrice: number;
  priceWithDisc: number;
  saleID: string;
  orderType: string;
  sticker: string;
  gNumber: string;
  srid: string;
}

// ---------------------------------------------------------------------------
// Cards / Products
// ---------------------------------------------------------------------------

export interface WbCard {
  nmID: number;
  imtID: number;
  nmUUID: string;
  subjectID: number;
  subjectName: string;
  vendorCode: string;
  brand: string;
  title: string;
  description: string;
  photos: Array<{
    big: string;
    c246x328: string;
    c516x688: string;
    square: string;
    tm: string;
  }>;
  video: string;
  dimensions: {
    length: number;
    width: number;
    height: number;
  };
  characteristics: Array<{
    id: number;
    name: string;
    value: string | string[];
  }>;
  sizes: Array<{
    techSize: string;
    wbSize: string;
    skus: string[];
    price: number;
    discountedPrice: number;
  }>;
  tags: number[];
  createdAt: string;
  updatedAt: string;
}

export interface WbCardsResponse {
  cards: WbCard[];
  cursor: {
    total: number;
    limit: number;
    offset: number;
  };
}

// ---------------------------------------------------------------------------
// Stocks
// ---------------------------------------------------------------------------

export interface WbStock {
  lastChangeDate: string;
  warehouseName: string;
  supplierArticle: string;
  nmId: number;
  barcode: string;
  quantity: number;
  inWayToClient: number;
  inWayFromClient: number;
  quantityFull: number;
  category: string;
  subject: string;
  brand: string;
  techSize: string;
  Price: number;
  Discount: number;
  isSupply: boolean;
  isRealization: boolean;
  SCCode: string;
}

// ---------------------------------------------------------------------------
// Advertising (Advert API)
// ---------------------------------------------------------------------------

export interface WbAdvertCampaign {
  advertId: number;
  type: number; // 8=auto, 9=search, 6=catalog
  status: number; // 4=ready, 7=active, 9=paused, 11=archived
  dailyBudget: number;
  createTime: string;
  changeTime: string;
  startTime: string;
  endTime: string;
  name: string;
  params: Array<{
    intervals?: Array<{ begin: number; end: number }>;
    price?: number;
    menuId?: number;
    subjectId?: number;
    setId?: number;
    nms?: number[];
  }>;
}

export interface WbAdvertStats {
  advertId: number;
  begin: string;
  end: string;
  views: number;
  clicks: number;
  ctr: number;
  cpc: number;
  spend: number;
  atbs: number;
  orders: number;
  shks: number;
  sum: number;
  sum_price: number;
}

// ---------------------------------------------------------------------------
// Feedbacks / Questions
// ---------------------------------------------------------------------------

export interface WbFeedback {
  id: string;
  imtId: number;
  nmId: number;
  subjectId: number;
  userName: string;
  text: string;
  productValuation: number;
  createdDate: string;
  updatedDate: string;
  answer?: {
    text: string;
    createdDate: string;
  };
  photoLinks?: string[];
  video?: string;
  wasViewed: boolean;
  isAbleSupplierFeedbackValuation: boolean;
  supplierFeedbackValuation: number;
  isAbleSupplierProductValuation: boolean;
  supplierProductValuation: number;
  isAbleReturnProductOrders: boolean;
  returnProductOrdersDate?: string;
}

export interface WbQuestion {
  id: string;
  imtId: number;
  nmId: number;
  subjectId: number;
  userName: string;
  text: string;
  createdDate: string;
  updatedDate: string;
  answer?: {
    text: string;
    createdDate: string;
  };
  wasViewed: boolean;
}

export interface WbFeedbacksResponse extends WbApiError {
  data: {
    feedbacks: WbFeedback[];
  };
}

export interface WbQuestionsResponse extends WbApiError {
  data: {
    questions: WbQuestion[];
  };
}

// ---------------------------------------------------------------------------
// Finance / Reports
// ---------------------------------------------------------------------------

export interface WbReportDetailRow {
  realizationreport_id: number;
  date_from: string;
  date_to: string;
  create_dt: string;
  currency_name: string;
  suppliercontract_code: string | null;
  rrd_id: number;
  gi_id: number;
  subject_name: string;
  nm_id: number;
  brand_name: string;
  sa_name: string;
  ts_name: string;
  barcode: string;
  doc_type_name: string;
  quantity: number;
  retail_price: number;
  retail_amount: number;
  sale_percent: number;
  commission_percent: number;
  office_id: number;
  office_name: string;
  supplier_oper_name: string;
  order_dt: string;
  sale_dt: string;
  rr_dt: string;
  shk_id: number;
  retail_price_withdisc_rub: number;
  delivery_amount: number;
  return_amount: number;
  delivery_rub: number;
  gi_box_type_name: string;
  product_discount_for_report: number;
  supplier_promo: number;
  rid: number;
  ppvz_spp_prc: number;
  ppvz_kvw_prc_base: number;
  ppvz_kvw_prc: number;
  sup_rating_prc_up: number;
  is_kgvp_v2: number;
  ppvz_sales_commission: number;
  ppvz_for_pay: number;
  ppvz_reward: number;
  acquiring_fee: number;
  acquiring_bank: string;
  ppvz_vw: number;
  ppvz_vw_nds: number;
  ppvz_office_id: number;
  ppvz_office_name: string;
  ppvz_supplier_id: number;
  ppvz_supplier_name: string;
  ppvz_inn: string;
  declaration_number: string;
  bonus_type_name: string;
  sticker_id: string;
  site_country: string;
  penalty: number;
  additional_payment: number;
  rebill_logistic_cost: number;
  rebill_logistic_org: string;
  kiz: string;
  storage_fee: number;
  deduction: number;
  acceptance: number;
  srid: string;
  report_type: number;
}

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

export interface WbWarehouse {
  ID: number;
  name: string;
  address: string;
  workTime: string;
  acceptsQR: boolean;
}

// ---------------------------------------------------------------------------
// Supplies / FBS
// ---------------------------------------------------------------------------

export interface WbSupply {
  id: string;
  done: boolean;
  createdAt: string;
  closedAt: string;
  scanDt: string;
  name: string;
  cargoType: number;
}

export interface WbSupplyOrder {
  id: number;
  rid: string;
  createdAt: string;
  warehouseId: number;
  offices: string[];
  user: {
    fio: string;
    phone: string;
  };
  skus: string[];
  price: number;
  convertedPrice: number;
  currencyCode: number;
  convertedCurrencyCode: number;
  orderUid: string;
  deliveryType: number;
  nmId: number;
  chrtId: number;
  article: string;
  colorCode: string;
  isLargeCargo: boolean;
  cargoType: number;
}
