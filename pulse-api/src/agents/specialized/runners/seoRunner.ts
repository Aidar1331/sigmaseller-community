/**
 * SEO Agent runner — persisted wrapper.
 *
 * Flow:
 *   1. Запись в `agent_run_results` (status=running).
 *   2. Вызов pure-function `runSeoAgent(wsId, shopId)`.
 *   3. Upsert полученных alerts в `seo_alerts` с дедупликацией:
 *      non-read alert для пары (keywordId, nmId) с тем же severity,
 *      созданный < 48 часов назад, блокирует создание дубля.
 *   4. Финализация run-записи.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentRunResults, seoAlerts, seoKeywords } from '../../../db/schema.js';
import { runSeoAgent } from '../seoAgent.js';
import log from '../../../lib/logger.js';

const logger = log.child({ module: 'seoRunner' });

export type SeoTrigger = 'cron' | 'manual' | 'subagent' | 'api';

export interface RunSeoPersistedInput {
  workspaceId: number;
  shopId: number | null;
  trigger: SeoTrigger;
}

export interface RunSeoPersistedResult {
  runId: string;
  summary: string;
  alertsCreated: number;
  alertsSkippedDedup: number;
}

const DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;

function mapSeverityToAlertType(severity: 'critical' | 'warning' | 'info'): string {
  if (severity === 'info') return 'recovered';
  return 'dropped';
}

export async function runSeoAgentPersisted(input: RunSeoPersistedInput): Promise<RunSeoPersistedResult> {
  const runId = randomUUID();
  const { workspaceId, shopId, trigger } = input;
  const started = Date.now();

  await db.insert(agentRunResults).values({
    runId,
    agentName: 'seo',
    workspaceId,
    shopId,
    trigger,
    status: 'running',
  });

  try {
    const { summary, alerts } = await runSeoAgent(workspaceId, shopId ?? undefined);

    // Построим keyword → keywordId (alerts приходят без keywordId)
    const keywordRows = await db
      .select({ keywordId: seoKeywords.keywordId, keyword: seoKeywords.keyword })
      .from(seoKeywords)
      .where(and(
        eq(seoKeywords.workspaceId, workspaceId),
        ...(shopId != null ? [eq(seoKeywords.shopId, shopId)] : []),
      ));
    const keywordToId = new Map(keywordRows.map((r) => [r.keyword, r.keywordId]));

    let created = 0;
    let skipped = 0;
    const dedupCutoff = new Date(Date.now() - DEDUP_WINDOW_MS);

    for (const a of alerts) {
      const keywordId = keywordToId.get(a.keyword);
      if (!keywordId) continue;
      const alertType = mapSeverityToAlertType(a.severity);

      // Дедуп: есть ли unread alert по той же паре за последние 48ч
      const existing = await db
        .select({ alertId: seoAlerts.alertId })
        .from(seoAlerts)
        .where(and(
          eq(seoAlerts.keywordId, keywordId),
          eq(seoAlerts.nmId, a.nmId),
          eq(seoAlerts.alertType, alertType),
          eq(seoAlerts.isRead, false),
          gte(seoAlerts.createdAt, dedupCutoff),
        ))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await db.insert(seoAlerts).values({
        keywordId,
        nmId: a.nmId,
        previousPosition: a.previousPosition,
        currentPosition: a.currentPosition,
        alertType,
      });
      created++;
    }

    const durationMs = Date.now() - started;
    await db
      .update(agentRunResults)
      .set({
        status: 'done',
        summary,
        metrics: { alertsTotal: alerts.length, created, skipped, durationMs },
        finishedAt: new Date(),
      })
      .where(eq(agentRunResults.runId, runId));

    logger.info({ runId, workspaceId, shopId, created, skipped, durationMs }, 'seo agent run done');

    return { runId, summary, alertsCreated: created, alertsSkippedDedup: skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, workspaceId, shopId, runId }, 'seo agent run failed');
    await db
      .update(agentRunResults)
      .set({ status: 'failed', error: message.slice(0, 500), finishedAt: new Date() })
      .where(eq(agentRunResults.runId, runId));
    throw err;
  }
}
