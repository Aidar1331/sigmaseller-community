/**
 * Task Monitor — scans workspace data and creates agentEvents for active triggers.
 * Runs daily via cron job. Each trigger evaluates conditions and creates events.
 */

import { db } from '../../db/client.js';
import {
  agentEvents, agentSettings, wbStocksCurrent, wbStocksFbsCurrent, wbOrdersSalesDailyProducts,
  wbAdvDailyProducts, wbCards, wbPricesHistory, wbCogs, marketplaceFeedbackItems,
  wbSppWeekly, seoPositionSnapshots, seoKeywords, wbFinanceDailyProducts,
} from '../../db/schema.js';
import { eq, and, gte, lte, lt, sql, desc } from 'drizzle-orm';
import { TRIGGERS, TRIGGER_MAP, type TriggerCategory, type TriggerPriority } from './triggers.js';
import { logTaskMonitor as logger } from '../../lib/logger.js';

interface MonitorContext {
  wsId: number;
  enabledTriggers: Set<string>;
  settings: any;
  cardMap: Map<number, { title: string; shopId: number | null }>;
}

interface EventCandidate {
  triggerId: string;
  eventType: string;
  severity: string;
  title: string;
  description: string;
  nmId?: number;
  shopId?: number | null;
  productTitle?: string;
  suggestedAction?: string;
  actionArgs?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

// ── Stock Triggers ──────────────────────────────────────

async function checkStockTriggers(ctx: MonitorContext): Promise<EventCandidate[]> {
  const events: EventCandidate[] = [];

  // Get current FBO stocks (wb_stocks_current — заполняется аналитическим API,
  // не включает FBS-склады продавца)
  const stocks = await db.select({
    nmId: wbStocksCurrent.nmId,
    totalQty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
  })
  .from(wbStocksCurrent)
  .where(eq(wbStocksCurrent.workspaceId, ctx.wsId))
  .groupBy(wbStocksCurrent.nmId);

  // Get current FBS stocks (склад продавца) — отдельно от FBO. Источник:
  // wb_stocks_fbs_current, наполняется fbsStocksSync job'ом раз в час.
  // Используется как буфер для OOS-триггеров и исключается из stock_excess.
  const fbsStocks = await db.select({
    nmId: wbStocksFbsCurrent.nmId,
    fbsQty: sql<number>`coalesce(sum(${wbStocksFbsCurrent.quantity}), 0)`.mapWith(Number),
  })
  .from(wbStocksFbsCurrent)
  .where(eq(wbStocksFbsCurrent.workspaceId, ctx.wsId))
  .groupBy(wbStocksFbsCurrent.nmId);
  const fbsMap = new Map(fbsStocks.map(s => [s.nmId, s.fbsQty]));

  // Get latest price per nmId (для рекомендации целевой цены в stock_excess).
  // wb_prices_history.price хранится в копейках.
  const latestPrices = await db.execute(sql`
    SELECT DISTINCT ON (nm_id) nm_id, price
    FROM wb_prices_history
    WHERE workspace_id = ${ctx.wsId}
    ORDER BY nm_id, date DESC
  `);
  const priceMap = new Map<number, number>();
  for (const row of latestPrices.rows ?? []) {
    const nmId = Number((row as any).nm_id);
    const priceKop = Number((row as any).price);
    if (Number.isFinite(nmId) && Number.isFinite(priceKop) && priceKop > 0) {
      priceMap.set(nmId, priceKop);
    }
  }

  // Get daily sales avg (last 14 days)
  const d14ago = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const salesAvg = await db.select({
    nmId: wbOrdersSalesDailyProducts.nmId,
    avgDaily: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesCount}), 0) / 14.0`.mapWith(Number),
  })
  .from(wbOrdersSalesDailyProducts)
  .where(and(
    eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
    gte(wbOrdersSalesDailyProducts.date, d14ago),
  ))
  .groupBy(wbOrdersSalesDailyProducts.nmId);

  const salesMap = new Map(salesAvg.map(s => [s.nmId, s.avgDaily]));

  // Recent 7-day sales velocity for trend detection (stock_forecast_oos)
  const d7ago = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const recentSales = await db.select({
    nmId: wbOrdersSalesDailyProducts.nmId,
    avgDaily: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesCount}), 0) / 7.0`.mapWith(Number),
  })
  .from(wbOrdersSalesDailyProducts)
  .where(and(
    eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
    gte(wbOrdersSalesDailyProducts.date, d7ago),
  ))
  .groupBy(wbOrdersSalesDailyProducts.nmId);
  const recentSalesMap = new Map(recentSales.map(s => [s.nmId, s.avgDaily]));

  // Detect products that recently had zero stock (stock_new_arrival)
  // Items with 0 sales in the last 7 days but had sales before => proxy for OOS
  const previouslyZeroSet = new Set<number>();
  if (ctx.enabledTriggers.has('stock_new_arrival')) {
    // Products that had zero total stock yesterday (or recently) — approximate with products
    // that had sales historically but zero sales in last 3 days
    const d3ago = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const recentlySelling = new Set(
      (await db.select({ nmId: wbOrdersSalesDailyProducts.nmId })
        .from(wbOrdersSalesDailyProducts)
        .where(and(
          eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
          gte(wbOrdersSalesDailyProducts.date, d3ago),
        ))
        .groupBy(wbOrdersSalesDailyProducts.nmId)
      ).map(r => r.nmId)
    );
    // Products with historical sales (14d+) but not in last 3 days
    for (const s of salesAvg) {
      if (s.avgDaily > 0.1 && !recentlySelling.has(s.nmId)) {
        previouslyZeroSet.add(s.nmId);
      }
    }
  }

  // Объединяем все nmId — у которых есть FBO остатки и/или FBS остатки.
  const allNmIds = new Set<number>([...stocks.map(s => s.nmId), ...fbsMap.keys()]);
  const fboMap = new Map(stocks.map(s => [s.nmId, s.totalQty]));

  for (const nmId of allNmIds) {
    const fboQty = fboMap.get(nmId) ?? 0;
    const fbsQty = fbsMap.get(nmId) ?? 0;
    const totalQty = fboQty + fbsQty;
    const daily = salesMap.get(nmId) ?? 0;
    const daysOfStockFbo = daily > 0 ? fboQty / daily : 999;       // для stock_excess (только FBO)
    const daysOfStockTotal = daily > 0 ? totalQty / daily : 999;   // для OOS-триггеров (с буфером FBS)
    const name = ctx.cardMap.get(nmId)?.title ?? `${nmId}`;
    const fbsTail = fbsQty > 0 ? `, FBS-буфер: ${fbsQty} шт` : '';

    // Цена за единицу (для расчёта потерянной выручки)
    const priceRubPerUnit = (priceMap.get(nmId) ?? 0) / 100;
    // Запас на 14 дней — стандартная рекомендация поставки
    const restockQty14d = Math.max(1, Math.round(daily * 14));
    const restockSumRub = restockQty14d > 0 && priceRubPerUnit > 0
      ? Math.round(restockQty14d * priceRubPerUnit)
      : 0;

    // stock_zero — нулевой ТОЛЬКО когда нет ни FBO, ни FBS
    if (ctx.enabledTriggers.has('stock_zero') && totalQty === 0 && daily > 0.1) {
      // За день простоя теряем: daily × priceRubPerUnit
      const lostPerDayRub = Math.round(daily * priceRubPerUnit);
      events.push({
        triggerId: 'stock_zero',
        eventType: 'oos_warning',
        severity: 'critical',
        title: `🚨 Нет товара: ${name} (${nmId})`,
        description: `Остаток 0 шт. Продажи: ${daily.toFixed(1)} шт/день, средняя цена ${priceRubPerUnit.toFixed(0)} ₽. `
          + `Каждый день простоя ≈ ${lostPerDayRub.toLocaleString('ru-RU')} ₽ потерь и ≈ ${daily.toFixed(1)} упущенных заказов. `
          + `Рекомендую поставку ${restockQty14d} шт${restockSumRub > 0 ? ` (≈ ${restockSumRub.toLocaleString('ru-RU')} ₽ выручки)` : ''} — хватит на 14 дней.`,
        nmId,
        productTitle: name,
        suggestedAction: 'restock',
        meta: { qty: 0, fboQty: 0, fbsQty: 0, avgDaily: daily, lostPerDayRub, restockQty14d },
      });
    }

    // stock_critical — общий запас < 7 дней. Если FBS закрывает дыру — severity warning.
    if (ctx.enabledTriggers.has('stock_critical') && totalQty > 0 && daysOfStockTotal < 7 && daily > 0.1) {
      const severity = fbsQty > 0 ? 'warning' : 'critical';
      const lostPotentialRub = priceRubPerUnit > 0
        ? Math.round(daily * priceRubPerUnit * Math.max(0, 14 - daysOfStockTotal))
        : 0;
      events.push({
        triggerId: 'stock_critical',
        eventType: 'oos_warning',
        severity,
        title: `⚠ Мало товара: ${name} (${nmId}) — на ${daysOfStockTotal.toFixed(0)} дн.`,
        description: `Остаток ${totalQty} шт (FBO: ${fboQty}${fbsTail}). Продажи ${daily.toFixed(1)} шт/день. `
          + `Если не пополнить — закончится через ${daysOfStockTotal.toFixed(0)} дн. `
          + `За следующие 14 дн упустим ≈ ${lostPotentialRub.toLocaleString('ru-RU')} ₽. `
          + `Рекомендую поставку ${restockQty14d} шт${restockSumRub > 0 ? ` (≈ ${restockSumRub.toLocaleString('ru-RU')} ₽ выручки)` : ''}.`,
        nmId,
        productTitle: name,
        suggestedAction: 'restock',
        meta: { qty: totalQty, fboQty, fbsQty, daysOfStock: Math.round(daysOfStockTotal), restockQty14d },
      });
    }

    // stock_low — общий запас на 7-14 дней
    if (ctx.enabledTriggers.has('stock_low') && daysOfStockTotal >= 7 && daysOfStockTotal < 14 && daily > 0.1) {
      events.push({
        triggerId: 'stock_low',
        eventType: 'stock_forecast',
        severity: 'warning',
        title: `📦 ${name} (${nmId}) — остаток на ${daysOfStockTotal.toFixed(0)} дн.`,
        description: `Остаток ${totalQty} шт (FBO: ${fboQty}${fbsTail}). Продажи ${daily.toFixed(1)} шт/день. `
          + `Запас закончится через ${daysOfStockTotal.toFixed(0)} дней — самое время заказать поставку. `
          + `Рекомендую ${restockQty14d} шт${restockSumRub > 0 ? ` (≈ ${restockSumRub.toLocaleString('ru-RU')} ₽ выручки)` : ''} — хватит на 14 дней.`,
        nmId,
        productTitle: name,
        suggestedAction: 'restock',
        meta: { qty: totalQty, fboQty, fbsQty, restockQty14d },
      });
    }

    // stock_excess — ИЗБЫТОК только по FBO (хранение жрёт деньги только на WB-складе).
    // По требованию оператора: НЕ срабатывает, если есть FBS-остатки —
    // продавец может регулировать поставку с FBS-склада, у него гибкость.
    if (ctx.enabledTriggers.has('stock_excess') && daysOfStockFbo > 90 && daily > 0 && fbsQty === 0) {
      // Рекомендованная скидка зависит от глубины избытка:
      //   90-120д   → −10%
      //   120-180д  → −15%
      //   >180д     → −25%
      const discountPct =
        daysOfStockFbo > 180 ? 25 :
        daysOfStockFbo > 120 ? 15 : 10;
      const currentPriceKop = priceMap.get(nmId);
      const currentPriceRub = currentPriceKop ? Math.round(currentPriceKop / 100) : null;
      const targetPriceRub = currentPriceRub ? Math.round(currentPriceRub * (1 - discountPct / 100)) : null;
      const priceTail =
        currentPriceRub && targetPriceRub
          ? ` · цена ${currentPriceRub} → ${targetPriceRub} ₽ (−${discountPct}%)`
          : '';

      events.push({
        triggerId: 'stock_excess',
        eventType: 'stock_forecast',
        severity: 'info',
        title: `Избыток FBO: ${name}`,
        description: `На складах WB ${fboQty} шт (${daysOfStockFbo.toFixed(0)} дней)${priceTail}`,
        nmId,
        productTitle: name,
        suggestedAction: 'reprice',
        actionArgs: currentPriceRub && targetPriceRub
          ? { currentPriceRub, targetPriceRub, discountPct }
          : { discountPct },
        meta: { qty: fboQty, fboQty, fbsQty: 0, daysOfStock: Math.round(daysOfStockFbo) },
      });
    }

    // stock_forecast_oos — прогноз OOS по общему остатку (FBO+FBS) с учётом
    // ускорения продаж за последние 7 дней.
    if (ctx.enabledTriggers.has('stock_forecast_oos') && totalQty > 0 && daily > 0.2) {
      const recent7 = recentSalesMap.get(nmId) ?? daily;
      const forecastDays = recent7 > 0 ? totalQty / recent7 : 999;
      if (forecastDays <= 14 && forecastDays > 7) {
        if (recent7 > daily * 1.15) {
          events.push({
            triggerId: 'stock_forecast_oos',
            eventType: 'stock_forecast',
            severity: 'warning',
            title: `Прогноз OOS: ${name}`,
            description: `При текущей скорости (${recent7.toFixed(1)} шт/день) остаток ${totalQty} шт (FBO: ${fboQty}${fbsTail}) закончится через ${forecastDays.toFixed(0)} дней. Скорость растёт.`,
            nmId,
            productTitle: name,
            suggestedAction: 'restock',
            meta: { qty: totalQty, fboQty, fbsQty, forecastDays: Math.round(forecastDays), recentDailyAvg: Number(recent7.toFixed(1)) },
          });
        }
      }
    }

    // stock_new_arrival — товар вернулся в наличие (с учётом FBS)
    if (ctx.enabledTriggers.has('stock_new_arrival') && totalQty > 0) {
      const hadZero = previouslyZeroSet.has(nmId);
      if (hadZero) {
        events.push({
          triggerId: 'stock_new_arrival',
          eventType: 'stock_forecast',
          severity: 'info',
          title: `Поступление: ${name}`,
          description: `Товар вернулся в наличие: ${totalQty} шт (FBO: ${fboQty}${fbsTail})`,
          nmId,
          productTitle: name,
          meta: { qty: totalQty, fboQty, fbsQty },
        });
      }
    }
  }

  // stock_warehouse_imbalance — check per-product warehouse distribution
  if (ctx.enabledTriggers.has('stock_warehouse_imbalance')) {
    const warehouseStocks = await db.select({
      nmId: wbStocksCurrent.nmId,
      warehouseName: wbStocksCurrent.warehouseName,
      quantity: wbStocksCurrent.quantity,
    })
    .from(wbStocksCurrent)
    .where(eq(wbStocksCurrent.workspaceId, ctx.wsId));

    // Group by nmId
    const byProduct = new Map<number, { warehouse: string; qty: number }[]>();
    for (const row of warehouseStocks) {
      if (!byProduct.has(row.nmId)) byProduct.set(row.nmId, []);
      byProduct.get(row.nmId)!.push({ warehouse: row.warehouseName ?? 'unknown', qty: row.quantity });
    }

    for (const [nmId, warehouses] of byProduct) {
      if (warehouses.length < 2) continue;
      const total = warehouses.reduce((s, w) => s + w.qty, 0);
      if (total < 10) continue;
      const maxQty = Math.max(...warehouses.map(w => w.qty));
      const maxPct = (maxQty / total) * 100;
      // Imbalance: one warehouse holds >80% of stock across 3+ warehouses
      if (maxPct > 80 && warehouses.length >= 3) {
        const name = ctx.cardMap.get(nmId)?.title ?? `${nmId}`;
        const topWh = warehouses.find(w => w.qty === maxQty)!;
        events.push({
          triggerId: 'stock_warehouse_imbalance',
          eventType: 'stock_forecast',
          severity: 'info',
          title: `Дисбаланс складов: ${name}`,
          description: `${topWh.warehouse}: ${maxPct.toFixed(0)}% от всего остатка (${warehouses.length} складов)`,
          nmId,
          productTitle: name,
          meta: { totalQty: total, warehouseCount: warehouses.length, topWarehouse: topWh.warehouse, topPct: Math.round(maxPct) },
        });
      }
    }
  }

  return events;
}

