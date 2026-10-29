// Multi-Agent v2 — V&V public API (Phase 0 skeleton)
//
// scheduleVerification(actionId) — called from graph.executeNode after a
//   successful dangerous action; inserts 4 pending check rows (immediate,
//   deferred_30s, deferred_5min, impact_24h).
// runPendingChecks() — called by the verification-runner cron every minute.
// verifyAction(actionId, checkType) — single check executor. Looks up checker
//   in registry, calls it, writes result.
//
// All callers MUST check env.ENABLE_MULTI_AGENT before invoking (Phase 0 guard).

import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentActions, agentVerificationChecks } from '../../db/schema.js';
import { getChecker } from './checks/index.js';
import type {
  CheckFnResult,
  CheckType,
  RunPendingSummary,
  VerificationExpectation,
} from './types.js';

const BATCH_SIZE = 50;

// Schedule all 4 verification check levels for a newly-executed dangerous action.
// Denormalises shop_id from agent_actions so per-shop dashboards/Monitor cron
// can filter without an extra join.
export async function scheduleVerification(
  actionId: number,
  expectations: VerificationExpectation = {},
): Promise<void> {
  const now = new Date();
  const deferred30s = new Date(now.getTime() + 30 * 1000);
  const deferred5m = new Date(now.getTime() + 5 * 60 * 1000);
  const impact24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Look up shop_id from the parent action so verification rows inherit scope.
  const [action] = await db
    .select({ shopId: agentActions.shopId })
    .from(agentActions)
    .where(eq(agentActions.actionId, actionId))
    .limit(1);
  const shopId = action?.shopId ?? null;

  await db.insert(agentVerificationChecks).values([
    { actionId, shopId, checkType: 'immediate', scheduledAt: now, details: expectations },
    { actionId, shopId, checkType: 'deferred_30s', scheduledAt: deferred30s, details: expectations },
    { actionId, shopId, checkType: 'deferred_5min', scheduledAt: deferred5m, details: expectations },
    { actionId, shopId, checkType: 'impact_24h', scheduledAt: impact24h, details: expectations },
  ]);
}

// Worker path: executes a single pending check (already SELECTed by runner).
export async function verifyAction(
  actionId: number,
  checkType: CheckType,
): Promise<CheckFnResult> {
  const [action] = await db
    .select({
      actionType: agentActions.actionType,
      payload: agentActions.payload,
      workspaceId: agentActions.workspaceId,
      shopId: agentActions.shopId,
    })
    .from(agentActions)
    .where(eq(agentActions.actionId, actionId))
    .limit(1);

  if (!action) {
    return { result: 'fail', details: { error: 'action_row_missing' } };
  }

  const checker = getChecker(action.actionType);
  if (!checker) {
    return { result: 'fail', details: { error: 'no_checker_registered', actionType: action.actionType } };
  }

  try {
    return await checker({
      actionId,
      actionType: action.actionType,
      checkType,
      payload: (action.payload as Record<string, unknown>) ?? {},
      workspaceId: action.workspaceId,
      shopId: action.shopId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: 'fail', details: { error: msg } };
  }
}

// Cron path: drain due checks, update agent_verification_checks rows.
export async function runPendingChecks(): Promise<RunPendingSummary> {
  const summary: RunPendingSummary = {
    checked: 0,
    passed: 0,
    drifted: 0,
    failed: 0,
    timedOut: 0,
    skippedNoChecker: 0,
  };

  const pending = await db
    .select({
      checkId: agentVerificationChecks.checkId,
      actionId: agentVerificationChecks.actionId,
      checkType: agentVerificationChecks.checkType,
    })
    .from(agentVerificationChecks)
    .where(and(isNull(agentVerificationChecks.result), lte(agentVerificationChecks.scheduledAt, new Date())))
    .limit(BATCH_SIZE);

  for (const row of pending) {
    const { result, details } = await verifyAction(row.actionId, row.checkType as CheckType);

    await db
      .update(agentVerificationChecks)
      .set({ result, details: details ?? null, executedAt: new Date() })
      .where(eq(agentVerificationChecks.checkId, row.checkId));

    await db
      .update(agentActions)
      .set({
        verificationStatus: result === 'pass' ? 'verified' : result,
        verificationAttempts: sql`${agentActions.verificationAttempts} + 1`,
      })
      .where(eq(agentActions.actionId, row.actionId));

    summary.checked++;
    if (result === 'pass') summary.passed++;
    else if (result === 'drift') summary.drifted++;
    else if (result === 'fail') summary.failed++;
    else if (result === 'timeout') summary.timedOut++;
  }

  return summary;
}
