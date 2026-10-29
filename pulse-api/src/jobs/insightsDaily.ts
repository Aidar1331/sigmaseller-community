import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import {
  workspaces,
  wbOrdersSalesDailyProducts,
  wbFunnelDailyProducts,
  wbAdvDailyProducts,
  wbFinanceDailyProducts,
  wbSppWeekly,
  marketplaceFeedbackItems,
  insights,
} from '../db/schema.js';
import { baseThresholdPct, insertInsight, scoreByDelta, severityByDelta } from '../services/insights.js';
import { getInsightSettings, updateInsightLastRun } from '../services/insightSettings.js';
import { getExcludedNmIds } from '../services/insightTags.js';
import { createStockInsights } from '../services/insightsStocks.js';
import { sendTelegramModeration } from '../integrations/telegram.js';

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function dateSub(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return ymd(d);
}

function listDates(start: string, end: string): string[] {
  const out: string[] = [];
  let d = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  while (d.getTime() <= e.getTime()) {
    out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function pctChange(cur: number, prev: number): number {
  if (prev <= 0) return cur > 0 ? 1 : 0;
  return (cur - prev) / prev;
}

function withinPctChange(cur: number, prev: number, pct: number): boolean {
  const delta = pctChange(cur, prev);
  return Math.abs(delta) <= pct;
}

function getLocalParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

async function maxDateForWorkspace(table: any, dateCol: any, workspaceId: number) {
  const [row] = await db
    .select({ maxDate: sql<string>`max(${dateCol})` })
    .from(table)
    .where(eq(table.workspaceId, workspaceId));
  return row?.maxDate ?? null;
}

async function sumOrdersSalesByNm(workspaceId: number, start: string, end: string) {
  const rows = await db
    .select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      orders: sql<number>`sum(${wbOrdersSalesDailyProducts.ordersCount})`.mapWith(Number),
      salesRub: sql<number>`sum(${wbOrdersSalesDailyProducts.salesRub})`.mapWith(Number),
      finishedPriceRub: sql<number>`sum(${wbOrdersSalesDailyProducts.finishedPriceRub})`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(
      and(
        eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
        gte(wbOrdersSalesDailyProducts.date, start),
        lte(wbOrdersSalesDailyProducts.date, end)
      )
    )
    .groupBy(wbOrdersSalesDailyProducts.nmId);

  const map = new Map<number, any>();
  for (const r of rows) {
    map.set(Number(r.nmId), {
      orders: Number(r.orders ?? 0),
      salesRub: Number(r.salesRub ?? 0),
      finishedPriceRub: Number(r.finishedPriceRub ?? 0),
    });
  }
  return map;
}

async function sumFunnelByNm(workspaceId: number, start: string, end: string) {
  const rows = await db
    .select({
      nmId: wbFunnelDailyProducts.nmId,
      viewCount: sql<number>`sum(${wbFunnelDailyProducts.viewCount})`.mapWith(Number),
      openCardCount: sql<number>`sum(${wbFunnelDailyProducts.openCardCount})`.mapWith(Number),
      orderCount: sql<number>`sum(${wbFunnelDailyProducts.orderCount})`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(
      and(
        eq(wbFunnelDailyProducts.workspaceId, workspaceId),
        gte(wbFunnelDailyProducts.date, start),
        lte(wbFunnelDailyProducts.date, end)
      )
    )
    .groupBy(wbFunnelDailyProducts.nmId);

  const map = new Map<number, any>();
  for (const r of rows) {
    map.set(Number(r.nmId), {
      viewCount: Number(r.viewCount ?? 0),
      openCardCount: Number(r.openCardCount ?? 0),
      orderCount: Number(r.orderCount ?? 0),
    });
  }
  return map;
}

async function sumAdvByNm(workspaceId: number, start: string, end: string) {
  const rows = await db
    .select({
      nmId: wbAdvDailyProducts.nmId,
      spendKopecks: sql<number>`sum(${wbAdvDailyProducts.spendKopecks})`.mapWith(Number),
      ordersCount: sql<number>`sum(${wbAdvDailyProducts.ordersCount})`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(
      and(eq(wbAdvDailyProducts.workspaceId, workspaceId), gte(wbAdvDailyProducts.date, start), lte(wbAdvDailyProducts.date, end))
    )
    .groupBy(wbAdvDailyProducts.nmId);

  const map = new Map<number, any>();
  for (const r of rows) {
    map.set(Number(r.nmId), {
      spendKopecks: Number(r.spendKopecks ?? 0),
      ordersCount: Number(r.ordersCount ?? 0),
    });
  }
  return map;
}

async function sumReturnsByNm(workspaceId: number, start: string, end: string) {
  const rows = await db
    .select({
      nmId: wbFinanceDailyProducts.nmId,
      returnsCount: sql<number>`sum(${wbFinanceDailyProducts.returnsCount})`.mapWith(Number),
    })
    .from(wbFinanceDailyProducts)
    .where(
      and(eq(wbFinanceDailyProducts.workspaceId, workspaceId), gte(wbFinanceDailyProducts.date, start), lte(wbFinanceDailyProducts.date, end))
    )
    .groupBy(wbFinanceDailyProducts.nmId);

  const map = new Map<number, any>();
  for (const r of rows) map.set(Number(r.nmId), { returnsCount: Number(r.returnsCount ?? 0) });
  return map;
}

async function avgOrdersByDow(workspaceId: number, nmIds: number[], start: string, end: string) {
  if (!nmIds.length) return new Map<number, Map<number, number>>();

  const rows = await db
    .select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      dow: sql<number>`extract(dow from ${wbOrdersSalesDailyProducts.date}::date)`.mapWith(Number),
      avgOrders: sql<number>`avg(${wbOrdersSalesDailyProducts.ordersCount})`.mapWith(Number),
    })
    .from(wbOrdersSalesDailyProducts)
    .where(
      and(
        eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
        gte(wbOrdersSalesDailyProducts.date, start),
        lte(wbOrdersSalesDailyProducts.date, end),
        inArray(wbOrdersSalesDailyProducts.nmId, nmIds as any)
      )
    )
    .groupBy(wbOrdersSalesDailyProducts.nmId, sql`extract(dow from ${wbOrdersSalesDailyProducts.date}::date)`);

  const map = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const nmId = Number(r.nmId);
    const dow = Number(r.dow);
    const avg = Number(r.avgOrders ?? 0);
    const m = map.get(nmId) ?? new Map<number, number>();
    m.set(dow, avg);
    map.set(nmId, m);
  }
  return map;
}

async function getLatestSppChange(workspaceId: number, nmId: number): Promise<number | null> {
  const rows = await db
    .select({
      dateFrom: wbSppWeekly.dateFrom,
      sppPctBp: wbSppWeekly.sppPctBp,
    })
    .from(wbSppWeekly)
    .where(and(eq(wbSppWeekly.workspaceId, workspaceId), eq(wbSppWeekly.nmId, nmId)))
    .orderBy(desc(wbSppWeekly.dateFrom))
    .limit(2);

  if (rows.length < 2) return null;
  const cur = Number(rows[0].sppPctBp ?? 0);
  const prev = Number(rows[1].sppPctBp ?? 0);
  if (prev === 0) return null;
  return (cur - prev) / prev;
}

async function feedbackNegativeShare(workspaceId: number, start: Date, end: Date) {
  const rows = await db
    .select({
      nmId: marketplaceFeedbackItems.nmId,
      total: sql<number>`count(*)`.mapWith(Number),
      negative: sql<number>`sum(case when ${marketplaceFeedbackItems.rating} <= 3 then 1 else 0 end)`.mapWith(Number),
    })
    .from(marketplaceFeedbackItems)
    .where(
      and(
        eq(marketplaceFeedbackItems.workspaceId, workspaceId),
        gte(marketplaceFeedbackItems.createdAt, start),
        lt(marketplaceFeedbackItems.createdAt, end)
      )
    )
    .groupBy(marketplaceFeedbackItems.nmId);

  const map = new Map<number, { total: number; negative: number }>();
  for (const r of rows) {
    map.set(Number(r.nmId ?? 0) || 0, { total: Number(r.total ?? 0), negative: Number(r.negative ?? 0) });
  }
  return map;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isTelegramEnabled(settings: any): boolean {
  return !!settings?.notifyChannels?.telegram;
}

function shouldTelegramCategory(settings: any, category: string): boolean {
  const cat = settings?.notifyChannels?.categories?.[category];
  if (cat && typeof cat.telegram === 'boolean') return cat.telegram;
  return !!settings?.notifyChannels?.telegram;
}

async function sendTelegramInsights(workspaceId: number, date: string, settings: any) {
  if (!isTelegramEnabled(settings)) return;

  const rows = await db
    .select({
      insightId: insights.insightId,
      title: insights.title,
      severity: insights.severity,
      score: insights.score,
      category: insights.category,
    })
    .from(insights)
    .where(and(eq(insights.workspaceId, workspaceId), eq(insights.date, date)))
    .orderBy(desc(insights.score), desc(insights.createdAt))
    .limit(20);

  const filtered = rows.filter(
    (r) =>
      (r.severity === 'critical' || r.severity === 'warn') &&
      shouldTelegramCategory(settings, String(r.category ?? ''))
  );
  const top = filtered.slice(0, 3);
  if (!top.length) return;

  const lines = top.map((r, idx) => {
    const sev = r.severity === 'critical' ? '🔴' : '🟠';
    return `${idx + 1}. ${sev} ${escapeHtml(String(r.title))}`;
  });

  const text = `<b>Pulse: инсайты за ${escapeHtml(date)}</b>\n` + lines.join('\n');
  await sendTelegramModeration({ text });
}

export async function runInsightsForWorkspace(workspaceId: number, dateOverride?: string) {
  const settings = await getInsightSettings(workspaceId);
  const threshold = baseThresholdPct(settings.sensitivity);

  const latestDate = dateOverride ?? (await maxDateForWorkspace(wbOrdersSalesDailyProducts, wbOrdersSalesDailyProducts.date, workspaceId));
  if (!latestDate) return { created: 0, reason: 'no_data' };

  const curEnd = latestDate;
  const curStart = dateSub(curEnd, 6);
  const prevEnd = dateSub(curStart, 1);
  const prevStart = dateSub(curStart, 7);

  const baselineStart = dateSub(curStart, 28);
  const baselineEnd = dateSub(curStart, 1);

  const excludedNmIds = await getExcludedNmIds(workspaceId, settings.excludedTagIds);

  const curOrders = await sumOrdersSalesByNm(workspaceId, curStart, curEnd);
  const prevOrders = await sumOrdersSalesByNm(workspaceId, prevStart, prevEnd);

  const nmIds = new Set<number>([...curOrders.keys(), ...prevOrders.keys()]);
  const nmList = [...nmIds].filter((nm) => !excludedNmIds.has(nm));

  const baselineByDow = await avgOrdersByDow(workspaceId, nmList, baselineStart, baselineEnd);
  const curDates = listDates(curStart, curEnd);

  const curFunnel = await sumFunnelByNm(workspaceId, curStart, curEnd);
  const prevFunnel = await sumFunnelByNm(workspaceId, prevStart, prevEnd);

  const curAdv = await sumAdvByNm(workspaceId, curStart, curEnd);
  const prevAdv = await sumAdvByNm(workspaceId, prevStart, prevEnd);

  const curReturns = await sumReturnsByNm(workspaceId, curStart, curEnd);
  const prevReturns = await sumReturnsByNm(workspaceId, prevStart, prevEnd);

  const feedbackCur = await feedbackNegativeShare(workspaceId, new Date(curStart + 'T00:00:00Z'), new Date(curEnd + 'T23:59:59Z'));
  const feedbackPrev = await feedbackNegativeShare(workspaceId, new Date(prevStart + 'T00:00:00Z'), new Date(prevEnd + 'T23:59:59Z'));

  const MIN_ORDERS = 10;
  const MIN_VIEWS = 1000;
  const MIN_SPEND_RUB = 3000;

  let created = 0;

  for (const nmId of nmList) {
    const cur = curOrders.get(nmId) ?? { orders: 0, salesRub: 0, finishedPriceRub: 0 };
    const prev = prevOrders.get(nmId) ?? { orders: 0, salesRub: 0, finishedPriceRub: 0 };

    if (cur.orders < MIN_ORDERS && prev.orders < MIN_ORDERS) continue;

    const baseline = baselineByDow.get(nmId) ?? null;
    let expectedOrders = prev.orders;
    if (baseline && baseline.size > 0) {
      let expected = 0;
      for (const d of curDates) {
        const dow = new Date(d + 'T00:00:00Z').getUTCDay();
        expected += baseline.get(dow) ?? 0;
      }
      if (expected > 0) expectedOrders = expected;
    }

    const deltaOrders = pctChange(cur.orders, expectedOrders);
    if (Math.abs(deltaOrders) >= threshold) {
      const sev = severityByDelta(deltaOrders, threshold);
      const score = scoreByDelta(deltaOrders, cur.orders);
      const direction = deltaOrders < 0 ? 'упали' : 'выросли';
      const title = `Заказы ${direction} на ${Math.abs(deltaOrders * 100).toFixed(0)}% (nmId ${nmId})`;
      const res = await insertInsight({
        workspaceId,
        nmId,
        date: curEnd,
        insightType: deltaOrders < 0 ? 'orders_drop' : 'orders_grow',
        category: 'sales',
        severity: sev,
        score,
        title,
        description: 'Сравнение 7 дней с предыдущим периодом (с учётом дня недели).',
        evidence: { curOrders: cur.orders, prevOrders: expectedOrders, deltaOrders },
        fingerprint: `orders:${nmId}:${curEnd}`,
      });
      if (res.inserted) created += 1;
    }

    const deltaSales = pctChange(cur.salesRub, prev.salesRub);
    if (Math.abs(deltaSales) >= threshold) {
      const sev = severityByDelta(deltaSales, threshold);
      const score = scoreByDelta(deltaSales, Math.max(1, Math.round(cur.salesRub / 100)));
      const direction = deltaSales < 0 ? 'упала' : 'выросла';
      const title = `Выручка ${direction} на ${Math.abs(deltaSales * 100).toFixed(0)}% (nmId ${nmId})`;
      const res = await insertInsight({
        workspaceId,
        nmId,
        date: curEnd,
        insightType: deltaSales < 0 ? 'revenue_drop' : 'revenue_grow',
        category: 'sales',
        severity: sev,
        score,
        title,
        description: '7 дней против предыдущих 7 дней.',
        evidence: { curSalesRub: cur.salesRub, prevSalesRub: prev.salesRub, deltaSales },
        fingerprint: `revenue:${nmId}:${curEnd}`,
      });
      if (res.inserted) created += 1;
    }

    const fCur = curFunnel.get(nmId) ?? { viewCount: 0, openCardCount: 0, orderCount: 0 };
    const fPrev = prevFunnel.get(nmId) ?? { viewCount: 0, openCardCount: 0, orderCount: 0 };
    if (fCur.viewCount >= MIN_VIEWS || fPrev.viewCount >= MIN_VIEWS) {
      const curCtr = fCur.viewCount > 0 ? fCur.openCardCount / fCur.viewCount : 0;
      const prevCtr = fPrev.viewCount > 0 ? fPrev.openCardCount / fPrev.viewCount : 0;
      const deltaCtr = pctChange(curCtr, prevCtr);

      if (Math.abs(deltaCtr) >= threshold) {
        const sev = severityByDelta(deltaCtr, threshold);
        const score = scoreByDelta(deltaCtr, fCur.viewCount);
        const direction = deltaCtr < 0 ? 'упал' : 'вырос';
        const title = `CTR открытия ${direction} на ${Math.abs(deltaCtr * 100).toFixed(0)}% (nmId ${nmId})`;
        const res = await insertInsight({
          workspaceId,
          nmId,
          date: curEnd,
          insightType: deltaCtr < 0 ? 'ctr_drop' : 'ctr_grow',
          category: 'conversion',
          severity: sev,
          score,
          title,
          description: 'CTR открытия карточки (открытия/показы).',
          evidence: { curCtr, prevCtr, curViews: fCur.viewCount, prevViews: fPrev.viewCount },
          fingerprint: `ctr:${nmId}:${curEnd}`,
        });
        if (res.inserted) created += 1;
      }

      if (deltaCtr < -threshold && withinPctChange(fCur.viewCount, fPrev.viewCount, 0.1)) {
        const title = `CTR упал при стабильных показах (nmId ${nmId})`;
        const res = await insertInsight({
          workspaceId,
          nmId,
          date: curEnd,
          insightType: 'ctr_drop_competitor',
          category: 'conversion',
          severity: 'warn',
          score: scoreByDelta(deltaCtr, fCur.viewCount),
          title,
          description: 'Возможен рост конкуренции в выдаче. Проверь выдачу по ключевым запросам.',
          evidence: { curCtr, prevCtr, curViews: fCur.viewCount, prevViews: fPrev.viewCount },
          fingerprint: `ctr_competitor:${nmId}:${curEnd}`,
        });
        if (res.inserted) created += 1;
      }

      const curOrderCvr = fCur.viewCount > 0 ? fCur.orderCount / fCur.viewCount : 0;
      const prevOrderCvr = fPrev.viewCount > 0 ? fPrev.orderCount / fPrev.viewCount : 0;
      const deltaOrderCvr = pctChange(curOrderCvr, prevOrderCvr);
      if (Math.abs(deltaOrderCvr) >= threshold) {
        const sev = severityByDelta(deltaOrderCvr, threshold);
        const score = scoreByDelta(deltaOrderCvr, fCur.orderCount);
        const direction = deltaOrderCvr < 0 ? 'упала' : 'выросла';
        const title = `Конверсия в заказ ${direction} на ${Math.abs(deltaOrderCvr * 100).toFixed(0)}% (nmId ${nmId})`;
        const res = await insertInsight({
          workspaceId,
          nmId,
          date: curEnd,
          insightType: deltaOrderCvr < 0 ? 'order_cvr_drop' : 'order_cvr_grow',
          category: 'conversion',
          severity: sev,
          score,
          title,
          description: 'Конверсия в заказ (заказы/показы).',
          evidence: { curOrderCvr, prevOrderCvr, curOrders: fCur.orderCount, prevOrders: fPrev.orderCount },
          fingerprint: `order_cvr:${nmId}:${curEnd}`,
        });
        if (res.inserted) created += 1;
      }
    }

    const advCur = curAdv.get(nmId) ?? { spendKopecks: 0, ordersCount: 0 };
    const advPrev = prevAdv.get(nmId) ?? { spendKopecks: 0, ordersCount: 0 };
    const spendRub = advCur.spendKopecks / 100;
    const prevSpendRub = advPrev.spendKopecks / 100;

    if (spendRub >= MIN_SPEND_RUB || prevSpendRub >= MIN_SPEND_RUB) {
      const drr = cur.salesRub > 0 ? (advCur.spendKopecks / cur.salesRub) * 100 : 0;
      const drrPrev = prev.salesRub > 0 ? (advPrev.spendKopecks / prev.salesRub) * 100 : 0;
      const deltaDrr = pctChange(drr, drrPrev);

      if (drr > settings.targetDrrPct && deltaDrr >= threshold) {
        const title = `DRR выше цели: ${drr.toFixed(1)}% > ${settings.targetDrrPct}% (nmId ${nmId})`;
        const res = await insertInsight({
          workspaceId,
          nmId,
          date: curEnd,
          insightType: 'drr_high',
          category: 'ads',
          severity: 'warn',
          score: scoreByDelta(deltaDrr, advCur.spendKopecks / 100),
          title,
          description: 'Расход на рекламу растёт быстрее выручки.',
          evidence: { drr, drrPrev, spendRub },
          fingerprint: `drr_high:${nmId}:${curEnd}`,
        });
        if (res.inserted) created += 1;
      }

      const spendDelta = pctChange(spendRub, prevSpendRub);
      const ordersDelta = pctChange(cur.orders, prev.orders);

      if (spendDelta > threshold && Math.abs(ordersDelta) < threshold) {
        const title = `Расходы на рекламу выросли, а заказы не изменились (nmId ${nmId})`;
        const res = await insertInsight({
          workspaceId,
          nmId,
          date: curEnd,
          insightType: 'ads_spend_up_no_orders',
          category: 'ads',
          severity: 'warn',
          score: scoreByDelta(spendDelta, spendRub),
          title,
          description: 'Проверь эффективность кампаний или ключевые фразы.',
          evidence: { spendRub, prevSpendRub, ordersDelta },
          fingerprint: `ads_spend_up:${nmId}:${curEnd}`,
        });
        if (res.inserted) created += 1;
      }

      if (spendDelta < -threshold && Math.abs(ordersDelta) < threshold) {
        const title = `Расходы на рекламу снизились без падения заказов (nmId ${nmId})`;
        const res = await insertInsight({
          workspaceId,
          nmId,
          date: curEnd,
          insightType: 'ads_spend_down_no_loss',
          category: 'ads',
          severity: 'info',
          score: scoreByDelta(spendDelta, spendRub),
          title,
          description: 'Есть шанс снизить бюджет без потерь.',
          evidence: { spendRub, prevSpendRub, ordersDelta },
          fingerprint: `ads_spend_down:${nmId}:${curEnd}`,
        });
        if (res.inserted) created += 1;
      }
    }

    const avgPriceCur = cur.orders > 0 ? cur.finishedPriceRub / cur.orders : 0;
    const avgPricePrev = prev.orders > 0 ? prev.finishedPriceRub / prev.orders : 0;
    if (avgPriceCur > 0 && avgPricePrev > 0) {
      const priceDelta = pctChange(avgPriceCur, avgPricePrev);
      const ordersDelta = pctChange(cur.orders, prev.orders);
      if (Math.abs(priceDelta) >= threshold && Math.abs(ordersDelta) >= threshold) {
        if (priceDelta < 0 && ordersDelta > 0) {
          const title = `Цена снизилась на ${Math.abs(priceDelta * 100).toFixed(0)}% → заказы выросли (nmId ${nmId})`;
          const res = await insertInsight({
            workspaceId,
            nmId,
            date: curEnd,
            insightType: 'price_down_orders_up',
            category: 'pricing',
            severity: 'info',
            score: scoreByDelta(ordersDelta, cur.orders),
            title,
            description: 'Эффект от снижения цены.',
            evidence: { avgPriceCur, avgPricePrev, ordersDelta },
            fingerprint: `price_down:${nmId}:${curEnd}`,
          });
          if (res.inserted) created += 1;
        }

        if (priceDelta > 0 && ordersDelta < 0) {
          const title = `Цена выросла на ${Math.abs(priceDelta * 100).toFixed(0)}% → заказы упали (nmId ${nmId})`;
          const res = await insertInsight({
            workspaceId,
            nmId,
            date: curEnd,
            insightType: 'price_up_orders_down',
            category: 'pricing',
            severity: 'warn',
            score: scoreByDelta(ordersDelta, cur.orders),
            title,
            description: 'Возможная чувствительность к цене.',
            evidence: { avgPriceCur, avgPricePrev, ordersDelta },
            fingerprint: `price_up:${nmId}:${curEnd}`,
          });
          if (res.inserted) created += 1;
        }
      }
    }

    const sppDelta = await getLatestSppChange(workspaceId, nmId);
    if (sppDelta != null && Math.abs(sppDelta) >= threshold) {
      const title = `СПП изменилась на ${Math.abs(sppDelta * 100).toFixed(0)}% (nmId ${nmId})`;
      const res = await insertInsight({
        workspaceId,
        nmId,
        date: curEnd,
        insightType: 'spp_change',
        category: 'pricing',
        severity: severityByDelta(sppDelta, threshold),
        score: scoreByDelta(sppDelta, cur.orders),
        title,
        description: 'Изменение СПП может повлиять на цену и спрос.',
        evidence: { sppDelta },
        fingerprint: `spp:${nmId}:${curEnd}`,
      });
      if (res.inserted) created += 1;
    }

    const retCur = curReturns.get(nmId) ?? { returnsCount: 0 };
    const retPrev = prevReturns.get(nmId) ?? { returnsCount: 0 };
    const returnRateCur = cur.orders > 0 ? retCur.returnsCount / cur.orders : 0;
    const returnRatePrev = prev.orders > 0 ? retPrev.returnsCount / prev.orders : 0;
    const retDelta = pctChange(returnRateCur, returnRatePrev);
    if (retCur.returnsCount >= 5 && Math.abs(retDelta) >= threshold) {
      const title = `Доля возвратов выросла на ${Math.abs(retDelta * 100).toFixed(0)}% (nmId ${nmId})`;
      const res = await insertInsight({
        workspaceId,
        nmId,
        date: curEnd,
        insightType: 'returns_spike',
        category: 'quality',
        severity: 'warn',
        score: scoreByDelta(retDelta, retCur.returnsCount),
        title,
        description: 'Проверь качество или соответствие фото/описания.',
        evidence: { returnRateCur, returnRatePrev, returns: retCur.returnsCount },
        fingerprint: `returns:${nmId}:${curEnd}`,
      });
      if (res.inserted) created += 1;
    }

    const fbCur = feedbackCur.get(nmId) ?? feedbackCur.get(0) ?? { total: 0, negative: 0 };
    const fbPrev = feedbackPrev.get(nmId) ?? feedbackPrev.get(0) ?? { total: 0, negative: 0 };
    if (fbCur.total >= 5 && fbPrev.total >= 5) {
      const negCur = fbCur.negative / Math.max(1, fbCur.total);
      const negPrev = fbPrev.negative / Math.max(1, fbPrev.total);
      const negDelta = pctChange(negCur, negPrev);
      if (negDelta >= threshold) {
        const title = `Негатив по отзывам вырос (nmId ${nmId})`;
        const res = await insertInsight({
          workspaceId,
          nmId,
          date: curEnd,
          insightType: 'reviews_negative_up',
          category: 'reviews',
          severity: 'warn',
          score: scoreByDelta(negDelta, fbCur.total),
          title,
          description: `Доля негатива: ${Math.round(negCur * 100)}% (было ${Math.round(negPrev * 100)}%).`,
          evidence: { negCur, negPrev, total: fbCur.total },
          fingerprint: `reviews_negative:${nmId}:${curEnd}`,
        });
        if (res.inserted) created += 1;
      }
    }
  }

  await createStockInsights({
    workspaceId,
    date: curEnd,
    minStockDays: settings.minStockDays,
    excludedNmIds,
    cooldownDays: 1,
  });

  return { created, date: curEnd };
}

// NOTE: Legacy setInterval-based startInsightsDailyLoop() removed
// Use runInsightsDaily() via pg-boss scheduler instead (registered in scheduler.ts)

/** Simple wrapper for scheduler - runs insights for all workspaces */
export async function runInsightsDaily(): Promise<void> {
  const { forEachWorkspace } = await import('./workspaceIterator.js');
  
  await forEachWorkspace(
    { overrideEnvVar: 'INSIGHTS_WORKSPACE_ID' },
    async (workspaceId) => {
      await runInsightsForWorkspace(workspaceId);
      return { ran: true };
    }
  );
}
