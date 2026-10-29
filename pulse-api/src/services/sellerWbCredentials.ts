import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { safeDecrypt } from '../lib/crypto.js';
import { currentAiWorkspace, resolveAiWorkspace } from '../lib/sellerAiContext.js';

/** Never use the operator's shop when the selected shop has no usable token. */
export async function sellerWbKey(workspaceId?: number, shopId?: number): Promise<string> {
  const scopedId = workspaceId ?? currentAiWorkspace() ?? undefined;
  if (scopedId !== undefined) resolveAiWorkspace(scopedId);
  if (shopId !== undefined && (!Number.isSafeInteger(shopId) || shopId <= 0)) throw new Error('Invalid shop');
  if (!scopedId && !shopId) throw new Error('Укажите магазин Wildberries');
  const result = await db.execute(sql`SELECT api_key FROM marketplace_shops
    WHERE platform = 'wb' AND is_active = true
    ${scopedId ? sql`AND workspace_id = ${scopedId}` : sql``}
    ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
    ORDER BY shop_id LIMIT 1`);
  const rows = (result as any).rows ?? result;
  const key = rows[0]?.api_key ? safeDecrypt(rows[0].api_key) : null;
  if (!key) throw new Error('Подключите действующий ключ выбранного магазина Wildberries');
  return key;
}
