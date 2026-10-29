/**
 * Agent Trigger Scan Job.
 *
 * Scans workspace data and creates agent_events for:
 * - OOS warnings (stock < threshold)
 * - Margin drops (margin < min)
 * - Order drops (significant decrease)
 * - Review spikes (sudden negative reviews)
 *
 * Run via pg-boss scheduler or manually.
 */

import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import { logJobs as logger } from '../lib/logger.js';
import { db } from '../db/client.js';
import {
  agentEvents,
  agentSettings,
  wbStocksCurrent,
  wbOrdersSalesDailyProducts,
  wbFunnelDailyProducts,
  workspaces,
} from '../db/schema.js';

// TODO: Add wbFeedbackItems when feedback table is created

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

export async function runAgentTriggerScan(opts: {
  workspaceId: number;
  dryRun?: boolean;
}) {
  const { workspaceId, dryRun = false } = opts;
  const today = ymd(new Date());
  const yesterday = daysAgo(1);
  const weekAgo = daysAgo(7);

  const created: Array<{
    eventType: string;
    nmId: number | null;
    title: string;
    severity: string;
  }> = [];

  // Load agent settings for this workspace
  const [settings] = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.workspaceId, workspaceId))
    .limit(1);

  const minDaysOfStock = 7; // default threshold
  const minMarginPct = settings?.minMarginPct ?? 10;

  // ── 1. OOS Warnings ──────────────────────────────────────────

  const lowStockProducts = await db
    .select({
      nmId: wbStocksCurrent.nmId,
      productTitle: wbStocksCurrent.productTitle,
      quantity: wbStocksCurrent.quantity,
      inWayToClient: wbStocksCurrent.inWayToClient,
      daysOfStock: wbStocksCurrent.daysOfStock,
    })
    .from(wbStocksCurrent)
    .where(and(
      eq(wbStocksCurrent.workspaceId, workspaceId),
      lt(wbStocksCurrent.daysOfStock, minDaysOfStock)
    ))
    .limit(50);

  for (const p of lowStockProducts) {
    const nmId = Number(p.nmId);
    const daysLeft = p.daysOfStock ?? 0;
    const severity = daysLeft <= 0 ? 'critical' : daysLeft < 3 ? 'warning' : 'info';

    // Check if event already exists for this product (avoid duplicates)
    const existing = await db
      .select({ eventId: agentEvents.eventId })
      .from(agentEvents)
      .where(and(
        eq(agentEvents.workspaceId, workspaceId),
        eq(agentEvents.nmId, nmId),
        eq(agentEvents.eventType, 'oos_warning'),
        eq(agentEvents.status, 'pending')
      ))
      .limit(1);

    if (existing.length > 0) continue;

    const event = {
      workspaceId,
      eventType: 'oos_warning',
      severity,
      source: 'agent',
      title: daysLeft <= 0
        ? `🚨 Товар закончился: ${p.productTitle ?? nmId}`
        : `⚠️ Заканчивается: ${p.productTitle ?? nmId} (${daysLeft} дн)`,
      description: `Остаток: ${p.quantity ?? 0} шт, в пути: ${p.inWayToClient ?? 0}`,
      nmId,
      productTitle: p.productTitle,
      suggestedAction: 'protect_price',
      actionArgs: { daysOfStock: daysLeft },
    };

    if (!dryRun) {
      await db.insert(agentEvents).values(event);
    }
    created.push({ eventType: event.eventType, nmId, title: event.title, severity });
  }

  // ── 2. Order Drops ───────────────────────────────────────────

  // Compare yesterday's orders to average of prior week
  const orderStats = await db
    .select({
      nmId: wbOrdersSalesDailyProducts.nmId,
      date: wbOrdersSalesDailyProducts.date,
      ordersCount: wbOrdersSalesDailyProducts.ordersCount,
    })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
      gte(wbOrdersSalesDailyProducts.date, weekAgo)
    ))
    .orderBy(desc(wbOrdersSalesDailyProducts.date))
    .limit(500);

  // Group by nmId
  const ordersByNm = new Map<number, { yesterday: number; weekAvg: number; title: string | null }>();
  for (const row of orderStats) {
    const nmId = Number(row.nmId);
    const qty = Number(row.ordersCount ?? 0);
    const existing = ordersByNm.get(nmId) ?? { yesterday: 0, weekAvg: 0, title: null };

    if (row.date === yesterday) {
      existing.yesterday = qty;
    } else {
      existing.weekAvg += qty / 6; // rough average
    }
    ordersByNm.set(nmId, existing);
  }

  for (const [nmId, stats] of ordersByNm) {
    // Alert if yesterday < 50% of week average
    if (stats.weekAvg > 3 && stats.yesterday < stats.weekAvg * 0.5) {
      const dropPct = Math.round((1 - stats.yesterday / stats.weekAvg) * 100);

      const existing = await db
        .select({ eventId: agentEvents.eventId })
        .from(agentEvents)
        .where(and(
          eq(agentEvents.workspaceId, workspaceId),
          eq(agentEvents.nmId, nmId),
          eq(agentEvents.eventType, 'order_drop'),
          eq(agentEvents.status, 'pending')
        ))
        .limit(1);

      if (existing.length > 0) continue;

      const event = {
        workspaceId,
        eventType: 'order_drop',
        severity: dropPct > 70 ? 'critical' : 'warning',
        source: 'agent',
        title: `📉 Падение заказов -${dropPct}%: ${stats.title ?? nmId}`,
        description: `Вчера: ${stats.yesterday}, средняя за неделю: ${Math.round(stats.weekAvg)}`,
        nmId,
        productTitle: stats.title,
        suggestedAction: 'analyze',
      };

      if (!dryRun) {
        await db.insert(agentEvents).values(event);
      }
      created.push({ eventType: event.eventType, nmId, title: event.title, severity: event.severity });
    }
  }

  // ── 3. Negative Review Spike ─────────────────────────────────
  // TODO: Enable when wbFeedbackItems table is created
  /*
  const recentReviews = await db
    .select({
      nmId: wbFeedbackItems.nmId,
      productTitle: wbFeedbackItems.productTitle,
      rating: wbFeedbackItems.rating,
    })
    .from(wbFeedbackItems)
    .where(and(
      eq(wbFeedbackItems.workspaceId, workspaceId),
      eq(wbFeedbackItems.itemType, 'review'),
      gte(wbFeedbackItems.publishedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
    ))
    .limit(100);

  // Count negative reviews (1-2 stars) per product
  const negativeByNm = new Map<number, { count: number; title: string | null }>();
  for (const r of recentReviews) {
    const nmId = Number(r.nmId);
    const rating = Number(r.rating ?? 5);
    if (rating <= 2) {
      const existing = negativeByNm.get(nmId) ?? { count: 0, title: r.productTitle };
      existing.count++;
      negativeByNm.set(nmId, existing);
    }
  }

  for (const [nmId, stats] of negativeByNm) {
    if (stats.count >= 2) { // 2+ negative reviews in 24h
      const existing = await db
        .select({ eventId: agentEvents.eventId })
        .from(agentEvents)
        .where(and(
          eq(agentEvents.workspaceId, workspaceId),
          eq(agentEvents.nmId, nmId),
          eq(agentEvents.eventType, 'review_spike'),
          eq(agentEvents.status, 'pending')
        ))
        .limit(1);

      if (existing.length > 0) continue;

      const event = {
        workspaceId,
        eventType: 'review_spike',
        severity: stats.count >= 5 ? 'critical' : 'warning',
        source: 'agent',
        title: `⭐ Негативные отзывы (${stats.count}): ${stats.title ?? nmId}`,
        description: `${stats.count} отзывов с рейтингом 1-2 за последние 24 часа`,
        nmId,
        productTitle: stats.title,
        suggestedAction: 'reply_review',
      };

      if (!dryRun) {
        await db.insert(agentEvents).values(event);
      }
      created.push({ eventType: event.eventType, nmId, title: event.title, severity: event.severity });
    }
  }
  */ // End of commented review_spike block

  return {
    workspaceId,
    created: created.length,
    events: created,
  };
}

/**
 * Run scan for all active workspaces.
 */
export async function runAgentTriggerScanAll() {
  const ws = await db.select({ workspaceId: workspaces.workspaceId }).from(workspaces);
  const results = [];

  for (const { workspaceId } of ws) {
    try {
      const r = await runAgentTriggerScan({ workspaceId });
      results.push(r);
    } catch (err) {
      logger.error({ workspaceId, err }, 'Agent scan failed for workspace');
    }
  }

  return results;
}
