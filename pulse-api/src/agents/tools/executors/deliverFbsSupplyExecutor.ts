/**
 * `deliver_fbs_supply` executor — closes an FBS supply for delivery.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbFbsSupplies } from '../../../db/schema.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { closeSupply } from '../../../integrations/wb/marketplace/client.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args {
  wbSupplyId?: string;
  fbsSupplyPk?: number;
}
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const deliverFbsSupplyExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.wbSupplyId && !a.fbsSupplyPk) {
    return { status: 'error', error: 'wbSupplyId or fbsSupplyPk required', retryable: false };
  }
  if (!ctx.shopId) {
    return { status: 'error', error: 'shopId required', retryable: false };
  }
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  let resolvedId = a.wbSupplyId;
  if (!resolvedId && a.fbsSupplyPk) {
    const [row] = await db
      .select({ wbSupplyId: wbFbsSupplies.wbSupplyId, workspaceId: wbFbsSupplies.workspaceId })
      .from(wbFbsSupplies)
      .where(eq(wbFbsSupplies.id, a.fbsSupplyPk))
      .limit(1);
    if (!row) return { status: 'error', error: `pk=${a.fbsSupplyPk} not found`, retryable: false };
    if (Number(row.workspaceId) !== ctx.workspaceId) {
      return { status: 'error', error: 'cross-workspace access denied', retryable: false };
    }
    resolvedId = row.wbSupplyId;
  }
  if (!resolvedId) return { status: 'error', error: 'wbSupplyId unresolved', retryable: false };

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };

    await closeSupply(apiKey, resolvedId);
    await db
      .update(wbFbsSupplies)
      .set({ done: true, closedAt: new Date(), updatedAt: new Date() })
      .where(eq(wbFbsSupplies.wbSupplyId, resolvedId));

    return {
      status: 'success',
      result: {
        wbSupplyId: resolvedId,
        message: `✅ FBS-поставка ${resolvedId} закрыта на отправку.`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
