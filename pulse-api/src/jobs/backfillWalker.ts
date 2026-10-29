/**
 * Overnight backfill walker (rev 25b)
 *
 * Replaces the "gulp 90 days at shop-connect time" pattern that consistently
 * hit WB per-endpoint 1/h or 2/24h quotas and left tables empty (observed
 * for shops 3, 4 on 2026-05-16: funnel=3 days, adv=1 day out of expected
 * 90+).
 *
 * Each tick (every 30 min in the 23:00-03:30 MSK window):
 *   1. Picks N rows from wb_backfill_progress where oldest_covered still
 *      has work to do, ordered by oldest last_advanced_at (round-robin).
 *   2. For each, spawns the existing toDb script with DAYS_BACK set to
 *      cover today → (oldest_covered - CHUNK_DAYS). Some redundant fetches
 *      happen for already-covered days but upserts dedupe; the per-seller
 *      Redis bucket (rev 23) keeps us within WB's actual budget.
 *   3. On success advance oldest_covered backward by CHUNK_DAYS.
 *   4. On failure (almost always WB 429 with retry > 5min) leave the
 *      cursor where it was, record last_error, and let the next tick
 *      retry the same window.
 *
 * Finance is intentionally excluded from this v0 because its
 * /api/v5/supplier/reportDetailByPeriod endpoint has a 2/24h quota — the
 * existing finance-daily cron already keeps it close to fully covered, so
 * walker has nothing to add for now. rev 25c will plumb proper DATE_FROM/
 * DATE_TO env so finance backfill can advance precise 14-day chunks per
 * day per seller.
 */

import { and, asc, isNull, or, sql } from 'drizzle-orm';
import { spawnAndWait } from '../lib/guardedSpawn.js';
import { db } from '../db/client.js';
import { wbBackfillProgress } from '../db/schema.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'backfillWalker' });

const CHUNK_DAYS = 7;
const MAX_PER_TICK = 1; // sequential: one (shop, sync_type) per tick; gentle pace

interface DispatchCfg {
  npmScript: string;
  extraEnv?: Record<string, string>;
}
const SYNC_DISPATCH: Record<string, DispatchCfg> = {
  orders_sales: { npmScript: 'wb:orders-sales:to-db' },
  funnel:       { npmScript: 'wb:funnel:history:to-db' },
  adv:          { npmScript: 'wb:adv:to-db', extraEnv: { ACTIVE_WITHIN_DAYS: '90' } },
  // finance: excluded for v0 — see file header
};

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function subDaysUtc(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() - n);
  return c;
}

export async function runBackfillWalker(): Promise<void> {
  const startTime = Date.now();
  logger.info('starting backfill walker tick');

  // Pick candidate rows that still have history left to fill, oldest-touched first.
  // "syncType IN (...)" mirrors the dispatch keys above; finance is filtered out.
  const candidates = await db
    .select({
      workspaceId: wbBackfillProgress.workspaceId,
      shopId: wbBackfillProgress.shopId,
      syncType: wbBackfillProgress.syncType,
      targetOldest: wbBackfillProgress.targetOldest,
      oldestCovered: wbBackfillProgress.oldestCovered,
    })
    .from(wbBackfillProgress)
    .where(
      and(
        or(
          isNull(wbBackfillProgress.oldestCovered),
          sql`${wbBackfillProgress.oldestCovered} > ${wbBackfillProgress.targetOldest}`,
        ),
        sql`${wbBackfillProgress.syncType} IN ('orders_sales', 'funnel', 'adv')`,
      ),
    )
    .orderBy(sql`${wbBackfillProgress.lastAdvancedAt} ASC NULLS FIRST`)
    .limit(MAX_PER_TICK);

  if (candidates.length === 0) {
    logger.info('no candidates — backfill complete or nothing to do');
    return;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const row of candidates) {
    const dispatch = SYNC_DISPATCH[row.syncType];
    if (!dispatch) {
      logger.warn({ syncType: row.syncType }, 'unknown sync_type, skipping');
      continue;
    }

    // Walk backward by CHUNK_DAYS from oldest_covered (or today if null),
    // clamped to target_oldest so we never overshoot.
    const cursorDate = row.oldestCovered ? new Date(row.oldestCovered + 'T00:00:00Z') : today;
    const targetDate = new Date(row.targetOldest + 'T00:00:00Z');
    const naiveBack = subDaysUtc(cursorDate, CHUNK_DAYS);
    const newCursor = naiveBack.getTime() < targetDate.getTime() ? targetDate : naiveBack;
    const daysBack = Math.ceil(
      (today.getTime() - newCursor.getTime()) / (24 * 3600 * 1000),
    );

    const childCtx = {
      workspaceId: row.workspaceId,
      shopId: row.shopId,
      syncType: row.syncType,
      cursorOld: row.oldestCovered,
      cursorNew: dateOnly(newCursor),
      daysBack,
      npmScript: dispatch.npmScript,
    };
    logger.info(childCtx, 'walker tick: spawning child');

    try {
      const result = await spawnAndWait(
        row.workspaceId,
        dispatch.npmScript,
        {
          SHOP_ID: String(row.shopId),
          DAYS_BACK: String(daysBack),
          ...(dispatch.extraEnv ?? {}),
        },
      );
      if (!result.ok) {
        throw new Error(`spawnAndWait non-zero exit (code=${result.code})`);
      }

      // Advance cursor. We trust the script to have fetched the window;
      // if WB rate-limited part of it, the *next* tick will sit on the
      // same cursor (since we only advance on full success) — but in
      // practice the per-shop scripts are written to fail fast on WB
      // refusal, which surfaces as non-zero exit and lands in the catch.
      await db
        .update(wbBackfillProgress)
        .set({
          oldestCovered: dateOnly(newCursor),
          lastAdvancedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            sql`${wbBackfillProgress.workspaceId} = ${row.workspaceId}`,
            sql`${wbBackfillProgress.shopId} = ${row.shopId}`,
            sql`${wbBackfillProgress.syncType} = ${row.syncType}`,
          ),
        );
      logger.info({ ...childCtx, advancedTo: dateOnly(newCursor) }, 'walker tick: advanced cursor');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(wbBackfillProgress)
        .set({
          lastAdvancedAt: new Date(),
          lastError: message.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(
          and(
            sql`${wbBackfillProgress.workspaceId} = ${row.workspaceId}`,
            sql`${wbBackfillProgress.shopId} = ${row.shopId}`,
            sql`${wbBackfillProgress.syncType} = ${row.syncType}`,
          ),
        );
      logger.error({ ...childCtx, err: message }, 'walker tick: child failed; cursor unchanged');
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info({ elapsedMs: elapsed, candidates: candidates.length }, 'walker tick complete');
}
