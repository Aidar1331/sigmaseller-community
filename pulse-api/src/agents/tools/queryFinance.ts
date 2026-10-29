/**
 * Tool: query_finance — Финансовый обзор workspace.
 * Reuses patterns from routes/finance.ts
 */

import { db } from '../../db/client.js';
import { wbFinanceDailyProducts, wbFinanceDaily, wbAdvDailyProducts, wbFunnelDailyProducts } from '../../db/schema.js';
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { resolveProductIds } from './_resolveProductIds.js';

interface QueryFinanceArgs {
  from: string;
  to: string;
  /** nmId или vendorCode (артикул продавца). Принимается любой. */
  nmIds?: Array<number | string>;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryFinanceOverview(args: QueryFinanceArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const start = args.from;
  const end = args.to;

  // Resolve nmId или vendorCode → массив nmId
  const resolvedNmIds = args.nmIds?.length ? await resolveProductIds(wsId, args.nmIds) : [];
  if (args.nmIds?.length && !resolvedNmIds.length) {
    return JSON.stringify({ error: 'no_products_found', hint: `артикулы не найдены: ${args.nmIds.join(', ')}` });
  }

  // Finance data
  const conds: any[] = [
    eq(wbFinanceDailyProducts.workspaceId, wsId),
    ...(shopId ? [eq(wbFinanceDailyProducts.shopId, shopId)] : []),
    gte(wbFinanceDailyProducts.date, start),
    lte(wbFinanceDailyProducts.date, end),
  ];
  if (resolvedNmIds.length) conds.push(inArray(wbFinanceDailyProducts.nmId, resolvedNmIds));

  const finance = await db
    .select({
      revenueKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.revenueKopecks}), 0)`.mapWith(Number),
      incomeKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.incomeFromSalesKopecks}), 0)`.mapWith(Number),
      logisticsKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.logisticsKopecks}), 0)`.mapWith(Number),
      penaltiesKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.penaltiesKopecks}), 0)`.mapWith(Number),
      acceptanceKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.paidAcceptanceKopecks}), 0)`.mapWith(Number),
      commissionKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.commissionKopecks}), 0)`.mapWith(Number),
      // ВАЖНО: `lines` в wb_finance_daily_products — это число СТРОК отчёта
      // о реализации (одна строка = одна транзакция: продажа, возврат,
      // корректировка). Это НЕ количество товаров. До 2026-05-27 мы
      // отдавали его как qtySold → AI показывал «Продано: 851 шт» хотя
      // реально было 198 выкупов. Сейчас НЕ берём lines, а делаем отдельный
      // запрос к wb_orders_sales_daily_products (источник истины по штукам).
    })
    .from(wbFinanceDailyProducts)
    .where(and(...conds));

  let f = finance[0] ?? { revenueKop: 0, incomeKop: 0, logisticsKop: 0, penaltiesKop: 0, acceptanceKop: 0, commissionKop: 0 };

  // Fallback: если wbFinanceDailyProducts пуст — используем wbFinanceDaily (shop-level)
  const isEmpty = f.revenueKop === 0 && f.incomeKop === 0;
  let source: 'wbFinanceDailyProducts' | 'wbFinanceDaily' = 'wbFinanceDailyProducts';

  if (isEmpty) {
    const dailyConds: any[] = [
      eq(wbFinanceDaily.workspaceId, wsId),
      ...(shopId ? [eq(wbFinanceDaily.shopId, shopId)] : []),
      gte(wbFinanceDaily.date, start),
      lte(wbFinanceDaily.date, end),
    ];
    // nmIds filter не применяется — в wbFinanceDaily нет nmId

    const dailyFinance = await db
      .select({
        revenueKop: sql<number>`coalesce(sum(${wbFinanceDaily.retailKopecks}), 0)`.mapWith(Number),
        incomeKop: sql<number>`coalesce(sum(${wbFinanceDaily.payoutKopecks}), 0)`.mapWith(Number),
        logisticsKop: sql<number>`coalesce(sum(${wbFinanceDaily.logisticsKopecks}), 0)`.mapWith(Number),
        penaltiesKop: sql<number>`coalesce(sum(${wbFinanceDaily.penaltyKopecks}), 0)`.mapWith(Number),
        acceptanceKop: sql<number>`coalesce(sum(${wbFinanceDaily.paidAcceptanceKopecks}), 0)`.mapWith(Number),
        commissionKop: sql<number>`coalesce(sum(${wbFinanceDaily.commissionKopecks}), 0)`.mapWith(Number),
      })
      .from(wbFinanceDaily)
      .where(and(...dailyConds));

    const fd = dailyFinance[0];
    if (fd && (fd.revenueKop > 0 || fd.incomeKop > 0)) {
      f = fd;
      source = 'wbFinanceDaily';
    }
  }

  // Физические количества и выручка по заказам/выкупам — из funnel
  // (WB Analytics API `/sales-funnel/products`). Раньше брали из
  // wb_orders_sales_daily_products (Statistics), но числа расходились с
  // WB ЛК и с дашбордом РНП. Теперь все три источника — funnel-таблица.
  const qtyConds: any[] = [
    eq(wbFunnelDailyProducts.workspaceId, wsId),
    ...(shopId ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
    gte(wbFunnelDailyProducts.date, start),
    lte(wbFunnelDailyProducts.date, end),
  ];
  if (resolvedNmIds.length) qtyConds.push(inArray(wbFunnelDailyProducts.nmId, resolvedNmIds));
  const qty = await db
    .select({
      ordersCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      salesCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
      // funnel.*Sum хранятся в РУБЛЯХ — приводим к копейкам через *100,
      // потому что все финансовые поля внизу считаются в копейках.
      ordersRubKop: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
      salesRubKop: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutSum}) * 100, 0)`.mapWith(Number),
      cancelCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.cancelCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(...qtyConds));
  const ordersCount = qty[0]?.ordersCount ?? 0;
  const salesCount = qty[0]?.salesCount ?? 0;
  const ordersRubKop = qty[0]?.ordersRubKop ?? 0;
  const salesRubKop = qty[0]?.salesRubKop ?? 0;
  const cancelCount = qty[0]?.cancelCount ?? 0;

  // Единый источник истины для «Выручка» — funnel.buyoutSum (выкупы из
  // WB Analytics). Финансовый отчёт даёт revenue с уже включёнными
  // корректировками; разницу показываем как `adjustmentsRub` чтобы юзер
  // видел: «выручка 865к + корректировки +12к = в финансах 877к». Дашборд
  // РНП и AI-чат теперь читают одинаковые числа.
  const financeRevenueKop = f.revenueKop;
  f.revenueKop = salesRubKop; // переопределяем главную выручку на единый источник (funnel)
  const adjustmentsKop = financeRevenueKop - salesRubKop;

  // Ad spend for the period — источник истины: wb_adv_finance (/adv/v1/upd),
  // соответствует xlsx-сводному ЛК ВБ «История затрат». /v3/fullstats
  // (wb_adv_daily_products) даёт ~½ от факта и не совпадает с финотчётами.
  // Per-nm scale при необходимости делает фронт; для агента возвращаем total.
  const advRes: any = await db.execute(sql`
    SELECT COALESCE(SUM(upd_sum_kopecks), 0) AS spend_kop
      FROM wb_adv_finance
     WHERE workspace_id = ${wsId}
       ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
       AND upd_date BETWEEN ${start} AND ${end}
  `);
  const advSpendKop = Number(((advRes.rows ?? advRes) as any[])[0]?.spend_kop ?? 0);

  // Себестоимость за период = unit_cogs × (sale_qty − returns_count).
  // Раньше cogs в AI вообще не учитывалась — поэтому маржа была завышена.
  const cogsRes: any = await db.execute(sql`
    SELECT COALESCE(SUM(COALESCE(c.cogs_kopecks, 0) * GREATEST(0, fdp.sale_qty - COALESCE(fdp.returns_count, 0))), 0) AS cogs_kop,
           COUNT(DISTINCT fdp.nm_id) FILTER (WHERE c.cogs_kopecks IS NULL OR c.cogs_kopecks = 0) AS nm_without_cogs
      FROM wb_finance_daily_products fdp
      LEFT JOIN wb_cogs c ON c.workspace_id = fdp.workspace_id AND c.nm_id = fdp.nm_id
     WHERE fdp.workspace_id = ${wsId}
       ${shopId ? sql`AND fdp.shop_id = ${shopId}` : sql``}
       AND fdp.date BETWEEN ${start} AND ${end}
  `);
  const cogsKop = Number(((cogsRes.rows ?? cogsRes) as any[])[0]?.cogs_kop ?? 0);
  const nmWithoutCogs = Number(((cogsRes.rows ?? cogsRes) as any[])[0]?.nm_without_cogs ?? 0);

  // Calculate margins. ВКЛЮЧАЕТ себестоимость!
  const totalCostsKop = f.logisticsKop + f.penaltiesKop + f.acceptanceKop + f.commissionKop + advSpendKop + cogsKop;
  const profitKop = f.revenueKop - totalCostsKop;
  const marginPct = f.revenueKop > 0 ? ((profitKop / f.revenueKop) * 100).toFixed(1) : '0';
  const drrPct = f.revenueKop > 0 ? ((advSpendKop / f.revenueKop) * 100).toFixed(1) : '0';

  return JSON.stringify({
    source,
    period: { from: start, to: end },
    // Главная выручка — sales_rub из orders_sales (единый источник для всех тулов).
    revenueKop: f.revenueKop,
    revenueRub: Math.round(f.revenueKop / 100),
    // Корректировки финотчёта (revenueFinance - salesRaw). Может быть «+» или «−».
    adjustmentsKop,
    adjustmentsRub: Math.round(adjustmentsKop / 100),
    financeReportRevenueRub: Math.round(financeRevenueKop / 100),
    logisticsKop: f.logisticsKop,
    penaltiesKop: f.penaltiesKop,
    acceptanceKop: f.acceptanceKop,
    commissionKop: f.commissionKop,
    advSpendKop: advSpendKop,
    totalCostsKop: totalCostsKop,
    profitKop: profitKop,
    profitRub: Math.round(profitKop / 100),
    marginPct: Number(marginPct),
    drrPct: Number(drrPct),
    // Заказы — главный показатель «активность недели». Сумма заказов
    // включает невыкупленные позиции (часть превратится в выручку позже).
    ordersCount,
    ordersRevenueRub: Math.round(ordersRubKop / 100),
    // Выкупы — показываем как вторичную метрику. Реальный % выкупа
    // считается когортно (см. query_funnel/buyoutPercent), а не отношением
    // ordersCount/salesCount за одну неделю (это разные товары/даты).
    salesCount,
    cancelCount,
    salesSource: 'analytics-funnel',
    qtySoldNote: 'Источник заказов/выкупов: WB Analytics (sales-funnel/products) — те же числа, что в WB ЛК и в дашборде РНП. Главная пара: ordersCount + ordersRevenueRub. salesCount/cancelCount — справочно (выкупы и отмены за период).',
    // Себестоимость
    cogsKop,
    cogsRub: Math.round(cogsKop / 100),
    nmWithoutCogs,
    cogsNote: nmWithoutCogs > 0
      ? `Себестоимость учтена для покрытых артикулов; ${nmWithoutCogs} артикулов без cogs в справочнике (заполнить через /cogs).`
      : 'Себестоимость учтена для всех артикулов с продажами в периоде.',
    sourcesNote: 'ФИНАНСЫ (деньги ₽): wb_finance_reports = совпадает с xlsx ЛК ВБ «Финансовые отчёты». Реклама — wb_adv_finance (= xlsx «История затрат»). Себестоимость — wb_cogs × фактически проданные штуки. ВОРОНКА (количество шт): wb_funnel_daily_products = orderCount/buyoutCount, совпадает с WB Analytics. Финансы и воронка — РАЗНЫЕ срезы, не смешивать.',
  });
}
