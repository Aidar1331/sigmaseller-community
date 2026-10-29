/**
 * Словарь для Лаборатории — переводит технические категории backend-а в
 * бизнес-язык селлера. Никаких статистических терминов в UI.
 */

import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Названия метрик — синхронно с METRIC_DEF из /dynamics
// ---------------------------------------------------------------------------

export const METRIC_LABEL: Record<string, string> = {
  // Продажи
  ordersCount: 'Заказы (шт.)',
  ordersRub: 'Заказы (₽)',
  salesCount: 'Продажи (шт.)',
  salesRub: 'Продажи (₽)',
  forPayRub: 'К перечислению (₽)',
  buyoutCount: 'Выкупы (шт.)',
  cancelCount: 'Отмены (шт.)',
  // Цена
  finishedPriceRub: 'Цена с СПП (₽)',
  listPriceRub: 'Базовая цена (₽)',
  sellerDiscountPct: 'Скидка продавца (%)',
  sppPct: 'СПП (%)',
  clubDiscountPct: 'WB Клуб скидка (%)',
  // Воронка
  viewCount: 'Показы',
  openCardCount: 'Открытия карточки',
  addToCartCount: 'В корзину',
  addToWishlistCount: 'В избранное',
  ctrPercent: 'CTR (%)',
  crPercent: 'CR в заказ (%)',
  // Реклама
  advSpendRub: 'Расход на рекламу (₽)',
  drrPercent: 'ДРР (%)',
  // Склад
  stockQty: 'Остаток (шт.)',
  inWayToClient: 'В пути к клиенту',
  daysOfStock: 'Дней на складе',
  // Финансы
  commissionRub: 'Комиссия WB (₽)',
  logisticsRub: 'Логистика (₽)',
  storageRub: 'Хранение (₽)',
  penaltyRub: 'Штрафы (₽)',
  marginRub: 'Прибыль до налога (₽)',
  marginPct: 'Прибыльность до налога (%)',
  // SEO
  positionBest: 'Лучшая позиция',
  positionMean: 'Средняя позиция',
  keywordsInTop10: 'Ключей в ТОП-10',
};

export function metricLabel(key: string): string {
  return METRIC_LABEL[key] ?? key;
}

// ---------------------------------------------------------------------------
// Сила связи — человеческий лейбл без чисел
// ---------------------------------------------------------------------------

/** backend bucket → UI label */
export function strengthLabel(bucket: string): string {
  switch (bucket) {
    case 'strong+':
    case 'strong-':
      return 'сильная';
    case 'moderate+':
    case 'moderate-':
      return 'умеренная';
    case 'weak':
      return 'слабая';
    default:
      return 'нет';
  }
}

/**
 * Направление связи простыми словами.
 * + означает «вместе растут/падают», − «в противоположные стороны».
 */
export function directionLabel(bucket: string): string {
  if (bucket.endsWith('+')) return 'в одну сторону';
  if (bucket.endsWith('-')) return 'в разные стороны';
  return '';
}

/** Цвет индикатора силы связи. */
export function strengthColor(bucket: string): 'green' | 'blue' | 'amber' | 'slate' {
  if (bucket === 'strong+' || bucket === 'strong-') return 'green';
  if (bucket === 'moderate+' || bucket === 'moderate-') return 'blue';
  if (bucket === 'weak') return 'amber';
  return 'slate';
}

// ---------------------------------------------------------------------------
// Надёжность — отражение p-value/FDR/sparsity в одно слово
// ---------------------------------------------------------------------------

/** `green/yellow/red` из insightEngine.confidence → человеческая надёжность. */
export function confidenceLabel(confidence: 'green' | 'yellow' | 'red'): string {
  switch (confidence) {
    case 'green':
      return 'высокая';
    case 'yellow':
      return 'средняя';
    case 'red':
      return 'низкая';
  }
}

export function confidenceColor(confidence: 'green' | 'yellow' | 'red'): 'emerald' | 'amber' | 'rose' {
  switch (confidence) {
    case 'green':
      return 'emerald';
    case 'yellow':
      return 'amber';
    case 'red':
      return 'rose';
  }
}

// ---------------------------------------------------------------------------
// Категория инсайта — как показать пользователю
// ---------------------------------------------------------------------------

export interface CategoryMeta {
  label: string;
  emoji: string;
  badgeTone: 'emerald' | 'rose' | 'amber';
  border: string; // tailwind-like utility suffix
}

export function categoryMeta(category: 'critical' | 'growth_point' | 'false_alarm'): CategoryMeta {
  switch (category) {
    case 'critical':
      return {
        label: 'Требует внимания',
        emoji: '🔴',
        badgeTone: 'rose',
        border: 'border-rose-300',
      };
    case 'growth_point':
      return {
        label: 'Точка роста',
        emoji: '💚',
        badgeTone: 'emerald',
        border: 'border-emerald-300',
      };
    case 'false_alarm':
      return {
        label: 'Под вопросом',
        emoji: '⚠',
        badgeTone: 'amber',
        border: 'border-amber-300',
      };
  }
}

// ---------------------------------------------------------------------------
// Очистка шаблонов от placeholder-ов (на случай если backend их оставит)
// ---------------------------------------------------------------------------

const PLACEHOLDERS = /\{(r|p|n|lag|E|q)\}/g;

/**
 * Убирает `{r}`, `{p}`, `{n}` из текста — UI-рендер доверяет бэку что
 * placeholder-ы уже заполнены, но на случай бага — страхуется.
 */
export function cleanTemplate(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(PLACEHOLDERS, '').replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Список терминов, которые ЗАПРЕЩЕНО показывать в UI (для eslint/runtime guard)
// ---------------------------------------------------------------------------

export const FORBIDDEN_TERMS = [
  'Pearson', 'Spearman', 'Kendall',
  'p-value', 'q-value', 'FDR', 'BH',
  'Fisher CI', 'bootstrap', 'HC1',
  'heteroscedasticity', 'winsorize',
  'Granger', 'VAR', 'OLS',
  'elasticity', 'partial correlation',
  'sparsity', 'change-point',
] as const;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _checkNode: ReactNode = null;
