import { db } from '../db/client.js';
import { eq, and, desc, like } from 'drizzle-orm';
import { wbSyncRuns } from '../db/schema.js';
import { getQueue, JOB_AUTO_ALERTS_SCHEDULE } from './queue.js';
import { forEachWorkspace } from './workspaceIterator.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  minIntervalHours: number;
};

export function getAutoAlertsSchedulerConfig(): Config {
  const enabled = (process.env.ENABLE_AUTO_ALERTS_SCHEDULE ?? '') === '1';
  const minIntervalHours = Number.parseInt(process.env.AUTO_ALERTS_MIN_INTERVAL_HOURS || '20', 10);
  return { enabled, minIntervalHours };
}

async function runAutoAlertsForWorkspace(
  workspaceId: number,
  reason: string,
  cfg: Config
): Promise<{ ran: boolean; message: string }> {
  const runs = await db
    .select({ createdAt: wbSyncRuns.createdAt, stage: wbSyncRuns.stage })
    .from(wbSyncRuns)
    // F-017b: dedup only on completed runs.
    .where(and(eq(wbSyncRuns.workspaceId, workspaceId), like(wbSyncRuns.stage, 'auto-alerts:%'), eq(wbSyncRuns.status, 'completed')))
    .orderBy(desc(wbSyncRuns.createdAt))
    .limit(1);

  const last = runs[0];
  if (last?.createdAt) {
    const ageMs = Date.now() - new Date(last.createdAt).getTime();
    if (ageMs < cfg.minIntervalHours * 3600 * 1000) {
      return { ran: false, message: `skip: last run too recent (${last.stage})` };
    }
  }

  const { randomUUID } = await import('node:crypto');
  const runId = randomUUID();

  await db.insert(wbSyncRuns).values({
    runId,
    workspaceId,
    stage: `auto-alerts:${reason}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const { runAutoAlerts } = await import('./autoAlerts.js');
  const result = await runAutoAlerts({ workspaceId });

  await db
    .update(wbSyncRuns)
    .set({ stage: 'done', updatedAt: new Date() })
    .where(eq(wbSyncRuns.runId, runId));

  return { ran: true, message: `ok alerts=${(result as any)?.created?.length ?? 0}` };
}

export async function maybeRunAutoAlerts(reason: string): Promise<Map<number, { ran: boolean; message: string } | Error>> {
  const cfg = getAutoAlertsSchedulerConfig();
  if (!cfg.enabled) {
    return new Map([[0, { ran: false, message: 'disabled' }]]);
  }

  return forEachWorkspace(
    { overrideEnvVar: 'AUTO_ALERTS_WORKSPACE_ID' },
    (workspaceId) => runAutoAlertsForWorkspace(workspaceId, reason, cfg)
  );
}

/* ─── pg-boss scheduler ─── */

export async function registerAutoAlertsSchedulerJob(): Promise<void> {
  const cfg = getAutoAlertsSchedulerConfig();
  if (!cfg.enabled) {
    logger.info('Disabled, skipping pg-boss registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_AUTO_ALERTS_SCHEDULE);

  await boss.schedule(JOB_AUTO_ALERTS_SCHEDULE, '0 7 * * *', {}, {
    tz: 'Europe/Moscow',
  });

  await boss.work(JOB_AUTO_ALERTS_SCHEDULE, { localConcurrency: 1 }, async () => {
    try {
      logger.info('pg-boss triggered');
      const results = await maybeRunAutoAlerts('pg-boss');
      for (const [wsId, result] of results) {
        if (result instanceof Error) {
          logger.error({ err: result, workspaceId: wsId }, 'Workspace error');
        } else {
          logger.info({ workspaceId: wsId, message: result.message }, 'Workspace result');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Work handler error');
    }
  });

  logger.info('Registered via pg-boss (cron 0 7 * * * MSK) all workspaces');
}