// ── Sales Triggers ──────────────────────────────────────

async function checkSalesTriggers(ctx: MonitorContext): Promise<EventCandidate[]> {
  const events: EventCandidate[] = [];
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const d7ago = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const d14ago = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

  // Цены per nm — для расчёта потерянной выручки в returns_spike etc.
  const priceMap = new Map<number, number>();
  try {
    const priceRes: any = await db.execute(sql`
      SELECT DISTINCT ON (nm_id) nm_id, price
        FROM wb_prices_history
       WHERE workspace_id = ${ctx.wsId} AND price > 0
       ORDER BY nm_id, date DESC
    `);
    for (const row of ((priceRes.rows ?? priceRes) as any[])) {
      const nmId = Number(row.nm_id);
      const priceKop = Number(row.price);
      if (Number.isFinite(nmId) && Number.isFinite(priceKop) && priceKop > 0) {
        priceMap.set(nmId, priceKop);
      }
    }
  } catch { /* soft dep */ }

  // Yesterday orders vs 7-day average — PER-SHOP detection (was: workspace-wide
  // which collapsed multi-shop sellers into one event with shop_id=NULL and
  // hid which exact shop slipped). Now we GROUP BY shop_id and emit a separate
  // event per shop, so events carry shop_id and pass the shop filter on UI.
  if (ctx.enabledTriggers.has('sales_drop_daily') || ctx.enabledTriggers.has('sales_spike')) {
    const yesterdayByShop = await db.select({
      shopId: wbOrdersSalesDailyProducts.shopId,
      orders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      eq(wbOrdersSalesDailyProducts.date, yesterday),
    ))
    .groupBy(wbOrdersSalesDailyProducts.shopId);

    const weekByShop = await db.select({
      shopId: wbOrdersSalesDailyProducts.shopId,
      avgOrders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0) / 7.0`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      gte(wbOrdersSalesDailyProducts.date, d7ago),
      lte(wbOrdersSalesDailyProducts.date, yesterday),
    ))
    .groupBy(wbOrdersSalesDailyProducts.shopId);

    const weekAvgByShop = new Map(weekByShop.map((w) => [w.shopId, w.avgOrders]));

    for (const yRow of yesterdayByShop) {
      if (yRow.shopId == null) continue; // skip rows with no shop attribution
      const yOrders = yRow.orders ?? 0;
      const avg = weekAvgByShop.get(yRow.shopId) ?? 0;

      if (ctx.enabledTriggers.has('sales_drop_daily') && avg > 3 && yOrders < avg * 0.7) {
        const dropPct = ((avg - yOrders) / avg * 100).toFixed(0);
        events.push({
          triggerId: 'sales_drop_daily',
          eventType: 'order_drop',
          severity: 'warning',
          shopId: yRow.shopId,
          title: `Падение заказов -${dropPct}%`,
          description: `Вчера ${yOrders} заказов (среднее ${avg.toFixed(0)})`,
        });
      }

      if (ctx.enabledTriggers.has('sales_spike') && avg > 1 && yOrders > avg * 1.5) {
        const growPct = ((yOrders - avg) / avg * 100).toFixed(0);
        events.push({
          triggerId: 'sales_spike',
          eventType: 'order_drop',
          severity: 'info',
          shopId: yRow.shopId,
          title: `Всплеск заказов +${growPct}%`,
          description: `Вчера ${yOrders} заказов (среднее ${avg.toFixed(0)})`,
        });
      }
    }
  }

  // buyout_drop — compare buyout rate (salesCount/ordersCount) this week vs last week
  if (ctx.enabledTriggers.has('buyout_drop')) {
    const buyoutThisWeek = await db.select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      orders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
      sales: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesCount}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      gte(wbOrdersSalesDailyProducts.date, d7ago),
    ))
    .groupBy(wbOrdersSalesDailyProducts.nmId);

    const buyoutPrevWeek = await db.select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      orders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
      sales: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesCount}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      gte(wbOrdersSalesDailyProducts.date, d14ago),
      lt(wbOrdersSalesDailyProducts.date, d7ago),
    ))
    .groupBy(wbOrdersSalesDailyProducts.nmId);

    const prevMap = new Map(buyoutPrevWeek.map(b => [b.nmId, b]));

    for (const curr of buyoutThisWeek) {
      if (curr.orders < 5) continue; // need enough volume
      const prev = prevMap.get(curr.nmId);
      if (!prev || prev.orders < 5) continue;
      const currRate = (curr.sales / curr.orders) * 100;
      const prevRate = (prev.sales / prev.orders) * 100;
      const dropPp = prevRate - currRate;
      if (dropPp >= 5) {
        const name = ctx.cardMap.get(curr.nmId)?.title ?? `${curr.nmId}`;
        events.push({
          triggerId: 'buyout_drop',
          eventType: 'order_drop',
          severity: 'warning',
          title: `Падение выкупа: ${name}`,
          description: `Выкуп ${prevRate.toFixed(0)}% → ${currRate.toFixed(0)}% (−${dropPp.toFixed(0)} п.п.)`,
          nmId: curr.nmId,
          productTitle: name,
          meta: { currentBuyoutPct: Math.round(currRate), previousBuyoutPct: Math.round(prevRate), dropPp: Math.round(dropPp) },
        });
      }
    }
  }

  // returns_spike — sudden increase in returns (orders - sales as proxy)
  if (ctx.enabledTriggers.has('returns_spike')) {
    const returnsThisWeek = await db.select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      orders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
      sales: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesCount}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      gte(wbOrdersSalesDailyProducts.date, d7ago),
    ))
    .groupBy(wbOrdersSalesDailyProducts.nmId);

    const returnsPrevWeek = await db.select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      orders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
      sales: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.salesCount}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      gte(wbOrdersSalesDailyProducts.date, d14ago),
      lt(wbOrdersSalesDailyProducts.date, d7ago),
    ))
    .groupBy(wbOrdersSalesDailyProducts.nmId);

    const prevRetMap = new Map(returnsPrevWeek.map(r => [r.nmId, r]));

    for (const curr of returnsThisWeek) {
      if (curr.orders < 5) continue;
      const returnsCurr = Math.max(0, curr.orders - curr.sales);
      const prev = prevRetMap.get(curr.nmId);
      const returnsPrev = prev ? Math.max(0, prev.orders - prev.sales) : 0;
      const returnRateCurr = (returnsCurr / curr.orders) * 100;
      // Spike: return rate > 25% AND increased significantly
      if (returnRateCurr > 25 && returnsCurr > returnsPrev * 1.5 && returnsCurr >= 3) {
        const name = ctx.cardMap.get(curr.nmId)?.title ?? `${curr.nmId}`;
        const growthPct = returnsPrev > 0
          ? Math.round(((returnsCurr - returnsPrev) / returnsPrev) * 100)
          : null;
        // Потеря: ≈ возвраты × средняя цена (примерно)
        const priceRubPerUnit = (priceMap.get(curr.nmId) ?? 0) / 100;
        const lostRevenueRub = priceRubPerUnit > 0
          ? Math.round(returnsCurr * priceRubPerUnit)
          : 0;
        events.push({
          triggerId: 'returns_spike',
          eventType: 'order_drop',
          severity: 'critical',
          title: `↗ Возвраты выросли: ${name} (${curr.nmId})`,
          description: `${returnsCurr} возвратов за 7 дней (${returnRateCurr.toFixed(0)}% от заказов). `
            + `Прошлая неделя: ${returnsPrev}${growthPct !== null && growthPct > 0 ? ` — рост на ${growthPct}%` : ''}. `
            + (lostRevenueRub > 0 ? `Возвращено ≈ ${lostRevenueRub.toLocaleString('ru-RU')} ₽ выручки. ` : '')
            + `Чек-лист: проверь отзывы за неделю (возможный брак/несоответствие), сверь фото с реальным товаром, проверь упаковку.`,
          nmId: curr.nmId,
          productTitle: name,
          meta: { returnsCurrent: returnsCurr, returnsPrevious: returnsPrev, returnRatePct: Math.round(returnRateCurr), growthPct, lostRevenueRub },
        });
      }
    }
  }

  // Weekly WoW comparison
  if (ctx.enabledTriggers.has('sales_drop_weekly')) {
    // PER-SHOP weekly drop — same rationale as sales_drop_daily above.
    const thisWeekByShop = await db.select({
      shopId: wbOrdersSalesDailyProducts.shopId,
      orders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      gte(wbOrdersSalesDailyProducts.date, d7ago),
    ))
    .groupBy(wbOrdersSalesDailyProducts.shopId);

    const prevWeekByShop = await db.select({
      shopId: wbOrdersSalesDailyProducts.shopId,
      orders: sql<number>`coalesce(sum(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, ctx.wsId),
      gte(wbOrdersSalesDailyProducts.date, d14ago),
      lte(wbOrdersSalesDailyProducts.date, d7ago),
    ))
    .groupBy(wbOrdersSalesDailyProducts.shopId);

    const prevMap = new Map(prevWeekByShop.map((p) => [p.shopId, p.orders]));

    for (const curr of thisWeekByShop) {
      if (curr.shopId == null) continue;
      const tw = curr.orders ?? 0;
      const pw = prevMap.get(curr.shopId) ?? 0;
      if (pw > 10 && tw < pw * 0.8) {
        const dropPct = ((pw - tw) / pw * 100).toFixed(0);
        events.push({
          triggerId: 'sales_drop_weekly',
          eventType: 'order_drop',
          severity: 'warning',
          shopId: curr.shopId,
          title: `Падение заказов WoW -${dropPct}%`,
          description: `Эта неделя: ${tw}, прошлая: ${pw}`,
        });
      }
    }
  }

  return events;
}

