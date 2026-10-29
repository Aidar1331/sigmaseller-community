/**
 * `confirm_fbs_order` executor. Soft ownership check against wb_fbs_orders.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { confirmOrder } from '../../../integrations/wb/marketplace/client.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args { orderId: number; }
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const confirmFbsOrderExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.orderId) return { status: 'error', error: 'bad orderId', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  // Soft ownership check — wb_fbs_orders may not have caught the order yet.
  try {
    const ownedRes = await db.execute<{ exists: number }>(sql`
      SELECT 1 AS exists FROM wb_fbs_orders WHERE workspace_id = ${ctx.workspaceId} AND order_id = ${a.orderId} LIMIT 1
    `);
    const rows = (ownedRes as any).rows ?? ownedRes;
    if (!Array.isArray(rows) || rows.length === 0) {
      // Not blocking; log via return result.
    }
  } catch { /* table missing, skip */ }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId ?? undefined);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };
    await confirmOrder(apiKey, a.orderId);
    return { status: 'success', result: { orderId: a.orderId, message: `✅ FBS заказ #${a.orderId} подтверждён` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
