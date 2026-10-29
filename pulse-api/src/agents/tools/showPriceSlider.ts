/**
 * Tool: show_price_slider — Generate price optimization widget.
 * Returns server-side projection table so client does local interpolation.
 * Business formulas stay on server — client only renders.
 */

import { db } from '../../db/client.js';
import { wbCards, wbCogs, wbFinanceWeeklyProducts, wbStocksCurrent } from '../../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';

interface ShowPriceSliderArgs {
  nmId: number;
  _workspaceId?: number;
  _shopId?: number;
}

export async function showPriceSlider(args: ShowPriceSliderArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const now = new Date();
  const d30ago = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);

  // Card info (scoped to shop — the same nmId may exist in multiple shops
  // of the same workspace; without the filter we might pull a card from a
  // different shop than the caller asked about).
  const [card] = await db
    .select({ nmId: wbCards.nmId, title: wbCards.title, vendorCode: wbCards.vendorCode })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, wsId),
      eq(wbCards.nmId, args.nmId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
    ))
    .limit(1);

  if (!card) return JSON.stringify({ error: `Товар ${args.nmId} не найден` });

  // Finance (per-unit costs)
  const finance = await db
    .select({
      revenueKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.revenueKopecks}), 0)`.mapWith(Number),
      incomeKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.incomeFromSalesKopecks}), 0)`.mapWith(Number),
      logisticsKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.logisticsKopecks}), 0)`.mapWith(Number),
      qty: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.lines}), 0)`.mapWith(Number),
    })
    .from(wbFinanceWeeklyProducts)
    .where(and(
      eq(wbFinanceWeeklyProducts.workspaceId, wsId),
      eq(wbFinanceWeeklyProducts.nmId, args.nmId),
      ...(shopId != null ? [eq(wbFinanceWeeklyProducts.shopId, shopId)] : []),
      gte(wbFinanceWeeklyProducts.dateFrom, d30ago),
    ));

  const f = finance[0] ?? { revenueKop: 0, incomeKop: 0, logisticsKop: 0, qty: 0 };
  const qty = f.qty || 1;

  // COGS
  const [cogs] = await db
    .select({ cogsKopecks: wbCogs.cogsKopecks })
    .from(wbCogs)
    .where(and(eq(wbCogs.workspaceId, wsId), eq(wbCogs.nmId, args.nmId)))
    .limit(1);

  const cogsPerUnit = cogs?.cogsKopecks ?? 0;
  const logisticsPerUnit = Math.round(f.logisticsKop / qty);
  const commissionPerUnit = Math.round((f.revenueKop - f.incomeKop) / qty); // WB commission = revenue - income
  const currentPriceKop = Math.round(f.revenueKop / qty);
  const fixedCosts = logisticsPerUnit + commissionPerUnit + cogsPerUnit;

  // Generate projection table: price points from -30% to +30% in 5% steps
  const ELASTICITY = -1.5;
  const projections: Array<{
    priceKop: number;
    priceRub: number;
    changePct: number;
    projectedQty: number;
    profitPerUnit: number;
    marginPct: number;
    totalProfit: number;
    revenueKop: number;
  }> = [];

  for (let pct = -30; pct <= 30; pct += 5) {
    const newPrice = Math.round(currentPriceKop * (1 + pct / 100));
    if (newPrice <= 0) continue;

    const qtyChange = pct * ELASTICITY;
    const projQty = Math.max(0, Math.round(qty * (1 + qtyChange / 100)));
    const profit = newPrice - fixedCosts;
    const margin = newPrice > 0 ? (profit / newPrice) * 100 : 0;

    projections.push({
      priceKop: newPrice,
      priceRub: Math.round(newPrice / 100),
      changePct: pct,
      projectedQty: projQty,
      profitPerUnit: profit,
      marginPct: +margin.toFixed(1),
      totalProfit: profit * projQty,
      revenueKop: newPrice * projQty,
    });
  }

  const widget = {
    __widget: 'price_slider',
    props: {
      title: `Оптимизация цены: ${card.title ?? card.vendorCode}`,
      nmId: args.nmId,
      currentPriceKop,
      currentPriceRub: Math.round(currentPriceKop / 100),
      cogsKop: cogsPerUnit,
      fixedCostsKop: fixedCosts,
      avgQty30d: qty,
      projections,
      elasticityCoeff: ELASTICITY,
      disclaimer: 'Прогноз на основе линейной модели эластичности. Точность повышается с накоплением данных.',
      range: {
        minKop: projections[0]?.priceKop ?? currentPriceKop * 0.7,
        maxKop: projections[projections.length - 1]?.priceKop ?? currentPriceKop * 1.3,
        stepKop: 100, // 1 rub step
      },
    },
  };

  return JSON.stringify(widget);
}
