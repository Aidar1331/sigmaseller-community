import { db } from '../../db/client.js';
import { agentLocks } from '../../db/schema.js';
import { and, eq, lt } from 'drizzle-orm';
import { checkWorkspaceAccess } from '../../plugins/workspace.js';
import { logAgent as logger } from '../../lib/logger.js';

/**
 * Verify the agent's user context belongs to the workspace.
 *
 * Must be called at the start of every dangerous (action_*) tool. Under
 * the simplified one-user-per-workspace model we only check membership;
 * there is no role tier to enforce. The legacy DISABLE_RBAC kill-switch
 * is gone — it had no meaning without role tiers.
 */
export async function assertAgentAuth(userId: number | undefined, workspaceId: number | undefined): Promise<void> {
  if (!userId || !workspaceId) {
    throw new Error('Agent auth failed: missing userId or workspaceId in context');
  }
  // `checkWorkspaceAccess` still accepts a minRole argument for
  // backwards-compat; we pass the lowest tier so it becomes a pure
  // membership check against workspace_members.
  const member = await checkWorkspaceAccess(userId, workspaceId, 'viewer');
  if (!member) {
    throw new Error(`Agent auth failed: user ${userId} is not a member of workspace ${workspaceId}`);
  }
}

/**
 * Per-resource-type TTL for distributed locks.
 *
 * Default 5 min is fine for most WB operations (price set, bid change,
 * feedback reply — all complete in seconds). But some flows are slow or
 * have provider rate limits that hold us in the call for minutes:
 *
 *   - action_create_supply: createSupply + setSupplyGoods can take >5 min
 *     on big batches; if lock expires mid-flight, a concurrent action can
 *     acquire it and we get duplicate uploads.
 *   - action_create_pass: WB enforces 1 request / 10 min globally; we must
 *     hold the lock long enough that the rate-limit window expires before
 *     anyone else attempts.
 *   - action_create_card: card create + verification on WB can chain ~10 min.
 *
 * Tuning is conservative — slightly long TTL is safe (worst case: a real
 * crashed worker delays the next attempt). Short TTL on long ops is unsafe.
 */
const LOCK_TTL_BY_RESOURCE_TYPE: Record<string, number> = {
  action_create_supply: 15 * 60 * 1000,
  action_create_pass:   15 * 60 * 1000,
  action_create_card:   10 * 60 * 1000,
};
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Acquire a distributed lock for a resource.
 * Uses a DB transaction to prevent race conditions between concurrent agents.
 */
export async function acquireLock(wsId: number, resourceType: string, resourceId: string, lockedBy: string): Promise<boolean> {
  const ttlMs = LOCK_TTL_BY_RESOURCE_TYPE[resourceType] ?? DEFAULT_LOCK_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    return await db.transaction(async (tx) => {
      // 1. Clean expired locks inside the transaction (atomic with insert below)
      await tx.delete(agentLocks).where(lt(agentLocks.expiresAt, new Date()));

      // 2. Try insert — onConflictDoNothing returns empty array if a live lock
      // already exists on the unique index (ws_id, resource_type, resource_id).
      const inserted = await tx.insert(agentLocks).values({
        workspaceId: wsId,
        resourceType,
        resourceId,
        lockedBy,
        expiresAt,
      }).onConflictDoNothing().returning();

      // 3. If inserted — we own the lock. If empty — someone else holds it.
      //    Transaction is atomic in Postgres: on throw the whole thing rolls
      //    back (including the expired-locks cleanup), so no partial state.
      return inserted.length > 0;
    });
  } catch (err) {
    // Log so ops can distinguish "contention" (returns false from tx) from
    // "DB error" (throw). Without this we were swallowing real failures.
    logger.error({ err, wsId, resourceType, resourceId, lockedBy }, 'acquireLock failed (DB error, not contention)');
    return false;
  }
}

/**
 * Release a lock for a resource.
 * Silently ignores errors — lock will expire via TTL if release fails.
 */
export async function releaseLock(wsId: number, resourceType: string, resourceId: string): Promise<void> {
  try {
    await db.delete(agentLocks).where(
      and(
        eq(agentLocks.workspaceId, wsId),
        eq(agentLocks.resourceType, resourceType),
        eq(agentLocks.resourceId, resourceId),
      )
    );
  } catch (err) {
    // Log but don't propagate: lock will expire via TTL if release fails.
    logger.warn({ err, wsId, resourceType, resourceId }, 'releaseLock failed (will expire via TTL)');
  }
}
