// Multi-Agent v2 Phase 4 — Monitor Service.
//
// Background observer that scans system_events / agent_actions / sync runs
// and generates proactive insights: margin drops, OOS warnings, verification
// drift patterns. Insights are written into agent_events with status='pending'
// and suggested_action — the existing /ai/events UI already handles them.
//
// Registered as cron JOBS.AGENT_MONITOR_SCAN (every 4 hours, behind
// ENABLE_MULTI_AGENT flag). Phase 4 emits pre-defined insight types; the
// LLM-based classification layer is deferred to Phase 6.

import { and, eq, gte, sql, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  agentActions,
  agentEvents,
  agentVerificationChecks,
  workspaces,
} from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';
import { pushCriticalToTelegram } from './telegramPush.js';

export interface MonitorRunSummary {
  scannedWorkspaces: number;
  insightsCreated: number;
  issues: string[];
}

export async function runAgentMonitorScan(): Promise<MonitorRunSummary> {
  const summary: MonitorRunSummary = { scannedWorkspaces: 0, insightsCreated: 0, issues: [] };
  const wsList = await db.select({ wsId: workspaces.workspaceId }).from(workspaces);

  for (const ws of wsList) {
    summary.scannedWorkspaces++;
    try {
      summary.insightsCreated += await scanWorkspace(ws.wsId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.issues.push(`ws=${ws.wsId}: ${msg}`);
      logger.error({ err, wsId: ws.wsId }, 'monitor scan failed');
    }
  }
  return summary;
}

// Per-workspace scan. Current insight types:
// 1. verification_drift: drift rate > 15% in last 24h
// 2. failed_actions_spike: > 5 failed actions in last 6h
async function scanWorkspace(wsId: number): Promise<number> {
  let created = 0;
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

  // 1. Verification drift
  const verifStats = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      drifted: sql<number>`count(*) filter (where ${agentVerificationChecks.result} = 'drift')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${agentVerificationChecks.result} = 'fail')`.mapWith(Number),
    })
    .from(agentVerificationChecks)
    .innerJoin(agentActions, eq(agentVerificationChecks.actionId, agentActions.actionId))
    .where(and(
      eq(agentActions.workspaceId, wsId),
      gte(agentVerificationChecks.executedAt, dayAgo),
    ));

  const stats = verifStats[0];
  if (stats && stats.total > 10 && (stats.drifted + stats.failed) / stats.total > 0.15) {
    // Skip if an identical insight exists in last 24h
    const [existing] = await db
      .select({ eventId: agentEvents.eventId })
      .from(agentEvents)
      .where(and(
        eq(agentEvents.workspaceId, wsId),
        eq(agentEvents.eventType, 'verification_drift_spike'),
        gte(agentEvents.createdAt, dayAgo),
      ))
      .limit(1);

    if (!existing) {
      await db.insert(agentEvents).values({
        workspaceId: wsId,
        eventType: 'verification_drift_spike',
        severity: 'warning',
        source: 'monitor',
        agentSource: 'monitor',
        title: `Drift/fail rate ${Math.round((stats.drifted + stats.failed) / stats.total * 100)}% за 24ч`,
        description: `Из ${stats.total} verification checks: ${stats.drifted} drift, ${stats.failed} fail. Порог 15% превышен.`,
        suggestedAction: 'review_rules',
        status: 'pending',
        meta: { total: stats.total, drifted: stats.drifted, failed: stats.failed },
      });
      created++;
    }
  }

  // 2. Failed actions spike
  const [actionStats] = await db
    .select({ failed: sql<number>`count(*) filter (where ${agentActions.status} = 'failed')`.mapWith(Number) })
    .from(agentActions)
    .where(and(
      eq(agentActions.workspaceId, wsId),
      gte(agentActions.createdAt, sixHoursAgo),
    ));

  if (actionStats && actionStats.failed > 5) {
    const [existing] = await db
      .select({ eventId: agentEvents.eventId })
      .from(agentEvents)
      .where(and(
        eq(agentEvents.workspaceId, wsId),
        eq(agentEvents.eventType, 'failed_actions_spike'),
        gte(agentEvents.createdAt, sixHoursAgo),
      ))
      .limit(1);

    if (!existing) {
      const title = `${actionStats.failed} failed actions за 6ч`;
      const description = 'Повышенное количество неуспешных действий агента. Проверьте WB API ключи и логи.';
      await db.insert(agentEvents).values({
        workspaceId: wsId,
        eventType: 'failed_actions_spike',
        severity: 'critical',
        source: 'monitor',
        agentSource: 'monitor',
        title,
        description,
        suggestedAction: 'investigate_logs',
        status: 'pending',
        meta: { failedCount: actionStats.failed, windowHours: 6 },
      });
      created++;
      // Fire-and-forget Telegram notification for critical severity
      void pushCriticalToTelegram({
        workspaceId: wsId,
        title,
        description,
        suggestedAction: 'investigate_logs',
        eventType: 'failed_actions_spike',
      });
    }
  }

  return created;
}
