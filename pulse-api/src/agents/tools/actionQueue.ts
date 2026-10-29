/**
 * Action Queue — durable execution of dangerous AI agent operations.
 *
 * Why this exists:
 *   The previous design ran action_* tools INLINE inside graph.executeNode:
 *     INSERT agent_actions (status=pending) → WB API → UPDATE status=executed
 *   If the API process died between the WB call and the UPDATE — or if a user
 *   asked for 15 actions in one message and the process restarted on the 8th
 *   — actions either left the audit trail in 'pending' forever (factual/audit
 *   drift) or were lost entirely (commands 9-15 never persisted).
 *
 *   The Action Queue durably persists every confirmed command as a `queued`
 *   row BEFORE the WB call, so a crash mid-flight is recoverable: a sweeper
 *   reclaims `running` rows older than 5 min and pg-boss retries them.
 *
 * Public API:
 *   - registerActionExecutor(actionType, executor) — wire a tool's executor
 *   - enqueueAction({ ... }) — called by the new (queue-mode) action_* tools;
 *     returns immediately with `{ actionId, status: 'queued' }` so the LLM
 *     can move on; the worker does the WB call.
 *
 * Worker side: see `jobs/agentActionRunner.ts`.
 *
 * Idempotency: an `idempotency_key = sha256(ws|shop|type|sortedArgs|conv)`
 * lives in a UNIQUE index. Re-enqueuing the same logical command returns the
 * existing actionId rather than creating a duplicate — useful for re-tries
 * from UI ("send again" button) and for SSE reconnects.
 */

import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { getQueue } from '../../jobs/queue.js';
import { logAgent as logger } from '../../lib/logger.js';

export const ACTION_QUEUE_NAME = 'agent-action-runner';
export const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Executor registry
// ---------------------------------------------------------------------------

export interface ActionContext {
  workspaceId: number;
  shopId: number | null;
  userId: number | null;
  conversationId: number | null;
  retryCount: number;       // 0 on first attempt
  actionId: number;         // the row in agent_actions
}

export interface ActionExecutorResult {
  /** 'success' → status=executed, 'error' → retryable/permanent decided by `retryable` */
  status: 'success' | 'error';
  /** Free-form result JSON (e.g. WB API response, success message, etc.) */
  result?: unknown;
  /** Human-readable failure reason; will be stored as last_error. */
  error?: string;
  /** When true, runner classifies as retryable (counts toward MAX_RETRIES). */
  retryable?: boolean;
}

export type ActionExecutor = (
  args: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<ActionExecutorResult>;

const executors = new Map<string, ActionExecutor>();

export function registerActionExecutor(actionType: string, executor: ActionExecutor): void {
  if (executors.has(actionType)) {
    logger.warn({ actionType }, 'actionQueue: overwriting existing executor');
  }
  executors.set(actionType, executor);
}

export function getActionExecutor(actionType: string): ActionExecutor | undefined {
  return executors.get(actionType);
}

export function listRegisteredActionTypes(): string[] {
  return [...executors.keys()];
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueArgs {
  workspaceId: number;
  shopId: number | null;
  userId: number | null;
  conversationId: number | null;
  /** Matches `agent_actions.action_type`, e.g. 'set_price', 'reply_feedback'. */
  actionType: string;
  /** Tool arguments. Sorted+hashed for idempotency. */
  toolArgs: Record<string, unknown>;
  rationale?: string;
  /**
   * Extra entropy for idempotency hash. The default key already includes
   * actionType + sortedArgs + conversationId, so two identical commands in the
   * same chat turn collide and reuse the same actionId. If the user explicitly
   * requests the action a second time in the same conversation, pass a fresh
   * value (e.g. message id) so a new row is created.
   */
  turnId?: string | number | null;
}

export interface EnqueuedAction {
  actionId: number;
  status: string;
  idempotencyKey: string;
  /** true → reused an existing row (idempotent dedup). */
  reused: boolean;
}

function computeIdempotencyKey(a: EnqueueArgs): string {
  // Stable JSON: sort keys at top level. We don't recurse — nested objects
  // are stringified as-is. Tool args are typically flat, so this is fine.
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(a.toolArgs).sort()) {
    sorted[k] = a.toolArgs[k];
  }
  const blob = JSON.stringify({
    ws: a.workspaceId,
    shop: a.shopId,
    type: a.actionType,
    args: sorted,
    conv: a.conversationId ?? null,
    turn: a.turnId ?? null,
  });
  return createHash('sha256').update(blob).digest('hex');
}

export async function enqueueAction(a: EnqueueArgs): Promise<EnqueuedAction> {
  if (!getActionExecutor(a.actionType)) {
    // Hard fail at enqueue rather than discovering at run time: the row would
    // sit in 'queued' forever otherwise.
    throw new Error(`actionQueue: no executor registered for actionType="${a.actionType}"`);
  }

  const key = computeIdempotencyKey(a);
  const now = new Date();
  const correlationId = randomUUID();

  // Try insert; ON CONFLICT (idempotency_key) → return nothing → fetch existing.
  const inserted = await db
    .insert(agentActions)
    .values({
      workspaceId: a.workspaceId,
      shopId: a.shopId,
      conversationId: a.conversationId,
      userId: a.userId,
      actionType: a.actionType,
      status: 'queued',
      payload: a.toolArgs as any,
      rationale: a.rationale ?? null,
      idempotencyKey: key,
      queuedAt: now,
      correlationId: correlationId as any,
      decidedBy: a.userId,
      decidedAt: now,
    } as any)
    .onConflictDoNothing({ target: agentActions.idempotencyKey })
    .returning({ actionId: agentActions.actionId, status: agentActions.status });

  if (inserted.length > 0) {
    const row = inserted[0];
    try {
      const boss = await getQueue();
      await boss.createQueue(ACTION_QUEUE_NAME);
      await boss.send(
        ACTION_QUEUE_NAME,
        { actionId: row.actionId },
        {
          // pg-boss-side retries; we ALSO track retry_count ourselves for
          // observability and per-action backoff. They reinforce each other.
          retryLimit: MAX_RETRIES,
          retryDelay: 30,
          retryBackoff: true,
          singletonKey: key,
        },
      );
    } catch (err) {
      // Enqueue persistence is committed already; if pg-boss is down the
      // sweeper will pick this up on the next minute via `failed:retryable`
      // reclassification. Don't poison the row here.
      logger.error({ err, actionId: row.actionId }, 'actionQueue: pg-boss send failed; sweeper will recover');
    }
    return { actionId: row.actionId, status: row.status, idempotencyKey: key, reused: false };
  }

  // Dedup path: fetch the existing row.
  const [existing] = await db
    .select({ actionId: agentActions.actionId, status: agentActions.status })
    .from(agentActions)
    .where(eq(agentActions.idempotencyKey, key))
    .limit(1);

  if (!existing) {
    // Should never happen — UNIQUE conflict but no row found. Race?
    throw new Error('actionQueue: idempotency_key conflict but row not found (race?)');
  }

  return {
    actionId: existing.actionId,
    status: existing.status,
    idempotencyKey: key,
    reused: true,
  };
}
