import { db } from '../../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray } from 'drizzle-orm';
import { wbSyncRuns } from '../../db/schema.js';

export type WbSyncStage =
  | 'queued'
  | 'history_7d'
  | 'cards'
  | 'funnel_30d'
  | 'funnel_60d'
  | 'funnel_90d'
  | 'done'
  | 'failed';

export async function updateRunStage(runId: string, patch: { stage?: WbSyncStage; error?: string | null }) {
  await db
    .update(wbSyncRuns)
    .set({
      stage: patch.stage,
      error: patch.error ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(wbSyncRuns.runId, runId));
}

export async function markRunDone(runId: string) {
  await updateRunStage(runId, { stage: 'done', error: null });
}

export async function markRunFailed(runId: string, error: string) {
  await updateRunStage(runId, { stage: 'failed', error });
}
