/**
 * Tool: calc_unit_economics — Unit economics calculator.
 * Reuses patterns from routes/unitEconomics.ts
 */

import { db } from '../../db/client.js';
import { wbFinanceWeeklyProducts, wbCogs } from '../../db/schema.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';

interface CalcUnitEconArgs {
  nmId: number;
  currentPriceKop?: number;
  newPriceKop?: number;
  cogsKop?: number;
  _workspaceId?: number;
}

export async function calcUnitEconomics(args: CalcUnitEconArgs): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const now = new Date();
  const d30ago = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  // Get recent finance data for this product
  const finance = await db
    .select({
      revenueKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.revenueKopecks}), 0)`.mapWith(Number),
      incomeKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.incomeFromSalesKopecks}), 0)`.mapWith(Number),
      logisticsKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.logisticsKopecks}), 0)`.mapWith(Number),
      penaltyKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.penaltiesKopecks}), 0)`.mapWith(Number),
      acceptanceKop: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.paidAcceptanceKopecks}), 0)`.mapWith(Number),
      qty: sql<number>`coalesce(sum(${wbFinanceWeeklyProducts.lines}), 0)`.mapWith(Number),
    })
    .from(wbFinanceWeeklyProducts)
    .where(and(
      eq(wbFinanceWeeklyProducts.workspaceId, wsId),
      eq(wbFinanceWeeklyProducts.nmId, args.nmId),
      gte(wbFinanceWeeklyProducts.dateFrom, d30ago),
    ));

  const f = finance[0] ?? { revenueKop: 0, incomeKop: 0, logisticsKop: 0, penaltyKop: 0, acceptanceKop: 0, qty: 0 };

  // Get COGS
  const [cogs] = await db
    .select({ cogsKopecks: wbCogs.cogsKopecks })
    .from(wbCogs)
    .where(and(eq(wbCogs.workspaceId, wsId), eq(wbCogs.nmId, args.nmId)))
    .limit(1);

  const cogsPerUnit = args.cogsKop ?? cogs?.cogsKopecks ?? 0;

  // Calculate per-unit economics
  // Commission = revenue - income (WB keeps the difference)
  const qty = f.qty || 1;
  const revenuePerUnit = Math.round(f.revenueKop / qty);
  const incomePerUnit = Math.round(f.incomeKop / qty);
  const commissionPerUnit = revenuePerUnit - incomePerUnit; // implicit WB commission
  const logisticsPerUnit = Math.round(f.logisticsKop / qty);
  const penaltyPerUnit = Math.round(f.penaltyKop / qty);
  const acceptancePerUnit = Math.round(f.acceptanceKop / qty);

  const totalCostsPerUnit = logisticsPerUnit + commissionPerUnit + penaltyPerUnit + acceptancePerUnit + cogsPerUnit;
  const profitPerUnit = revenuePerUnit - totalCostsPerUnit;
  const marginPct = revenuePerUnit > 0 ? ((profitPerUnit / revenuePerUnit) * 100).toFixed(1) : '0';
  const roi = cogsPerUnit > 0 ? ((profitPerUnit / cogsPerUnit) * 100).toFixed(1) : '0';

  const result: any = {
    nmId: args.nmId,
    period: { from: d30ago, to: today },
    qtySold: f.qty,
    perUnit: {
      revenueKop: revenuePerUnit,
      logisticsKop: logisticsPerUnit,
      commissionKop: commissionPerUnit,
      penaltyKop: penaltyPerUnit,
      cogsKop: cogsPerUnit,
      totalCostsKop: totalCostsPerUnit,
      profitKop: profitPerUnit,
      marginPct: Number(marginPct),
      roi: Number(roi),
    },
  };

  // Projection for new price (linear elasticity model, coefficient -1.5)
  if (args.newPriceKop && revenuePerUnit > 0) {
    const currentPrice = args.currentPriceKop ?? revenuePerUnit;
    const priceChangePct = ((args.newPriceKop - currentPrice) / currentPrice) * 100;
    const elasticity = -1.5;
    const qtyChangePct = priceChangePct * elasticity;
    const projectedQty = Math.max(0, Math.round(f.qty * (1 + qtyChangePct / 100)));
    const projectedRevenuePerUnit = args.newPriceKop;
    const projectedProfitPerUnit = projectedRevenuePerUnit - totalCostsPerUnit + (revenuePerUnit - projectedRevenuePerUnit) * 0; // costs stay same
    const projectedTotalProfit = projectedProfitPerUnit * projectedQty;

    result.projection = {
      newPriceKop: args.newPriceKop,
      priceChangePct: +priceChangePct.toFixed(1),
      projectedQty,
      qtyChangePct: +qtyChangePct.toFixed(1),
      projectedProfitPerUnit: args.newPriceKop - totalCostsPerUnit,
      projectedMarginPct: args.newPriceKop > 0 ? +(((args.newPriceKop - totalCostsPerUnit) / args.newPriceKop) * 100).toFixed(1) : 0,
      projectedTotalProfitKop: (args.newPriceKop - totalCostsPerUnit) * projectedQty,
      disclaimer: 'Прогноз основан на линейной модели эластичности (коэф. -1.5). Реальные результаты могут отличаться.',
    };
  }

  return JSON.stringify(result);
}
