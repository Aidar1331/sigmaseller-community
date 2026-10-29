import { PgBoss } from 'pg-boss';
import type { ConstructorOptions as PgBossOptions } from 'pg-boss/dist/types.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { env } from '../env.js';
import { logJobs as logger } from '../lib/logger.js';
import { db } from '../db/client.js';

let boss: PgBoss | null = null;

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss;

  // M7: bound the unbounded growth of pgboss.job_common (was 23k completed
  // rows over 6 days — every-minute cron tics never aged out).
  // pg-boss runtime accepts these options; the published `ConstructorOptions`
  // type in v12 leaves them off, hence the cast.
  const opts = {
    connectionString: env.DATABASE_URL,
    maintenanceIntervalSeconds: 300,
    archiveCompletedAfterSeconds: 3600,  // 1 h → move to archive
    deleteAfterDays: 7,                  // 7 d → drop from archive
  } as PgBossOptions;
  boss = new PgBoss(opts);

  boss.on('error', (err: Error) => {
    logger.error({ err }, 'pg-boss error');
  });

  await boss.start();
  
  // Clean up stale/orphaned jobs on startup
  await cleanupStaleJobs();
  
  return boss;
}

/**
 * Clean up jobs that got stuck due to server restarts.
 * Jobs in 'active' state for more than 30 minutes are considered stale.
 */
async function cleanupStaleJobs(): Promise<void> {
  try {
    const result = await db.execute(sql`
      UPDATE pgboss.job 
      SET state = 'retry', retry_count = retry_count + 1
      WHERE state = 'active' 
        AND started_on < NOW() - INTERVAL '30 minutes'
      RETURNING id, name
    `);
    
    const rows = result.rows as Array<{ id: string; name: string }>;
    if (rows.length > 0) {
      logger.warn({ count: rows.length, jobs: rows.map(r => r.name) }, 'Reset stale jobs to retry');
    } else {
      logger.info('No stale jobs found');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup stale jobs');
  }
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 10_000 });
    boss = null;
  }
}

/* ─── Job names ─── */
export const JOB_FINANCE_WEEKLY_PRODUCTS = 'finance-weekly-products-sync';
export const JOB_STOCKS_SNAPSHOT = 'stocks-daily-snapshot';
export const JOB_SPP_WEEKLY = 'spp-weekly-sync';
export const JOB_ORDERS_SALES_SYNC = 'orders-sales-sync';
export const JOB_ADV_DAILY_SYNC = 'adv-daily-sync';
export const JOB_FUNNEL_DAILY_SYNC = 'funnel-daily-sync';
export const JOB_AUTO_ALERTS_SCHEDULE = 'auto-alerts-daily';
export const JOB_INITIAL_SYNC = 'initial-full-sync';
export const JOB_FBS_RUN = 'fbs-run';
export const JOB_FBS_SCHEDULE_TICK = 'fbs-schedule-tick';
export const JOB_CAMPAIGNS_SYNC = 'campaigns-sync';
