/**
 * `create_supply` executor. No ownership (creating new). Calls createSupply +
 * setSupplyGoods sequentially; second failure leaves orphan preorder on WB
 * (caller must handle that via UI).
 */
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { createSupply, setSupplyGoods } from '../../../integrations/wb/supplies/client.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args {
  warehouseID: number;
  deliveryType: 'box' | 'mono_pallet' | 'super_safe';
  goods: Array<{ barcode: string; quantity: number }>;
  preferredDate?: string;
}
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const createSupplyExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.warehouseID || !Array.isArray(a.goods) || a.goods.length === 0) {
    return { status: 'error', error: 'bad args', retryable: false };
  }
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId ?? undefined);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };
    const supplyResult = await createSupply(apiKey, {
      warehouseID: a.warehouseID,
      deliveryType: a.deliveryType,
      cargoType: 'standard',
    });
    await setSupplyGoods(apiKey, supplyResult.preorderID, a.goods);
    const total = a.goods.reduce((s, g) => s + g.quantity, 0);
    return {
      status: 'success',
      result: {
        preorderID: supplyResult.preorderID,
        message: `✅ Поставка создана (preorder ${supplyResult.preorderID}): ${a.goods.length} артикулов, ${total} шт.`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
