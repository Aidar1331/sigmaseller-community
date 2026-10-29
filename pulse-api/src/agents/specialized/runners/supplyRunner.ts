/**
 * Supply Agent runner — persisted wrapper around pure-function supplyAgent.
 *
 * Обеспечивает:
 *   1. Старт записи в `agent_run_results` (status=running).
 *   2. Вызов `runSupplyAgent(wsId, targetDays, shopId)`.
 *   3. Сохранение рекомендаций в `agent_supply_recommendations`.
 *   4. Финализация run-записи (done/failed + summary + metrics).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { agentRunResults, agentSupplyRecommendations, wbCards } from '../../../db/schema.js';
import { runSupplyAgent } from '../supplyAgent.js';
import log from '../../../lib/logger.js';

const logger = log.child({ module: 'supplyRunner' });

export type SupplyTrigger = 'cron' | 'manual' | 'subagent' | 'api';

export interface RunSupplyPersistedInput {
  workspaceId: number;
  shopId: number | null;
  trigger: SupplyTrigger;
  targetDays?: number;
}

export interface RunSupplyPersistedResult {
  runId: string;
  summary: string;
  recommendationsCount: number;
}

export async function runSupplyAgentPersisted(input: RunSupplyPersistedInput): Promise<RunSupplyPersistedResult> {
  const runId = randomUUID();
  const { workspaceId, shopId, trigger, targetDays } = input;
  const started = Date.now();

  await db.insert(agentRunResults).values({
    runId,
    agentName: 'supply',
    workspaceId,
    shopId,
    trigger,
    status: 'running',
  });

  try {
    const { summary, recommendations } = await runSupplyAgent(
      workspaceId,
      targetDays ?? 45,
      shopId ?? undefined,
    );

    if (recommendations.length > 0) {
      // Подтянем нормальные названия товаров (в supplyAgent может быть '')
      const nmIds = recommendations.map((r) => r.nmId);
      const cards = await db
        .select({ nmId: wbCards.nmId, title: wbCards.title })
        .from(wbCards)
        .where(and(eq(wbCards.workspaceId, workspaceId)));
      const titles = new Map(cards.filter((c) => c.title).map((c) => [c.nmId, c.title as string]));

      const rows = recommendations.map((r) => ({
        runId,
        workspaceId,
        shopId,
        nmId: r.nmId,
        productTitle: titles.get(r.nmId) ?? r.productTitle ?? null,
        currentStock: r.currentStock,
        avgDailySales: r.avgDailySales,
        daysOfStock: r.daysOfStock,
        recommendedQty: r.recommendedQty,
        urgency: r.urgency,
        reason: r.reason,
      }));

      // Батчами по 500 во избежание параметрического кап.
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        await db.insert(agentSupplyRecommendations).values(rows.slice(i, i + BATCH));
      }
    }

    const durationMs = Date.now() - started;
    await db
      .update(agentRunResults)
      .set({
        status: 'done',
        summary,
        metrics: {
          count: recommendations.length,
          durationMs,
          byUrgency: countBy(recommendations, (r) => r.urgency),
        },
        finishedAt: new Date(),
      })
      .where(eq(agentRunResults.runId, runId));

    logger.info(
      { runId, workspaceId, shopId, count: recommendations.length, durationMs },
      'supply agent run done',
    );

    return { runId, summary, recommendationsCount: recommendations.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, workspaceId, shopId, runId }, 'supply agent run failed');
    await db
      .update(agentRunResults)
      .set({ status: 'failed', error: message.slice(0, 500), finishedAt: new Date() })
      .where(eq(agentRunResults.runId, runId));
    throw err;
  }
}

function countBy<T>(arr: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of arr) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
