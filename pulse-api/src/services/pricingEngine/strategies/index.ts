/**
 * Pricing Strategy Registry.
 * Each strategy evaluates a product and returns a price recommendation.
 */

export interface ProductContext {
  nmId: number;
  currentPriceKop: number;
  cogsKop?: number;
  // Sales data
  ordersLast7d: number;
  ordersLast14d: number;
  ordersLast30d: number;
  salesTrend7dPct: number; // % change vs previous 7d
  // Stock data
  stockQty: number;
  daysOfStock: number;
  // Funnel data
  atcRate: number; // add-to-cart rate %
  conversionRate: number; // order/view %
  // Rating
  avgRating: number;
  recentNegativeCount: number; // in last 10 reviews
  // Advertising
  drrPct: number;
  advSpendKop: number;
}

export interface StrategyResult {
  strategyType: string;
  recommendedPriceKop: number;
  reason: string;
  priority: number; // higher = more important (1-10)
  confidence: number; // 0-1
}

export type PricingStrategy = (ctx: ProductContext, config: Record<string, unknown>) => StrategyResult | null;

// ── Strategies ────────────────────────────────────────────

export const maximizeProfit: PricingStrategy = (ctx, config) => {
  // If good conversion and stock available, test higher price
  if (ctx.conversionRate > 2 && ctx.daysOfStock > 30 && ctx.ordersLast7d > 5) {
    const increase = Math.min(5, Math.max(2, ctx.conversionRate - 1.5)); // 2-5%
    return {
      strategyType: 'maximize_profit',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * (1 + increase / 100)),
      reason: `Конверсия ${ctx.conversionRate.toFixed(1)}% выше среднего, стока на ${ctx.daysOfStock} дн — повышаем на ${increase.toFixed(0)}%`,
      priority: 5,
      confidence: 0.7,
    };
  }
  return null;
};

export const holdUntilSupply: PricingStrategy = (ctx) => {
  if (ctx.daysOfStock < 14 && ctx.daysOfStock > 0) {
    const increase = ctx.daysOfStock < 7 ? 10 : 5;
    return {
      strategyType: 'hold_supply',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * (1 + increase / 100)),
      reason: `Стока на ${ctx.daysOfStock} дн (< 14) — повышаем на ${increase}% до поставки`,
      priority: 8,
      confidence: 0.9,
    };
  }
  return null;
};

export const demandReactionUp: PricingStrategy = (ctx) => {
  if (ctx.salesTrend7dPct > 15 && ctx.daysOfStock > 14) {
    const increase = Math.min(5, Math.round(ctx.salesTrend7dPct / 10));
    return {
      strategyType: 'demand_up',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * (1 + increase / 100)),
      reason: `Спрос растёт +${ctx.salesTrend7dPct.toFixed(0)}% за 7д — повышаем на ${increase}%`,
      priority: 6,
      confidence: 0.75,
    };
  }
  return null;
};

export const demandReactionDown: PricingStrategy = (ctx) => {
  if (ctx.salesTrend7dPct < -15 && ctx.daysOfStock > 30) {
    const decrease = Math.min(5, Math.round(Math.abs(ctx.salesTrend7dPct) / 10));
    return {
      strategyType: 'demand_down',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * (1 - decrease / 100)),
      reason: `Спрос падает ${ctx.salesTrend7dPct.toFixed(0)}% за 7д — снижаем на ${decrease}%`,
      priority: 7,
      confidence: 0.75,
    };
  }
  return null;
};

export const turnoverBased: PricingStrategy = (ctx, config) => {
  const targetDays = (config.targetTurnoverDays as number) ?? 60;
  if (ctx.daysOfStock > targetDays * 1.5) {
    const excess = (ctx.daysOfStock - targetDays) / targetDays * 100;
    const decrease = Math.min(10, Math.round(excess / 10));
    return {
      strategyType: 'turnover',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * (1 - decrease / 100)),
      reason: `Оборачиваемость ${ctx.daysOfStock} дн (цель ${targetDays}) — снижаем на ${decrease}%`,
      priority: 4,
      confidence: 0.7,
    };
  }
  if (ctx.daysOfStock < targetDays * 0.5 && ctx.daysOfStock > 0) {
    const deficit = (targetDays - ctx.daysOfStock) / targetDays * 100;
    const increase = Math.min(8, Math.round(deficit / 10));
    return {
      strategyType: 'turnover',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * (1 + increase / 100)),
      reason: `Оборачиваемость ${ctx.daysOfStock} дн (цель ${targetDays}) — повышаем на ${increase}%`,
      priority: 4,
      confidence: 0.7,
    };
  }
  return null;
};

export const negativeReviews: PricingStrategy = (ctx) => {
  if (ctx.avgRating < 4.0 && ctx.recentNegativeCount >= 3) {
    return {
      strategyType: 'negative_reviews',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * 0.95),
      reason: `Рейтинг ${ctx.avgRating.toFixed(1)} (< 4.0), ${ctx.recentNegativeCount} негативных — временная скидка 5%`,
      priority: 6,
      confidence: 0.8,
    };
  }
  return null;
};

export const atcOptimization: PricingStrategy = (ctx) => {
  if (ctx.atcRate < 1 && ctx.ordersLast7d < 3 && ctx.daysOfStock > 30) {
    return {
      strategyType: 'atc_optimize',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * 0.97),
      reason: `ATC ${ctx.atcRate.toFixed(1)}% (< 1%) — снижаем на 3% для роста конверсии`,
      priority: 5,
      confidence: 0.7,
    };
  }
  return null;
};

export const aggressiveSale: PricingStrategy = (ctx) => {
  if (ctx.daysOfStock > 90 && ctx.ordersLast30d < 5) {
    const decrease = ctx.daysOfStock > 180 ? 20 : 10;
    return {
      strategyType: 'aggressive_sale',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * (1 - decrease / 100)),
      reason: `Мёртвый сток: ${ctx.daysOfStock} дн, ${ctx.ordersLast30d} заказов/мес — распродажа -${decrease}%`,
      priority: 3,
      confidence: 0.85,
    };
  }
  return null;
};

export const oosProtection: PricingStrategy = (ctx) => {
  if (ctx.daysOfStock > 0 && ctx.daysOfStock < 3) {
    return {
      strategyType: 'oos_protection',
      recommendedPriceKop: Math.round(ctx.currentPriceKop * 1.15),
      reason: `Критический остаток: ${ctx.daysOfStock} дн — защита +15% + рекомендуем остановить рекламу`,
      priority: 9,
      confidence: 0.95,
    };
  }
  return null;
};

// ── Registry ──────────────────────────────────────────────

export const ALL_STRATEGIES: Record<string, PricingStrategy> = {
  maximize_profit: maximizeProfit,
  hold_supply: holdUntilSupply,
  demand_up: demandReactionUp,
  demand_down: demandReactionDown,
  turnover: turnoverBased,
  negative_reviews: negativeReviews,
  atc_optimize: atcOptimization,
  aggressive_sale: aggressiveSale,
  oos_protection: oosProtection,
};
