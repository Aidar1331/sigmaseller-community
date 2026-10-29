/**
 * Metric registry for the Лаборатория.
 *
 * Each key maps to exactly one SQL-derivable daily series. `buildMetricSeries`
 * uses the `source` field to pick the right fact table and column(s), and
 * always joins with shop_id — there is no shop-agnostic access path.
 */

export type MetricKey =
  // Sales / orders
  | 'ordersCount'
  | 'ordersRub'
  | 'salesCount'
  | 'salesRub'
  | 'forPayRub'
  | 'buyoutCount'
  | 'cancelCount'
  // Price
  | 'finishedPriceRub'       // actual price paid that day (WB fact)
  | 'listPriceRub'           // catalogue price, LOCF from wb_prices_history
  | 'sellerDiscountPct'
  | 'sppPct'
  | 'clubDiscountPct'
  // Funnel
  | 'viewCount'
  | 'openCardCount'
  | 'addToCartCount'
  | 'addToWishlistCount'
  | 'ctrPercent'
  | 'crPercent'
  // Ads
  | 'advSpendRub'
  | 'drrPercent'
  // Stock
  | 'stockQty'
  | 'inWayToClient'
  | 'daysOfStock'
  // Finance
  | 'commissionRub'
  | 'logisticsRub'
  | 'storageRub'
  | 'penaltyRub'
  | 'marginRub'
  | 'marginPct'
  // SEO
  | 'positionBest'
  | 'positionMean'
  | 'keywordsInTop10';

export type MetricGroup = 'sales' | 'price' | 'funnel' | 'ads' | 'stock' | 'finance' | 'seo';

export interface MetricDef {
  key: MetricKey;
  label: string;
  group: MetricGroup;
  /** Higher is better — used by interpretation templates. */
  goodDirection: 'up' | 'down' | 'neutral';
  /** For interpretation text and axis formatting. */
  unit: 'count' | 'rub' | 'pct' | 'rank' | 'days';
  /**
   * Fact table contributing the series. buildMetricSeries uses this to route
   * to the appropriate SQL fragment. All routes enforce shop_id.
   */
  source:
    | 'orders_sales'
    | 'funnel'
    | 'adv'
    | 'stocks'
    | 'finance'
    | 'price_locf'
    | 'seo';
}

