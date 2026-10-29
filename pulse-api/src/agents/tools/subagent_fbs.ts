// Multi-Agent v2 — FBS subagent tool. Reports recent FBS shipment activity
// from wb_fbs_shipments_daily_products. (Confirmation / marking handled by
// specific action_confirm_fbs_order + marking tools, to come in a follow-up.)

import { randomUUID } from 'node:crypto';
import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentExecutionRuns, wbFbsShipmentsDailyProducts } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface SubagentFbsInput {
  userIntent: string;
  daysBack?: number;
  detailLevel?: 'quick' | 'thorough';
  _workspaceId?: number;
  _shopId?: number | null;
  _correlationId?: string;
}

export async function subagentFbs(input: SubagentFbsInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', agentName: 'fbs', error: 'workspace_id missing' });

  const correlationId = input._correlationId ?? randomUUID();
  const runId = randomUUID();
  const daysBack = input.daysBack ?? 7;
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);

  await db.insert(agentExecutionRuns).values({
    runId,
    agentName: 'fbs',
    workspaceId: wsId,
    shopId: input._shopId ?? null,
    correlationId,
    status: 'running',
    inputSnapshot: { userIntent: input.userIntent, daysBack, detailLevel: input.detailLevel ?? 'quick' },
  });

  try {
    const [row] = await db
      .select({
        totalOrders: sql<number>`coalesce(sum(${wbFbsShipmentsDailyProducts.ordersCount}), 0)`.mapWith(Number),
        totalItems: sql<number>`coalesce(sum(${wbFbsShipmentsDailyProducts.itemsCount}), 0)`.mapWith(Number),
        distinctNmIds: sql<number>`count(distinct ${wbFbsShipmentsDailyProducts.nmId})`.mapWith(Number),
      })
      .from(wbFbsShipmentsDailyProducts)
      .where(and(
        eq(wbFbsShipmentsDailyProducts.workspaceId, wsId),
        gte(wbFbsShipmentsDailyProducts.date, since),
      ));

    const output = {
      status: row.totalOrders > 0 ? ('ok' as const) : ('no_data' as const),
      agentName: 'fbs' as const,
      summary: `FBS за ${daysBack}д: ${row.totalOrders} заказов, ${row.totalItems} товаров по ${row.distinctNmIds} SKU`,
      stats: { daysBack, totalOrders: row.totalOrders, totalItems: row.totalItems, distinctNmIds: row.distinctNmIds },
      runId,
    };

    await db.update(agentExecutionRuns)
      .set({ status: 'done', finishedAt: new Date(), output: output as unknown as Record<string, unknown> })
      .where(eq(agentExecutionRuns.runId, runId));
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, wsId, runId }, 'subagentFbs failed');
    await db.update(agentExecutionRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: msg })
      .where(eq(agentExecutionRuns.runId, runId));
    return JSON.stringify({ status: 'error', agentName: 'fbs', error: msg, runId });
  }
}
