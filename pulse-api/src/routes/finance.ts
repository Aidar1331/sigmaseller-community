import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbCards, wbFinanceDaily, wbFinanceDailyProducts, wbTagProducts, wbAdvDailyProducts, wbAdvDaily, wbCogs } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';
import { getFinanceReportsByPeriod } from '../services/financeReports.js';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function weekStart(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // 0=Mon
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function weekEnd(startIso: string): string {
  return isoDate(addDays(new Date(startIso + 'T00:00:00Z'), 6));
}

export const financeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/finance/:workspaceId', { preHandler: requireRole('supervisor') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        nmIds: z.string().optional(),
        tagId: z.coerce.number().int().positive().optional(),
        mergeWeeks: z.enum(['0', '1']).optional(),
        mergeProducts: z.enum(['0', '1']).optional(),
        rounding: z.enum(['standard', 'raw']).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    
    const shopId = query.shopId;

    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));

    const mergeWeeks = (query.mergeWeeks ?? '0') === '1';
    const mergeProducts = (query.mergeProducts ?? '0') === '1';
    const rounding = query.rounding ?? 'standard';

    let nmIds = (query.nmIds ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    // If tagId provided, get nmIds for that tag
    if (query.tagId) {
      const taggedCards = await db
        .select({ nmId: wbTagProducts.nmId })
        .from(wbTagProducts)
        .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.tagId, query.tagId)));
      const taggedNmIds = taggedCards.map((r) => r.nmId);
      if (nmIds.length > 0) {
        // Intersection of requested nmIds and tagged nmIds
        const taggedSet = new Set(taggedNmIds);
        nmIds = nmIds.filter((id) => taggedSet.has(id));
      } else {
        nmIds = taggedNmIds;
      }
      if (nmIds.length === 0) {
        return { workspaceId: params.workspaceId, start, end, mergeWeeks, mergeProducts, rows: [] };
      }
    }

    // Try product-level table first; fall back to aggregate table if empty
    const prodWhere = [eq(wbFinanceDailyProducts.workspaceId, params.workspaceId), buildShopFilter(wbFinanceDailyProducts.shopId, shopId), gte(wbFinanceDailyProducts.date, start), lte(wbFinanceDailyProducts.date, end)].filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (nmIds.length > 0) prodWhere.push(inArray(wbFinanceDailyProducts.nmId, nmIds as any));

    let rows = await db
      .select()
      .from(wbFinanceDailyProducts)
      .where(and(...prodWhere));

    // Fallback: use aggregate wbFinanceDaily when product-level table is empty
    let usedAggregate = false;
    if (rows.length === 0 && nmIds.length === 0) {
      const aggWhere = [eq(wbFinanceDaily.workspaceId, params.workspaceId), buildShopFilter(wbFinanceDaily.shopId, shopId), gte(wbFinanceDaily.date, start), lte(wbFinanceDaily.date, end)].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const aggRows = await db.select().from(wbFinanceDaily).where(and(...aggWhere));
      // Map aggregate column names to product-level column names
      rows = aggRows.map((r) => ({
        ...r,
        nmId: 0,
        revenueKopecks: r.retailKopecks,
        incomeFromSalesKopecks: r.payoutKopecks,
        penaltiesKopecks: r.penaltyKopecks,
        additionalPaymentsKopecks: r.additionalPaymentKopecks,
      })) as any;
      usedAggregate = true;
    }

    // Load ad spend data for the same period
    const advWhere = [eq(wbAdvDailyProducts.workspaceId, params.workspaceId), gte(wbAdvDailyProducts.date, start), lte(wbAdvDailyProducts.date, end)].filter(Boolean);
    if (shopId) advWhere.push(buildShopFilter(wbAdvDailyProducts.shopId, shopId)!);
    if (nmIds.length > 0) advWhere.push(inArray(wbAdvDailyProducts.nmId, nmIds as any));
    const advRows = await db
      .select({ date: wbAdvDailyProducts.date, nmId: wbAdvDailyProducts.nmId, spendKopecks: wbAdvDailyProducts.spendKopecks })
      .from(wbAdvDailyProducts)
      .where(and(...advWhere.filter((c): c is NonNullable<typeof c> => c !== undefined)));
    // Build lookup: date|nmId → spendKopecks
    const advLookup = new Map<string, number>();
    let advFullstatsTotal = 0;
    for (const a of advRows) {
      const key = `${a.date}|${a.nmId}`;
      const v = a.spendKopecks ?? 0;
      advLookup.set(key, (advLookup.get(key) ?? 0) + v);
      advFullstatsTotal += v;
    }
    // Шкалируем per-nm-per-day доли (/v3/fullstats) к фактическому total из
    // /adv/v1/upd (совпадает с xlsx ЛК ВБ).
    const advTotalRow: any = await db.execute(sql`
      SELECT COALESCE(SUM(upd_sum_kopecks), 0) AS adv_kop
        FROM wb_adv_finance
       WHERE workspace_id = ${params.workspaceId}
         AND upd_date BETWEEN ${start} AND ${end}
         ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
    `);
    const advFinanceTotal = Number(((advTotalRow.rows ?? advTotalRow) as any[])[0]?.adv_kop ?? 0);
    if (advFullstatsTotal > 0 && advFinanceTotal > 0 && advFinanceTotal !== advFullstatsTotal) {
      const scale = advFinanceTotal / advFullstatsTotal;
      for (const [k, v] of advLookup) advLookup.set(k, Math.round(v * scale));
    }

    // Load COGS data
    const cogsWhere = [eq(wbCogs.workspaceId, params.workspaceId)];
    if (nmIds.length > 0) cogsWhere.push(inArray(wbCogs.nmId, nmIds as any));
    const cogsRows = await db.select({ nmId: wbCogs.nmId, cogsKopecks: wbCogs.cogsKopecks }).from(wbCogs).where(and(...cogsWhere));
    const cogsLookup = new Map(cogsRows.map((r) => [r.nmId, r.cogsKopecks ?? 0]));

    // attach vendorCode, title, mainPhotoUrl (2026-06-01 — for table UI)
    const cardRows = nmIds.length
      ? await db
          .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title, mainPhotoUrl: wbCards.mainPhotoUrl })
          .from(wbCards)
          .where(and(eq(wbCards.workspaceId, params.workspaceId), inArray(wbCards.nmId, nmIds as any)))
      : [];
    const vendorByNm = new Map(cardRows.map((r) => [r.nmId, r.vendorCode] as const));
    const cardByNm = new Map(cardRows.map((r) => [r.nmId, { title: r.title, mainPhotoUrl: r.mainPhotoUrl }] as const));

    type Agg = {
      lines: number;
      revenueKopecks: number;
      incomeFromSalesKopecks: number;
      commissionKopecks: number;
      logisticsKopecks: number;
      returnLogisticsKopecks: number;
      paidAcceptanceKopecks: number;
      storageKopecks: number;
      penaltiesKopecks: number;
      otherHoldKopecks: number;
      acquiringKopecks: number;
      additionalPaymentsKopecks: number;
      advSpendKopecks: number;
      cogsKopecks: number;
    };

    function empty(): Agg {
      return {
        lines: 0,
        revenueKopecks: 0,
        incomeFromSalesKopecks: 0,
        commissionKopecks: 0,
        logisticsKopecks: 0,
        returnLogisticsKopecks: 0,
        paidAcceptanceKopecks: 0,
        storageKopecks: 0,
        penaltiesKopecks: 0,
        otherHoldKopecks: 0,
        acquiringKopecks: 0,
        additionalPaymentsKopecks: 0,
        advSpendKopecks: 0,
        cogsKopecks: 0,
      };
    }

    const byKey = new Map<string, { bucketStart: string; bucketEnd: string; nmId: number; vendorCode: string | null; a: Agg }>();

    for (const r of rows as any[]) {
      const date = String(r.date);
      const bucketStart = mergeWeeks ? weekStart(date) : date;
      const bucketEnd = mergeWeeks ? weekEnd(bucketStart) : date;
      const nmId = mergeProducts ? 0 : Number(r.nmId);

      const key = `${bucketStart}→${bucketEnd}|${nmId}`;
      const cur = byKey.get(key);
      const a = cur?.a ?? empty();

      a.lines += Number(r.lines ?? 0);
      a.revenueKopecks += Number(r.revenueKopecks ?? 0);
      a.incomeFromSalesKopecks += Number(r.incomeFromSalesKopecks ?? 0);
      a.commissionKopecks += Number(r.commissionKopecks ?? 0);
      a.logisticsKopecks += Number(r.logisticsKopecks ?? 0);
      a.returnLogisticsKopecks += Number(r.returnLogisticsKopecks ?? 0);
      a.paidAcceptanceKopecks += Number(r.paidAcceptanceKopecks ?? 0);
      a.storageKopecks += Number(r.storageKopecks ?? 0);
      a.penaltiesKopecks += Number(r.penaltiesKopecks ?? 0);
      a.otherHoldKopecks += Number(r.otherHoldKopecks ?? 0);
      a.acquiringKopecks += Number(r.acquiringKopecks ?? 0);
      a.additionalPaymentsKopecks += Number(r.additionalPaymentsKopecks ?? 0);

      // Add ad spend from lookup
      const advKey = `${date}|${Number(r.nmId)}`;
      a.advSpendKopecks += advLookup.get(advKey) ?? 0;
      // Add COGS (per unit × фактически проданные − возвращённые штуки).
      // sale_qty — реальные продажи (docType='Продажа'), returns_count —
      // возвраты. Если товар продан и возвращён, его cogs не должен
      // оставаться в расходах.
      const unitCogs = cogsLookup.get(Number(r.nmId)) ?? 0;
      const soldQty = Number(r.saleQty ?? r.lines ?? 1);
      const returnedQty = Number(r.returnsCount ?? 0);
      a.cogsKopecks += unitCogs * Math.max(0, soldQty - returnedQty);

      if (!cur) {
        byKey.set(key, {
          bucketStart,
          bucketEnd,
          nmId,
          vendorCode: nmId ? vendorByNm.get(nmId) ?? null : null,
          a,
        });
      }
    }

    const round2 = (x: number) => Math.round(x * 100) / 100;
    const toRub = (k: number) => k / 100;

    const out = Array.from(byKey.values())
      .map((x) => {
        const revenueRub = toRub(x.a.revenueKopecks);
        const pct = (v: number) => (revenueRub > 0 ? Math.round((v / revenueRub) * 100) : 0);

        const seg = {
          revenueRub,
          incomeFromSalesRub: toRub(x.a.incomeFromSalesKopecks),

          // WB reportDetailByPeriod often stores costs as negative amounts.
          // For "finance" UI we expose costs as positive numbers.
          commissionRub: Math.abs(toRub(x.a.commissionKopecks)),
          logisticsRub: Math.abs(toRub(x.a.logisticsKopecks)),
          returnLogisticsRub: Math.abs(toRub(x.a.returnLogisticsKopecks)),
          paidAcceptanceRub: Math.abs(toRub(x.a.paidAcceptanceKopecks)),
          storageRub: Math.abs(toRub(x.a.storageKopecks)),
          penaltiesRub: Math.abs(toRub(x.a.penaltiesKopecks)),
          otherHoldRub: Math.abs(toRub(x.a.otherHoldKopecks)),
          acquiringRub: Math.abs(toRub(x.a.acquiringKopecks)),

          // additional payments can be positive or negative adjustments
          additionalPaymentsRub: toRub(x.a.additionalPaymentsKopecks),

          // Advertising spend
          advSpendRub: Math.abs(toRub(x.a.advSpendKopecks)),
          // Cost of goods sold
          cogsRub: Math.abs(toRub(x.a.cogsKopecks)),
        };

        const segments =
          rounding === 'standard'
            ? {
                ...Object.fromEntries(Object.entries(seg).map(([k, v]) => [k, round2(v as number)])),
                pct: {
                  incomeFromSales: pct(seg.incomeFromSalesRub),
                  commission: pct(seg.commissionRub),
                  logistics: pct(seg.logisticsRub),
                  returnLogistics: pct(seg.returnLogisticsRub),
                  paidAcceptance: pct(seg.paidAcceptanceRub),
                  storage: pct(seg.storageRub),
                  penalties: pct(seg.penaltiesRub),
                  otherHold: pct(seg.otherHoldRub),
                  acquiring: pct(seg.acquiringRub),
                  additionalPayments: pct(seg.additionalPaymentsRub),
                  advSpend: pct(seg.advSpendRub),
                  cogs: pct(seg.cogsRub),
                },
              }
            : {
                ...seg,
                pct: {
                  incomeFromSales: pct(seg.incomeFromSalesRub),
                  commission: pct(seg.commissionRub),
                  logistics: pct(seg.logisticsRub),
                  returnLogistics: pct(seg.returnLogisticsRub),
                  paidAcceptance: pct(seg.paidAcceptanceRub),
                  storage: pct(seg.storageRub),
                  penalties: pct(seg.penaltiesRub),
                  otherHold: pct(seg.otherHoldRub),
                  acquiring: pct(seg.acquiringRub),
                  additionalPayments: pct(seg.additionalPaymentsRub),
                  advSpend: pct(seg.advSpendRub),
                  cogs: pct(seg.cogsRub),
                },
              };

        const card = x.nmId ? cardByNm.get(x.nmId) : null;
        return {
          bucketStart: x.bucketStart,
          bucketEnd: x.bucketEnd,
          nmId: x.nmId,
          vendorCode: x.vendorCode,
          title: card?.title ?? null,
          mainPhotoUrl: card?.mainPhotoUrl ?? null,
          lines: x.a.lines,
          segments,
        };
      })
      .sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : a.nmId - b.nmId));

    return { workspaceId: params.workspaceId, start, end, mergeWeeks, mergeProducts, rows: out };
  });

  // ═══════════════════════════════════════════════
  // SHOP-LEVEL TOTALS (Хранение/Удержания/Промо/Штрафы)
  // ═══════════════════════════════════════════════
  //
  // wb_finance_daily_products (per-product) НЕ содержит строки без nm_id
  // (хранение/удержания/штрафы приходят shop-level). Поэтому KPI «Прочее»,
  // «Промо», «Штрафы» нужно брать из wb_finance_daily (агрегат по shop),
  // иначе пользователь видит 0 там, где у WB ЛК есть реальная сумма.
  app.get('/finance/:workspaceId/shop-totals', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      from: z.string(),
      to: z.string(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const { wbFinanceDaily } = await import('../db/schema.js');
    const { gte, lte } = await import('drizzle-orm');

    const conds: any[] = [
      eq(wbFinanceDaily.workspaceId, params.workspaceId),
      gte(wbFinanceDaily.date, query.from),
      lte(wbFinanceDaily.date, query.to),
    ];
    if (query.shopId != null) conds.push(eq(wbFinanceDaily.shopId, query.shopId));

    const [row] = await db
      .select({
        retailKop: sql<number>`coalesce(sum(${wbFinanceDaily.retailKopecks}), 0)`.mapWith(Number),
        payoutKop: sql<number>`coalesce(sum(${wbFinanceDaily.payoutKopecks}), 0)`.mapWith(Number),
        logisticsKop: sql<number>`coalesce(sum(${wbFinanceDaily.logisticsKopecks}), 0)`.mapWith(Number),
        storageKop: sql<number>`coalesce(sum(${wbFinanceDaily.storageKopecks}), 0)`.mapWith(Number),
        otherHoldKop: sql<number>`coalesce(sum(${wbFinanceDaily.otherHoldKopecks}), 0)`.mapWith(Number),
        promotionKop: sql<number>`coalesce(sum(${wbFinanceDaily.promotionKopecks}), 0)`.mapWith(Number),
        penaltyKop: sql<number>`coalesce(sum(${wbFinanceDaily.penaltyKopecks}), 0)`.mapWith(Number),
        acquiringKop: sql<number>`coalesce(sum(${wbFinanceDaily.acquiringKopecks}), 0)`.mapWith(Number),
        paidAcceptanceKop: sql<number>`coalesce(sum(${wbFinanceDaily.paidAcceptanceKopecks}), 0)`.mapWith(Number),
      })
      .from(wbFinanceDaily)
      .where(and(...conds));

    const toRub = (k: number) => Math.round(Math.abs(Number(k) ?? 0) / 100);
    return {
      from: query.from,
      to: query.to,
      shopId: query.shopId ?? null,
      totals: {
        retailRub: toRub(row?.retailKop ?? 0),
        payoutRub: toRub(row?.payoutKop ?? 0),
        logisticsRub: toRub(row?.logisticsKop ?? 0),
        storageRub: toRub(row?.storageKop ?? 0),
        otherHoldRub: toRub(row?.otherHoldKop ?? 0),
        promotionRub: toRub(row?.promotionKop ?? 0),
        penaltyRub: toRub(row?.penaltyKop ?? 0),
        acquiringRub: toRub(row?.acquiringKop ?? 0),
        paidAcceptanceRub: toRub(row?.paidAcceptanceKop ?? 0),
      },
    };
  });

  // ═══════════════════════════════════════════════
  // STORAGE (Хранение)
  // ═══════════════════════════════════════════════

  app.get('/finance/:workspaceId/storage', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      nmId: z.coerce.number().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const { wbStorageDaily } = await import('../db/schema.js');
    const { gte, lte, desc } = await import('drizzle-orm');

    const today = new Date();
    const dateTo = query.to || today.toISOString().slice(0, 10);
    const dateFrom = query.from || new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const shopId = query.shopId;

    let whereConditions: any[] = [
      eq(wbStorageDaily.workspaceId, params.workspaceId),
      buildShopFilter(wbStorageDaily.shopId, shopId),
      gte(wbStorageDaily.date, new Date(dateFrom)),
      lte(wbStorageDaily.date, new Date(dateTo)),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    if (query.nmId) {
      whereConditions.push(eq(wbStorageDaily.nmId, query.nmId));
    }

    const rows = await db
      .select()
      .from(wbStorageDaily)
      .where(and(...whereConditions))
      .orderBy(desc(wbStorageDaily.date))
      .limit(50000);

    // Calculate totals
    const totalCost = rows.reduce((sum, r) => sum + (r.cost || 0), 0);
    const totalVolume = rows.reduce((sum, r) => sum + (r.volume || 0), 0);

    // Агрегат по артикулам (топ-100 по стоимости)
    const byNmMap = new Map<number, { cost: number; volume: number; days: number }>();
    for (const r of rows) {
      const nm = Number(r.nmId);
      if (!nm) continue;
      const prev = byNmMap.get(nm) ?? { cost: 0, volume: 0, days: 0 };
      prev.cost += Number(r.cost) || 0;
      prev.volume += Number(r.volume) || 0;
      prev.days += 1;
      byNmMap.set(nm, prev);
    }
    const nmIdsArr = Array.from(byNmMap.keys());
    const cardRows: any = nmIdsArr.length ? await db.execute(sql`
      SELECT nm_id, COALESCE(title, '') AS title,
             COALESCE(vendor_code, '') AS vendor_code,
             COALESCE(main_photo_url, '') AS photo
        FROM wb_cards
       WHERE workspace_id = ${params.workspaceId}
         AND nm_id = ANY(${sql.raw(`ARRAY[${nmIdsArr.join(',')}]::bigint[]`)})
    `) : { rows: [] };
    const cardMap = new Map<number, { title: string; vendorCode: string; photo: string }>();
    for (const c of (cardRows.rows ?? cardRows) as any[]) {
      cardMap.set(Number(c.nm_id), { title: c.title ?? '', vendorCode: c.vendor_code ?? '', photo: c.photo ?? '' });
    }
    const byNm = Array.from(byNmMap.entries())
      .map(([nm, v]) => {
        const card = cardMap.get(nm);
        return {
          nmId: nm,
          vendorCode: card?.vendorCode ?? '',
          title: card?.title ?? '',
          photo: card?.photo || null,
          costKop: v.cost,
          volume: Math.round(v.volume * 1000) / 1000,
          days: v.days,
        };
      })
      .sort((a, b) => b.costKop - a.costKop)
      .slice(0, 100);

    return {
      workspaceId: params.workspaceId,
      dateFrom,
      dateTo,
      rows,
      byNm,
      totals: {
        cost: totalCost,
        volume: totalVolume,
        count: rows.length,
        items: byNm.length,
      },
    };
  });

  // ═══════════════════════════════════════════════
  // DEDUCTIONS (Штрафы и удержания)
  // ═══════════════════════════════════════════════

  app.get('/finance/:workspaceId/deductions', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      from: z.string().optional(),
      dateFrom: z.string().optional(),
      to: z.string().optional(),
      dateTo: z.string().optional(),
      type: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const today = isoDate(new Date());
    const dateTo = query.to ?? query.dateTo ?? today;
    const dateFrom = query.from ?? query.dateFrom ?? isoDate(addDays(new Date(dateTo + 'T00:00:00Z'), -30));
    const shopId = query.shopId;

    // Per-day агрегаты — штрафы + «Прочие удержания» (deduction_kopecks):
    // источник = wb_finance_reports (так совпадает с xlsx ЛК ВБ).
    const daily: any = await db.execute(sql`
      SELECT date_from AS date,
             SUM(penalty_kopecks) AS penalty_kop,
             SUM(deduction_kopecks) AS deduction_kop
        FROM wb_finance_reports
       WHERE workspace_id = ${params.workspaceId}
         ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
         AND report_type = 1
         AND date_from BETWEEN ${dateFrom} AND ${dateTo}
       GROUP BY date_from
       ORDER BY date_from DESC
    `);

    // Per-nm штрафы (там где есть привязка к артикулу).
    const byNm: any = await db.execute(sql`
      SELECT fdp.nm_id,
             COALESCE(wc.vendor_code, '') AS vendor_code,
             COALESCE(wc.title, '') AS title,
             COALESCE(wc.main_photo_url, '') AS photo,
             SUM(fdp.penalties_kopecks) AS penalty_kop
        FROM wb_finance_daily_products fdp
        LEFT JOIN wb_cards wc ON wc.workspace_id = fdp.workspace_id AND wc.nm_id = fdp.nm_id
       WHERE fdp.workspace_id = ${params.workspaceId}
         ${shopId ? sql`AND fdp.shop_id = ${shopId}` : sql``}
         AND fdp.date BETWEEN ${dateFrom} AND ${dateTo}
         AND fdp.penalties_kopecks > 0
       GROUP BY fdp.nm_id, wc.vendor_code, wc.title, wc.main_photo_url
       ORDER BY penalty_kop DESC
       LIMIT 100
    `);

    const dailyRows = (daily.rows ?? daily) as any[];
    const totalPenaltyKop = dailyRows.reduce((s, r) => s + Number(r.penalty_kop ?? 0), 0);
    const totalDeductionKop = dailyRows.reduce((s, r) => s + Number(r.deduction_kop ?? 0), 0);

    return {
      workspaceId: params.workspaceId,
      dateFrom,
      dateTo,
      totals: {
        penaltyRub: Math.round(totalPenaltyKop / 100),
        deductionRub: Math.round(totalDeductionKop / 100),
        totalRub: Math.round((totalPenaltyKop + totalDeductionKop) / 100),
        days: dailyRows.length,
        items: (byNm.rows ?? byNm).length,
      },
      daily: dailyRows.map((r) => ({
        date: r.date,
        penaltyRub: Math.round(Number(r.penalty_kop ?? 0) / 100),
        deductionRub: Math.round(Number(r.deduction_kop ?? 0) / 100),
      })),
      byNm: ((byNm.rows ?? byNm) as any[]).map((r) => ({
        nmId: Number(r.nm_id),
        vendorCode: r.vendor_code ?? '',
        title: r.title ?? '',
        photo: r.photo ?? null,
        penaltyRub: Math.round(Number(r.penalty_kop ?? 0) / 100),
      })),
    };
  });

  // P&L по неделям (аналог Торгстат)
  app.get('/finance/:workspaceId/pnl', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      groupBy: z.enum(['day', 'week', 'month']).optional(),
      shopId: z.coerce.number().int().positive().optional(),
      taxRate: z.coerce.number().optional(),
    }).parse(req.query);

    const shopId = query.shopId;
    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -90));
    const groupBy = query.groupBy ?? 'week';
    const taxRatePct = query.taxRate ?? 15;
    const taxRate = taxRatePct > 1 ? taxRatePct / 100 : taxRatePct;

    // Группировка по периодам
    let dateExpr: ReturnType<typeof sql>;
    if (groupBy === 'day') {
      dateExpr = sql<string>`${wbFinanceDaily.date}`;
    } else if (groupBy === 'month') {
      dateExpr = sql<string>`to_char(${wbFinanceDaily.date}::date, 'YYYY-MM')`;
    } else {
      // week - начало недели (понедельник)
      dateExpr = sql<string>`to_char(date_trunc('week', ${wbFinanceDaily.date}::date), 'YYYY-MM-DD')`;
    }

    const financeData = await db
      .select({
        period: dateExpr.as('period'),
        // Выручка
        retailKopecks: sql<number>`sum(${wbFinanceDaily.retailKopecks})`.as('retailKopecks'),
        sppKopecks: sql<number>`sum(${wbFinanceDaily.sppAmountKopecks})`.as('sppKopecks'),
        payoutKopecks: sql<number>`sum(${wbFinanceDaily.payoutKopecks})`.as('payoutKopecks'),
        // Удержания
        commissionKopecks: sql<number>`sum(${wbFinanceDaily.commissionKopecks})`.as('commissionKopecks'),
        ppvzVwKopecks: sql<number>`sum(${wbFinanceDaily.ppvzVwKopecks})`.as('ppvzVwKopecks'),
        logisticsKopecks: sql<number>`sum(${wbFinanceDaily.logisticsKopecks})`.as('logisticsKopecks'),
        returnLogisticsKopecks: sql<number>`sum(${wbFinanceDaily.returnLogisticsKopecks})`.as('returnLogisticsKopecks'),
        storageKopecks: sql<number>`sum(${wbFinanceDaily.storageKopecks})`.as('storageKopecks'),
        penaltyKopecks: sql<number>`sum(${wbFinanceDaily.penaltyKopecks})`.as('penaltyKopecks'),
        acquiringKopecks: sql<number>`sum(${wbFinanceDaily.acquiringKopecks})`.as('acquiringKopecks'),
        otherHoldKopecks: sql<number>`sum(${wbFinanceDaily.otherHoldKopecks})`.as('otherHoldKopecks'),
        additionalPaymentKopecks: sql<number>`sum(${wbFinanceDaily.additionalPaymentKopecks})`.as('additionalPaymentKopecks'),
        paidAcceptanceKopecks: sql<number>`sum(${wbFinanceDaily.paidAcceptanceKopecks})`.as('paidAcceptanceKopecks'),
        // Счётчики
        lines: sql<number>`sum(${wbFinanceDaily.lines})`.as('lines'),
        returnsCount: sql<number>`sum(${wbFinanceDaily.returnsCount})`.as('returnsCount'),
      })
      .from(wbFinanceDaily)
      .where(
        and(
          eq(wbFinanceDaily.workspaceId, params.workspaceId),
          gte(wbFinanceDaily.date, start),
          lte(wbFinanceDaily.date, end),
          buildShopFilter(wbFinanceDaily.shopId, shopId),
        )
      )
      .groupBy(dateExpr)
      .orderBy(dateExpr);

    // Adv spend per period — источник `wb_adv_finance` (/adv/v1/upd =
    // фактические списания, совпадает с xlsx «История затрат»).
    // Раньше тянули из wb_adv_daily_products (/v3/fullstats) — это метрики
    // РК, не списания. Расходились с ЛК ВБ в ~2×.
    const advPeriodExpr =
      groupBy === 'day' ? sql`upd_date`
      : groupBy === 'month' ? sql`to_char(upd_date::date, 'YYYY-MM')`
      : sql`to_char(date_trunc('week', upd_date::date), 'YYYY-MM-DD')`;
    const advRaw: any = await db.execute(sql`
      SELECT ${advPeriodExpr} AS period,
             COALESCE(SUM(upd_sum_kopecks), 0) AS adv_kop
        FROM wb_adv_finance
       WHERE workspace_id = ${params.workspaceId}
         AND upd_date BETWEEN ${start} AND ${end}
         ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
       GROUP BY ${advPeriodExpr}
    `);
    const advMap = new Map<string, number>(
      ((advRaw.rows ?? advRaw) as any[]).map((r) => [String(r.period), Number(r.adv_kop) || 0])
    );

    // COGS per period — джойним wb_finance_daily_products (per-nm_id) с wb_cogs
    // (справочник). себестоимость = cogs_kopecks × lines (кол-во строк = продаж).
    let cogsDateExpr: ReturnType<typeof sql>;
    if (groupBy === 'day') cogsDateExpr = sql<string>`${wbFinanceDailyProducts.date}`;
    else if (groupBy === 'month') cogsDateExpr = sql<string>`to_char(${wbFinanceDailyProducts.date}::date, 'YYYY-MM')`;
    else cogsDateExpr = sql<string>`to_char(date_trunc('week', ${wbFinanceDailyProducts.date}::date), 'YYYY-MM-DD')`;
    const cogsRaw = await db.execute(sql`
      SELECT ${cogsDateExpr} AS period,
        COALESCE(SUM(COALESCE(c.cogs_kopecks, 0) * GREATEST(0, fdp.sale_qty - COALESCE(fdp.returns_count, 0))), 0) AS cogs_kop,
        COUNT(DISTINCT fdp.nm_id) FILTER (WHERE c.cogs_kopecks IS NULL OR c.cogs_kopecks = 0) AS nm_without_cogs
      FROM ${wbFinanceDailyProducts} fdp
      LEFT JOIN ${wbCogs} c ON c.workspace_id = fdp.workspace_id AND c.nm_id = fdp.nm_id
      WHERE fdp.workspace_id = ${params.workspaceId}
        AND fdp.date >= ${start} AND fdp.date <= ${end}
        ${shopId ? sql`AND fdp.shop_id = ${shopId}` : sql``}
      GROUP BY ${cogsDateExpr}
    `);
    const cogsMap = new Map<string, { kop: number; gaps: number }>();
    for (const row of (cogsRaw.rows ?? []) as any[]) {
      cogsMap.set(String(row.period), {
        kop: Number(row.cogs_kop) || 0,
        gaps: Number(row.nm_without_cogs) || 0,
      });
    }

    // Преобразуем в P&L структуру
    const rows = financeData.map(r => {
      const period = String(r.period);
      
      // Выручка
      const revenueRub = Number(r.retailKopecks) / 100;
      const sppRub = Number(r.sppKopecks) / 100;
      const realizationRub = revenueRub - sppRub; // Сумма реализации (для налога)
      
      // Комиссия (правильная формула: retail - payout)
      const payoutRub = Number(r.payoutKopecks) / 100;
      const commissionRub = revenueRub - payoutRub;
      
      // Логистика
      const logisticsRub = Number(r.logisticsKopecks) / 100;
      const returnLogisticsRub = Number(r.returnLogisticsKopecks) / 100;
      const totalLogisticsRub = logisticsRub + returnLogisticsRub;
      
      // Прочие расходы
      const storageRub = Number(r.storageKopecks) / 100;
      const penaltyRub = Number(r.penaltyKopecks) / 100;
      const acquiringRub = Number(r.acquiringKopecks) / 100;
      const otherHoldRub = Number(r.otherHoldKopecks) / 100;
      const paidAcceptanceRub = Number(r.paidAcceptanceKopecks) / 100;
      
      // Услуги МП (Торгстат)
      const marketplaceCostsRub = commissionRub + totalLogisticsRub + storageRub + penaltyRub + acquiringRub + otherHoldRub + paidAcceptanceRub;

      // Реклама и Себестоимость — теперь учтены в чистой прибыли
      const advRub = (advMap.get(period) ?? 0) / 100;
      const cogsInfo = cogsMap.get(period);
      const cogsRub = (cogsInfo?.kop ?? 0) / 100;
      const cogsGapsCount = cogsInfo?.gaps ?? 0; // сколько nm_id без cogs

      // Валовая прибыль = Выручка - Услуги МП - COGS - Реклама
      const grossProfitRub = revenueRub - marketplaceCostsRub - cogsRub - advRub;

      // Маржинальность
      const marginPct = revenueRub > 0 ? (grossProfitRub / revenueRub) * 100 : 0;

      // Налог (от суммы реализации)
      const taxRub = realizationRub * taxRate;

      // Чистая прибыль = Валовая - Налог (валовая уже включает cogs и adv)
      const netProfitRub = grossProfitRub - taxRub;
      
      // Рентабельность
      const profitabilityPct = revenueRub > 0 ? (netProfitRub / revenueRub) * 100 : 0;
      
      // ROI = ЧП / (Выручка - ЧП)
      const costsRub = revenueRub - netProfitRub;
      const roiPct = costsRub > 0 ? (netProfitRub / costsRub) * 100 : 0;
      
      // К оплате
      const toPayRub = payoutRub + Number(r.additionalPaymentKopecks) / 100 - totalLogisticsRub - storageRub;
      
      return {
        period,
        periodEnd: groupBy === 'week' ? weekEnd(period) : period,

        // Выручка
        revenueRub: Math.round(revenueRub),
        sppRub: Math.round(sppRub),
        realizationRub: Math.round(realizationRub),

        // Удержания
        commissionRub: Math.round(commissionRub),
        logisticsRub: Math.round(totalLogisticsRub),
        storageRub: Math.round(storageRub),
        penaltyRub: Math.round(penaltyRub),
        acquiringRub: Math.round(acquiringRub),
        otherHoldRub: Math.round(otherHoldRub),

        // Себестоимость + реклама (новое)
        cogsRub: Math.round(cogsRub),
        cogsGapsCount, // сколько nm_id без cogs за этот период
        advRub: Math.round(advRub),

        // Итоги
        marketplaceCostsRub: Math.round(marketplaceCostsRub),
        grossProfitRub: Math.round(grossProfitRub),
        taxRub: Math.round(taxRub),
        netProfitRub: Math.round(netProfitRub),
        toPayRub: Math.round(toPayRub),
        
        // Метрики
        marginPct: Math.round(marginPct * 10) / 10,
        profitabilityPct: Math.round(profitabilityPct * 10) / 10,
        roiPct: Math.round(roiPct * 10) / 10,
        
        // Счётчики
        salesCount: Number(r.lines) || 0,
        returnsCount: Number(r.returnsCount) || 0,
      };
    });

    // Итоги за весь период
    const totals = {
      revenueRub: rows.reduce((s, r) => s + r.revenueRub, 0),
      sppRub: rows.reduce((s, r) => s + r.sppRub, 0),
      commissionRub: rows.reduce((s, r) => s + r.commissionRub, 0),
      logisticsRub: rows.reduce((s, r) => s + r.logisticsRub, 0),
      storageRub: rows.reduce((s, r) => s + r.storageRub, 0),
      marketplaceCostsRub: rows.reduce((s, r) => s + r.marketplaceCostsRub, 0),
      grossProfitRub: rows.reduce((s, r) => s + r.grossProfitRub, 0),
      taxRub: rows.reduce((s, r) => s + r.taxRub, 0),
      netProfitRub: rows.reduce((s, r) => s + r.netProfitRub, 0),
      toPayRub: rows.reduce((s, r) => s + r.toPayRub, 0),
      salesCount: rows.reduce((s, r) => s + r.salesCount, 0),
      returnsCount: rows.reduce((s, r) => s + r.returnsCount, 0),
    };

    const totalRevenue = totals.revenueRub;
    totals['marginPct' as keyof typeof totals] = totalRevenue > 0 ? Math.round((totals.grossProfitRub / totalRevenue) * 1000) / 10 : 0;
    totals['profitabilityPct' as keyof typeof totals] = totalRevenue > 0 ? Math.round((totals.netProfitRub / totalRevenue) * 1000) / 10 : 0;
    totals['roiPct' as keyof typeof totals] = (totalRevenue - totals.netProfitRub) > 0 
      ? Math.round((totals.netProfitRub / (totalRevenue - totals.netProfitRub)) * 1000) / 10 
      : 0;

    return {
      workspaceId: params.workspaceId,
      start,
      end,
      groupBy,
      taxRate: taxRatePct,
      rows,
      totals,
    };
  });

  /**
   * GET /finance/:ws/by-product?start=YYYY-MM-DD&end=YYYY-MM-DD&shopId=&sortBy=
   * Сводная по артикулам как в РНП:
   *   nm_id | title | выручка | комиссия | логистика | хранение | штрафы |
   *   приёмка | реклама | себестоимость | чистая прибыль
   */
  app.get('/finance/:workspaceId/by-product', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      sortBy: z.enum(['revenue', 'penalty', 'storage', 'adv', 'cogs', 'profit']).optional().default('revenue'),
      limit: z.coerce.number().int().positive().max(500).optional().default(200),
      // По какой дате группировать. 'report' (по умолчанию для финансов) = rr_date
      // = дата отчёта ВБ, совпадает с ЛК ВБ. 'sale' = sale_dt (когда продали).
      dateBasis: z.enum(['sale', 'report']).optional().default('report'),
    }).parse(req.query);

    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));
    const shopId = query.shopId;
    const dateCol = query.dateBasis === 'sale' ? sql`fdp.date` : sql`COALESCE(fdp.rr_date, fdp.date)`;

    // Финансы per nm_id (агрегированные за период).
    // Выручка («Продажа» как в ЛК ВБ) = retail_price_withdisc - СПП.
    // Pulse сохраняет retail_price_withdisc в revenue_kopecks и СПП отдельно
    // в spp_amount_kopecks — вычитаем для совпадения с xlsx ВБ.
    const finRows = await db.execute(sql`
      SELECT fdp.nm_id,
        SUM(fdp.revenue_kopecks - COALESCE(fdp.spp_amount_kopecks, 0)) AS revenue_kop,
        SUM(COALESCE(fdp.spp_amount_kopecks, 0)) AS spp_kop,
        SUM(fdp.commission_kopecks) AS commission_kop,
        SUM(fdp.logistics_kopecks + fdp.return_logistics_kopecks) AS logistics_kop,
        SUM(fdp.storage_kopecks) AS storage_kop,
        SUM(fdp.penalties_kopecks) AS penalty_kop,
        SUM(fdp.paid_acceptance_kopecks) AS acceptance_kop,
        SUM(fdp.acquiring_kopecks) AS acquiring_kop,
        SUM(COALESCE(fdp.other_hold_kopecks, 0)) AS other_hold_kop,
        SUM(COALESCE(fdp.additional_payments_kopecks, 0)) AS adjustment_kop,
        SUM(fdp.lines) AS lines,
        SUM(fdp.sale_qty) AS sale_qty,
        SUM(fdp.returns_count) AS returns
      FROM wb_finance_daily_products fdp
      WHERE fdp.workspace_id = ${params.workspaceId}
        AND ${dateCol} >= ${start} AND ${dateCol} <= ${end}
        ${shopId ? sql`AND fdp.shop_id = ${shopId}` : sql``}
      GROUP BY fdp.nm_id
    `);

    // Реклама per nm_id. Источник долей — /v3/fullstats (wb_adv_daily_products,
    // per-nm). Итог — /adv/v1/upd (wb_adv_finance, факт.списания, совпадает с
    // xlsx ЛК ВБ). Масштабируем per-nm доли так чтобы сумма = xlsx-итог.
    const advRows = await db.execute(sql`
      SELECT nm_id, SUM(spend_kopecks) AS adv_kop
      FROM wb_adv_daily_products
      WHERE workspace_id = ${params.workspaceId}
        AND date >= ${start} AND date <= ${end}
        ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
      GROUP BY nm_id
    `);
    const advRowsList = (advRows.rows ?? []) as any[];
    const advFullstatsTotal = advRowsList.reduce((s, r) => s + (Number(r.adv_kop) || 0), 0);

    const advTotalRes = await db.execute(sql`
      SELECT COALESCE(SUM(upd_sum_kopecks), 0) AS adv_kop
      FROM wb_adv_finance
      WHERE workspace_id = ${params.workspaceId}
        AND upd_date BETWEEN ${start} AND ${end}
        ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
    `);
    const advFinanceTotal = Number(((advTotalRes.rows ?? advTotalRes) as any[])[0]?.adv_kop ?? 0);

    const advScale = advFullstatsTotal > 0 ? advFinanceTotal / advFullstatsTotal : 1;
    const advMap = new Map<number, number>();
    for (const r of advRowsList) advMap.set(Number(r.nm_id), Math.round((Number(r.adv_kop) || 0) * advScale));

    // Налог УСН + НДС за период с учётом регламента магазина — берём ровно тот же
    // расчёт, что и /finance/reports (по таблице wb_finance_reports), чтобы сумма
    // налога на товарах совпадала с marginRub в Отчётах. Per-nm доля = revenue_nm /
    // revenue_total. Аппроксимация: фактически налог shop-level, на отдельный
    // артикул точно не делится, но для рейтинговой колонки «Прибыль» этого хватает.
    const { totals: reportTotals } = await getFinanceReportsByPeriod(
      params.workspaceId,
      shopId,
      start,
      end,
    );
    const totalTaxKop = Math.round(reportTotals.taxRub * 100);
    const totalVatKop = Math.round(reportTotals.vatRub * 100);

    // COGS per nm_id (cogs_kopecks × lines)
    const cogsRows = await db.execute(sql`
      SELECT nm_id, cogs_kopecks FROM wb_cogs WHERE workspace_id = ${params.workspaceId}
    `);
    const cogsLookup = new Map<number, number>();
    for (const r of (cogsRows.rows ?? []) as any[]) cogsLookup.set(Number(r.nm_id), Number(r.cogs_kopecks) || 0);

    // Карточки (title + photo + vendor_code)
    const cardRows = await db.execute(sql`
      SELECT nm_id, title, vendor_code, main_photo_url FROM wb_cards WHERE workspace_id = ${params.workspaceId}
    `);
    const cardMap = new Map<number, { title: string; vendorCode: string; photo: string | null }>();
    for (const r of (cardRows.rows ?? []) as any[]) {
      cardMap.set(Number(r.nm_id), {
        title: r.title || '',
        vendorCode: r.vendor_code || '',
        photo: r.main_photo_url || null,
      });
    }

    // 1-й проход: считаем все per-nm составляющие в копейках кроме налога,
    // чтобы получить total revenue и поделить налог пропорционально.
    // Ориентир на «Отчёты ВБ»: per-nm суммы потом scale-факторятся так,
    // чтобы итог = reports.totals (см. ниже scale_*). retail_amount per-nm
    // = (revenue + spp) — потому что reports.retail = чистая retail-выручка
    // после возвратов; СПП в неё включён.
    type ItemRaw = {
      nmId: number; lines: number; saleQty: number; returns: number;
      revKop: number; sppKop: number; commKop: number; logKop: number;
      storKop: number; penKop: number; accKop: number; acqKop: number;
      otherHoldKop: number; adjKop: number; advKop: number;
      cogsKop: number; unitCogsKop: number;
    };
    const itemsRaw: ItemRaw[] = (finRows.rows ?? []).map((r: any) => {
      const nmId = Number(r.nm_id);
      const revKop = Number(r.revenue_kop) || 0;
      const saleQty = Number(r.sale_qty) || 0;
      const returns = Number(r.returns) || 0;
      const unitCogsKop = cogsLookup.get(nmId) || 0;
      // Себестоимость = unit_cogs × (продано − возвращено), не lines.
      return {
        nmId,
        lines: Number(r.lines) || 0,
        saleQty,
        returns,
        revKop,
        sppKop: Number(r.spp_kop) || 0,
        commKop: Number(r.commission_kop) || 0,
        logKop: Number(r.logistics_kop) || 0,
        storKop: Number(r.storage_kop) || 0,
        penKop: Number(r.penalty_kop) || 0,
        accKop: Number(r.acceptance_kop) || 0,
        acqKop: Number(r.acquiring_kop) || 0,
        otherHoldKop: Number(r.other_hold_kop) || 0,
        adjKop: Number(r.adjustment_kop) || 0,
        advKop: advMap.get(nmId) || 0,
        unitCogsKop,
        cogsKop: unitCogsKop * Math.max(0, saleQty - returns),
      };
    });

    const totalRevenueKop = itemsRaw.reduce((s, it) => s + it.revKop, 0);

    // Получаем итоги из wb_finance_reports (ground-truth, копейка-в-копейку
    // с xlsx ЛК ВБ). По ним посчитаем scale-factor для каждой метрики, чтобы
    // суммы per-nm после масштабирования = итог в «Отчётах ВБ».
    const reportTotalsRes2: any = await db.execute(sql`
      SELECT COALESCE(SUM(retail_amount_kopecks), 0)   AS retail_kop,
             COALESCE(SUM(delivery_service_kopecks), 0) AS log_kop,
             COALESCE(SUM(paid_storage_kopecks), 0)    AS stor_kop,
             COALESCE(SUM(paid_acceptance_kopecks), 0) AS acc_kop,
             COALESCE(SUM(penalty_kopecks), 0)         AS pen_kop,
             COALESCE(SUM(deduction_kopecks), 0)       AS ded_kop,
             COALESCE(SUM(additional_payment_kopecks), 0) AS add_kop
        FROM wb_finance_reports
       WHERE workspace_id = ${params.workspaceId}
         ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
         AND date_from BETWEEN ${start} AND ${end}
    `);
    const rtotals = ((reportTotalsRes2.rows ?? reportTotalsRes2) as any[])[0] ?? {};

    // Итоги per-nm (то, что ВБ разнёс по артикулам в wb_finance_daily_products).
    const rawSums = {
      retail: itemsRaw.reduce((s, it) => s + it.revKop + it.sppKop, 0),
      log:    itemsRaw.reduce((s, it) => s + it.logKop, 0),
      stor:   itemsRaw.reduce((s, it) => s + it.storKop, 0),
      acc:    itemsRaw.reduce((s, it) => s + it.accKop, 0),
      pen:    itemsRaw.reduce((s, it) => s + it.penKop, 0),
      ded:    itemsRaw.reduce((s, it) => s + it.otherHoldKop, 0),
      add:    itemsRaw.reduce((s, it) => s + it.adjKop, 0),
    };

    // Reports = ground truth итогов. По требованию оператора: удержания
    // НЕ размазываем по revShare. Каждый артикул получает только то, что
    // WB реально к нему привязал. Остаток (= reports − rawSums) показываем
    // отдельным блоком «Неучтённые удержания» в UI.
    //
    // retailAmount — отдельный случай: масштабируем по reports чтобы общая
    // выручка совпала. Это пропорция размеров продажи, а не размазывание
    // расходов. Так per-nm retail отражает то же что в xlsx ЛК ВБ.
    const reportsTotals = {
      retail: Number(rtotals.retail_kop ?? 0),
      log:    Number(rtotals.log_kop ?? 0),
      stor:   Number(rtotals.stor_kop ?? 0),
      acc:    Number(rtotals.acc_kop ?? 0),
      pen:    Number(rtotals.pen_kop ?? 0),
      ded:    Number(rtotals.ded_kop ?? 0),
      add:    Number(rtotals.add_kop ?? 0),
    };
    const retailScale = rawSums.retail > 0 ? reportsTotals.retail / rawSums.retail : 1;
    // Scale-factor для каждого вида удержаний. Это размазывает «неучтённые»
    // удержания (которые ВБ не привязал к nm_id) пропорционально доле каждого
    // артикула в сумме привязанных к nm удержаний. Так per-nm total = total из
    // «Отчётов ВБ» и маржа сходится.
    const logScale  = rawSums.log  > 0 ? reportsTotals.log  / rawSums.log  : 1;
    const storScale = rawSums.stor > 0 ? reportsTotals.stor / rawSums.stor : 1;
    const accScale  = rawSums.acc  > 0 ? reportsTotals.acc  / rawSums.acc  : 1;
    const penScale  = rawSums.pen  > 0 ? reportsTotals.pen  / rawSums.pen  : 1;
    const dedScale  = rawSums.ded  > 0 ? reportsTotals.ded  / rawSums.ded  : 1;
    const addScale  = rawSums.add  > 0 ? reportsTotals.add  / rawSums.add  : 1;

    const items = itemsRaw.map((it) => {
      // Доля артикула в общей выручке периода (по revenue_kop = retail - СПП).
      const revShare = totalRevenueKop > 0 ? it.revKop / totalRevenueKop : 0;
      const taxKop = Math.round(totalTaxKop * revShare);
      const vatKop = Math.round(totalVatKop * revShare);

      // Все суммы масштабируются к итогам «Отчётов ВБ» — это размазывает
      // неучтённые удержания (без nm_id) по артикулам пропорционально.
      const retailKop    = Math.round((it.revKop + it.sppKop) * retailScale);
      const totalLogKop  = Math.round(it.logKop * logScale);
      const totalStorKop = Math.round(it.storKop * storScale);
      const totalAccKop  = Math.round(it.accKop * accScale);
      const totalPenKop  = Math.round(it.penKop * penScale);
      const totalDedKop  = Math.round(it.otherHoldKop * dedScale);
      const totalAddKop  = Math.round(it.adjKop * addScale);

      // Прибыль по формуле «Отчётов ВБ»: retail − log − stor − acc − ded − pen
      // + add − cogs − tax − vat. Реклама УЖЕ внутри deduction (поэтому
      // отдельно НЕ вычитаем). Комиссия и acquiring уже в retail (retail =
      // чистая выручка после комиссии в WB API).
      const profitKop = retailKop
        - totalLogKop - totalStorKop - totalAccKop - totalDedKop - totalPenKop
        + totalAddKop
        - it.cogsKop
        - taxKop - vatKop;

      const card = cardMap.get(it.nmId);
      return {
        nmId: it.nmId,
        title: card?.title ?? `${it.nmId}`,
        vendorCode: card?.vendorCode ?? '',
        photo: card?.photo ?? null,
        lines: it.lines,
        saleQty: it.saleQty,
        returns: it.returns,
        hasCogs: it.unitCogsKop > 0,
        revenueRub: Math.round(it.revKop / 100),
        retailAmountRub: Math.round(retailKop / 100),
        commissionRub: Math.round(it.commKop / 100),
        logisticsRub: Math.round(totalLogKop / 100),
        storageRub: Math.round(totalStorKop / 100),
        penaltyRub: Math.round(totalPenKop / 100),
        acceptanceRub: Math.round(totalAccKop / 100),
        acquiringRub: Math.round(it.acqKop / 100),
        otherHoldRub: Math.round(totalDedKop / 100),
        adjustmentRub: Math.round(totalAddKop / 100),
        advRub: Math.round(it.advKop / 100),
        cogsRub: Math.round(it.cogsKop / 100),
        taxRub: Math.round(taxKop / 100),
        vatRub: Math.round(vatKop / 100),
        profitRub: Math.round(profitKop / 100),
        // Маржинальность по формуле «Отчётов ВБ»: profit / retailAmount × 100.
        marginPct: retailKop > 0 ? Math.round((profitKop / retailKop) * 1000) / 10 : 0,
      };
    });

    // Сортировка
    const sortKey: Record<string, (i: any) => number> = {
      revenue: (i) => i.revenueRub,
      penalty: (i) => i.penaltyRub,
      storage: (i) => i.storageRub,
      adv: (i) => i.advRub,
      cogs: (i) => i.cogsRub,
      profit: (i) => i.profitRub,
    };
    items.sort((a, b) => sortKey[query.sortBy](b) - sortKey[query.sortBy](a));

    // Сводный итог по всем строкам. Сумма profitRub = marginRub в «Отчётах ВБ»
    // (поскольку unattributed уже разнесены).
    const totals = items.reduce(
      (acc, i) => ({
        revenueRub: acc.revenueRub + i.revenueRub,
        retailAmountRub: acc.retailAmountRub + i.retailAmountRub,
        commissionRub: acc.commissionRub + i.commissionRub,
        logisticsRub: acc.logisticsRub + i.logisticsRub,
        storageRub: acc.storageRub + i.storageRub,
        penaltyRub: acc.penaltyRub + i.penaltyRub,
        acceptanceRub: acc.acceptanceRub + i.acceptanceRub,
        acquiringRub: acc.acquiringRub + i.acquiringRub,
        otherHoldRub: acc.otherHoldRub + i.otherHoldRub,
        adjustmentRub: acc.adjustmentRub + i.adjustmentRub,
        advRub: acc.advRub + i.advRub,
        cogsRub: acc.cogsRub + i.cogsRub,
        taxRub: acc.taxRub + i.taxRub,
        vatRub: acc.vatRub + i.vatRub,
        profitRub: acc.profitRub + i.profitRub,
        lines: acc.lines + i.lines,
        saleQty: acc.saleQty + i.saleQty,
        returns: acc.returns + i.returns,
      }),
      {
        revenueRub: 0, retailAmountRub: 0, commissionRub: 0, logisticsRub: 0, storageRub: 0, penaltyRub: 0,
        acceptanceRub: 0, acquiringRub: 0, otherHoldRub: 0, adjustmentRub: 0, advRub: 0, cogsRub: 0,
        taxRub: 0, vatRub: 0, profitRub: 0,
        saleQty: 0,
        lines: 0, returns: 0,
      },
    );

    // «Неучтённые удержания» — то, что есть в /finance/reports, но ВБ не привязал
    // к артикулам. Возвращается отдельно — UI должен показать как блок «не разнесено».
    // Сумма (totals.profit + unattributed.*) ≈ marginRub из «Отчётов ВБ».
    const toRub = (kop: number) => Math.max(0, Math.round(kop / 100));
    const unattributed = {
      logisticsRub:   toRub(reportsTotals.log  - rawSums.log),
      storageRub:     toRub(reportsTotals.stor - rawSums.stor),
      acceptanceRub:  toRub(reportsTotals.acc  - rawSums.acc),
      penaltyRub:     toRub(reportsTotals.pen  - rawSums.pen),
      deductionRub:   toRub(reportsTotals.ded  - rawSums.ded),
      adjustmentRub:  Math.round((reportsTotals.add - rawSums.add) / 100), // может быть отрицательной
    };

    return {
      start, end, count: items.length,
      items: items.slice(0, query.limit),
      totals,
      unattributed,
    };
  });

  // ============================================================
  // WB Finance Reports (новый API finance-api.wildberries.ru)
  // ============================================================
  /**
   * GET /finance/:ws/reports?start=YYYY-MM-DD&end=YYYY-MM-DD&shopId=
   * Список отчётов реализации ВБ за период — точно как xlsx-сводный,
   * плюс наши надстройки: реклама и себестоимость за период каждого отчёта.
   */
  app.get('/finance/:workspaceId/reports', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));
    const shopId = query.shopId;

    const { rows: out, totals } = await getFinanceReportsByPeriod(params.workspaceId, shopId, start, end);
    return { start, end, count: out.length, reports: out, totals };
  });

  /**
   * GET /finance/:ws/summary?start=&end=&shopId=
   * KPI обзора /finance — точные суммы из wb_finance_reports (новый API ВБ),
   * подмешан adv и cogs.
   */
  app.get('/finance/:workspaceId/summary', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));
    const shopId = query.shopId;

    const [agg] = (await db.execute(sql`
      SELECT
        COUNT(*) AS reports,
        COALESCE(SUM(retail_amount_kopecks), 0) AS retail_kop,
        COALESCE(SUM(for_pay_kopecks), 0) AS for_pay_kop,
        COALESCE(SUM(delivery_service_kopecks), 0) AS delivery_kop,
        COALESCE(SUM(paid_storage_kopecks), 0) AS storage_kop,
        COALESCE(SUM(paid_acceptance_kopecks), 0) AS acceptance_kop,
        COALESCE(SUM(deduction_kopecks), 0) AS deduction_kop,
        COALESCE(SUM(penalty_kopecks), 0) AS penalty_kop,
        COALESCE(SUM(additional_payment_kopecks), 0) AS additional_kop,
        COALESCE(SUM(bank_payment_kopecks), 0) AS bank_pay_kop
      FROM wb_finance_reports
      WHERE workspace_id = ${params.workspaceId}
        ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
        AND date_from BETWEEN ${start} AND ${end}
    `)).rows as any[];

    // /adv/v1/upd — соответствует xlsx-сводному (vs /v3/fullstats, который ~½)
    const [advAgg] = (await db.execute(sql`
      SELECT COALESCE(SUM(upd_sum_kopecks), 0) AS adv_kop
      FROM wb_adv_finance
      WHERE workspace_id = ${params.workspaceId}
        ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
        AND upd_date BETWEEN ${start} AND ${end}
    `)).rows as any[];

    const [cogsAgg] = (await db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(c.cogs_kopecks, 0) * GREATEST(0, fdp.sale_qty - COALESCE(fdp.returns_count, 0))), 0) AS cogs_kop
      FROM wb_finance_daily_products fdp
      LEFT JOIN wb_cogs c ON c.workspace_id = fdp.workspace_id AND c.nm_id = fdp.nm_id
      WHERE fdp.workspace_id = ${params.workspaceId}
        ${shopId ? sql`AND fdp.shop_id = ${shopId}` : sql``}
        AND COALESCE(fdp.rr_date, fdp.date) BETWEEN ${start} AND ${end}
    `)).rows as any[];

    const retailKop = Number(agg?.retail_kop ?? 0);
    const forPayKop = Number(agg?.for_pay_kop ?? 0);
    const advKop = Number(advAgg?.adv_kop ?? 0);
    const cogsKop = Number(cogsAgg?.cogs_kop ?? 0);
    const deliveryKop = Number(agg?.delivery_kop ?? 0);
    const storageKop = Number(agg?.storage_kop ?? 0);
    const acceptanceKop = Number(agg?.acceptance_kop ?? 0);
    const deductionKop = Number(agg?.deduction_kop ?? 0);
    const penaltyKop = Number(agg?.penalty_kop ?? 0);
    const additionalKop = Number(agg?.additional_kop ?? 0);
    const bankPayKop = Number(agg?.bank_pay_kop ?? 0);
    // Чистая прибыль = (К перечислению) − все наши «сторонние» расходы (реклама + cogs)
    // ВАЖНО: advKop НЕ вычитаем — реклама (paymentType=Баланс) уже сидит
    // внутри `deductionKop` (ВБ удерживает рекламные списания из выручки).
    // Дублировать = задвоение. advKop остаётся в ответе для UI как info.
    const netKop = forPayKop - deliveryKop - storageKop - acceptanceKop - deductionKop - penaltyKop + additionalKop - cogsKop;

    return {
      start, end,
      source: 'wb_finance_reports',
      reportsCount: Number(agg?.reports ?? 0),
      retailRub: Math.round(retailKop / 100),
      forPayRub: Math.round(forPayKop / 100),
      deliveryRub: Math.round(deliveryKop / 100),
      storageRub: Math.round(storageKop / 100),
      acceptanceRub: Math.round(acceptanceKop / 100),
      deductionRub: Math.round(deductionKop / 100),
      penaltyRub: Math.round(penaltyKop / 100),
      additionalPaymentRub: Math.round(additionalKop / 100),
      bankPayRub: Math.round(bankPayKop / 100),
      advRub: Math.round(advKop / 100),
      cogsRub: Math.round(cogsKop / 100),
      netProfitRub: Math.round(netKop / 100),
      marginPct: retailKop > 0 ? Math.round((netKop / retailKop) * 1000) / 10 : 0,
    };
  });

  /** POST /finance/:ws/reports/sync — ручной sync отчётов через новый API */
  app.post('/finance/:workspaceId/reports/sync', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.number().int().positive(),
      start: z.string(),
      end: z.string(),
    }).parse(req.body);

    const { syncFinanceReportsForShop } = await import('../integrations/wb/financeReports.js');
    return syncFinanceReportsForShop(params.workspaceId, body.shopId, body.start, body.end);
  });

  // Реклама: фактические списания (источник = ЛК ВБ «История затрат», endpoint /adv/v1/upd).
  // Точно соответствует xlsx-сводному по «История затрат».
  app.get('/finance/:workspaceId/adv-expenses', { preHandler: requireRole('supervisor') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const today = isoDate(new Date());
    const end = query.end ?? today;
    const start = query.start ?? isoDate(addDays(new Date(end + 'T00:00:00Z'), -30));

    const conds = [
      sql`workspace_id = ${params.workspaceId}`,
      sql`upd_date BETWEEN ${start} AND ${end}`,
    ];
    if (query.shopId) conds.push(sql`shop_id = ${query.shopId}`);
    const where = sql.join(conds, sql` AND `);

    const dailyRows: Array<{
      date: string;
      shop_id: number | null;
      total_kop: string;
      balance_kop: string;
      account_kop: string;
      bonus_kop: string;
      cashback_kop: string;
      rows: string;
      adverts: string;
    }> = await db.execute(sql`
      SELECT upd_date AS date,
             shop_id,
             SUM(upd_sum_kopecks) AS total_kop,
             SUM(upd_sum_kopecks) FILTER (WHERE payment_type = 'Баланс') AS balance_kop,
             SUM(upd_sum_kopecks) FILTER (WHERE payment_type IN ('Счёт','Счет')) AS account_kop,
             SUM(upd_sum_kopecks) FILTER (WHERE payment_type = 'Бонусы') AS bonus_kop,
             SUM(upd_sum_kopecks) FILTER (WHERE payment_type = 'Кэшбэк') AS cashback_kop,
             COUNT(*) AS rows,
             COUNT(DISTINCT advert_id) AS adverts
        FROM wb_adv_finance
       WHERE ${where}
       GROUP BY upd_date, shop_id
       ORDER BY upd_date DESC
    `).then((r: any) => r.rows ?? r);

    const byCampaign: Array<{
      advert_id: number;
      camp_name: string | null;
      advert_type: number;
      advert_status: number;
      total_kop: string;
      rows: string;
      days: string;
    }> = await db.execute(sql`
      SELECT advert_id,
             MAX(camp_name) AS camp_name,
             MAX(advert_type) AS advert_type,
             MAX(advert_status) AS advert_status,
             SUM(upd_sum_kopecks) AS total_kop,
             COUNT(*) AS rows,
             COUNT(DISTINCT upd_date) AS days
        FROM wb_adv_finance
       WHERE ${where}
       GROUP BY advert_id
       ORDER BY SUM(upd_sum_kopecks) DESC
       LIMIT 200
    `).then((r: any) => r.rows ?? r);

    // Per-nm разбивка: доли из /v3/fullstats × scale до /adv/v1/upd total
    const advNmFullstats: any = await db.execute(sql`
      SELECT nm_id, SUM(spend_kopecks) AS spend_kop
        FROM wb_adv_daily_products
       WHERE workspace_id = ${params.workspaceId}
         ${query.shopId ? sql`AND shop_id = ${query.shopId}` : sql``}
         AND date BETWEEN ${start} AND ${end}
       GROUP BY nm_id
       ORDER BY spend_kop DESC
       LIMIT 200
    `);
    const nmRowsRaw: any[] = (advNmFullstats.rows ?? advNmFullstats) as any[];
    const fullstatsTotal = nmRowsRaw.reduce((s, r) => s + Number(r.spend_kop ?? 0), 0);
    // titles + photos
    const cardRows: any = nmRowsRaw.length ? await db.execute(sql`
      SELECT nm_id, COALESCE(title, '') AS title,
             COALESCE(vendor_code, '') AS vendor_code,
             COALESCE(main_photo_url, '') AS photo
        FROM wb_cards
       WHERE workspace_id = ${params.workspaceId}
         AND nm_id = ANY(${sql.raw(`ARRAY[${nmRowsRaw.map(r => Number(r.nm_id)).join(',')}]::bigint[]`)})
    `) : { rows: [] };
    const cardMap = new Map<number, { title: string; vendorCode: string; photo: string }>();
    for (const c of (cardRows.rows ?? cardRows) as any[]) {
      cardMap.set(Number(c.nm_id), { title: c.title ?? '', vendorCode: c.vendor_code ?? '', photo: c.photo ?? '' });
    }

    let totalKop = 0;
    let balanceKop = 0;
    let accountKop = 0;
    let bonusKop = 0;
    let cashbackKop = 0;
    let totalRows = 0;
    for (const r of dailyRows) {
      totalKop += Number(r.total_kop ?? 0);
      balanceKop += Number(r.balance_kop ?? 0);
      accountKop += Number(r.account_kop ?? 0);
      bonusKop += Number(r.bonus_kop ?? 0);
      cashbackKop += Number(r.cashback_kop ?? 0);
      totalRows += Number(r.rows ?? 0);
    }

    return {
      workspaceId: params.workspaceId,
      shopId: query.shopId ?? null,
      start,
      end,
      totals: {
        totalKop, balanceKop, accountKop, bonusKop, cashbackKop,
        rows: totalRows,
        days: dailyRows.length,
        campaigns: byCampaign.length,
      },
      daily: dailyRows.map((r) => ({
        date: r.date,
        shopId: r.shop_id,
        totalKop: Number(r.total_kop ?? 0),
        balanceKop: Number(r.balance_kop ?? 0),
        accountKop: Number(r.account_kop ?? 0),
        bonusKop: Number(r.bonus_kop ?? 0),
        cashbackKop: Number(r.cashback_kop ?? 0),
        rows: Number(r.rows ?? 0),
        adverts: Number(r.adverts ?? 0),
      })),
      byCampaign: byCampaign.map((r) => ({
        advertId: r.advert_id,
        campName: r.camp_name,
        advertType: r.advert_type,
        advertStatus: r.advert_status,
        totalKop: Number(r.total_kop ?? 0),
        rows: Number(r.rows ?? 0),
        days: Number(r.days ?? 0),
      })),
      byNm: nmRowsRaw.map((r) => {
        const fullstatsKop = Number(r.spend_kop ?? 0);
        const scale = fullstatsTotal > 0 ? totalKop / fullstatsTotal : 1;
        const scaledKop = Math.round(fullstatsKop * scale);
        const card = cardMap.get(Number(r.nm_id));
        return {
          nmId: Number(r.nm_id),
          vendorCode: card?.vendorCode ?? '',
          title: card?.title ?? '',
          photo: card?.photo || null,
          spendKop: scaledKop,
        };
      }).sort((a, b) => b.spendKop - a.spendKop),
    };
  });
};
