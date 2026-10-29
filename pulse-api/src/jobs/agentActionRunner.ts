/**
 * Worker + sweeper for the Action Queue.
 *
 * Worker (`agent-action-runner` pg-boss queue):
 *   - Atomic claim via UPDATE ... RETURNING with status guard (queued|failed:retryable → running).
 *   - Looks up an executor from the in-process registry (actionQueue.ts).
 *   - On success → executed; on retryable failure (< MAX_RETRIES) → failed:retryable
 *     (sweeper re-enqueues); on terminal failure → failed:permanent.
 *
 * Sweeper (cron, every minute via scheduler.ts):
 *   - Finds rows stuck in 'running' for > 5 minutes (process died, OOM, infinite loop).
 *   - Rewrites to failed:retryable (if retry budget remaining) or failed:permanent.
 *   - Re-sends retryable ones into pg-boss so they get another chance.
 */

import { sql, eq } from 'drizzle-orm';
import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { agentActions } from '../db/schema.js';
import { logAgent as logger } from '../lib/logger.js';
import {
  ACTION_QUEUE_NAME,
  MAX_RETRIES,
  getActionExecutor,
  type ActionContext,
} from '../agents/tools/actionQueue.js';

// M5: tools where verification drift matters enough to compute synchronously.
// All hit WB endpoints that affect money / inventory and where catching a
// drift within 5 min (cron path) is too slow for the chat-loop UX.
const CRITICAL_ACTION_TYPES = new Set<string>([
  'set_price',
  'create_card',
  'create_supply',
  'create_pass',
]);

interface RunnerPayload {
  actionId: number;
}

interface ClaimedRow {
  action_type: string;
  payload: unknown;
  workspace_id: string | number;
  shop_id: string | number | null;
  user_id: string | number | null;
  conversation_id: string | number | null;
  retry_count: number;
  [key: string]: unknown; // drizzle db.execute<T> requires index signature
}

