import { db } from '../../db/client.js';
import { wbOrdersSalesDailyProducts, wbStocksCurrent, wbStocksFbsCurrent, wbFunnelDailyProducts } from '../../db/schema.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';

export type StrategyType =
  | 'maximize_profit' | 'hold_supply' | 'demand_up' | 'demand_down'
  | 'turnover' | 'negative_reviews' | 'atc_optimize' | 'aggressive_sale' | 'oos_protection';

export interface StrategyInput {
  wsId: number;
  nmId: number;
  currentPriceKop: number;
  config: Record<string, unknown>;
}

export interface StrategyResult {
  proposedPriceKop: number;
  reason: string;
  confidence: number; // 0-100
}

async function getRecentMetrics(wsId: number, nmId: number, days: number) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const [sales] = await db.select({
    totalOrders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
    totalSales: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesCount}), 0)`.mapWith(Number),
    totalRevenueKop: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersRub}), 0)`.mapWith(Number),
  })
  .from(wbOrdersSalesDailyProducts)
  .where(and(
    eq(wbOrdersSalesDailyProducts.workspaceId, wsId),
    eq(wbOrdersSalesDailyProducts.nmId, nmId),
    gte(wbOrdersSalesDailyProducts.date, from),
    lte(wbOrdersSalesDailyProducts.date, to),
  ));

  return { ...sales, days };
}

/**
 * Возвращает суммарный остаток (FBO + FBS).
 * Стратегии turnover/oos_protection без FBS считали FBS-only товары как
 * "залежавшиеся" и срезали цену. Теперь учитываем FBS-буфер.
 */
async function getStockLevel(wsId: number, nmId: number): Promise<number> {
  const [fbo] = await db.select({
    totalQty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
  })
  .from(wbStocksCurrent)
  .where(and(
    eq(wbStocksCurrent.workspaceId, wsId),
    eq(wbStocksCurrent.nmId, nmId),
  ));
  const [fbs] = await db.select({
    totalQty: sql<number>`coalesce(sum(${wbStocksFbsCurrent.quantity}), 0)`.mapWith(Number),
  })
  .from(wbStocksFbsCurrent)
  .where(and(
    eq(wbStocksFbsCurrent.workspaceId, wsId),
    eq(wbStocksFbsCurrent.nmId, nmId),
  ));
  return (fbo?.totalQty ?? 0) + (fbs?.totalQty ?? 0);
}

