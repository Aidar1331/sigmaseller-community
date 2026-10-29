/**
 * Supply Agent -- demand forecast and supply planning.
 */

import { db } from '../../db/client.js';
import { wbFunnelDailyProducts, wbStocksCurrent, wbCards } from '../../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';

interface SupplyRecommendation {
  nmId: number;
  productTitle: string;
  currentStock: number;
  avgDailySales: number;
  daysOfStock: number;
  recommendedQty: number;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
}

export async function runSupplyAgent(wsId: number, targetDays: number = 45, shopId?: number): Promise<{
  summary: string;
  recommendations: SupplyRecommendation[];
}> {
  const d30ago = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // Get daily orders for last 30 days (scoped to shop when provided).
  // Источник — funnel (WB Analytics). Раньше Statistics. Для прогноза спроса
  // используем orderCount (заказы), а не buyoutCount (выкупы): план поставки
  // должен исходить из реального спроса со склада, а не из финальных выкупов
  // — часть товара уйдёт в путь к клиенту до выкупа.
  // firstSaleDate / activeDays — чтобы отличать «молодые» карточки
  // (< 21 дня активных продаж) от зрелых: у молодых avgDaily нестабилен,
  // их не будем форсить в critical.
  const salesData = await db.select({
    nmId: wbFunnelDailyProducts.nmId,
    totalSales: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
    firstSaleDate: sql<string | null>`min(${wbFunnelDailyProducts.date}) filter (where ${wbFunnelDailyProducts.orderCount} > 0)`.mapWith((v) => (v == null ? null : String(v))),
    activeDays: sql<number>`count(distinct ${wbFunnelDailyProducts.date}) filter (where ${wbFunnelDailyProducts.orderCount} > 0)`.mapWith(Number),
  })
  .from(wbFunnelDailyProducts)
  .where(and(
    eq(wbFunnelDailyProducts.workspaceId, wsId),
    gte(wbFunnelDailyProducts.date, d30ago),
    ...(shopId != null ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
  ))
  .groupBy(wbFunnelDailyProducts.nmId);

  // Get current stocks (scoped to shop when provided)
  const stocksData = await db.select({
    nmId: wbStocksCurrent.nmId,
    totalQty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
  })
  .from(wbStocksCurrent)
  .where(and(
    eq(wbStocksCurrent.workspaceId, wsId),
    ...(shopId != null ? [eq(wbStocksCurrent.shopId, shopId)] : []),
  ))
  .groupBy(wbStocksCurrent.nmId);

  // Get card names (scoped to shop when provided)
  const cards = await db.select({ nmId: wbCards.nmId, title: wbCards.title })
    .from(wbCards).where(and(
      eq(wbCards.workspaceId, wsId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
    ));
  const cardMap = new Map(cards.map(c => [c.nmId, c.title ?? `${c.nmId}`]));

  const stockMap = new Map(stocksData.map(s => [s.nmId, s.totalQty]));

  const recommendations: SupplyRecommendation[] = [];

  const today = Date.now();
  for (const sale of salesData) {
    // avgDaily считаем по реальному жизненному периоду товара: если он
    // продаётся всего 5 дней, usage = 30/5 = 6 → средний слишком высок.
    // Используем max(activeDays, 14) чтобы «молодняк» не раздувал прогноз.
    const windowDays = Math.max(14, Math.min(30, sale.activeDays || 30));
    const avgDaily = sale.totalSales / windowDays;
    if (avgDaily < 0.1) continue; // Skip non-sellers

    const currentStock = stockMap.get(sale.nmId) ?? 0;
    const daysOfStock = avgDaily > 0 ? currentStock / avgDaily : 999;
    const recommendedQty = Math.max(0, Math.ceil(avgDaily * targetDays - currentStock));
    if (recommendedQty <= 0) continue;

    // Возраст первой продажи (в днях) — «молодой» товар < 21 дня
    let ageDays: number | null = null;
    if (sale.firstSaleDate) {
      const firstTs = new Date(sale.firstSaleDate + (sale.firstSaleDate.length === 10 ? 'T00:00:00Z' : '')).getTime();
      if (!Number.isNaN(firstTs)) {
        ageDays = Math.floor((today - firstTs) / 86_400_000);
      }
    }
    const isYoung = ageDays !== null && ageDays < 21;

    let urgency: SupplyRecommendation['urgency'] = 'low';
    let reason = '';

    if (daysOfStock <= 0) {
      urgency = isYoung ? 'high' : 'critical';
      reason = isYoung
        ? `Товар новый (${ageDays} дн), остаток 0. Данные ещё нестабильны — поставка на ${recommendedQty} шт.`
        : `Нулевой остаток. Продажи ${avgDaily.toFixed(1)} шт/день за ${windowDays} дн.`;
    } else if (daysOfStock < 7) {
      urgency = isYoung ? 'high' : 'critical';
      reason = isYoung
        ? `Новый товар (${ageDays} дн): ${currentStock} шт хватит на ${daysOfStock.toFixed(0)} дн. Средний спрос уточняется.`
        : `Стоп-риск: ${currentStock} шт, хватит на ${daysOfStock.toFixed(0)} дн при ${avgDaily.toFixed(1)} шт/день.`;
    } else if (daysOfStock < 14) {
      urgency = 'high';
      reason = `Остаток ${currentStock} шт на ${daysOfStock.toFixed(0)} дн (продаёте ${avgDaily.toFixed(1)} шт/день).`;
    } else if (daysOfStock < targetDays * 0.7) {
      urgency = 'medium';
      reason = `Остаток ниже целевого (${targetDays} дн): ${daysOfStock.toFixed(0)} дн хватит. Поставка ${recommendedQty} шт.`;
    } else {
      urgency = 'low';
      reason = `Пополнение до ${targetDays} дн — нужно ${recommendedQty} шт.`;
    }

    recommendations.push({
      nmId: sale.nmId,
      productTitle: cardMap.get(sale.nmId) ?? `${sale.nmId}`,
      currentStock,
      avgDailySales: Math.round(avgDaily * 10) / 10,
      daysOfStock: Math.round(daysOfStock),
      recommendedQty,
      urgency,
      reason,
    });
  }

  // Sort by urgency
  const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  recommendations.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  const critCount = recommendations.filter(r => r.urgency === 'critical').length;
  const highCount = recommendations.filter(r => r.urgency === 'high').length;
  const summary = `План поставок: ${recommendations.length} позиций нужно пополнить (${critCount} критичных, ${highCount} высокий приоритет)`;

  return { summary, recommendations: recommendations.slice(0, 100) };
}