interface SweptRow {
  action_id: number;
  new_status: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export async function registerAgentActionRunner(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(ACTION_QUEUE_NAME);

  await boss.work<RunnerPayload>(
    ACTION_QUEUE_NAME,
    { batchSize: 1 },
    async (jobs) => {
      const job = jobs[0];
      const { actionId } = job.data;
      await processOne(actionId);
    },
  );

  logger.info({ queue: ACTION_QUEUE_NAME }, 'agent-action-runner registered');
}

async function processOne(actionId: number): Promise<void> {
  // Atomic claim. Multiple workers/restarts can both have a pending pg-boss
  // job for the same actionId (e.g. sweeper re-enqueued one that pg-boss also
  // re-tried). The status guard ensures only one wins.
  const res = await db.execute<ClaimedRow>(sql`
    UPDATE agent_actions
    SET status = 'running',
        started_at = NOW()
    WHERE action_id = ${actionId}
      AND status IN ('queued', 'failed:retryable')
    RETURNING action_type, payload, workspace_id, shop_id, user_id, conversation_id, retry_count
  `);

  const rows = ((res as any).rows ?? res) as ClaimedRow[];
  if (rows.length === 0) {
    logger.info({ actionId }, 'agent-action-runner: action already terminal or claimed, skipping');
    return;
  }
  const row = rows[0];

  const executor = getActionExecutor(row.action_type);
  if (!executor) {
    await markPermanent(actionId, `no executor registered for action_type=${row.action_type}`);
    return;
  }

  const ctx: ActionContext = {
    workspaceId: Number(row.workspace_id),
    shopId: row.shop_id !== null ? Number(row.shop_id) : null,
    userId: row.user_id !== null ? Number(row.user_id) : null,
    conversationId: row.conversation_id !== null ? Number(row.conversation_id) : null,
    retryCount: row.retry_count ?? 0,
    actionId,
  };

  try {
    const result = await executor(row.payload as Record<string, unknown>, ctx);

    if (result.status === 'success') {
      await markExecuted(actionId, result.result);
      // M5: sync V&V for critical actions. The cron-driven runPendingChecks
      // catches everything within 5 min, but for tools that touch money
      // (set_price) or have hard rate limits (create_card / create_supply /
      // create_pass) we want the verification result attached to the action
      // before the user-facing response cycle ends. Schedule the 4 levels,
      // then synchronously execute the 'immediate' one and log any drift.
      // Note: only fires when MULTI_AGENT is on (i.e. when V&V infra is live).
      if (process.env.ENABLE_MULTI_AGENT === '1' && CRITICAL_ACTION_TYPES.has(row.action_type)) {
        try {
          const { scheduleVerification, verifyAction } = await import('../services/agentVerification/index.js');
          await scheduleVerification(actionId, {});
          const immediate = await verifyAction(actionId, 'immediate');
          if (immediate.result === 'drift' || immediate.result === 'fail') {
            logger.warn({ actionId, actionType: row.action_type, ...immediate }, 'M5 sync V&V: drift/fail on critical action');
          }
        } catch (vvErr) {
          logger.error({ err: vvErr, actionId }, 'M5 sync V&V failed (non-fatal)');
        }
      }
      return;
    }

    // M14: detect token-expired downstream + notify the workspace owner.
    // The executor returns an error string from WB; we surface a clear
    // signal to the user (deduped per day) so they rotate the key
    // promptly. notifyTokenExpired() is best-effort.
    const errStr = result.error ?? '';
    if (looksLikeTokenExpired(errStr) && ctx.shopId != null) {
      try {
        const { notifyTokenExpired } = await import('../services/wb/notifyTokenExpired.js');
        await notifyTokenExpired({ workspaceId: ctx.workspaceId, shopId: ctx.shopId });
      } catch (notifyErr) {
        logger.error({ err: notifyErr, actionId, shopId: ctx.shopId }, 'notifyTokenExpired failed (non-fatal)');
      }
    }

    // Executor reported failure. Decide retryable vs permanent.
    const retryable = result.retryable === true;
    if (retryable && ctx.retryCount < MAX_RETRIES - 1) {
      await markRetryable(actionId, result.error ?? 'unknown error', ctx.retryCount + 1);
      // Throw so pg-boss honours its own retry policy too (defence in depth).
      throw new Error(result.error ?? 'retryable failure');
    }
    await markPermanent(actionId, result.error ?? 'unknown error');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const inferredRetryable = isLikelyRetryable(err);

    // M14: also fire notify on thrown WbTokenExpiredError (executor may bubble it).
    if (looksLikeTokenExpired(msg) && ctx.shopId != null) {
      try {
        const { notifyTokenExpired } = await import('../services/wb/notifyTokenExpired.js');
        await notifyTokenExpired({ workspaceId: ctx.workspaceId, shopId: ctx.shopId });
      } catch { /* swallow */ }
    }

    // Re-classify thrown errors. If we already marked retryable above, the
    // re-throw lands here and we just bubble it up (don't double-write).
    if (inferredRetryable && ctx.retryCount < MAX_RETRIES - 1) {
      // Only write if we haven't already (best-effort check by re-reading status).
      const stillRunning = await isStillRunning(actionId);
      if (stillRunning) {
        await markRetryable(actionId, msg, ctx.retryCount + 1);
      }
      throw err; // let pg-boss retry too
    }
    const stillRunning = await isStillRunning(actionId);
    if (stillRunning) {
      await markPermanent(actionId, msg);
    }
  }
}

async function isStillRunning(actionId: number): Promise<boolean> {
  const [row] = await db
    .select({ status: agentActions.status })
    .from(agentActions)
    .where(eq(agentActions.actionId, actionId))
    .limit(1);
  return row?.status === 'running';
}

async function markExecuted(actionId: number, result: unknown): Promise<void> {
  const now = new Date();
  await db
    .update(agentActions)
    .set({
      status: 'executed',
      result: (result ?? null) as any,
      completedAt: now,
      executedAt: now,
    })
    .where(eq(agentActions.actionId, actionId));
}

async function markRetryable(actionId: number, error: string, retryCount: number): Promise<void> {
  // Exponential backoff with jitter: 2s, 4s, 8s ... capped at 60s.
  const baseMs = Math.min(60_000, 2_000 * 2 ** (retryCount - 1));
  const jitterMs = Math.floor(baseMs * 0.25 * Math.random());
  const next = new Date(Date.now() + baseMs + jitterMs);
  await db
    .update(agentActions)
    .set({
      status: 'failed:retryable',
      lastError: error.slice(0, 1000),
      retryCount,
      nextRetryAt: next,
    })
    .where(eq(agentActions.actionId, actionId));
}

async function markPermanent(actionId: number, error: string): Promise<void> {
  await db
    .update(agentActions)
    .set({
      status: 'failed:permanent',
      lastError: error.slice(0, 1000),
      completedAt: new Date(),
    })
    .where(eq(agentActions.actionId, actionId));
}

function isLikelyRetryable(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  if (msg.includes('econn') || msg.includes('etimedout') || msg.includes('enotfound')) return true;
  if (msg.includes('timeout')) return true;
  if (msg.includes('rate-limit') || msg.includes('429')) return true;
  if (/\bhttp 5\d{2}\b/.test(msg)) return true;
  return false;
}

// M14: token-expired errors come from wbClient.ts as WbTokenExpiredError
// (thrown) or surfaced into executor error strings as "WB token expired".
// We match both shapes so notifyTokenExpired fires regardless of bubbling
// style. Permanent (not retryable) — the user must rotate the key.
function looksLikeTokenExpired(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('wb token expired')
      || lower.includes('wbtokenexpiredexception')
      || lower.includes('wbtokenexpirederror')
      || (lower.includes('401') && lower.includes('token'));
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

/**
 * Reclaim actions stuck in `running` longer than the threshold (process died
 * before completing). Retryable rows get re-enqueued; the rest become
 * `failed:permanent`. Designed to be called from a `* * * * *` cron.
 *
 * Returns the number of rows touched (for logging / future metrics).
 */
export async function sweepStuckActions(staleMinutes = 5): Promise<{ rescued: number; permanent: number }> {
  const res = await db.execute<SweptRow>(sql`
    UPDATE agent_actions
    SET status = CASE
                   WHEN retry_count < ${MAX_RETRIES} THEN 'failed:retryable'
                   ELSE 'failed:permanent'
                 END,
        last_error    = COALESCE(last_error, '') || ' | sweeper: worker died with action in running state',
        next_retry_at = CASE WHEN retry_count < ${MAX_RETRIES} THEN NOW() ELSE NULL END,
        completed_at  = CASE WHEN retry_count >= ${MAX_RETRIES} THEN NOW() ELSE completed_at END
    WHERE status = 'running'
      AND started_at < NOW() - (${staleMinutes}::text || ' minutes')::interval
    RETURNING action_id,
              CASE WHEN retry_count < ${MAX_RETRIES} THEN 'failed:retryable' ELSE 'failed:permanent' END AS new_status
  `);

  const rows = ((res as any).rows ?? res) as Array<{ action_id: number; new_status: string }>;
  let rescued = 0;
  let permanent = 0;

  if (rows.length > 0) {
    try {
      const boss = await getQueue();
      for (const r of rows) {
        if (r.new_status === 'failed:retryable') {
          rescued++;
          try {
            await boss.send(ACTION_QUEUE_NAME, { actionId: r.action_id });
          } catch (err) {
            logger.warn({ err, actionId: r.action_id }, 'sweeper: failed to re-enqueue');
          }
        } else {
          permanent++;
        }
      }
    } catch (err) {
      logger.error({ err, rescuedCandidates: rows.length }, 'sweeper: pg-boss unavailable; rows updated but not re-enqueued');
    }
  }

  if (rows.length > 0) {
    logger.info({ rescued, permanent }, 'agent-action sweeper: cleaned up stuck actions');
  }
  return { rescued, permanent };
}
