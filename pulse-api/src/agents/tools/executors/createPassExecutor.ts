/**
 * `create_pass` executor. WB enforces 1 request / 10 min globally on this
 * endpoint — any rate-limit reply is therefore terminal-with-retry-via-queue,
 * NOT pg-boss-quick-retry: we mark retryable so the sweeper picks up later,
 * but with a long backoff via retry_count.
 */
import { db } from '../../../db/client.js';
import { supplyPasses } from '../../../db/schema.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { createPass, validatePassData } from '../../../integrations/wb/passes.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args {
  firstName: string;
  lastName: string;
  carModel: string;
  carNumber: string;
  warehouseId: number;
  supplyId?: number;
}
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const createPassExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  const validation = validatePassData({
    firstName: a.firstName, lastName: a.lastName,
    carModel: a.carModel, carNumber: a.carNumber, officeId: a.warehouseId,
  });
  if (!validation.valid) return { status: 'error', error: validation.error ?? 'invalid pass data', retryable: false };

  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId ?? undefined);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };
    const { id: wbPassId } = await createPass(apiKey, {
      firstName: a.firstName, lastName: a.lastName,
      carModel: a.carModel, carNumber: a.carNumber, officeId: a.warehouseId,
    });
    const validUntil = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.insert(supplyPasses).values({
      workspaceId: ctx.workspaceId, shopId: ctx.shopId ?? null,
      supplyId: a.supplyId ?? null, wbPassId, warehouseId: a.warehouseId,
      driverFirstName: a.firstName, driverLastName: a.lastName,
      carModel: a.carModel, carNumber: a.carNumber, validUntil,
    });
    return {
      status: 'success',
      result: {
        wbPassId, warehouseId: a.warehouseId, validUntil: validUntil.toISOString(),
        message: `✅ Пропуск создан (ID ${wbPassId}). Действует 48 часов.`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