export const METRICS: Record<MetricKey, MetricDef> = {
  // Sales
  ordersCount:       { key: 'ordersCount',       label: 'Заказы (шт.)',       group: 'sales',  goodDirection: 'up',   unit: 'count', source: 'orders_sales' },
  ordersRub:         { key: 'ordersRub',         label: 'Заказы (₽)',          group: 'sales',  goodDirection: 'up',   unit: 'rub',   source: 'orders_sales' },
  salesCount:        { key: 'salesCount',        label: 'Продажи (шт.)',       group: 'sales',  goodDirection: 'up',   unit: 'count', source: 'orders_sales' },
  salesRub:          { key: 'salesRub',          label: 'Продажи (₽)',         group: 'sales',  goodDirection: 'up',   unit: 'rub',   source: 'orders_sales' },
  forPayRub:         { key: 'forPayRub',         label: 'К перечислению (₽)',  group: 'sales',  goodDirection: 'up',   unit: 'rub',   source: 'orders_sales' },
  buyoutCount:       { key: 'buyoutCount',       label: 'Выкупы (шт.)',        group: 'sales',  goodDirection: 'up',   unit: 'count', source: 'funnel' },
  cancelCount:       { key: 'cancelCount',       label: 'Отмены (шт.)',        group: 'sales',  goodDirection: 'down', unit: 'count', source: 'funnel' },

  // Price
  finishedPriceRub:  { key: 'finishedPriceRub',  label: 'Цена с СПП (₽)',      group: 'price',  goodDirection: 'neutral', unit: 'rub', source: 'orders_sales' },
  listPriceRub:      { key: 'listPriceRub',      label: 'Базовая цена (₽)',    group: 'price',  goodDirection: 'neutral', unit: 'rub', source: 'price_locf' },
  sellerDiscountPct: { key: 'sellerDiscountPct', label: 'Скидка продавца (%)', group: 'price',  goodDirection: 'neutral', unit: 'pct', source: 'price_locf' },
  sppPct:            { key: 'sppPct',            label: 'СПП (%)',              group: 'price',  goodDirection: 'neutral', unit: 'pct', source: 'price_locf' },
  clubDiscountPct:   { key: 'clubDiscountPct',   label: 'WB Клуб скидка (%)',   group: 'price',  goodDirection: 'neutral', unit: 'pct', source: 'price_locf' },

  // Funnel
  viewCount:         { key: 'viewCount',         label: 'Показы',               group: 'funnel', goodDirection: 'up',   unit: 'count', source: 'funnel' },
  openCardCount:     { key: 'openCardCount',     label: 'Открытия карточки',    group: 'funnel', goodDirection: 'up',   unit: 'count', source: 'funnel' },
  addToCartCount:    { key: 'addToCartCount',    label: 'В корзину',            group: 'funnel', goodDirection: 'up',   unit: 'count', source: 'funnel' },
  addToWishlistCount:{ key: 'addToWishlistCount',label: 'В избранное',           group: 'funnel', goodDirection: 'up',   unit: 'count', source: 'funnel' },
  ctrPercent:        { key: 'ctrPercent',        label: 'CTR (%)',               group: 'funnel', goodDirection: 'up',   unit: 'pct',   source: 'funnel' },
  crPercent:         { key: 'crPercent',         label: 'CR в заказ (%)',        group: 'funnel', goodDirection: 'up',   unit: 'pct',   source: 'funnel' },

  // Ads
  advSpendRub:       { key: 'advSpendRub',       label: 'Расход на рекламу (₽)', group: 'ads',    goodDirection: 'neutral', unit: 'rub', source: 'adv' },
  drrPercent:        { key: 'drrPercent',        label: 'ДРР (%)',                group: 'ads',    goodDirection: 'down', unit: 'pct',   source: 'adv' },

  // Stock
  stockQty:          { key: 'stockQty',          label: 'Остаток (шт.)',          group: 'stock',  goodDirection: 'up',   unit: 'count', source: 'stocks' },
  inWayToClient:     { key: 'inWayToClient',     label: 'В пути к клиенту',       group: 'stock',  goodDirection: 'neutral', unit: 'count', source: 'stocks' },
  daysOfStock:       { key: 'daysOfStock',       label: 'Дней на складе',          group: 'stock',  goodDirection: 'neutral', unit: 'days',  source: 'stocks' },

  // Finance
  commissionRub:     { key: 'commissionRub',     label: 'Комиссия WB (₽)',         group: 'finance',goodDirection: 'down', unit: 'rub', source: 'finance' },
  logisticsRub:      { key: 'logisticsRub',      label: 'Логистика (₽)',           group: 'finance',goodDirection: 'down', unit: 'rub', source: 'finance' },
  storageRub:        { key: 'storageRub',        label: 'Хранение (₽)',            group: 'finance',goodDirection: 'down', unit: 'rub', source: 'finance' },
  penaltyRub:        { key: 'penaltyRub',        label: 'Штрафы (₽)',              group: 'finance',goodDirection: 'down', unit: 'rub', source: 'finance' },
  marginRub:         { key: 'marginRub',         label: 'Прибыль до налога (₽)',    group: 'finance',goodDirection: 'up',   unit: 'rub', source: 'finance' },
  marginPct:         { key: 'marginPct',         label: 'Прибыльность до налога (%)', group: 'finance',goodDirection: 'up',   unit: 'pct', source: 'finance' },

  // SEO
  positionBest:      { key: 'positionBest',      label: 'Лучшая позиция',          group: 'seo',    goodDirection: 'down', unit: 'rank',  source: 'seo' },
  positionMean:      { key: 'positionMean',      label: 'Средняя позиция',         group: 'seo',    goodDirection: 'down', unit: 'rank',  source: 'seo' },
  keywordsInTop10:   { key: 'keywordsInTop10',   label: 'Ключей в ТОП-10',         group: 'seo',    goodDirection: 'up',   unit: 'count', source: 'seo' },
};

export function metricDef(key: MetricKey): MetricDef {
  const m = METRICS[key];
  if (!m) throw new Error(`Unknown metric key: ${key}`);
  return m;
}

/**
 * Default metric pack для N×N matrix в UI и формирования пар гипотез в
 * `/lab/:ws/insights`. В пары включаются только те метрики, которые входят
 * сюда (см. `routes/lab.ts:283`). Поэтому каждая новая гипотеза, требующая
 * специфичной метрики (например `forPayRub` для `ads_roi_payout`), должна
 * добавлять её и сюда.
 */
export const DEFAULT_MATRIX_METRICS: MetricKey[] = [
  'ordersCount',
  'finishedPriceRub',
  'viewCount',          // для traffic_to_cart
  'addToCartCount',     // для traffic_to_cart
  'advSpendRub',
  'forPayRub',          // для ads_roi_payout
  'stockQty',
  'marginPct',
];
