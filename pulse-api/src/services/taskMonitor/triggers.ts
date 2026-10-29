/**
 * Task Monitor — 24 triggers across 5 categories.
 * Inspired by JVO task system.
 *
 * Categories: stocks | sales | advertising | pricing | content
 * Priorities: critical | high | medium
 */

export type TriggerCategory = 'stocks' | 'sales' | 'advertising' | 'pricing' | 'content';
export type TriggerPriority = 'critical' | 'high' | 'medium';

export interface TriggerConfig {
  id: string;
  name: string;
  category: TriggerCategory;
  priority: TriggerPriority;
  description: string;
  defaultEnabled: boolean;
}

export const TRIGGERS: TriggerConfig[] = [
  // ── Stocks (7 triggers) ──────────────────
  { id: 'stock_zero', name: 'Нулевой остаток', category: 'stocks', priority: 'critical', description: 'FBO=0 и FBS=0 — товар полностью отсутствует', defaultEnabled: true },
  { id: 'stock_critical', name: 'Критически мало', category: 'stocks', priority: 'critical', description: 'Общий остаток (FBO+FBS) менее 7 дней продаж', defaultEnabled: true },
  { id: 'stock_low', name: 'Мало товара', category: 'stocks', priority: 'high', description: 'Общий остаток (FBO+FBS) менее 14 дней продаж', defaultEnabled: true },
  { id: 'stock_excess', name: 'Избыток на WB (FBO)', category: 'stocks', priority: 'medium', description: 'Остаток на складах WB более 90 дней. FBS не учитывается (не жрёт хранение WB).', defaultEnabled: true },
  { id: 'stock_forecast_oos', name: 'Прогноз OOS', category: 'stocks', priority: 'high', description: 'Прогнозируемый дефицит через 14 дней', defaultEnabled: true },
  { id: 'stock_warehouse_imbalance', name: 'Дисбаланс складов', category: 'stocks', priority: 'medium', description: 'Неравномерное распределение по складам', defaultEnabled: false },
  { id: 'stock_new_arrival', name: 'Поступление товара', category: 'stocks', priority: 'medium', description: 'Зафиксировано поступление после нулевого остатка', defaultEnabled: true },

  // ── Sales (5 triggers) ──────────────────
  { id: 'sales_drop_daily', name: 'Падение заказов (день)', category: 'sales', priority: 'high', description: 'Заказы за день упали >30% от среднего', defaultEnabled: true },
  { id: 'sales_drop_weekly', name: 'Падение заказов (неделя)', category: 'sales', priority: 'high', description: 'Заказы за неделю упали >20% WoW', defaultEnabled: true },
  { id: 'sales_spike', name: 'Всплеск заказов', category: 'sales', priority: 'medium', description: 'Заказы выросли >50% от среднего', defaultEnabled: true },
  { id: 'buyout_drop', name: 'Падение выкупа', category: 'sales', priority: 'high', description: 'Процент выкупа упал более чем на 5 п.п.', defaultEnabled: true },
  { id: 'returns_spike', name: 'Всплеск возвратов', category: 'sales', priority: 'critical', description: 'Количество возвратов резко выросло', defaultEnabled: true },

  // ── Advertising (5 triggers) ──────────────────
  { id: 'adv_drr_high', name: 'ДРР выше нормы', category: 'advertising', priority: 'high', description: 'ДРР превышает заданный порог', defaultEnabled: true },
  { id: 'adv_zero_orders', name: 'Реклама без заказов', category: 'advertising', priority: 'critical', description: 'Расход на рекламу есть, заказов нет', defaultEnabled: true },
  { id: 'adv_budget_exhausted', name: 'Бюджет исчерпан', category: 'advertising', priority: 'high', description: 'Дневной бюджет рекламной кампании исчерпан', defaultEnabled: true },
  { id: 'adv_ctr_drop', name: 'Падение CTR', category: 'advertising', priority: 'medium', description: 'CTR упал более чем на 20%', defaultEnabled: false },
  { id: 'adv_cpc_spike', name: 'Рост CPC', category: 'advertising', priority: 'medium', description: 'Стоимость клика выросла более чем на 30%', defaultEnabled: false },

  // ── Pricing (4 triggers) ──────────────────
  { id: 'price_competitor_lower', name: 'Конкурент снизил цену', category: 'pricing', priority: 'high', description: 'Конкурент снизил цену на аналогичный товар', defaultEnabled: false },
  { id: 'price_margin_negative', name: 'Отрицательная маржа', category: 'pricing', priority: 'critical', description: 'Маржинальность товара стала отрицательной', defaultEnabled: true },
  { id: 'price_spp_change', name: 'Изменение СПП', category: 'pricing', priority: 'medium', description: 'WB изменил процент СПП', defaultEnabled: true },
  // ОТКЛЮЧЕНО 2026-05-27: триггер вычислял «эффективную комиссию» как
  // sum(commission_kopecks)/sum(revenue_kopecks) за неделю. Но
  // commission_kopecks в финансах включает компенсации, корректировки,
  // возвраты со знаком, из-за чего получались отрицательные «ставки»
  // (например -6.9% → 3.5%). Реальная категорная комиссия меняется не
  // «на товар», а WB-глобально и берётся через /api/v1/tariffs/commission.
  { id: 'price_commission_change', name: 'Изменение комиссии', category: 'pricing', priority: 'medium', description: 'WB изменил комиссию по категории', defaultEnabled: false },

  // ── Content (3 triggers) ──────────────────
  { id: 'content_negative_review', name: 'Негативный отзыв', category: 'content', priority: 'high', description: 'Получен отзыв с оценкой 1-2', defaultEnabled: true },
  { id: 'content_rating_drop', name: 'Падение рейтинга', category: 'content', priority: 'high', description: 'Средний рейтинг товара упал ниже 4.0', defaultEnabled: true },
  { id: 'content_seo_position_drop', name: 'Падение SEO позиций', category: 'content', priority: 'medium', description: 'Позиция по ключевому слову упала более чем на 20 мест', defaultEnabled: true },
];

export const TRIGGER_MAP = new Map(TRIGGERS.map(t => [t.id, t]));
