import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { wbOrdersSalesDailyProducts, wbStocksCurrent, wbStocksFbsCurrent } from '../db/schema.js';
import { insertInsight } from './insights.js';

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function createStockInsights(opts: {
  workspaceId: number;
  date?: string;
  minStockDays: number;
  excludedNmIds?: Set<number>;
  cooldownDays?: number;
}) {
  const date = opts.date ?? ymd(new Date());
  const minStockDays = Math.max(0, opts.minStockDays ?? 0);
  const excluded = opts.excludedNmIds ?? new Set<number>();
  const cooldownDays = opts.cooldownDays ?? 1;


  const rows = await db
    .select({
      nmId: wbStocksCurrent.nmId,
      quantity: wbStocksCurrent.quantity,
      inWayToClient: wbStocksCurrent.inWayToClient,
      inWayFromClient: wbStocksCurrent.inWayFromClient,
    })
    .from(wbStocksCurrent)
    .where(eq(wbStocksCurrent.workspaceId, opts.workspaceId));

  // FBS-остатки (склад продавца) — добавляются к FBO как буфер, чтобы не
  // алёртить «остаток 0» / «низкий остаток» для FBS-only товаров. Продавец
  // сам управляет FBS-поставкой.
  const fbsRows = await db
    .select({
      nmId: wbStocksFbsCurrent.nmId,
      quantity: sql<number>`coalesce(sum(${wbStocksFbsCurrent.quantity}), 0)`.mapWith(Number),
    })
    .from(wbStocksFbsCurrent)
    .where(eq(wbStocksFbsCurrent.workspaceId, opts.workspaceId))
    .groupBy(wbStocksFbsCurrent.nmId);
  const fbsByNm = new Map<number, number>();
  for (const r of fbsRows) fbsByNm.set(Number(r.nmId), Number(r.quantity ?? 0));

  const prev14Start = ymd(new Date(new Date(date + 'T00:00:00Z').getTime() - 14 * 24 * 3600 * 1000));
  const avgs = await db
    .select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      avgSalesCount: sql<number>`avg(${wbOrdersSalesDailyProducts.salesCount})`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(
      and(
        eq(wbOrdersSalesDailyProducts.workspaceId, opts.workspaceId),
        gte(wbOrdersSalesDailyProducts.date, prev14Start),
        lt(wbOrdersSalesDailyProducts.date, date)
      )
    )
    .groupBy(wbOrdersSalesDailyProducts.nmId);

  const avgSalesByNm = new Map<number, number>();
  for (const r of avgs) avgSalesByNm.set(Number(r.nmId), Number(r.avgSalesCount ?? 0));

  let created = 0;

  // Объединяем FBO + FBS чтобы не дубль-алёртить товары которые только на FBS.
  const allNmIds = new Set<number>([...rows.map(r => Number(r.nmId)), ...fbsByNm.keys()]);
  const fboByNm = new Map<number, { qty: number; inWayToClient: number | null; inWayFromClient: number | null }>();
  for (const r of rows) {
    fboByNm.set(Number(r.nmId), {
      qty: Number(r.quantity ?? 0),
      inWayToClient: r.inWayToClient as number | null,
      inWayFromClient: r.inWayFromClient as number | null,
    });
  }

  for (const nmId of allNmIds) {
    if (excluded.has(nmId)) continue;

    const fbo = fboByNm.get(nmId) ?? { qty: 0, inWayToClient: null, inWayFromClient: null };
    const fbsQty = fbsByNm.get(nmId) ?? 0;
    const totalQty = fbo.qty + fbsQty;
    const salesPerDay = avgSalesByNm.get(nmId) ?? 0;
    const coverDays = salesPerDay > 0 ? totalQty / salesPerDay : null;

    // stock_zero только когда нет ни FBO, ни FBS
    if (totalQty === 0) {
      const fingerprint = `stock_zero:${nmId}:${date}`;
      const res = await insertInsight({
        workspaceId: opts.workspaceId,
        nmId,
        date,
        insightType: 'stock_zero',
        category: 'stocks',
        severity: 'critical',
        score: 100,
        title: `Остатки = 0 (nmId ${nmId})`,
        description: 'Остатки на WB и на складе продавца равны 0. Проверь поставки и в пути.',
        evidence: { quantity: totalQty, fboQty: fbo.qty, fbsQty, inWayToClient: fbo.inWayToClient, inWayFromClient: fbo.inWayFromClient },
        fingerprint,
        cooldownDays,
      });
      if (res.inserted) created += 1;
      continue;
    }

    if (minStockDays > 0 && coverDays != null && coverDays < minStockDays) {
      const fingerprint = `stock_low:${nmId}:${date}`;
      const res = await insertInsight({
        workspaceId: opts.workspaceId,
        nmId,
        date,
        insightType: 'stock_low',
        category: 'stocks',
        severity: coverDays < Math.max(1, minStockDays / 2) ? 'critical' : 'warn',
        score: Math.round((minStockDays - coverDays) * 10),
        title: `Низкий остаток: ${coverDays.toFixed(1)}д < ${minStockDays}д (nmId ${nmId})`,
        description: 'Остатка не хватает на заданное число дней продаж (по среднему за последние 14 дней).',
        evidence: { quantity: totalQty, fboQty: fbo.qty, fbsQty, salesPerDay, coverDays, minStockDays },
        fingerprint,
        cooldownDays,
      });
      if (res.inserted) created += 1;
    }
  }

  return { created };
}