// Strategy implementations
const strategies: Record<StrategyType, (input: StrategyInput) => Promise<StrategyResult>> = {
  // 1. Maximize profit — raise price if demand is stable
  maximize_profit: async (input) => {
    const metrics = await getRecentMetrics(input.wsId, input.nmId, 14);
    const dailyOrders = metrics.totalOrders / Math.max(metrics.days, 1);

    if (dailyOrders >= 3) {
      const increase = Math.min(5, Math.max(2, Math.round(dailyOrders / 2)));
      return {
        proposedPriceKop: Math.round(input.currentPriceKop * (1 + increase / 100)),
        reason: `Стабильный спрос (${dailyOrders.toFixed(1)} заказов/день). Повышение на ${increase}%`,
        confidence: Math.min(90, 50 + dailyOrders * 5),
      };
    }
    return { proposedPriceKop: input.currentPriceKop, reason: 'Спрос недостаточен для повышения', confidence: 30 };
  },

  // 2. Hold supply — balance price with stock level
  hold_supply: async (input) => {
    const stock = await getStockLevel(input.wsId, input.nmId);
    const metrics = await getRecentMetrics(input.wsId, input.nmId, 7);
    const dailySales = metrics.totalSales / Math.max(metrics.days, 1);
    const daysOfStock = dailySales > 0 ? stock / dailySales : 999;

    if (daysOfStock < 14) {
      const increase = Math.min(8, Math.round((14 - daysOfStock) * 0.5));
      return {
        proposedPriceKop: Math.round(input.currentPriceKop * (1 + increase / 100)),
        reason: `Остаток ${stock} шт (${daysOfStock.toFixed(0)} дней). Замедление продаж.`,
        confidence: 75,
      };
    }
    if (daysOfStock > 60) {
      return {
        proposedPriceKop: Math.round(input.currentPriceKop * 0.95),
        reason: `Избыточный остаток (${daysOfStock.toFixed(0)} дней). Стимулирование продаж.`,
        confidence: 65,
      };
    }
    return { proposedPriceKop: input.currentPriceKop, reason: 'Остатки в норме', confidence: 50 };
  },

  // 3. Demand up — price elasticity when demand grows
  demand_up: async (input) => {
    const recent = await getRecentMetrics(input.wsId, input.nmId, 7);
    const prev = await getRecentMetrics(input.wsId, input.nmId, 14);
    const recentDaily = recent.totalOrders / Math.max(recent.days, 1);
    const prevDaily = (prev.totalOrders - recent.totalOrders) / Math.max(prev.days - recent.days, 1);

    if (prevDaily > 0 && recentDaily > prevDaily * 1.2) {
      const growthPct = ((recentDaily - prevDaily) / Math.max(prevDaily, 1)) * 100;
      const increase = Math.min(7, Math.round(growthPct / 5));
      return {
        proposedPriceKop: Math.round(input.currentPriceKop * (1 + increase / 100)),
        reason: `Рост спроса +${growthPct.toFixed(0)}% WoW. Повышение цены на ${increase}%`,
        confidence: 70,
      };
    }
    return { proposedPriceKop: input.currentPriceKop, reason: 'Рост спроса не зафиксирован', confidence: 30 };
  },

  // 4. Demand down — lower price to stimulate
  demand_down: async (input) => {
    const recent = await getRecentMetrics(input.wsId, input.nmId, 7);
    const prev = await getRecentMetrics(input.wsId, input.nmId, 14);
    const recentDaily = recent.totalOrders / Math.max(recent.days, 1);
    const prevDaily = (prev.totalOrders - recent.totalOrders) / Math.max(prev.days - recent.days, 1);

    if (prevDaily > 1 && recentDaily < prevDaily * 0.7) {
      const dropPct = ((prevDaily - recentDaily) / Math.max(prevDaily, 1)) * 100;
      const decrease = Math.min(10, Math.round(dropPct / 4));
      return {
        proposedPriceKop: Math.round(input.currentPriceKop * (1 - decrease / 100)),
        reason: `Спад спроса -${dropPct.toFixed(0)}% WoW. Снижение на ${decrease}%`,
        confidence: 65,
      };
    }
    return { proposedPriceKop: input.currentPriceKop, reason: 'Снижения спроса не зафиксировано', confidence: 30 };
  },

  // 5. Turnover — optimize for maximum turnover rate
  turnover: async (input) => {
    const stock = await getStockLevel(input.wsId, input.nmId);
    const metrics = await getRecentMetrics(input.wsId, input.nmId, 14);
    const dailySales = metrics.totalSales / Math.max(metrics.days, 1);
    const daysOfStock = dailySales > 0 ? stock / dailySales : 999;
    const targetDays = (input.config.targetDays as number) ?? 30;

    if (daysOfStock > targetDays * 1.5) {
      const decrease = Math.min(15, Math.round((daysOfStock - targetDays) / Math.max(targetDays, 1) * 10));
      return {
        proposedPriceKop: Math.round(input.currentPriceKop * (1 - decrease / 100)),
        reason: `Оборачиваемость ${daysOfStock.toFixed(0)} дней (цель: ${targetDays}). Снижение на ${decrease}%`,
        confidence: 70,
      };
    }
    return { proposedPriceKop: input.currentPriceKop, reason: `Оборачиваемость в норме (${daysOfStock.toFixed(0)} дней)`, confidence: 50 };
  },

  // 6. Negative reviews — lower price on rating drop
  negative_reviews: async (input) => {
    // Simplified — lower price slightly to compensate reputation damage
    return {
      proposedPriceKop: Math.round(input.currentPriceKop * 0.97),
      reason: 'Коррекция цены из-за негативных отзывов (-3%)',
      confidence: 55,
    };
  },

  // 7. ATC optimize — optimize add-to-cart rate
  atc_optimize: async (input) => {
    // Lower price slightly to improve cart conversion
    return {
      proposedPriceKop: Math.round(input.currentPriceKop * 0.98),
      reason: 'Оптимизация конверсии в корзину (-2%)',
      confidence: 50,
    };
  },

  // 8. Aggressive sale — maximum discount
  aggressive_sale: async (input) => {
    const maxDiscount = (input.config.maxDiscountPct as number) ?? 20;
    return {
      proposedPriceKop: Math.round(input.currentPriceKop * (1 - maxDiscount / 100)),
      reason: `Агрессивная распродажа: скидка ${maxDiscount}%`,
      confidence: 80,
    };
  },

  // 9. OOS protection — raise price when stock is critical
  oos_protection: async (input) => {
    const stock = await getStockLevel(input.wsId, input.nmId);
    const metrics = await getRecentMetrics(input.wsId, input.nmId, 7);
    const dailySales = metrics.totalSales / Math.max(metrics.days, 1);
    const daysOfStock = dailySales > 0 ? stock / dailySales : 999;

    if (daysOfStock < 7) {
      const increase = Math.min(15, Math.round((7 - daysOfStock) * 2));
      return {
        proposedPriceKop: Math.round(input.currentPriceKop * (1 + increase / 100)),
        reason: `Критический остаток (${daysOfStock.toFixed(0)} дней). Защита от OOS: +${increase}%`,
        confidence: 85,
      };
    }
    return { proposedPriceKop: input.currentPriceKop, reason: 'Остатки не критичны', confidence: 40 };
  },
};

export async function evaluateStrategy(type: StrategyType, input: StrategyInput): Promise<StrategyResult> {
  const handler = strategies[type];
  if (!handler) throw new Error(`Unknown strategy: ${type}`);
  return handler(input);
}
