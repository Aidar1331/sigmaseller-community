/**
 * `manage_promotion` executor. Ownership re-check on every nmId in args.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { addProductsToPromotion, removeProductsFromPromotion } from '../../../integrations/wb/promotions.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args { promotionId: number; action: 'add' | 'remove'; nmIds: number[]; }
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const managePromotionExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.promotionId || !Array.isArray(a.nmIds) || a.nmIds.length === 0) {
    return { status: 'error', error: 'bad args', retryable: false };
  }
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const ownedRes = await db.execute<{ nm_id: number }>(sql`
    SELECT nm_id FROM wb_cards WHERE workspace_id = ${ctx.workspaceId} AND nm_id = ANY(${a.nmIds})
  `);
  const ownedRows = ((ownedRes as any).rows ?? ownedRes) as Array<{ nm_id: number }>;
  const ownedSet = new Set(ownedRows.map((r) => Number(r.nm_id)));
  const foreign = a.nmIds.filter((id) => !ownedSet.has(id));
  if (foreign.length > 0) {
    return { status: 'error', error: `nmIds not owned: ${foreign.slice(0, 5).join(',')}`, retryable: false };
  }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId ?? undefined);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };
    if (a.action === 'add') await addProductsToPromotion(apiKey, a.promotionId, a.nmIds);
    else await removeProductsFromPromotion(apiKey, a.promotionId, a.nmIds);
    const verb = a.action === 'add' ? 'добавлено в' : 'убрано из';
    return { status: 'success', result: { promotionId: a.promotionId, count: a.nmIds.length, message: `✅ ${a.nmIds.length} товар(ов) ${verb} акции #${a.promotionId}` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
