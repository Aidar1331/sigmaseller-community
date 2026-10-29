/**
 * Cron Job: Check Creative Audit Experiments
 *
 * Runs daily to evaluate experiments that are 7+ days old.
 * Calculates metrics delta and determines verdict.
 */

import { db } from '../db/client.js';
import { eq, and, lte, sql, gte } from 'drizzle-orm';
import {
  creativeAuditExperiments,
  wbFunnelDailyProducts,
  wbOrdersSalesDailyProducts,
  wbEvents,
} from '../db/schema.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'audit-experiments-job' });

const EVALUATION_DAYS = 7; // Days after apply to evaluate

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

interface Metrics {
  ctr: number;
  conversion: number;
  orders: number;
  revenue: number;
  views: number;
}

interface MetricsDelta {
  ctr: { before: number; after: number; change: number; changePct: number };
  conversion: { before: number; after: number; change: number; changePct: number };
  orders: { before: number; after: number; change: number; changePct: number };
  revenue: { before: number; after: number; change: number; changePct: number };
}

type Verdict = 'positive' | 'neutral' | 'negative';

/**
 * Get metrics for a product over the last N days
 */
async function getMetrics(
  workspaceId: number,
  nmId: number,
  dateFrom: string,
  dateTo: string
): Promise<Metrics> {
  const [funnelRow] = await db
    .select({
      views: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.viewCount}), 0)`,
      opens: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.openCardCount}), 0)`,
      orders: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.orderCount}), 0)`,
    })
    .from(wbFunnelDailyProducts)
    .where(
      and(
        eq(wbFunnelDailyProducts.workspaceId, workspaceId),
        eq(wbFunnelDailyProducts.nmId, nmId),
        gte(wbFunnelDailyProducts.date, dateFrom),
        lte(wbFunnelDailyProducts.date, dateTo)
      )
    );

  const [ordersRow] = await db
    .select({
      orders: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersCount}), 0)`,
      revenue: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersRub}), 0)`,
    })
    .from(wbOrdersSalesDailyProducts)
    .where(
      and(
        eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
        eq(wbOrdersSalesDailyProducts.nmId, nmId),
        gte(wbOrdersSalesDailyProducts.date, dateFrom),
        lte(wbOrdersSalesDailyProducts.date, dateTo)
      )
    );

  const views = Number(funnelRow?.views ?? 0);
  const opens = Number(funnelRow?.opens ?? 0);
  const orders = Number(ordersRow?.orders ?? funnelRow?.orders ?? 0);
  const revenue = Number(ordersRow?.revenue ?? 0) / 100;

  const ctr = views > 0 ? (opens / views) * 100 : 0;
  const conversion = views > 0 ? (orders / views) * 100 : 0;

  return {
    ctr: Math.round(ctr * 100) / 100,
    conversion: Math.round(conversion * 100) / 100,
    orders,
    revenue: Math.round(revenue),
    views,
  };
}

/**
 * Calculate delta between baseline and result metrics
 */
function calculateDelta(baseline: Metrics, result: Metrics): MetricsDelta {
  const calcChange = (before: number, after: number) => {
    const change = after - before;
    const changePct = before > 0 ? ((after - before) / before) * 100 : after > 0 ? 100 : 0;
    return {
      before,
      after,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
    };
  };

  return {
    ctr: calcChange(baseline.ctr, result.ctr),
    conversion: calcChange(baseline.conversion, result.conversion),
    orders: calcChange(baseline.orders, result.orders),
    revenue: calcChange(baseline.revenue, result.revenue),
  };
}

/**
 * Determine verdict based on metrics delta
 */
function determineVerdict(delta: MetricsDelta): Verdict {
  // Positive: CTR +10% OR conversion +5% OR revenue +10%
  if (delta.ctr.changePct > 10 || delta.conversion.changePct > 5 || delta.revenue.changePct > 10) {
    return 'positive';
  }

  // Negative: CTR -10% OR conversion -5% OR revenue -10%
  if (delta.ctr.changePct < -10 || delta.conversion.changePct < -5 || delta.revenue.changePct < -10) {
    return 'negative';
  }

  return 'neutral';
}

/**
 * Main job function - evaluate experiments that are ready
 */
export async function checkAuditExperiments(): Promise<{
  checked: number;
  completed: number;
  positive: number;
  neutral: number;
  negative: number;
}> {
  const cutoffDate = daysAgo(EVALUATION_DAYS);

  logger.info({ cutoffDate }, 'Checking audit experiments for evaluation');

  // Find experiments that are running and old enough to evaluate
  const experiments = await db
    .select()
    .from(creativeAuditExperiments)
    .where(
      and(
        eq(creativeAuditExperiments.status, 'running'),
        lte(creativeAuditExperiments.baselineDate, cutoffDate)
      )
    );

  logger.info({ count: experiments.length }, 'Found experiments to evaluate');

  const stats = { checked: 0, completed: 0, positive: 0, neutral: 0, negative: 0 };

  for (const exp of experiments) {
    stats.checked++;

    try {
      const workspaceId = Number(exp.workspaceId);
      const nmId = Number(exp.nmId);
      const baseline = exp.baselineMetrics as Metrics;

      // Get current metrics (last 7 days)
      const dateFrom = daysAgo(7);
      const dateTo = daysAgo(1);
      const resultMetrics = await getMetrics(workspaceId, nmId, dateFrom, dateTo);

      // Calculate delta
      const delta = calculateDelta(baseline, resultMetrics);
      const verdict = determineVerdict(delta);

      // Update experiment
      await db
        .update(creativeAuditExperiments)
        .set({
          status: 'completed',
          resultMetrics,
          resultDate: dateTo,
          resultDelta: delta,
          resultVerdict: verdict,
          completedAt: new Date(),
        })
        .where(eq(creativeAuditExperiments.experimentId, exp.experimentId));

      // Create result event
      const appliedFields: string[] = [];
      if (exp.appliedTitle) appliedFields.push('title');
      if (exp.appliedDescription) appliedFields.push('description');
      if ((exp.appliedCharacteristics as any[])?.length > 0) appliedFields.push('characteristics');

      const verdictEmoji = verdict === 'positive' ? '📈' : verdict === 'negative' ? '📉' : '➡️';
      const verdictText = verdict === 'positive' ? 'Улучшение' : verdict === 'negative' ? 'Ухудшение' : 'Без изменений';

      await db.insert(wbEvents).values({
        workspaceId,
        nmId,
        date: isoDate(new Date()),
        type: 'log',
        category: 'creative_audit',
        title: `${verdictEmoji} Эксперимент #${exp.experimentId}: ${verdictText}`,
        description: `CTR: ${delta.ctr.before}% → ${delta.ctr.after}% (${delta.ctr.changePct > 0 ? '+' : ''}${delta.ctr.changePct}%)\n` +
          `Conv: ${delta.conversion.before}% → ${delta.conversion.after}% (${delta.conversion.changePct > 0 ? '+' : ''}${delta.conversion.changePct}%)\n` +
          `Orders: ${delta.orders.before} → ${delta.orders.after}`,
        source: 'agent',
        sourceId: String(exp.experimentId),
        status: 'resolved',
        evidence: { experimentId: exp.experimentId, delta, verdict },
      });

      stats.completed++;
      if (verdict === 'positive') stats.positive++;
      else if (verdict === 'negative') stats.negative++;
      else stats.neutral++;

      logger.info(
        { experimentId: exp.experimentId, nmId, verdict, delta },
        'Experiment evaluated'
      );
    } catch (err: any) {
      logger.error({ err, experimentId: exp.experimentId }, 'Failed to evaluate experiment');
    }
  }

  logger.info(stats, 'Audit experiments check completed');

  return stats;
}

// Allow running as standalone script
if (process.argv[1]?.includes('auditExperiments')) {
  checkAuditExperiments()
    .then((stats) => {
      console.log('Audit experiments check completed:', stats);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed:', err);
      process.exit(1);
    });
}