// ── Advertising Triggers ──────────────────────────────────

async function checkAdvTriggers(ctx: MonitorContext): Promise<EventCandidate[]> {
  const events: EventCandidate[] = [];
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const hasAnyAdvTrigger = ['adv_drr_high', 'adv_zero_orders', 'adv_budget_exhausted', 'adv_ctr_drop', 'adv_cpc_spike']
    .some(t => ctx.enabledTriggers.has(t));
  if (!hasAnyAdvTrigger) return events;

  // Yesterday's ad metrics aggregated by nmId (wbAdvDailyProducts has no campaignId)
  const advData = await db.select({
    nmId: wbAdvDailyProducts.nmId,
    spend: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
    orders: sql<number>`coalesce(sum(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
    revenue: sql<number>`coalesce(sum(${wbAdvDailyProducts.sumPriceKopecks}), 0)`.mapWith(Number),
    views: sql<number>`coalesce(sum(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
    clicks: sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
  })
  .from(wbAdvDailyProducts)
  .where(and(
    eq(wbAdvDailyProducts.workspaceId, ctx.wsId),
    eq(wbAdvDailyProducts.date, yesterday),
  ))
  .groupBy(wbAdvDailyProducts.nmId);

  const maxDrr = ctx.settings?.maxDrrFactPct ?? 15;

  for (const ad of advData) {
    if (ad.spend <= 0) continue;
    const name = ctx.cardMap.get(ad.nmId)?.title ?? `${ad.nmId}`;
    const drr = ad.revenue > 0 ? (ad.spend / ad.revenue) * 100 : 100;

    // adv_zero_orders
    if (ctx.enabledTriggers.has('adv_zero_orders') && ad.orders === 0 && ad.spend > 500_00) {
      events.push({
        triggerId: 'adv_zero_orders',
        eventType: 'margin_drop',
        severity: 'critical',
        title: `Реклама без заказов: ${name}`,
        description: `Расход ${(ad.spend / 100).toFixed(0)} ₽, заказов: 0`,
        nmId: ad.nmId,
        productTitle: name,
        suggestedAction: 'pause_ads',
        meta: { nmId: ad.nmId, spend: ad.spend },
      });
    }

    // adv_drr_high
    if (ctx.enabledTriggers.has('adv_drr_high') && drr > maxDrr && ad.revenue > 0) {
      events.push({
        triggerId: 'adv_drr_high',
        eventType: 'margin_drop',
        severity: 'warning',
        title: `ДРР ${drr.toFixed(1)}% (порог ${maxDrr}%): ${name}`,
        description: `Расход ${(ad.spend / 100).toFixed(0)} ₽, выручка ${(ad.revenue / 100).toFixed(0)} ₽`,
        nmId: ad.nmId,
        productTitle: name,
        suggestedAction: 'pause_ads',
      });
    }
  }

  // adv_ctr_drop / adv_cpc_spike — compare yesterday vs 7-day avg
  if (ctx.enabledTriggers.has('adv_ctr_drop') || ctx.enabledTriggers.has('adv_cpc_spike')) {
    const d7ago = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const d2ago = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

    const weeklyAdv = await db.select({
      nmId: wbAdvDailyProducts.nmId,
      views: sql<number>`coalesce(sum(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
      clicks: sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
      spend: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
      days: sql<number>`count(distinct ${wbAdvDailyProducts.date})`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(and(
      eq(wbAdvDailyProducts.workspaceId, ctx.wsId),
      gte(wbAdvDailyProducts.date, d7ago),
      lte(wbAdvDailyProducts.date, d2ago), // exclude yesterday for baseline
    ))
    .groupBy(wbAdvDailyProducts.nmId);

    const weeklyMap = new Map(weeklyAdv.map(w => [w.nmId, w]));

    for (const ad of advData) {
      if (ad.spend <= 0) continue;
      const name = ctx.cardMap.get(ad.nmId)?.title ?? `${ad.nmId}`;
      const baseline = weeklyMap.get(ad.nmId);
      if (!baseline || baseline.days < 3) continue;

      // CTR drop
      if (ctx.enabledTriggers.has('adv_ctr_drop') && ad.views > 100) {
        const ctrYesterday = ad.clicks > 0 && ad.views > 0 ? (ad.clicks / ad.views) * 100 : 0;
        const ctrAvg = baseline.clicks > 0 && baseline.views > 0
          ? (baseline.clicks / baseline.views) * 100 : 0;
        if (ctrAvg > 0.5 && ctrYesterday < ctrAvg * 0.8) {
          const dropPct = ((ctrAvg - ctrYesterday) / ctrAvg * 100).toFixed(0);
          events.push({
            triggerId: 'adv_ctr_drop',
            eventType: 'margin_drop',
            severity: 'info',
            title: `CTR упал −${dropPct}%: ${name}`,
            description: `CTR ${ctrYesterday.toFixed(2)}% (среднее ${ctrAvg.toFixed(2)}%)`,
            nmId: ad.nmId,
            productTitle: name,
            meta: { ctrYesterday: Number(ctrYesterday.toFixed(2)), ctrAvg: Number(ctrAvg.toFixed(2)) },
          });
        }
      }

      // CPC spike
      if (ctx.enabledTriggers.has('adv_cpc_spike') && ad.clicks > 0) {
        const cpcYesterday = ad.spend / ad.clicks;
        const avgClicks = baseline.clicks / baseline.days;
        const avgSpend = baseline.spend / baseline.days;
        const cpcAvg = avgClicks > 0 ? avgSpend / avgClicks : 0;
        if (cpcAvg > 0 && cpcYesterday > cpcAvg * 1.3) {
          const spikePct = ((cpcYesterday - cpcAvg) / cpcAvg * 100).toFixed(0);
          events.push({
            triggerId: 'adv_cpc_spike',
            eventType: 'margin_drop',
            severity: 'info',
            title: `CPC вырос +${spikePct}%: ${name}`,
            description: `CPC ${(cpcYesterday / 100).toFixed(2)} ₽ (среднее ${(cpcAvg / 100).toFixed(2)} ₽)`,
            nmId: ad.nmId,
            productTitle: name,
            meta: { cpcYesterdayKop: Math.round(cpcYesterday), cpcAvgKop: Math.round(cpcAvg) },
          });
        }
      }
    }
  }

  // adv_budget_exhausted — detect campaigns where spend dropped to near-zero mid-day
  // Proxy: significant spend 2 days ago, near-zero yesterday
  if (ctx.enabledTriggers.has('adv_budget_exhausted')) {
    const d2ago = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

    const prevDaySpend = await db.select({
      nmId: wbAdvDailyProducts.nmId,
      spend: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(and(
      eq(wbAdvDailyProducts.workspaceId, ctx.wsId),
      eq(wbAdvDailyProducts.date, d2ago),
    ))
    .groupBy(wbAdvDailyProducts.nmId);

    const prevSpendMap = new Map(prevDaySpend.map(p => [p.nmId, p.spend]));

    for (const ad of advData) {
      const prevSpend = prevSpendMap.get(ad.nmId) ?? 0;
      // If previous day had good spend but yesterday dropped >90%
      if (prevSpend > 1000_00 && ad.spend < prevSpend * 0.1) {
        const name = ctx.cardMap.get(ad.nmId)?.title ?? `${ad.nmId}`;
        events.push({
          triggerId: 'adv_budget_exhausted',
          eventType: 'margin_drop',
          severity: 'warning',
          title: `Бюджет исчерпан: ${name}`,
          description: `Расход упал с ${(prevSpend / 100).toFixed(0)} ₽ до ${(ad.spend / 100).toFixed(0)} ₽`,
          nmId: ad.nmId,
          productTitle: name,
          meta: { spendYesterdayKop: ad.spend, spendPrevDayKop: prevSpend },
        });
      }
    }
  }

  return events;
}

// ── Pricing Triggers ──────────────────────────────────

async function checkPricingTriggers(ctx: MonitorContext): Promise<EventCandidate[]> {
  const events: EventCandidate[] = [];

  const hasPricingTrigger = ['price_margin_negative', 'price_spp_change', 'price_commission_change'].some(t => ctx.enabledTriggers.has(t));
  if (!hasPricingTrigger) return events;

  // Load COGS and latest prices to detect negative margin
  const cogs = await db.select({
    nmId: wbCogs.nmId,
    cogsKop: wbCogs.cogsKopecks,
  })
  .from(wbCogs)
  .where(eq(wbCogs.workspaceId, ctx.wsId));

  if (cogs.length === 0) return events;

  // Batch: fetch latest price per nmId in a single query
  const latestPrices = await db.select({
    nmId: wbPricesHistory.nmId,
    price: wbPricesHistory.price,
  })
  .from(wbPricesHistory)
  .where(and(
    eq(wbPricesHistory.workspaceId, ctx.wsId),
    sql`(${wbPricesHistory.nmId}, ${wbPricesHistory.date}) IN (
      SELECT nm_id, MAX(date) FROM wb_prices_history
      WHERE workspace_id = ${ctx.wsId}
      GROUP BY nm_id
    )`,
  ));
  const priceMap = new Map(latestPrices.map(p => [p.nmId, p.price]));

  for (const item of cogs) {
    if (item.cogsKop <= 0) continue;

    const priceKop = priceMap.get(item.nmId);
    if (!priceKop || priceKop <= 0) continue;

    const marginPct = ((priceKop - item.cogsKop) / priceKop) * 100;
    const name = ctx.cardMap.get(item.nmId)?.title ?? `${item.nmId}`;

    if (marginPct < 0) {
      events.push({
        triggerId: 'price_margin_negative',
        eventType: 'margin_drop',
        severity: 'critical',
        title: `Отрицательная маржа: ${name}`,
        description: `Маржа ${marginPct.toFixed(1)}%. Цена ${(priceKop / 100).toFixed(0)} ₽, себестоимость ${(item.cogsKop / 100).toFixed(0)} ₽`,
        nmId: item.nmId,
        productTitle: name,
        suggestedAction: 'reprice',
        meta: { priceKop, cogsKop: item.cogsKop, marginPct: Math.round(marginPct) },
      });
    }
  }

  // price_spp_change — detect SPP changes by comparing last 2 weeks of wbSppWeekly
  if (ctx.enabledTriggers.has('price_spp_change')) {
    // Get the two most recent weeks per nmId
    const sppData = await db.select({
      nmId: wbSppWeekly.nmId,
      dateFrom: wbSppWeekly.dateFrom,
      sppPctBp: wbSppWeekly.sppPctBp,
    })
    .from(wbSppWeekly)
    .where(eq(wbSppWeekly.workspaceId, ctx.wsId))
    .orderBy(desc(wbSppWeekly.dateFrom));

    // Group by nmId, take last 2
    const sppByProduct = new Map<number, { dateFrom: string; sppPctBp: number }[]>();
    for (const row of sppData) {
      const arr = sppByProduct.get(row.nmId) ?? [];
      if (arr.length < 2) {
        arr.push({ dateFrom: row.dateFrom, sppPctBp: row.sppPctBp });
        sppByProduct.set(row.nmId, arr);
      }
    }

    for (const [nmId, weeks] of sppByProduct) {
      if (weeks.length < 2) continue;
      const [current, previous] = weeks;
      const changeBp = current.sppPctBp - previous.sppPctBp;
      if (Math.abs(changeBp) >= 200) { // >=2% change
        const name = ctx.cardMap.get(nmId)?.title ?? `${nmId}`;
        const changePct = changeBp / 100;
        const direction = changePct > 0 ? 'вырос' : 'снизился';
        events.push({
          triggerId: 'price_spp_change',
          eventType: 'margin_drop',
          severity: 'info',
          title: `СПП ${direction}: ${name}`,
          description: `СПП ${direction} на ${Math.abs(changePct).toFixed(1)}% (${(previous.sppPctBp / 100).toFixed(1)}% → ${(current.sppPctBp / 100).toFixed(1)}%)`,
          nmId,
          productTitle: name,
          meta: { currentSppPct: current.sppPctBp / 100, previousSppPct: previous.sppPctBp / 100, changePct },
        });
      }
    }
  }

  // price_commission_change — УДАЛЕНО 2026-05-27.
  //
  // Триггер сравнивал «эффективную комиссию» = sum(commission_kopecks) /
  // sum(revenue_kopecks) этой недели с предыдущей. Но commission_kopecks
  // содержит компенсации, корректировки и возвраты со знаком, из-за чего
  // получались отрицательные «ставки» вроде -6.9% → 3.5%. Реальная
  // категорная комиссия меняется WB-глобально и сравнивать её
  // по-товарно бессмысленно. Когда понадобится — реализовывать через
  // /api/v1/tariffs/commission (вернёт ставку по category subjectID).

  return events;
}

// ── Content Triggers ──────────────────────────────────

async function checkContentTriggers(ctx: MonitorContext): Promise<EventCandidate[]> {
  const events: EventCandidate[] = [];
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // content_negative_review — recent reviews with rating 1-2
  if (ctx.enabledTriggers.has('content_negative_review')) {
    const negReviews = await db.select({
      nmId: marketplaceFeedbackItems.nmId,
      rating: marketplaceFeedbackItems.rating,
      text: marketplaceFeedbackItems.text,
      itemId: marketplaceFeedbackItems.itemId,
    })
    .from(marketplaceFeedbackItems)
    .where(and(
      eq(marketplaceFeedbackItems.workspaceId, ctx.wsId),
      lte(marketplaceFeedbackItems.rating, 2),
      gte(marketplaceFeedbackItems.createdAt, new Date(yesterday)),
    ))
    .limit(20);

    for (const rev of negReviews) {
      const name = (rev.nmId ? ctx.cardMap.get(rev.nmId)?.title : null) ?? `${rev.nmId ?? 'unknown'}`;
      events.push({
        triggerId: 'content_negative_review',
        eventType: 'feedback_alert',
        severity: 'warning',
        title: `Негативный отзыв (${rev.rating}★): ${name}`,
        description: (rev.text ?? '').slice(0, 200) || 'Без текста',
        nmId: rev.nmId ?? undefined,
        productTitle: name,
        suggestedAction: 'reply_feedback',
        meta: { feedbackId: rev.itemId, rating: rev.rating },
      });
    }
  }

  // content_seo_position_drop — position dropped by >20 places
  if (ctx.enabledTriggers.has('content_seo_position_drop')) {
    // Get all active keywords for workspace
    const keywords = await db.select({
      keywordId: seoKeywords.keywordId,
      keyword: seoKeywords.keyword,
    })
    .from(seoKeywords)
    .where(and(
      eq(seoKeywords.workspaceId, ctx.wsId),
      eq(seoKeywords.isActive, true),
    ));

    // Batch: fetch all snapshots for all keywords in one query, then group in JS
    if (keywords.length > 0) {
      const keywordMap = new Map(keywords.map(k => [k.keywordId, k.keyword]));

      const allSnapshots = await db.select({
        keywordId: seoPositionSnapshots.keywordId,
        position: seoPositionSnapshots.position,
        nmId: seoPositionSnapshots.nmId,
        checkedAt: seoPositionSnapshots.checkedAt,
      })
      .from(seoPositionSnapshots)
      .where(sql`${seoPositionSnapshots.keywordId} IN (${sql.join(keywords.map(k => sql`${k.keywordId}`), sql`, `)})`)
      .orderBy(desc(seoPositionSnapshots.checkedAt));

      // Group in JS — take first 2 per keyword
      const snapshotsByKw = new Map<number, typeof allSnapshots>();
      for (const snap of allSnapshots) {
        const arr = snapshotsByKw.get(snap.keywordId) ?? [];
        if (arr.length < 2) {
          arr.push(snap);
          snapshotsByKw.set(snap.keywordId, arr);
        }
      }

      for (const [kwId, snapshots] of snapshotsByKw) {
        if (snapshots.length < 2) continue;
        const [latest, previous] = snapshots;
        if (latest.position === null || previous.position === null) continue;
        const drop = latest.position - previous.position;
        if (drop >= 20) {
          const kwText = keywordMap.get(kwId) ?? `${kwId}`;
          const name = ctx.cardMap.get(latest.nmId)?.title ?? `${latest.nmId}`;
          events.push({
            triggerId: 'content_seo_position_drop',
            eventType: 'feedback_alert',
            severity: 'warning',
            title: `SEO позиция упала: "${kwText}"`,
            description: `${name}: позиция ${previous.position} → ${latest.position} (−${drop} мест)`,
            nmId: latest.nmId,
            productTitle: name,
            meta: { keyword: kwText, previousPosition: previous.position, currentPosition: latest.position, drop },
          });
        }
      }
    }
  }

  // content_rating_drop — average rating below 4.0
  if (ctx.enabledTriggers.has('content_rating_drop')) {
    const avgRatings = await db.select({
      nmId: marketplaceFeedbackItems.nmId,
      avgRating: sql<number>`avg(${marketplaceFeedbackItems.rating})`.mapWith(Number),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(marketplaceFeedbackItems)
    .where(and(
      eq(marketplaceFeedbackItems.workspaceId, ctx.wsId),
      eq(marketplaceFeedbackItems.marketplace, 'wb'),
    ))
    .groupBy(marketplaceFeedbackItems.nmId);

    for (const item of avgRatings) {
      if (!item.nmId || item.count < 5) continue; // need enough reviews
      if (item.avgRating < 4.0) {
        const name = ctx.cardMap.get(item.nmId)?.title ?? `${item.nmId}`;
        events.push({
          triggerId: 'content_rating_drop',
          eventType: 'feedback_alert',
          severity: 'warning',
          title: `Рейтинг ниже 4.0: ${name}`,
          description: `Средний рейтинг: ${item.avgRating.toFixed(1)} (${item.count} отзывов)`,
          nmId: item.nmId,
          productTitle: name,
          meta: { avgRating: Number(item.avgRating.toFixed(2)), reviewCount: item.count },
        });
      }
    }
  }

  return events;
}

// ── Main Scanner ──────────────────────────────────────

export async function runTaskMonitor(wsId: number): Promise<{ eventsCreated: number; events: EventCandidate[] }> {
  // Load settings
  const [settings] = await db.select().from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);

  // Determine enabled triggers (default: all with defaultEnabled=true)
  const enabledTriggers = new Set(
    TRIGGERS.filter(t => t.defaultEnabled).map(t => t.id)
  );

  // Load card names + shop_id once for all trigger functions. Без shop_id task-monitor мешал товары разных магазинов и ставил events.shop_id=NULL → UI не мог фильтровать по shop.
  const cards = await db.select({ nmId: wbCards.nmId, title: wbCards.title, shopId: wbCards.shopId })
    .from(wbCards).where(eq(wbCards.workspaceId, wsId));
  const cardMap = new Map<number, { title: string; shopId: number | null }>(
    cards.map(c => [Number(c.nmId), { title: c.title ?? `${c.nmId}`, shopId: c.shopId ?? null }]),
  );

  const ctx: MonitorContext = { wsId, enabledTriggers, settings, cardMap };

  // Run all trigger groups in parallel
  const [stockEvents, salesEvents, advEvents, pricingEvents, contentEvents] = await Promise.all([
    checkStockTriggers(ctx),
    checkSalesTriggers(ctx),
    checkAdvTriggers(ctx),
    checkPricingTriggers(ctx),
    checkContentTriggers(ctx),
  ]);

  const allEvents = [...stockEvents, ...salesEvents, ...advEvents, ...pricingEvents, ...contentEvents];

  // Dedup: skip candidates where the same (workspace, nm, trigger) already has
  // a pending event in the last 24h. Without this each cron tick re-creates
  // identical "OOS"/"Критически мало"/"Всплеск возвратов" rows for the same
  // products, flooding Telegram with copies of the same alert.
  let candidates = allEvents;
  if (candidates.length > 0) {
    const existing = await db.execute(sql`
      SELECT nm_id, meta->>'triggerId' AS trigger
        FROM agent_events
       WHERE workspace_id = ${wsId}
         AND status = 'pending'
         AND created_at > NOW() - INTERVAL '24 hours';
    `);
    const seen = new Set<string>();
    for (const r of existing.rows as any[]) {
      seen.add(`${r.nm_id ?? 'null'}:${r.trigger ?? ''}`);
    }
    const before = candidates.length;
    candidates = candidates.filter((e) => {
      const key = `${e.nmId ?? 'null'}:${e.triggerId}`;
      if (seen.has(key)) return false;
      seen.add(key); // also dedup within this batch
      return true;
    });
    const skipped = before - candidates.length;
    if (skipped > 0) {
      logger.info({ wsId, skipped, kept: candidates.length }, 'task monitor dedup: dropped duplicate event candidates');
    }
  }

  // Batch insert events in a transaction
  if (candidates.length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(agentEvents).values(
        candidates.map(e => ({
          workspaceId: wsId,
          shopId: e.shopId ?? (e.nmId ? (cardMap.get(e.nmId)?.shopId ?? null) : null),
          eventType: e.eventType,
          severity: e.severity,
          source: 'agent' as const,
          title: e.title,
          description: e.description,
          nmId: e.nmId ?? null,
          productTitle: e.productTitle ?? null,
          suggestedAction: e.suggestedAction ?? null,
          actionArgs: e.actionArgs ?? null,
          meta: { triggerId: e.triggerId, ...(e.meta ?? {}) },
          status: 'pending',
        }))
      );
    });
  }

  return { eventsCreated: candidates.length, events: candidates };
}

/**
 * Run task monitor for all active workspaces.
 * Called from cron job.
 */
export async function runTaskMonitorForAll(): Promise<void> {
  const { workspaces } = await import('../../db/schema.js');
  const wsList = await db.select({ wsId: workspaces.workspaceId }).from(workspaces);

  logger.info({ workspaceCount: wsList.length }, 'Running task monitor for all workspaces');

  for (const ws of wsList) {
    try {
      const result = await runTaskMonitor(ws.wsId);
      if (result.eventsCreated > 0) {
        logger.info({ wsId: ws.wsId, eventsCreated: result.eventsCreated }, 'Task monitor events created');
      }
    } catch (err) {
      logger.error({ wsId: ws.wsId, err }, 'Task monitor failed for workspace');
    }
  }
}
