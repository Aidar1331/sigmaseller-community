/**
 * `update_characteristics` executor. Ownership in wb_cards.
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbCards } from '../../../db/schema.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { safeUpdateCard } from '../../../integrations/wb/content.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args {
  nmId: number;
  characteristics: Array<{ id: number; value: string | string[] }>;
  title?: string;
  description?: string;
}
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const updateCharacteristicsExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.nmId || !Array.isArray(a.characteristics) || a.characteristics.length === 0) {
    return { status: 'error', error: 'bad args', retryable: false };
  }
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const owned = await db.select({ nmId: wbCards.nmId }).from(wbCards)
    .where(and(eq(wbCards.workspaceId, ctx.workspaceId), eq(wbCards.nmId, a.nmId))).limit(1);
  if (owned.length === 0) return { status: 'error', error: `nmId=${a.nmId} not in workspace`, retryable: false };

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId ?? undefined);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };
    const patch: any = { characteristics: a.characteristics };
    if (a.title) patch.title = a.title;
    if (a.description) patch.description = a.description;
    const result = await safeUpdateCard(apiKey, a.nmId, patch);
    if (result.error) return { status: 'error', error: result.errorText ?? 'update failed', retryable: false };
    return { status: 'success', result: { nmId: a.nmId, message: `✅ Карточка ${a.nmId}: обновлено ${a.characteristics.length} характеристик` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
