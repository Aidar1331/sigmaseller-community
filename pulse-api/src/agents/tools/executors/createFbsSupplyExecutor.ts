/**
 * `create_fbs_supply` executor — creates an FBS supply on WB marketplace and
 * adds the requested orderIds. Mirror of the inline path in actionCreateFbsSupply.ts.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbFbsSupplies, wbFbsSupplyOrders } from '../../../db/schema.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import {
  createSupply as marketplaceCreateSupply,
  addOrderToSupply,
} from '../../../integrations/wb/marketplace/client.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args {
  name?: string;
  orderIds: number[];
}
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const createFbsSupplyExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!Array.isArray(a.orderIds) || a.orderIds.length === 0) {
    return { status: 'error', error: 'orderIds required', retryable: false };
  }
  if (!ctx.shopId) {
    return { status: 'error', error: 'shopId required to avoid shop-leak', retryable: false };
  }
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };

    const supplyName = a.name ?? new Date().toISOString().slice(0, 10);
    const created = await marketplaceCreateSupply(apiKey, supplyName);
    const supplyId = (created as any).id ?? (created as any).supplyId;
    if (!supplyId) {
      return { status: 'error', error: `WB returned supply without id: ${JSON.stringify(created).slice(0, 200)}`, retryable: false };
    }

    const [mirror] = await db
      .insert(wbFbsSupplies)
      .values({
        workspaceId: ctx.workspaceId,
        shopId: ctx.shopId,
        wbSupplyId: supplyId,
        name: supplyName,
        ordersCount: 0,
      })
      .returning();

    const added: number[] = [];
    const errors: Array<{ orderId: number; error: string }> = [];
    for (const orderId of a.orderIds) {
      try {
        await addOrderToSupply(apiKey, supplyId, orderId);
        added.push(orderId);
      } catch (err) {
        errors.push({ orderId, error: String(err instanceof Error ? err.message : err) });
      }
    }

    if (added.length > 0) {
      await db
        .insert(wbFbsSupplyOrders)
        .values(added.map((orderId) => ({ fbsSupplyPk: mirror.id, wbOrderId: orderId, status: 'added' })))
        .onConflictDoNothing();
      await db
        .update(wbFbsSupplies)
        .set({ ordersCount: added.length, updatedAt: new Date() })
        .where(eq(wbFbsSupplies.id, mirror.id));
    }

    return {
      status: errors.length === 0 ? 'success' : 'success',
      result: {
        wbSupplyId: supplyId,
        fbsSupplyPk: mirror.id,
        addedCount: added.length,
        errorsCount: errors.length,
        message:
          errors.length === 0
            ? `✅ FBS-поставка ${supplyId} создана, добавлено ${added.length} заказов.`
            : `⚠️ FBS-поставка ${supplyId} создана. Добавлено ${added.length}/${a.orderIds.length}.`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
