/**
 * `manage_discount` executor. Sets or removes seller discount on nmId via WB
 * discounts-prices-api. Re-checks ownership in wb_cards.
 */

import { sql, eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { marketplaceShops } from '../../../db/schema.js';
import { assertAgentAuth } from '../locks.js';
import { safeDecrypt } from '../../../lib/crypto.js';
import type { ActionExecutor } from '../actionQueue.js';
import { logAgent as logger } from '../../../lib/logger.js';

interface ManageDiscountArgs {
  nmId: number;
  discountPct: number;
  operation: 'set' | 'remove';
}

const WB_DISCOUNT_URL = 'https://discounts-prices-api.wildberries.ru/api/v2/upload/task';

const retryable = (msg: string): boolean => {
  const m = msg.toLowerCase();
  return /\b5\d\d\b/.test(m) || m.includes('timeout') || m.includes('econn') || m.includes('rate-limit') || m.includes('429');
};

export const manageDiscountExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as ManageDiscountArgs;
  if (!a.nmId || a.nmId <= 0) return { status: 'error', error: 'bad nmId', retryable: false };
  if (a.operation !== 'set' && a.operation !== 'remove') return { status: 'error', error: 'bad operation', retryable: false };
  if (a.operation === 'set' && (a.discountPct < 0 || a.discountPct > 100)) {
    return { status: 'error', error: 'discountPct out of [0,100]', retryable: false };
  }
  if (ctx.shopId == null) return { status: 'error', error: 'shop_id missing', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM wb_cards
    WHERE workspace_id = ${ctx.workspaceId} AND nm_id = ${a.nmId}
      AND (shop_id = ${ctx.shopId} OR shop_id IS NULL)
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return { status: 'error', error: `nmId=${a.nmId} not in workspace=${ctx.workspaceId}`, retryable: false };
  }

  // Resolve WB key for this shop (encrypted at rest).
  const [shop] = await db
    .select({ apiKey: marketplaceShops.apiKey })
    .from(marketplaceShops)
    .where(eq(marketplaceShops.shopId, ctx.shopId))
    .limit(1);
  if (!shop?.apiKey) return { status: 'error', error: 'shop api_key missing', retryable: false };
  const apiKey = safeDecrypt(shop.apiKey);
  if (!apiKey) return { status: 'error', error: 'shop api_key decrypt failed', retryable: false };

  const body = {
    data: [{ nmID: a.nmId, discount: a.operation === 'set' ? a.discountPct : 0 }],
  };

  try {
    const response = await fetch(WB_DISCOUNT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await response.text();
      const errMsg = `WB ${response.status}: ${errText.slice(0, 400)}`;
      logger.warn({ actionId: ctx.actionId, nmId: a.nmId, errMsg }, 'manage_discount: WB rejected');
      return { status: 'error', error: errMsg, retryable: response.status >= 500 || response.status === 429 };
    }
    const successMsg = a.operation === 'set'
      ? `Скидка ${a.discountPct}% установлена на товар ${a.nmId}`
      : `Скидка убрана с товара ${a.nmId}`;
    return { status: 'success', result: { nmId: a.nmId, operation: a.operation, message: `✅ ${successMsg}` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
