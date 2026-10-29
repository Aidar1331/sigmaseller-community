import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  pulsePlans,
  salesMonthlyTargets,
  wbOrdersSalesDailyProducts,
  wbFunnelDailyProducts,
  wbAdvDailyProducts,
  wbAdvDaily,
} from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

const metricSchema = z.enum(['orders_qty', 'orders_rub', 'sales_qty', 'sales_rub']);

const importBodySchema = z.object({
  workspaceId: z.number().int().positive(),
  actorUserId: z.number().int().positive(),
  // base64 of xlsx
  xlsxBase64: z.string().min(100),
  overwrite: z.boolean().optional().default(true),
  dryRun: z.boolean().optional().default(false),
});

export const plansRoutes: FastifyPluginAsync = async (app) => {
  app.get('/plans', { preHandler: requireRole('viewer') },async (req) => {
    const q = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        start: z.string().min(10).max(10).optional(),
        end: z.string().min(10).max(10).optional(),
        nmId: z.coerce.number().int().positive().optional(),
        metric: metricSchema.optional(),
      })
      .parse(req.query);


    const where: any[] = [eq(pulsePlans.workspaceId, q.workspaceId)];
    if (q.start) where.push(gte(pulsePlans.date, q.start));
    if (q.end) where.push(lte(pulsePlans.date, q.end));
    if (q.nmId) where.push(eq(pulsePlans.nmId, q.nmId));
    if (q.metric) where.push(eq(pulsePlans.metric, q.metric));

    const rows = await db.select().from(pulsePlans).where(and(...where)).orderBy(pulsePlans.date);
    return { rows };
  });

  app.get('/plans/summary', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        start: z.string().min(10).max(10),
        end: z.string().min(10).max(10),
        metric: metricSchema.optional(),
        tagId: z.coerce.number().int().positive().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    // Month label derived from start (YYYY-MM-DD -> YYYY-MM)
    const monthLabel = q.start.slice(0, 7);

    // tagId filter (via JOIN to wb_tag_products); shopId filter применяется к ОБЕИМ
    // частям — и факту, и плану. Раньше plan-агрегация была workspace-level, из-за
    // чего при выборе магазина в Products table «втекали» планы соседних магазинов
    // (если у workspace > 1 магазина и план сохранён прицельно через distribute).
    // Записи pulse_plans с shop_id=NULL (legacy без выбранного магазина) показываем
    // во всех магазинах, чтобы не потерять старые планы.
    const shopFilterFact = q.shopId ? sql`AND f.shop_id = ${q.shopId}` : sql``;
    const shopFilterPlan = q.shopId ? sql`AND (p.shop_id = ${q.shopId} OR p.shop_id IS NULL)` : sql``;
    const tagJoinPlan = q.tagId
      ? sql`INNER JOIN wb_tag_products tp_p ON tp_p.workspace_id = p.workspace_id AND tp_p.nm_id = p.nm_id AND tp_p.tag_id = ${q.tagId}`
      : sql``;
    const tagJoinFact = q.tagId
      ? sql`INNER JOIN wb_tag_products tp_f ON tp_f.workspace_id = f.workspace_id AND tp_f.nm_id = f.nm_id AND tp_f.tag_id = ${q.tagId}`
      : sql``;

    // Aggregate plan (shop-aware с NULL fallback) + fact (shop-aware) per nmId
    const aggRes: any = await db.execute(sql`
      WITH plan_agg AS (
        SELECT
          p.nm_id,
          SUM(CASE WHEN p.metric = 'orders_qty' THEN p.value ELSE 0 END) AS plan_qty,
          SUM(CASE WHEN p.metric = 'orders_rub' THEN p.value ELSE 0 END) AS plan_rub
        FROM pulse_plans p
        ${tagJoinPlan}
        WHERE p.workspace_id = ${q.workspaceId}
          AND p.date >= ${q.start} AND p.date <= ${q.end}
          ${shopFilterPlan}
        GROUP BY p.nm_id
      ),
      fact_agg AS (
        SELECT
          f.nm_id,
          SUM(f.orders_count) AS fact_qty,
          SUM(f.orders_rub)   AS fact_rub
        FROM wb_orders_sales_daily_products f
        ${tagJoinFact}
        WHERE f.workspace_id = ${q.workspaceId}
          AND f.date >= ${q.start} AND f.date <= ${q.end}
          ${shopFilterFact}
        GROUP BY f.nm_id
      ),
      merged AS (
        SELECT
          COALESCE(p.nm_id, f.nm_id) AS nm_id,
          COALESCE(p.plan_qty, 0)    AS plan_qty,
          COALESCE(p.plan_rub, 0)    AS plan_rub,
          COALESCE(f.fact_qty, 0)    AS fact_qty,
          COALESCE(f.fact_rub, 0)    AS fact_rub
        FROM plan_agg p
        FULL OUTER JOIN fact_agg f ON p.nm_id = f.nm_id
      )
      SELECT
        m.nm_id,
        m.plan_qty::bigint  AS plan_qty,
        m.plan_rub::bigint  AS plan_rub,
        m.fact_qty::bigint  AS fact_qty,
        m.fact_rub::bigint  AS fact_rub,
        c.title             AS name,
        c.main_photo_url    AS photo,
        (
          SELECT t.name FROM wb_tag_products tp
          JOIN wb_tags t ON t.tag_id = tp.tag_id
          WHERE tp.workspace_id = ${q.workspaceId} AND tp.nm_id = m.nm_id
          ORDER BY t.tag_id LIMIT 1
        ) AS tag
      FROM merged m
      LEFT JOIN wb_cards c ON c.workspace_id = ${q.workspaceId} AND c.nm_id = m.nm_id
      WHERE (m.plan_qty > 0 OR m.plan_rub > 0 OR m.fact_qty > 0 OR m.fact_rub > 0)
      ORDER BY (m.plan_qty + m.fact_qty) DESC, m.nm_id
      LIMIT 500
    `);

    const rows: Array<{
      nm_id: number | string;
      plan_qty: number | string;
      plan_rub: number | string;
      fact_qty: number | string;
      fact_rub: number | string;
      name: string | null;
      photo: string | null;
      tag: string | null;
    }> = (aggRes as any).rows ?? aggRes ?? [];

    const products = rows.map((r) => ({
      nmId: Number(r.nm_id),
      name: r.name ?? `nm ${r.nm_id}`,
      photo: r.photo,
      tag: r.tag,
      planQty: Number(r.plan_qty ?? 0),
      factQty: Number(r.fact_qty ?? 0),
      planRevenue: Math.round(Number(r.plan_rub ?? 0) / 100),
      factRevenue: Math.round(Number(r.fact_rub ?? 0) / 100),
    }));

    const planOrdersQty = products.reduce((s, p) => s + p.planQty, 0);
    const factOrdersQty = products.reduce((s, p) => s + p.factQty, 0);
    const planRevenue = products.reduce((s, p) => s + p.planRevenue, 0);
    const factRevenue = products.reduce((s, p) => s + p.factRevenue, 0);

    // Available months across all plan data
    const monthsRes: any = await db.execute(sql`
      SELECT DISTINCT to_char(date::date, 'YYYY-MM') AS ym
      FROM pulse_plans
      WHERE workspace_id = ${q.workspaceId}
      ORDER BY 1 DESC
      LIMIT 24
    `);
    const availableMonths: string[] = ((monthsRes as any).rows ?? monthsRes ?? []).map((r: any) => r.ym);

    // Tag options for frontend dropdown
    const tagsRes: any = await db.execute(sql`
      SELECT t.tag_id AS id, t.name, t.color
      FROM wb_tags t
      WHERE t.workspace_id = ${q.workspaceId}
      ORDER BY t.name
    `);
    const tags = ((tagsRes as any).rows ?? tagsRes ?? []).map((r: any) => ({
      id: Number(r.id),
      name: r.name,
      color: r.color,
    }));

    return {
      workspaceId: q.workspaceId,
      start: q.start,
      end: q.end,
      month: monthLabel,
      metric: q.metric ?? 'orders_qty',
      tagId: q.tagId ?? null,
      shopId: q.shopId ?? null,
      planOrdersQty,
      factOrdersQty,
      planRevenue,
      factRevenue,
      products,
      tags,
      availableMonths,
    };
  });

  // ───────────────────────────────────────────────────────────────────────
  // Inline upsert: одна строка плана по (nmId, месяц, metric).
  // Хранится одной записью на первый день месяца, агрегация в /plans/summary
  // суммирует по диапазону — подходит для месячного бюджета.
  // ───────────────────────────────────────────────────────────────────────
  app.post('/plans/upsert', { preHandler: requireRole('manager') }, async (req) => {
    const body = z.object({
      workspaceId: z.number().int().positive(),
      shopId: z.number().int().positive().optional(),
      actorUserId: z.number().int().positive().optional(),
      nmId: z.number().int().positive(),
      // YYYY-MM (например «2026-05»). Бекенд сохранит как date=YYYY-MM-01.
      month: z.string().regex(/^\d{4}-\d{2}$/),
      metric: metricSchema,
      // value:
      //   для *_qty — штуки (целое >= 0).
      //   для *_rub — рубли (число, перепишем в копейки в БД).
      value: z.number().nonnegative(),
    }).parse(req.body);

    // actorUserId — fallback на req.user
    const sessionUserId = (req as any).user?.userId ?? null;
    const actorUserId = body.actorUserId ?? sessionUserId;
    if (!actorUserId) {
      throw Object.assign(new Error('Не удалось определить пользователя'), { statusCode: 401 });
    }

    const date = `${body.month}-01`;
    // *_qty храним как целое, *_rub — в копейках.
    const storeValue = body.metric.endsWith('_rub')
      ? Math.round(body.value * 100)
      : Math.round(body.value);

    await db
      .insert(pulsePlans)
      .values({
        workspaceId: body.workspaceId,
        shopId: body.shopId ?? null,
        date,
        nmId: body.nmId,
        metric: body.metric,
        value: storeValue,
        createdByUserId: actorUserId,
      })
      .onConflictDoUpdate({
        target: [pulsePlans.workspaceId, pulsePlans.date, pulsePlans.nmId, pulsePlans.metric],
        set: { value: storeValue, updatedAt: new Date() },
      });

    return { ok: true, nmId: body.nmId, month: body.month, metric: body.metric, value: storeValue };
  });

  app.post('/plans/import/xlsx', { preHandler: requireRole('manager'), bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const body = importBodySchema.parse(req.body);

    // Раньше тут спавнили `python -c '...openpyxl...'`, но pulse-юзер не имеет
    // доступа к /root/clawd/.venv и в системном python3 нет openpyxl —
    // импорт плана падал у всех. Парсим xlsx прямо в Node через npm пакет.
    const XLSX = await import('xlsx');
    const buf = Buffer.from(body.xlsxBase64, 'base64');

    let workbook: any;
    try {
      workbook = XLSX.read(buf, { type: 'buffer', cellDates: true });
    } catch (err: any) {
      throw new Error(`Не удалось прочитать xlsx: ${err.message ?? 'unknown'}`);
    }

    const SHEETS: Record<string, 'orders_qty' | 'orders_rub' | 'sales_qty' | 'sales_rub'> = {
      'Заказы (шт)': 'orders_qty',
      'Заказы (руб)': 'orders_rub',
      'Продажи (шт)': 'sales_qty',
      'Продажи (руб)': 'sales_rub',
    };

    const toIso = (v: any): string | null => {
      if (v == null || v === '') return null;
      if (v instanceof Date && !isNaN(v.getTime())) {
        // Date из xlsx — отдаём как ISO (UTC-truncated до YYYY-MM-DD).
        const y = v.getUTCFullYear();
        const m = String(v.getUTCMonth() + 1).padStart(2, '0');
        const d = String(v.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        // Excel serial (1900-based). XLSX обычно даёт Date при cellDates:true,
        // но если попалось — обработаем.
        const base = Date.UTC(1899, 11, 30);
        const d = new Date(base + v * 86_400_000);
        if (isNaN(d.getTime())) return null;
        const y = d.getUTCFullYear();
        const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
        const da = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${mo}-${da}`;
      }
      const s = String(v).trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      // dd.mm.yyyy
      const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
      return null;
    };

    const parsedRows: Array<{ metric: string; date: string; nmId: number; value: number }> = [];
    const parseErrors: Array<{ sheet: string; error: string }> = [];

    for (const [sheetName, metric] of Object.entries(SHEETS)) {
      const ws = workbook.Sheets[sheetName];
      if (!ws) {
        parseErrors.push({ sheet: sheetName, error: 'missing' });
        continue;
      }
      // Получаем массив-массивов без преобразования заголовков.
      const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      if (aoa.length < 2) continue;

      const header = aoa[0] ?? [];
      const nmIds: Array<number | null> = [];
      for (let i = 1; i < header.length; i++) {
        const cell = header[i];
        const nm = Number(String(cell ?? '').trim());
        nmIds.push(Number.isFinite(nm) && nm > 0 ? Math.trunc(nm) : null);
      }

      for (let r = 1; r < aoa.length; r++) {
        const row = aoa[r] ?? [];
        const iso = toIso(row[0]);
        if (!iso) continue;
        for (let i = 0; i < nmIds.length; i++) {
          const nm = nmIds[i];
          if (nm == null) continue;
          const raw = row[i + 1];
          if (raw == null || raw === '') continue;
          const val = Number(raw);
          if (!Number.isFinite(val)) continue;
          parsedRows.push({ metric, date: iso, nmId: nm, value: val });
        }
      }
    }

    const rows = parsedRows;

    // transform values to int/kopecks
    const toInt = (metric: string, value: number) => {
      if (metric.endsWith('_rub')) return Math.round(value * 100);
      return Math.round(value);
    };


    // Optionally clear overlapping range for the involved nmIds+metrics
    const metrics = Array.from(new Set(rows.map((r) => r.metric))) as string[];
    const nmIds = Array.from(new Set(rows.map((r) => r.nmId)));
    const dates = rows.map((r) => r.date).sort();
    const start = dates[0];
    const end = dates[dates.length - 1];

    if (body.dryRun) {
      return {
        ok: true,
        dryRun: true,
        rows: rows.length,
        stats: {
          nmIds: nmIds.length,
          metrics,
          start,
          end,
        },
        parseErrors,
      };
    }

    if (body.overwrite && rows.length && start && end && nmIds.length && metrics.length) {
      await db
        .delete(pulsePlans)
        .where(
          and(
            eq(pulsePlans.workspaceId, body.workspaceId),
            gte(pulsePlans.date, start),
            lte(pulsePlans.date, end),
            inArray(pulsePlans.nmId, nmIds),
            inArray(pulsePlans.metric, metrics)
          )
        );
    }

    // Insert (batched)
    const batchSize = 2000;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      if (!chunk.length) continue;
      await db.insert(pulsePlans).values(
        chunk.map((r) => ({
          workspaceId: body.workspaceId,
          date: r.date,
          nmId: r.nmId,
          metric: metricSchema.parse(r.metric),
          value: toInt(r.metric, r.value),
          createdByUserId: body.actorUserId,
          updatedAt: new Date(),
          createdAt: new Date(),
        }))
      );
      inserted += chunk.length;
    }

    return {
      ok: true,
      inserted,
      stats: {
        nmIds: nmIds.length,
        metrics: metrics,
        start,
        end,
      },
      parseErrors,
    };
  });

  // ─────────────────────────────────────────────────────────────────────
  // MONTHLY TARGET + DAILY GRID (страница /plan по шаблону оператора)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * GET /plans/monthly?workspaceId=X&shopId=Y&month=YYYY-MM
   * Возвращает: { target, daily[1..N], summary }
   *   target  — параметры месяца (Выручка по рынку, целевая доля, план выр/реклама/показы/заказы)
   *   daily   — массив на каждый день: { date, planRevenueKop, factRevenueKop, planImpressions, factImpressions, planOrdersQty, factOrdersQty, factAdSpendKop }
   *   summary — { factTotalRevenueKop, factTotalAdSpendKop, factTotalOrders, runRateKop, daysWithFact, daysInMonth, accumPlanKop, accumFactKop, pctOfPlan, forecastKop, dailyNeededKop }
   */
  app.get('/plans/monthly', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().nonnegative().optional().default(0),
      month: z.string().regex(/^\d{4}-\d{2}$/),
    }).parse(req.query);

    const [year, monthN] = q.month.split('-').map(Number);
    const daysInMonth = new Date(year, monthN, 0).getDate();
    const monthStart = `${q.month}-01`;
    const monthEnd = `${q.month}-${String(daysInMonth).padStart(2, '0')}`;

    // 1. Целевые параметры
    const [target] = await db.select().from(salesMonthlyTargets).where(and(
      eq(salesMonthlyTargets.workspaceId, q.workspaceId),
      eq(salesMonthlyTargets.shopId, q.shopId),
      eq(salesMonthlyTargets.month, q.month),
    )).limit(1);

    // 2. Факт по дням
    const shopFilterOrders = q.shopId ? [eq(wbOrdersSalesDailyProducts.shopId, q.shopId)] : [];
    const shopFilterFunnel = q.shopId ? [eq(wbFunnelDailyProducts.shopId, q.shopId)] : [];
    const shopFilterAdv = q.shopId ? [eq(wbAdvDailyProducts.shopId, q.shopId)] : [];

    // Источники истины (синхронизированы с /finance и AI-чатом):
    //   Выручка (₽)   — funnel.orderSum × 100 (Analytics API, совпадает с ЛК ВБ → Аналитика)
    //   Просмотры/шт   — funnel.openCardCount / orderCount (Analytics, совпадает с ЛК)
    //   Реклама (₽)   — wb_adv_daily.spend_kopecks (= ЛК ВБ Продвижение → Статистика по дням,
    //                  /adv/v3/fullstats day.sum). Отличается от xlsx «История затрат»
    //                  (wb_adv_finance) — там пост-факт списания с задержкой 1-2 дня.
    const funnelByDay = await db.select({
      date: wbFunnelDailyProducts.date,
      impressions: sql<number>`coalesce(sum(${wbFunnelDailyProducts.openCardCount}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      orderSumRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}), 0)`.mapWith(Number),
    }).from(wbFunnelDailyProducts).where(and(
      eq(wbFunnelDailyProducts.workspaceId, q.workspaceId),
      gte(wbFunnelDailyProducts.date, monthStart),
      lte(wbFunnelDailyProducts.date, monthEnd),
      ...shopFilterFunnel,
    )).groupBy(wbFunnelDailyProducts.date);

    // Реклама — дневные траты из ЛК ВБ Продвижение (fullstats day.sum)
    const advByDay = await db.select({
      date: wbAdvDaily.date,
      spendKop: sql<number>`coalesce(sum(${wbAdvDaily.spendKopecks}), 0)`.mapWith(Number),
    }).from(wbAdvDaily).where(and(
      eq(wbAdvDaily.workspaceId, q.workspaceId),
      gte(wbAdvDaily.date, monthStart),
      lte(wbAdvDaily.date, monthEnd),
      ...(q.shopId ? [eq(wbAdvDaily.shopId, q.shopId)] : []),
    )).groupBy(wbAdvDaily.date);

    // Клики из /v3/fullstats (wb_adv_daily_products) per день
    const clicksByDay = await db.select({
      date: wbAdvDailyProducts.date,
      clicks: sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
    }).from(wbAdvDailyProducts).where(and(
      eq(wbAdvDailyProducts.workspaceId, q.workspaceId),
      gte(wbAdvDailyProducts.date, monthStart),
      lte(wbAdvDailyProducts.date, monthEnd),
      ...shopFilterAdv,
    )).groupBy(wbAdvDailyProducts.date);
    const clicksMap = new Map(clicksByDay.map(r => [r.date, r.clicks]));

    const revMap = new Map(funnelByDay.map(r => [r.date, Math.round(Number(r.orderSumRub) * 100)]));
    const funMap = new Map(funnelByDay.map(r => [r.date, { i: r.impressions, o: r.orders }]));
    const advMap = new Map(advByDay.map(r => [r.date, r.spendKop]));

    // 3. План на день (равномерный)
    const planRevenueDailyKop = target?.planRevenueRub ? Math.round((Number(target.planRevenueRub) * 100) / daysInMonth) : 0;
    const planAdSpendDailyKop = target?.planAdSpendRub ? Math.round((Number(target.planAdSpendRub) * 100) / daysInMonth) : 0;
    const planImpressionsDaily = target?.planImpressions ? Math.round(Number(target.planImpressions) / daysInMonth) : 0;
    const planOrdersDaily = target?.planOrdersQty ? Math.round(Number(target.planOrdersQty) / daysInMonth) : 0;

    const today = new Date().toISOString().slice(0, 10);
    let factTotalRevenueKop = 0;
    let factTotalAdSpendKop = 0;
    let factTotalOrders = 0;
    let daysWithFact = 0;
    let accumPlanKop = 0;
    let accumFactKop = 0;

    const daily = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const dateStr = `${q.month}-${String(day).padStart(2, '0')}`;
      const factRevenueKop = revMap.get(dateStr) ?? 0;
      const fact = funMap.get(dateStr) ?? { i: 0, o: 0 };
      const factAdSpendKop = advMap.get(dateStr) ?? 0;
      const isPast = dateStr <= today;
      if (isPast) {
        accumPlanKop += planRevenueDailyKop;
      }
      if (factRevenueKop > 0) {
        factTotalRevenueKop += factRevenueKop;
        accumFactKop += factRevenueKop;
        daysWithFact++;
      }
      factTotalAdSpendKop += factAdSpendKop;
      factTotalOrders += fact.o;
      const factClicks = clicksMap.get(dateStr) ?? 0;
      // ДРР = adSpend / revenue × 100. Если выручки нет — отдаём null
      // (UI покажет «—» вместо «∞%»).
      const factDrr = factRevenueKop > 0 ? (factAdSpendKop / factRevenueKop) * 100 : null;
      return {
        date: dateStr,
        day,
        planRevenueKop: planRevenueDailyKop,
        factRevenueKop,
        planImpressions: planImpressionsDaily,
        factImpressions: fact.i,
        planOrdersQty: planOrdersDaily,
        factOrdersQty: fact.o,
        planAdSpendKop: planAdSpendDailyKop,
        factAdSpendKop,
        factClicks,
        factDrr,
      };
    });

    const planTotalKop = target?.planRevenueRub ? Number(target.planRevenueRub) * 100 : 0;
    const runRateKop = daysWithFact > 0 ? Math.round((factTotalRevenueKop / daysWithFact) * daysInMonth) : 0;
    const remainingDays = daysInMonth - daysWithFact;
    const dailyNeededKop = remainingDays > 0
      ? Math.max(0, Math.round((planTotalKop - factTotalRevenueKop) / remainingDays))
      : 0;

    return {
      target: target ?? null,
      params: {
        month: q.month,
        daysInMonth,
        daysWithFact,
        remainingDays,
        today,
      },
      daily,
      summary: {
        factTotalRevenueKop,
        factTotalAdSpendKop,
        factTotalOrders,
        factTotalClicks: daily.reduce((s: number, d: any) => s + (d.factClicks ?? 0), 0),
        factTotalDrr: factTotalRevenueKop > 0 ? (factTotalAdSpendKop / factTotalRevenueKop) * 100 : null,
        runRateKop,
        accumPlanKop,
        accumFactKop,
        pctOfPlan: planTotalKop > 0 ? factTotalRevenueKop / planTotalKop : 0,
        forecastKop: runRateKop,
        dailyNeededKop,
        drrPct: factTotalRevenueKop > 0 ? factTotalAdSpendKop / factTotalRevenueKop : 0,
      },
    };
  });

  /**
   * GET /plans/auto-suggest?workspaceId=X&shopId=Y&month=YYYY-MM
   * Возвращает предложение плана по каждому SKU на основе:
   *   - средних продаж за 30 дней
   *   - тренда (7 дней vs 30 дней)
   *   - остатков FBO + FBS
   *   - текущей цены
   * Алгоритм:
   *   base = avg30d × днейВМесяце
   *   trend7 = avg7d / avg30d (если 0 < trend < 2.5 — учитываем)
   *   план_шт = round(base × clamp(trend, 0.5, 2.0))
   *   ограничение: план_шт ≤ (FBO + FBS) × 1.5  ← оставляем буфер на поставку
   *   план_₽ = план_шт × текущая_цена
   */
  app.get('/plans/auto-suggest', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().nonnegative().optional().default(0),
      month: z.string().regex(/^\d{4}-\d{2}$/),
    }).parse(req.query);

    const ws = q.workspaceId;
    const [year, monthN] = q.month.split('-').map(Number);
    const daysInMonth = new Date(year, monthN, 0).getDate();
    const today = new Date();
    const d30 = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const d7 = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const isoToday = today.toISOString().slice(0, 10);

    // Продажи за 30 и 7 дней per nm_id
    const sales30 = await db.execute(sql`
      SELECT nm_id,
             SUM(orders_count) AS qty,
             SUM(orders_rub) AS rub_kop
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${ws}
        AND date >= ${d30} AND date <= ${isoToday}
      GROUP BY nm_id
    `);
    const sales7 = await db.execute(sql`
      SELECT nm_id, SUM(orders_count) AS qty
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${ws}
        AND date >= ${d7} AND date <= ${isoToday}
      GROUP BY nm_id
    `);
    const sales30Map = new Map<number, { qty: number; rubKop: number }>();
    for (const r of (sales30.rows ?? []) as any[]) {
      sales30Map.set(Number(r.nm_id), { qty: Number(r.qty) || 0, rubKop: Number(r.rub_kop) || 0 });
    }
    const sales7Map = new Map<number, number>();
    for (const r of (sales7.rows ?? []) as any[]) {
      sales7Map.set(Number(r.nm_id), Number(r.qty) || 0);
    }

    // Остатки FBO
    const fbo = await db.execute(sql`
      SELECT nm_id, SUM(quantity) AS qty
      FROM wb_stocks_current WHERE workspace_id = ${ws} GROUP BY nm_id
    `);
    const fboMap = new Map<number, number>();
    for (const r of (fbo.rows ?? []) as any[]) fboMap.set(Number(r.nm_id), Number(r.qty) || 0);

    // Остатки FBS
    const fbs = await db.execute(sql`
      SELECT nm_id, SUM(quantity) AS qty
      FROM wb_stocks_fbs_current WHERE workspace_id = ${ws} GROUP BY nm_id
    `);
    const fbsMap = new Map<number, number>();
    for (const r of (fbs.rows ?? []) as any[]) fbsMap.set(Number(r.nm_id), Number(r.qty) || 0);

    // Карточки
    const cards = await db.execute(sql`
      SELECT nm_id, title, vendor_code, main_photo_url
      FROM wb_cards WHERE workspace_id = ${ws}
    `);
    const cardMap = new Map<number, { title: string; vendorCode: string; photo: string | null }>();
    for (const r of (cards.rows ?? []) as any[]) {
      cardMap.set(Number(r.nm_id), {
        title: r.title || '',
        vendorCode: r.vendor_code || '',
        photo: r.main_photo_url || null,
      });
    }

    // Объединяем по nm_id: только те, у кого есть либо продажи, либо остатки
    const allNm = new Set<number>([
      ...sales30Map.keys(),
      ...fboMap.keys(),
      ...fbsMap.keys(),
    ]);

    // Если есть сохранённое распределение для этого месяца — оверрайдим planQty
    // (пользователь применил «Распределить план по SKU» и нажал «Сохранить»).
    const savedRows: any = await db.execute(sql`
      SELECT nm_id, plan_qty
        FROM sales_monthly_targets_per_nm
       WHERE workspace_id = ${ws}
         AND shop_id = ${q.shopId}
         AND month = ${q.month}
    `);
    const savedPlanMap = new Map<number, number>();
    for (const r of ((savedRows.rows ?? savedRows) as any[])) {
      savedPlanMap.set(Number(r.nm_id), Number(r.plan_qty) || 0);
    }

    const rows: any[] = [];
    let totalPlanQty = 0;
    let totalPlanRub = 0;
    let totalAvgPriceKop = 0;
    let countWithSales = 0;

    for (const nmId of allNm) {
      const sales30 = sales30Map.get(nmId) ?? { qty: 0, rubKop: 0 };
      const sales7 = sales7Map.get(nmId) ?? 0;
      const fboQty = fboMap.get(nmId) ?? 0;
      const fbsQty = fbsMap.get(nmId) ?? 0;
      const totalStock = fboQty + fbsQty;

      const avg30 = sales30.qty / 30;
      const avg7 = sales7 / 7;
      const trend = avg30 > 0 ? avg7 / avg30 : 1.0;
      const trendClamped = Math.max(0.5, Math.min(2.0, trend));

      const baseQty = avg30 * daysInMonth;
      const trendedQty = baseQty * trendClamped;

      // Ограничение по остаткам (×1.5 — буфер для предполагаемой поставки)
      const maxFromStock = totalStock * 1.5;
      const autoSuggestedQty = Math.round(Math.min(trendedQty, maxFromStock));
      // Если есть сохранённое значение — используем его; иначе auto-suggest
      const savedQty = savedPlanMap.get(nmId);
      const planQty = savedQty != null ? savedQty : autoSuggestedQty;
      const planFromSaved = savedQty != null;

      // Средняя цена за товар (из 30-дневных продаж)
      const avgPriceKop = sales30.qty > 0 ? Math.round(sales30.rubKop / sales30.qty) : 0;
      const planRubKop = planQty * avgPriceKop;

      if (planQty > 0 || sales30.qty > 0 || totalStock > 0) {
        const card = cardMap.get(nmId);
        rows.push({
          nmId,
          title: card?.title ?? `${nmId}`,
          vendorCode: card?.vendorCode ?? '',
          photo: card?.photo ?? null,
          avg30dQty: Math.round(avg30 * 10) / 10,
          avg7dQty: Math.round(avg7 * 10) / 10,
          trendPct: Math.round((trend - 1) * 100),
          fboQty,
          fbsQty,
          totalStockQty: totalStock,
          avgPriceRub: Math.round(avgPriceKop / 100),
          planQty,
          planRevenueRub: Math.round(planRubKop / 100),
          stockLimited: trendedQty > maxFromStock,
          planFromSaved,
        });
        totalPlanQty += planQty;
        totalPlanRub += Math.round(planRubKop / 100);
        if (sales30.qty > 0) {
          totalAvgPriceKop += avgPriceKop;
          countWithSales++;
        }
      }
    }

    rows.sort((a, b) => b.planRevenueRub - a.planRevenueRub);

    return {
      month: q.month,
      daysInMonth,
      summary: {
        skuCount: rows.length,
        totalPlanQty,
        totalPlanRub,
        avgPriceRub: countWithSales > 0 ? Math.round(totalAvgPriceKop / countWithSales / 100) : 0,
      },
      rows,
    };
  });

  /** POST /plans/monthly — upsert месячных таргетов */
  /**
   * GET /plans/distribute-orders?workspaceId&shopId&month&totalQty
   * Распределяет total план в штуках по SKU пропорционально продажам за 30 дней.
   * Учитывает остатки FBO+FBS — если по SKU нет товара, его доля идёт на 0
   * и перераспределяется на остальные.
   * Возвращает массив {nmId, vendorCode, title, photo, sold30d, share, suggestedQty, stockTotal}.
   */
  app.get('/plans/distribute-orders', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().nonnegative().optional().default(0),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      totalQty: z.coerce.number().int().positive(),
    }).parse(req.query);

    const today = new Date();
    const d30 = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const isoToday = today.toISOString().slice(0, 10);

    const shopFilter = q.shopId ? sql`AND shop_id = ${q.shopId}` : sql``;

    // Продажи за 30 дней per nm (источник — funnel = совпадает с РНП-дашбордом)
    const salesRes: any = await db.execute(sql`
      SELECT nm_id, COALESCE(SUM(order_count), 0) AS qty
        FROM wb_funnel_daily_products
       WHERE workspace_id = ${q.workspaceId} ${shopFilter}
         AND date BETWEEN ${d30} AND ${isoToday}
       GROUP BY nm_id
      HAVING COALESCE(SUM(order_count), 0) > 0
       ORDER BY qty DESC
       LIMIT 200
    `);
    const sales = ((salesRes.rows ?? salesRes) as any[]).map((r) => ({
      nmId: Number(r.nm_id), sold30d: Number(r.qty) || 0,
    }));
    if (sales.length === 0) return { items: [], totalQty: q.totalQty };

    const nmIds = sales.map((s) => s.nmId);

    // Остатки FBO + FBS
    const stocksRes: any = await db.execute(sql`
      SELECT nm_id, COALESCE(SUM(quantity), 0) AS qty
        FROM (
          SELECT nm_id, quantity FROM wb_stocks_current
           WHERE workspace_id = ${q.workspaceId} ${shopFilter}
          UNION ALL
          SELECT nm_id, quantity FROM wb_stocks_fbs_current
           WHERE workspace_id = ${q.workspaceId} ${shopFilter}
        ) s
       WHERE nm_id = ANY(${sql.raw(`ARRAY[${nmIds.join(',')}]::bigint[]`)})
       GROUP BY nm_id
    `);
    const stockMap = new Map<number, number>();
    for (const r of ((stocksRes.rows ?? stocksRes) as any[])) {
      stockMap.set(Number(r.nm_id), Number(r.qty) || 0);
    }

    // Карточки
    const cardsRes: any = await db.execute(sql`
      SELECT nm_id, title, vendor_code, main_photo_url FROM wb_cards
       WHERE workspace_id = ${q.workspaceId}
         AND nm_id = ANY(${sql.raw(`ARRAY[${nmIds.join(',')}]::bigint[]`)})
    `);
    const cardMap = new Map<number, { title: string; vendorCode: string; photo: string | null }>();
    for (const r of ((cardsRes.rows ?? cardsRes) as any[])) {
      cardMap.set(Number(r.nm_id), { title: r.title || '', vendorCode: r.vendor_code || '', photo: r.main_photo_url || null });
    }

    // Шаг 1: считаем доли только по SKU где есть остатки (или sold30d > 0 как fallback)
    let totalSold = 0;
    const eligible = sales.map((s) => {
      const stock = stockMap.get(s.nmId) ?? 0;
      const eligibleQty = stock > 0 ? s.sold30d : 0;
      totalSold += eligibleQty;
      return { ...s, stock, eligibleQty };
    });

    // Fallback: если остатков ни у кого нет — распределяем по продажам
    if (totalSold === 0) {
      totalSold = sales.reduce((s, x) => s + x.sold30d, 0);
      for (const e of eligible) e.eligibleQty = e.sold30d;
    }

    const items = eligible.map((e) => {
      const share = totalSold > 0 ? e.eligibleQty / totalSold : 0;
      let suggested = Math.round(share * q.totalQty);
      // Ограничение сверху: не больше чем (sold30d × 1.5) — не разгоняем
      const cap = Math.round(e.sold30d * 1.5);
      if (cap > 0 && suggested > cap) suggested = cap;
      const card = cardMap.get(e.nmId);
      return {
        nmId: e.nmId,
        vendorCode: card?.vendorCode ?? '',
        title: card?.title ?? `${e.nmId}`,
        photo: card?.photo ?? null,
        sold30d: e.sold30d,
        stockTotal: e.stock,
        share: Math.round(share * 10000) / 100, // % с 2 знаками
        suggestedQty: suggested,
      };
    }).sort((a, b) => b.suggestedQty - a.suggestedQty);

    const distributed = items.reduce((s, i) => s + i.suggestedQty, 0);
    return {
      month: q.month,
      totalQty: q.totalQty,
      distributedQty: distributed,
      remainingQty: Math.max(0, q.totalQty - distributed),
      items,
    };
  });

  /**
   * POST /plans/monthly/per-nm — bulk upsert плана per артикул
   */
  app.post('/plans/monthly/per-nm', { preHandler: requireRole('manager') }, async (req) => {
    const body = z.object({
      workspaceId: z.number().int().positive(),
      shopId: z.number().int().nonnegative().optional().default(0),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      items: z.array(z.object({
        nmId: z.number().int().positive(),
        planQty: z.number().int().nonnegative(),
        planRub: z.number().int().nonnegative().optional().default(0),
      })),
    }).parse(req.body);

    if (body.items.length === 0) return { ok: true, count: 0 };

    // Bulk upsert
    const now = new Date();
    for (const it of body.items) {
      await db.execute(sql`
        INSERT INTO sales_monthly_targets_per_nm
          (workspace_id, shop_id, month, nm_id, plan_qty, plan_rub, updated_at)
        VALUES (${body.workspaceId}, ${body.shopId}, ${body.month}, ${it.nmId}, ${it.planQty}, ${it.planRub}, ${now})
        ON CONFLICT (workspace_id, shop_id, month, nm_id) DO UPDATE
          SET plan_qty = EXCLUDED.plan_qty,
              plan_rub = EXCLUDED.plan_rub,
              updated_at = EXCLUDED.updated_at
      `);
    }
    return { ok: true, count: body.items.length };
  });

  /**
   * GET /plans/monthly/per-nm — план per артикул за месяц
   */
  app.get('/plans/monthly/per-nm', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().nonnegative().optional().default(0),
      month: z.string().regex(/^\d{4}-\d{2}$/),
    }).parse(req.query);

    const rows: any = await db.execute(sql`
      SELECT nm_id, plan_qty, plan_rub
        FROM sales_monthly_targets_per_nm
       WHERE workspace_id = ${q.workspaceId}
         AND shop_id = ${q.shopId}
         AND month = ${q.month}
    `);
    return {
      items: ((rows.rows ?? rows) as any[]).map((r) => ({
        nmId: Number(r.nm_id),
        planQty: Number(r.plan_qty) || 0,
        planRub: Number(r.plan_rub) || 0,
      })),
    };
  });

  app.post('/plans/monthly', { preHandler: requireRole('manager') }, async (req) => {
    const body = z.object({
      workspaceId: z.number().int().positive(),
      shopId: z.number().int().nonnegative().optional().default(0),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      marketRevenueRub: z.number().int().nonnegative().nullable().optional(),
      targetSharePct: z.number().min(0).max(1).nullable().optional(),
      planRevenueRub: z.number().int().nonnegative().default(0),
      planAdSpendRub: z.number().int().nonnegative().nullable().optional(),
      planImpressions: z.number().int().nonnegative().nullable().optional(),
      planOrdersQty: z.number().int().nonnegative().nullable().optional(),
      comment: z.string().max(2000).nullable().optional(),
    }).parse(req.body);

    await db.insert(salesMonthlyTargets).values({
      workspaceId: body.workspaceId,
      shopId: body.shopId,
      month: body.month,
      marketRevenueRub: body.marketRevenueRub ?? null,
      targetSharePct: body.targetSharePct?.toString() ?? null,
      planRevenueRub: body.planRevenueRub,
      planAdSpendRub: body.planAdSpendRub ?? null,
      planImpressions: body.planImpressions ?? null,
      planOrdersQty: body.planOrdersQty ?? null,
      comment: body.comment ?? null,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [salesMonthlyTargets.workspaceId, salesMonthlyTargets.shopId, salesMonthlyTargets.month],
      set: {
        marketRevenueRub: body.marketRevenueRub ?? null,
        targetSharePct: body.targetSharePct?.toString() ?? null,
        planRevenueRub: body.planRevenueRub,
        planAdSpendRub: body.planAdSpendRub ?? null,
        planImpressions: body.planImpressions ?? null,
        planOrdersQty: body.planOrdersQty ?? null,
        comment: body.comment ?? null,
        updatedAt: new Date(),
      },
    });

    return { ok: true };
  });
};
