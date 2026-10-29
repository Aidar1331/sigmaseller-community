import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logJobs as logger } from '../lib/logger.js';
import {
  wbAdvDailyProducts,
  wbAlertSettings,
  wbEvents,
  wbOrdersSalesDailyProducts,
  wbStocksCurrent,
  wbTagProducts,
  wbFunnelDailyProducts,
  pulseAlertControls,
} from '../db/schema.js';

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function runAutoAlerts(opts: {
  workspaceId: number;
  date?: string; // YYYY-MM-DD, defaults to today (UTC)
}) {
  const workspaceId = opts.workspaceId;
  const date = opts.date ?? ymd(new Date());

  const created: Array<{ fingerprint: string; nmId: number | null; title: string }> = [];

  // Load settings
  const settings = await db.select().from(wbAlertSettings).where(eq(wbAlertSettings.workspaceId, workspaceId));
  const workspaceDefaults = settings.find((s) => !s.nmId && !s.tagId) ?? null;

  const controls = await db.select().from(pulseAlertControls).where(eq(pulseAlertControls.workspaceId, workspaceId));
  const controlsDefaults = controls.find((s) => !s.nmId && !s.tagId) ?? null;

  function effectiveSetting(nmId: number, tagIds: number[]) {
    const nm = settings.find((s) => Number(s.nmId ?? 0) === nmId) ?? null;
    const tag = settings.find((s) => s.tagId && tagIds.includes(Number(s.tagId))) ?? null;
    const pick = (key: keyof typeof wbAlertSettings.$inferSelect) =>
      (nm as any)?.[key] ?? (tag as any)?.[key] ?? (workspaceDefaults as any)?.[key] ?? null;

    const nmC = controls.find((s) => Number(s.nmId ?? 0) === nmId) ?? null;
    const tagC = controls.find((s) => s.tagId && tagIds.includes(Number(s.tagId))) ?? null;
    const pickC = (key: keyof typeof pulseAlertControls.$inferSelect) =>
      (nmC as any)?.[key] ?? (tagC as any)?.[key] ?? (controlsDefaults as any)?.[key] ?? null;

    return {
      // thresholds
      maxDrrFactPct: pick('maxDrrFactPct') as number | null,
      maxDrrForecastPct: pick('maxDrrForecastPct') as number | null,
      minDaysOfStock: pick('minDaysOfStock') as number | null,
      buyoutDropPpWarn: pick('buyoutDropPpWarn') as number | null,
      buyoutDropPpCrit: pick('buyoutDropPpCrit') as number | null,

      // controls
      enableStocks: (pickC('enableStocks') as boolean | null) ?? true,
      enableAds: (pickC('enableAds') as boolean | null) ?? true,
      enableDrr: (pickC('enableDrr') as boolean | null) ?? true,
      enableBuyout: (pickC('enableBuyout') as boolean | null) ?? true,
      enableSalesDrop: (pickC('enableSalesDrop') as boolean | null) ?? true,
      cooldownDays: (pickC('cooldownDays') as number | null) ?? 1,
    };
  }

  // tag map (for product-scoped settings)
  const tagRows = await db.select({ nmId: wbTagProducts.nmId, tagId: wbTagProducts.tagId }).from(wbTagProducts).where(eq(wbTagProducts.workspaceId, workspaceId));
  const tagsByNm = new Map<number, number[]>();
  for (const r of tagRows) {
    const nmId = Number(r.nmId);
    const tagId = Number(r.tagId);
    const list = tagsByNm.get(nmId) ?? [];
    list.push(tagId);
    tagsByNm.set(nmId, list);
  }

  // 1) Stocks: low/zero based on settings
  {
    const rows = await db
      .select({
        nmId: wbStocksCurrent.nmId,
        quantity: wbStocksCurrent.quantity,
        inWayToClient: wbStocksCurrent.inWayToClient,
        inWayFromClient: wbStocksCurrent.inWayFromClient,
      })
      .from(wbStocksCurrent)
      .where(eq(wbStocksCurrent.workspaceId, workspaceId));

    // salesPerDay from last 14 days average
    const prev14Start = ymd(new Date(new Date(date + 'T00:00:00Z').getTime() - 14 * 24 * 3600 * 1000));
    const avgs = await db
      .select({ nmId: wbOrdersSalesDailyProducts.nmId, avgSalesCount: sql<number>`avg(${wbOrdersSalesDailyProducts.salesCount})` })
      .from(wbOrdersSalesDailyProducts)
      .where(and(eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId), gte(wbOrdersSalesDailyProducts.date, prev14Start), lt(wbOrdersSalesDailyProducts.date, date)))
      .groupBy(wbOrdersSalesDailyProducts.nmId);
    const avgSalesByNm = new Map<number, number>();
    for (const r of avgs) avgSalesByNm.set(Number(r.nmId), Number(r.avgSalesCount ?? 0));

    for (const r of rows) {
      const nmId = Number(r.nmId);
      const tagIds = tagsByNm.get(nmId) ?? [];
      const s = effectiveSetting(nmId, tagIds);
      if (!s.enableStocks) continue;

      const qty = Number(r.quantity ?? 0);
      const salesPerDay = avgSalesByNm.get(nmId) ?? 0;
      const coverDays = salesPerDay > 0 ? qty / salesPerDay : null;

      // zero always critical
      if (qty === 0) {
        const prefix = `stock_zero:${nmId}:`;
        if (await recentlyFired(prefix, s.cooldownDays)) continue;
        const fingerprint = `stock_zero:${nmId}:${date}`;
        const title = `Остатки = 0 (nmId ${nmId})`;
        try {
          await db
            .insert(wbEvents)
            .values({
              workspaceId,
              nmId,
              date,
              type: 'alert',
              category: 'stocks',
              severity: 'critical',
              status: 'open',
              title,
              description: 'На текущий момент остатки на WB равны 0. Проверь поставки/склад/в пути.',
              evidence: { quantity: r.quantity, inWayToClient: r.inWayToClient, inWayFromClient: r.inWayFromClient, salesPerDay, coverDays },
              fingerprint,
              // AI fields
              triggerRule: 'stock_zero',
              suggestedAction: 'Срочно создать поставку на склад WB. Проверить товары в пути и на складе поставщика.',
              widgetType: 'stocks_table',
              widgetProps: { nmId, showInWay: true },
            })
            .onConflictDoNothing();
          created.push({ fingerprint, nmId, title });
        } catch (alertErr) { logger.error({ err: alertErr }, 'Alert insert error');
          // ignore
        }
        continue;
      }

      // low stock by setting (warn)
      if (s.minDaysOfStock != null && coverDays != null && coverDays < s.minDaysOfStock) {
        const prefix = `stock_low:${nmId}:`;
        if (await recentlyFired(prefix, s.cooldownDays)) continue;
        const fingerprint = `stock_low:${nmId}:${date}`;
        const title = `Низкий остаток: ${coverDays.toFixed(1)}д < ${s.minDaysOfStock}д (nmId ${nmId})`;
        const isCritical = coverDays < Math.max(1, s.minDaysOfStock / 2);
        try {
          await db
            .insert(wbEvents)
            .values({
              workspaceId,
              nmId,
              date,
              type: 'alert',
              category: 'stocks',
              severity: isCritical ? 'critical' : 'warn',
              status: 'open',
              title,
              description: 'Остатка не хватает на заданное число дней продаж (по среднему за последние 14 дней).',
              evidence: { quantity: r.quantity, salesPerDay, coverDays, minDaysOfStock: s.minDaysOfStock },
              fingerprint,
              // AI fields
              triggerRule: 'stock_low',
              suggestedAction: isCritical
                ? 'Срочно запланировать поставку. Текущего остатка хватит менее чем на половину целевого срока.'
                : 'Запланировать поставку в ближайшее время. Остаток ниже целевого уровня.',
              widgetType: 'stocks_table',
              widgetProps: { nmId, highlightLow: true, targetDays: s.minDaysOfStock },
            })
            .onConflictDoNothing();
          created.push({ fingerprint, nmId, title });
        } catch (alertErr) { logger.error({ err: alertErr }, 'Alert insert error');
          // ignore
        }
      }
    }
  }

  async function recentlyFired(prefix: string, cooldownDays: number) {
    if (cooldownDays <= 0) return false;
    const from = ymd(new Date(new Date(date + 'T00:00:00Z').getTime() - cooldownDays * 24 * 3600 * 1000));
    const rows = await db
      .select({ date: wbEvents.date })
      .from(wbEvents)
      .where(and(eq(wbEvents.workspaceId, workspaceId), gte(wbEvents.date, from), lt(wbEvents.date, date), sql`${wbEvents.fingerprint} like ${prefix + '%'}`))
      .limit(1);
    return rows.length > 0;
  }

  // 2) Ads: advertsCount > 0 but spend == 0 for the day
  {
    const rows = await db
      .select({ nmId: wbAdvDailyProducts.nmId, spendKopecks: wbAdvDailyProducts.spendKopecks, advertsCount: wbAdvDailyProducts.advertsCount })
      .from(wbAdvDailyProducts)
      .where(
        and(
          eq(wbAdvDailyProducts.workspaceId, workspaceId),
          eq(wbAdvDailyProducts.date, date),
          gt0(wbAdvDailyProducts.advertsCount),
          eq(wbAdvDailyProducts.spendKopecks, 0)
        )
      );

    for (const r of rows) {
      const nmId = Number(r.nmId);
      const tagIds = tagsByNm.get(nmId) ?? [];
      const s = effectiveSetting(nmId, tagIds);
      if (!s.enableAds) continue;

      const prefix = `adv_spend_zero:${nmId}:`;
      if (await recentlyFired(prefix, s.cooldownDays)) continue;

      const fingerprint = `${prefix}${date}`;
      const title = `Реклама: расход 0 при активных объявлениях (nmId ${nmId})`;
      try {
        await db
          .insert(wbEvents)
          .values({
            workspaceId,
            nmId,
            date,
            type: 'alert',
            category: 'ads',
            severity: 'warn',
            status: 'open',
            title,
            description: 'Есть активные объявления, но расход за день = 0. Возможен нулевой бюджет/остановка показов.',
            evidence: { spendKopecks: r.spendKopecks, advertsCount: r.advertsCount, cooldownDays: s.cooldownDays },
            fingerprint,
            // AI fields
            triggerRule: 'adv_spend_zero',
            suggestedAction: 'Проверить бюджет и ставки рекламных кампаний. Возможно, кампания приостановлена или ставка слишком низкая.',
            widgetType: 'campaign_list',
            widgetProps: { nmId, showBudget: true, showBids: true },
          })
          .onConflictDoNothing();
        created.push({ fingerprint, nmId, title });
      } catch (alertErr) { logger.error({ err: alertErr }, 'Alert insert error');
        // ignore
      }
    }
  }

  // 3) DRR threshold exceeded (fact)
  {
    // compute DRR% per nmId from today's spend vs today's salesRub
    const adv = await db
      .select({ nmId: wbAdvDailyProducts.nmId, spendKopecks: wbAdvDailyProducts.spendKopecks })
      .from(wbAdvDailyProducts)
      .where(and(eq(wbAdvDailyProducts.workspaceId, workspaceId), eq(wbAdvDailyProducts.date, date)));

    const sales = await db
      .select({ nmId: wbOrdersSalesDailyProducts.nmId, salesRub: wbOrdersSalesDailyProducts.salesRub })
      .from(wbOrdersSalesDailyProducts)
      .where(and(eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId), eq(wbOrdersSalesDailyProducts.date, date)));

    const spendByNm = new Map<number, number>();
    for (const r of adv) spendByNm.set(Number(r.nmId), Number(r.spendKopecks ?? 0));

    const salesByNm = new Map<number, number>();
    for (const r of sales) salesByNm.set(Number(r.nmId), Number(r.salesRub ?? 0));

    for (const [nmId, spendK] of spendByNm.entries()) {
      const salesRub = salesByNm.get(nmId) ?? 0;
      if (salesRub <= 0) continue;
      // Both spendK (wb_adv_daily_products.spendKopecks) and salesRub
      // (wb_orders_sales_daily_products.salesRub — naming misleading: column
      // stores kopecks per schema.ts) are in kopecks. Ratio cancels units
      // so no /100 conversion is needed. Previous code divided spendK by 100
      // first, producing DRR 100× smaller than reality → alerts never fired.
      const drrPct = (spendK / salesRub) * 100;
      const tagIds = tagsByNm.get(nmId) ?? [];
      const s = effectiveSetting(nmId, tagIds);
      if (!s.enableDrr) continue;
      if (s.maxDrrFactPct == null) continue;

      const prefix = `drr_fact_high:${nmId}:`;
      if (await recentlyFired(prefix, s.cooldownDays)) continue;
      if (drrPct <= s.maxDrrFactPct) continue;

      const fingerprint = `drr_fact_high:${nmId}:${date}`;
      const title = `ДРР выше порога (${drrPct.toFixed(1)}% > ${s.maxDrrFactPct}%) (nmId ${nmId})`;
      const isCritical = drrPct > s.maxDrrFactPct * 1.5;
      try {
        await db
          .insert(wbEvents)
          .values({
            workspaceId,
            nmId,
            date,
            type: 'alert',
            category: 'ads',
            severity: isCritical ? 'critical' : 'warn',
            status: 'open',
            title,
            description: 'ДРР (факт) за день выше заданного порога.',
            evidence: { spendKopecks: spendK, salesRub, drrPct, thresholdPct: s.maxDrrFactPct },
            fingerprint,
            // AI fields
            triggerRule: 'drr_high',
            suggestedAction: isCritical
              ? 'Рекомендую приостановить рекламу или значительно снизить ставки. ДРР критически высокий.'
              : 'Рассмотреть снижение ставок рекламных кампаний для оптимизации ДРР.',
            widgetType: 'drr_chart',
            widgetProps: { nmId, showThreshold: true, threshold: s.maxDrrFactPct },
          })
          .onConflictDoNothing();
        created.push({ fingerprint, nmId, title });
      } catch (alertErr) { logger.error({ err: alertErr }, 'Alert insert error');
        // ignore
      }
    }
  }

  // 4) Buyout drop vs prev 7d avg (funnel)
  {
    const prev7Start = ymd(new Date(new Date(date + 'T00:00:00Z').getTime() - 7 * 24 * 3600 * 1000));

    const avgs = await db
      .select({ nmId: wbFunnelDailyProducts.nmId, avgBuyoutBp: sql<number>`avg(${wbFunnelDailyProducts.buyoutPercentBp})` })
      .from(wbFunnelDailyProducts)
      .where(and(eq(wbFunnelDailyProducts.workspaceId, workspaceId), gte(wbFunnelDailyProducts.date, prev7Start), lt(wbFunnelDailyProducts.date, date)))
      .groupBy(wbFunnelDailyProducts.nmId);

    const avgByNm = new Map<number, number>();
    for (const r of avgs) avgByNm.set(Number(r.nmId), Number(r.avgBuyoutBp ?? 0));

    const todays = await db
      .select({ nmId: wbFunnelDailyProducts.nmId, buyoutBp: wbFunnelDailyProducts.buyoutPercentBp, orderCount: wbFunnelDailyProducts.orderCount })
      .from(wbFunnelDailyProducts)
      .where(and(eq(wbFunnelDailyProducts.workspaceId, workspaceId), eq(wbFunnelDailyProducts.date, date)));

    for (const r of todays) {
      const nmId = Number(r.nmId);
      const avgBp = avgByNm.get(nmId);
      if (avgBp == null) continue;
      const todayBp = Number(r.buyoutBp ?? 0);
      const dropPp = (avgBp - todayBp) / 100; // bp -> percentage points

      const tagIds = tagsByNm.get(nmId) ?? [];
      const s = effectiveSetting(nmId, tagIds);

      if (!s.enableBuyout) continue;

      const prefix = `buyout_drop:${nmId}:`;
      if (await recentlyFired(prefix, s.cooldownDays)) continue;

      const warn = s.buyoutDropPpWarn ?? null;
      const crit = s.buyoutDropPpCrit ?? null;
      if (warn == null && crit == null) continue;

      const sev = crit != null && dropPp >= crit ? 'critical' : warn != null && dropPp >= warn ? 'warn' : null;
      if (!sev) continue;

      const fingerprint = `buyout_drop:${nmId}:${date}`;
      const title = `Падение %выкупа: -${dropPp.toFixed(1)} п.п. (nmId ${nmId})`;
      try {
        await db
          .insert(wbEvents)
          .values({
            workspaceId,
            nmId,
            date,
            type: 'alert',
            category: 'buyout',
            severity: sev,
            status: 'open',
            title,
            description: 'Процент выкупа за день ниже среднего за последние 7 дней на заданный порог.',
            evidence: { todayBp, avgBp, dropPp, warnPp: warn, critPp: crit, orderCount: r.orderCount },
            fingerprint,
            // AI fields
            triggerRule: 'buyout_drop',
            suggestedAction: sev === 'critical'
              ? 'Критическое падение выкупа. Проанализировать последние отзывы, проверить качество товара и актуальность описания.'
              : 'Проанализировать причины снижения выкупа: отзывы, фото, описание, размерная сетка.',
            widgetType: 'funnel_diagram',
            widgetProps: { nmId, showTrend: true, comparePeriod: '7d' },
          })
          .onConflictDoNothing();
        created.push({ fingerprint, nmId, title });
      } catch (alertErr) { logger.error({ err: alertErr }, 'Alert insert error');
        // ignore
      }
    }
  }

  // 5) Sharp sales drop vs last 7 days avg
  {
    const prev7Start = ymd(new Date(new Date(date + 'T00:00:00Z').getTime() - 7 * 24 * 3600 * 1000));

    // avg salesRub by nmId for the previous 7 days (excluding today)
    const avgs = await db
      .select({ nmId: wbOrdersSalesDailyProducts.nmId, avgSalesRub: sql<number>`avg(${wbOrdersSalesDailyProducts.salesRub})` })
      .from(wbOrdersSalesDailyProducts)
      .where(and(eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId), gte(wbOrdersSalesDailyProducts.date, prev7Start), lt(wbOrdersSalesDailyProducts.date, date)))
      .groupBy(wbOrdersSalesDailyProducts.nmId);

    const avgByNm = new Map<number, number>();
    for (const r of avgs) avgByNm.set(Number(r.nmId), Number(r.avgSalesRub ?? 0));

    const todays = await db
      .select({ nmId: wbOrdersSalesDailyProducts.nmId, salesRub: wbOrdersSalesDailyProducts.salesRub, ordersCount: wbOrdersSalesDailyProducts.ordersCount })
      .from(wbOrdersSalesDailyProducts)
      .where(and(eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId), eq(wbOrdersSalesDailyProducts.date, date)));

    for (const r of todays) {
      const nmId = Number(r.nmId);
      const avgSales = avgByNm.get(nmId) ?? 0;
      const todaySales = Number(r.salesRub ?? 0);

      // thresholds: average >= 5k RUB (500k kopecks) and today < 30% of avg
      if (avgSales < 500_000) continue;
      if (todaySales >= avgSales * 0.3) continue;

      const tagIds = tagsByNm.get(nmId) ?? [];
      const s = effectiveSetting(nmId, tagIds);
      if (!s.enableSalesDrop) continue;

      const prefix = `sales_drop:${nmId}:`;
      if (await recentlyFired(prefix, s.cooldownDays)) continue;

      const fingerprint = `sales_drop:${nmId}:${date}`;
      const title = `Просадка продаж (nmId ${nmId})`;
      const dropPct = ((avgSales - todaySales) / avgSales * 100).toFixed(0);
      try {
        await db
          .insert(wbEvents)
          .values({
            workspaceId,
            nmId,
            date,
            type: 'alert',
            category: 'sales',
            severity: 'warn',
            status: 'open',
            title,
            description: 'Продажи за день сильно ниже среднего за последние 7 дней.',
            evidence: { todaySalesRub: todaySales, avgSalesRub7d: avgSales, ordersCount: r.ordersCount },
            fingerprint,
            // AI fields
            triggerRule: 'sales_drop',
            suggestedAction: `Продажи упали на ${dropPct}%. Проверить: позиции в поиске, остатки на складах, работу рекламы, изменения цен конкурентов.`,
            widgetType: 'sales_chart',
            widgetProps: { nmId, period: '14d', showAverage: true },
          })
          .onConflictDoNothing();
        created.push({ fingerprint, nmId, title });
      } catch (alertErr) { logger.error({ err: alertErr }, 'Alert insert error');
        // ignore
      }
    }
  }

  return { ok: true as const, workspaceId, date, createdCount: created.length, created };
}

function gt0(col: any) {
  // drizzle-orm lacks a nice helper; use raw SQL compare
  return sql`${col} > 0`;
}
