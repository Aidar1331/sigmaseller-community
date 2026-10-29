/**
 * Rating Drop detector — emits wb_events when a product's average review
 * rating drops below threshold OR drops materially vs the prior window.
 *
 * Logic:
 *  - Recent window: last 30 days of reviews.
 *  - Baseline window: 31-90 days ago.
 *  - Trigger conditions (any of):
 *    1. recent_avg ≤ 3.5 AND recent_count ≥ 5 → severity=critical
 *    2. recent_avg ≤ 4.0 AND recent_count ≥ 5 AND recent_avg < baseline_avg − 0.3 → warn
 *    3. baseline_avg − recent_avg ≥ 0.5 AND recent_count ≥ 5 AND baseline_count ≥ 5 → warn (steep drop)
 *
 * Fingerprint = `rating_drop:{ws}:{nmId}:{yyyy-mm}` — one event per product per
 * month max (don't spam if rating stays low for weeks).
 */

import { and, eq, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { marketplaceFeedbackItems, wbEvents } from '../../db/schema.js';
import { log } from '../../lib/logger.js';

const logger = log.child({ module: 'detector:ratingDrop' });

const RECENT_DAYS = 30;
const BASELINE_DAYS = 90;
const HARD_FLOOR = 3.5; // critical if recent ≤ this
const SOFT_FLOOR = 4.0; // warn if recent ≤ this AND dropped vs baseline
const DROP_DELTA = 0.3; // warn if recent dropped vs baseline by this
const STEEP_DROP_DELTA = 0.5;
const MIN_REVIEWS = 5; // ignore products with too few reviews (noisy avg)

interface DetectorResult {
  workspaceId: number;
  scanned: number;
  detected: number;
  inserted: number;
  skippedExisting: number;
  errors: number;
}

function fingerprint(workspaceId: number, nmId: number): string {
  const yyyyMM = new Date().toISOString().slice(0, 7); // 2026-05
  return `rating_drop:${workspaceId}:${nmId}:${yyyyMM}`;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function detectRatingDrops(workspaceId: number): Promise<DetectorResult> {
  const result: DetectorResult = {
    workspaceId,
    scanned: 0,
    detected: 0,
    inserted: 0,
    skippedExisting: 0,
    errors: 0,
  };

  const now = new Date();
  const recentSince = new Date(now.getTime() - RECENT_DAYS * 86400_000);
  const baselineSince = new Date(now.getTime() - BASELINE_DAYS * 86400_000);

  type StatRow = {
    nmId: bigint | number;
    productTitle: string | null;
    shopId: bigint | number | null;
    recentAvg: number | null;
    recentCount: number;
    baselineAvg: number | null;
    baselineCount: number;
  };

  let stats: StatRow[];
  try {
    const res = await db.execute<StatRow>(sql`
      SELECT
        nm_id AS "nmId",
        MAX(product_title) AS "productTitle",
        MAX(shop_id) AS "shopId",
        AVG(rating) FILTER (WHERE created_at >= ${recentSince}) AS "recentAvg",
        COUNT(*) FILTER (WHERE created_at >= ${recentSince} AND rating IS NOT NULL)::int AS "recentCount",
        AVG(rating) FILTER (WHERE created_at >= ${baselineSince} AND created_at < ${recentSince}) AS "baselineAvg",
        COUNT(*) FILTER (WHERE created_at >= ${baselineSince} AND created_at < ${recentSince} AND rating IS NOT NULL)::int AS "baselineCount"
      FROM marketplace_feedback_items
      WHERE workspace_id = ${workspaceId}
        AND marketplace = 'wb'
        AND item_type = 'review'
        AND nm_id IS NOT NULL
        AND created_at >= ${baselineSince}
      GROUP BY nm_id
      HAVING COUNT(*) FILTER (WHERE created_at >= ${recentSince} AND rating IS NOT NULL) >= ${MIN_REVIEWS}
    `);
    stats = ((res as any).rows ?? res) as StatRow[];
  } catch (err) {
    logger.error({ err, workspaceId }, 'failed to query rating stats');
    result.errors = 1;
    return result;
  }

  result.scanned = stats.length;
  if (stats.length === 0) return result;

  type CandidatePayload = typeof wbEvents.$inferInsert;
  const candidates: { fingerprint: string; payload: CandidatePayload }[] = [];

  for (const s of stats) {
    const recentAvg = s.recentAvg != null ? Number(s.recentAvg) : null;
    const baselineAvg = s.baselineAvg != null ? Number(s.baselineAvg) : null;
    if (recentAvg == null) continue;

    let severity: 'warn' | 'critical' | null = null;
    let reason = '';

    if (recentAvg <= HARD_FLOOR) {
      severity = 'critical';
      reason = `Средний рейтинг за 30 дней упал до ${recentAvg.toFixed(2)}★`;
    } else if (
      recentAvg <= SOFT_FLOOR &&
      baselineAvg != null &&
      s.baselineCount >= MIN_REVIEWS &&
      recentAvg < baselineAvg - DROP_DELTA
    ) {
      severity = 'warn';
      reason = `Рейтинг ${baselineAvg.toFixed(2)}★ → ${recentAvg.toFixed(2)}★ (просадка ${(baselineAvg - recentAvg).toFixed(2)})`;
    } else if (
      baselineAvg != null &&
      s.baselineCount >= MIN_REVIEWS &&
      baselineAvg - recentAvg >= STEEP_DROP_DELTA
    ) {
      severity = 'warn';
      reason = `Резкое падение рейтинга: ${baselineAvg.toFixed(2)}★ → ${recentAvg.toFixed(2)}★`;
    }

    if (severity == null) continue;
    result.detected += 1;

    const nmId = Number(s.nmId);
    const shopId = s.shopId != null ? Number(s.shopId) : null;
    const productTxt = s.productTitle ? ` — ${s.productTitle.slice(0, 60)}` : '';
    const title = severity === 'critical'
      ? `🔴 Рейтинг ${recentAvg.toFixed(1)}★ (товар ${nmId})${productTxt}`
      : `🟡 Рейтинг падает: ${recentAvg.toFixed(1)}★ (товар ${nmId})${productTxt}`;

    candidates.push({
      fingerprint: fingerprint(workspaceId, nmId),
      payload: {
        workspaceId,
        shopId,
        nmId,
        date: ymdUtc(now),
        time: null,
        type: 'alert',
        category: 'review',
        severity,
        status: 'open',
        priority: severity === 'critical' ? 'urgent' : 'high',
        title,
        description: `${reason}. Отзывов за 30д: ${s.recentCount}, за прошлый период: ${s.baselineCount}.`,
        evidence: {
          source: 'ratingDrop detector',
          recentAvg,
          recentCount: s.recentCount,
          baselineAvg,
          baselineCount: s.baselineCount,
          drop: baselineAvg != null ? Number((baselineAvg - recentAvg).toFixed(2)) : null,
          windowDays: RECENT_DAYS,
        },
        tags: [],
        fingerprint: fingerprint(workspaceId, nmId),
        source: 'system',
        sourceId: `ratingDrop:${workspaceId}:${nmId}`,
      },
    });
  }

  if (candidates.length === 0) return result;

  // Pre-check existing (partial unique index won't work with onConflict)
  const fingerprints = candidates.map((c) => c.fingerprint);
  let existing = new Set<string>();
  try {
    const rows = await db
      .select({ fingerprint: wbEvents.fingerprint })
      .from(wbEvents)
      .where(and(eq(wbEvents.workspaceId, workspaceId), inArray(wbEvents.fingerprint, fingerprints)));
    existing = new Set(rows.map((r) => r.fingerprint).filter((f): f is string => !!f));
  } catch (err) {
    logger.error({ err, workspaceId }, 'failed to pre-check fingerprints');
    result.errors += 1;
    return result;
  }

  const toInsert = candidates.filter((c) => !existing.has(c.fingerprint));
  result.skippedExisting = candidates.length - toInsert.length;
  if (toInsert.length === 0) return result;

  try {
    await db.insert(wbEvents).values(toInsert.map((c) => c.payload));
    result.inserted = toInsert.length;
  } catch (err) {
    logger.warn({ err, workspaceId, batch: toInsert.length }, 'bulk insert failed, falling back');
    for (const c of toInsert) {
      try {
        await db.insert(wbEvents).values(c.payload);
        result.inserted += 1;
      } catch (rowErr) {
        const msg = String((rowErr as any)?.message ?? '');
        if (msg.includes('wb_events_fingerprint_uniq') || msg.includes('duplicate key')) {
          result.skippedExisting += 1;
        } else {
          result.errors += 1;
          logger.error({ err: rowErr, fingerprint: c.fingerprint }, 'insert failed');
        }
      }
    }
  }

  return result;
}

export async function detectRatingDropsAllWorkspaces(): Promise<{
  workspaces: number;
  totalDetected: number;
  totalInserted: number;
  totalErrors: number;
}> {
  type WsRow = { workspaceId: number };
  const wsRes = await db.execute<WsRow>(sql`
    SELECT DISTINCT workspace_id AS "workspaceId"
    FROM marketplace_feedback_items
    WHERE marketplace = 'wb' AND item_type = 'review'
      AND created_at >= NOW() - INTERVAL '90 days'
  `);
  const wsRows = ((wsRes as any).rows ?? wsRes) as WsRow[];

  let totalDetected = 0;
  let totalInserted = 0;
  let totalErrors = 0;

  for (const { workspaceId } of wsRows) {
    try {
      const r = await detectRatingDrops(workspaceId);
      totalDetected += r.detected;
      totalInserted += r.inserted;
      totalErrors += r.errors;
    } catch (err) {
      logger.error({ err, workspaceId }, 'detectRatingDrops failed');
      totalErrors += 1;
    }
  }

  logger.info(
    { workspaces: wsRows.length, totalDetected, totalInserted, totalErrors },
    'ratingDrop detector tick done',
  );

  return { workspaces: wsRows.length, totalDetected, totalInserted, totalErrors };
}
