/**
 * Tool `action_create_pass` — создать пропуск продавца на склад WB.
 *
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 * ⚠️ Строгий rate limit WB: 1 запрос в 10 минут на аккаунт!
 * Пропуск действует 48 часов с момента создания.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks here.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentActions, supplyPasses } from '../../db/schema.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { createPass, validatePassData } from '../../integrations/wb/passes.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionCreatePassArgs {
  firstName: string;
  lastName: string;
  carModel: string;
  carNumber: string;
  warehouseId: number;
  supplyId?: number;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionCreatePass(args: ActionCreatePassArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_create_pass must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try { await assertAgentAuth(args._userId, wsId); } catch (err: any) { return JSON.stringify({ error: err.message }); }

  const validation = validatePassData({
    firstName: args.firstName,
    lastName: args.lastName,
    carModel: args.carModel,
    carNumber: args.carNumber,
    officeId: args.warehouseId,
  });
  if (!validation.valid) {
    return JSON.stringify({ status: 'error', error: validation.error });
  }

  // Action Queue path (no ownership — creating new pass).
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'create_pass',
      toolArgs: {
        firstName: args.firstName,
        lastName: args.lastName,
        carModel: args.carModel,
        carNumber: args.carNumber,
        warehouseId: args.warehouseId,
        supplyId: args.supplyId,
      },
      rationale: args.rationale,
      turnId: args.carNumber,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Создание пропуска уже в очереди [actionId:${enq.actionId}].`
        : `✓ Создание пропуска для ${args.firstName} ${args.lastName} (${args.carModel} ${args.carNumber}) поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  let action: any = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    [action] = await db.insert(agentActions).values({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      actionType: 'create_pass',
      status: 'pending',
      payload: {
        warehouseId: args.warehouseId,
        driver: `${args.firstName} ${args.lastName}`,
        car: `${args.carModel} ${args.carNumber}`,
      },
      rationale: args.rationale,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
      decidedAt: new Date(),
    }).returning();

    const { id: wbPassId } = await createPass(apiKey, {
      firstName: args.firstName,
      lastName: args.lastName,
      carModel: args.carModel,
      carNumber: args.carNumber,
      officeId: args.warehouseId,
    });

    const validUntil = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await db.insert(supplyPasses).values({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      supplyId: args.supplyId ?? null,
      wbPassId,
      warehouseId: args.warehouseId,
      driverFirstName: args.firstName,
      driverLastName: args.lastName,
      carModel: args.carModel,
      carNumber: args.carNumber,
      validUntil,
    });

    await db.update(agentActions)
      .set({ status: 'executed', executedAt: new Date(), completedAt: new Date(), result: { wbPassId, validUntil: validUntil.toISOString() } })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      wbPassId,
      warehouseId: args.warehouseId,
      driver: `${args.firstName} ${args.lastName}`,
      car: `${args.carModel} ${args.carNumber}`,
      validUntil: validUntil.toISOString(),
      message: `Пропуск создан (ID ${wbPassId}). Действует до ${validUntil.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.`,
    });
  } catch (err: any) {
    if (action?.actionId) {
      await db.update(agentActions)
        .set({ status: 'failed' })
        .where(eq(agentActions.actionId, action.actionId))
        .catch(() => {});
    }
    return JSON.stringify({ status: 'failed', error: err.message || 'Ошибка создания пропуска' });
  }
}
