/**
 * Tool: action_create_supply — Create FBO supply on WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Rev 25z.4 (2026-05-24): added optional desiredDate/maxCoefficient/packageType
 * for end-to-end booking. Tool now performs the FULL chain in one call:
 *   createSupply → setSupplyGoods → setSupplyPackage → confirmSupply (or queue)
 * See workspace/PLAN-SUPPLIES-E2E-AGENT-2026-05-23.md Layer A.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected.
 *  - Lock acquisition lives at graph level — no per-tool locks here.
 */

import { db } from '../../db/client.js';
import { agentActions, supplyBookingQueue, supplySlotsCache } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import {
  createSupply,
  setSupplyGoods,
  setSupplyPackage,
  confirmSupply,
} from '../../integrations/wb/supplies/client.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';
import { log } from '../../lib/logger.js';

const logger = log.child({ module: 'actionCreateSupply' });

interface ActionCreateSupplyArgs {
  warehouseID: number;
  deliveryType: 'box' | 'mono_pallet' | 'super_safe';
  goods: Array<{ barcode: string; quantity: number }>;
  rationale: string;
  // Rev 25z.4: optional E2E-booking parameters
  desiredDate?: string; // YYYY-MM-DD. If set, tool tries to book this slot (or queue).
  maxCoefficient?: number; // default 1.0. If actual coeff > threshold → queue, not book.
  packageType?: 'box' | 'mono_pallet'; // default = derived from deliveryType
  // Legacy param (kept for backwards compat with old prompts)
  preferredDate?: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

async function getCachedCoefficient(
  workspaceId: number,
  warehouseId: number,
  date: string,
): Promise<number | null> {
  const [row] = await db
    .select({ coefficient: supplySlotsCache.coefficient })
    .from(supplySlotsCache)
    .where(
      and(
        eq(supplySlotsCache.workspaceId, workspaceId),
        eq(supplySlotsCache.warehouseId, warehouseId),
        eq(supplySlotsCache.date, date),
      ),
    )
    .orderBy(desc(supplySlotsCache.fetchedAt))
    .limit(1);
  if (!row || row.coefficient == null) return null;
  return Number(row.coefficient);
}

export async function actionCreateSupply(args: ActionCreateSupplyArgs): Promise<string> {
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_create_supply must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    await assertAgentAuth(args._userId, wsId);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }

  const totalItems = args.goods.reduce((s, g) => s + g.quantity, 0);
  const desiredDate = args.desiredDate ?? args.preferredDate;
  const maxCoefficient = args.maxCoefficient ?? 1.0;
  const packageType =
    args.packageType ?? (args.deliveryType === 'mono_pallet' ? 'mono_pallet' : 'box');

  // ── Queue path (when ENABLE_ACTION_QUEUE=1) ────────────────────────────
  // Executor mirrors the full E2E chain below.
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      userId: args._userId ?? null,
      conversationId: null,
      actionType: 'create_supply',
      toolArgs: {
        warehouseID: args.warehouseID,
        deliveryType: args.deliveryType,
        goods: args.goods,
        desiredDate,
        maxCoefficient,
        packageType,
      },
      rationale: args.rationale,
      turnId: `${args.warehouseID}-${desiredDate ?? ''}`,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Создание поставки уже в очереди [actionId:${enq.actionId}].`
        : `✓ Создание поставки на склад ${args.warehouseID} (${args.goods.length} артикулов, ${totalItems} шт) поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  // ── Inline path ────────────────────────────────────────────────────────
  let action: any = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    [action] = await db
      .insert(agentActions)
      .values({
        workspaceId: wsId,
        shopId: args._shopId ?? null,
        actionType: 'create_supply',
        status: 'pending',
        payload: {
          warehouseID: args.warehouseID,
          deliveryType: args.deliveryType,
          goodsCount: args.goods.length,
          totalItems,
          desiredDate,
          maxCoefficient,
          packageType,
        },
        rationale: args.rationale,
        decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
        decidedAt: new Date(),
      })
      .returning();

    // Step 1+2: create preorder + attach goods
    const supplyResult = await createSupply(apiKey, {
      warehouseID: args.warehouseID,
      deliveryType: args.deliveryType,
      cargoType: 'standard',
    });
    await setSupplyGoods(apiKey, supplyResult.preorderID, args.goods);

    // Step 3: set package type (default derived from deliveryType).
    // WB ожидает массив "коробов" — для упрощения шлём один блок с totalItems.
    try {
      await setSupplyPackage(apiKey, supplyResult.preorderID, [
        { packageType, quantity: totalItems },
      ] as any);
    } catch (pkgErr: any) {
      // setSupplyPackage может потребовать более детальной разбивки по barcode/qty —
      // если упадёт, ловим ошибку и не прерываем поток (preorder создан, упаковку
      // юзер настроит позже либо queue processor попробует).
      logger.warn({ err: pkgErr.message, preorderID: supplyResult.preorderID }, 'setSupplyPackage failed (non-fatal)');
    }

    // Step 4: conditional book or queue
    let bookingStatus: 'booked' | 'queued' | 'pending' = 'pending';
    let bookedDate: string | null = null;
    let bookedCoeff: number | null = null;

    if (desiredDate) {
      const cachedCoeff = await getCachedCoefficient(wsId, args.warehouseID, desiredDate);

      // Book immediately if cached coeff is acceptable (≤ threshold AND >=0)
      if (cachedCoeff != null && cachedCoeff >= 0 && cachedCoeff <= maxCoefficient) {
        try {
          const confirmRes = await confirmSupply(apiKey, supplyResult.preorderID, {
            date: desiredDate,
            coefficient: cachedCoeff,
          });
          bookingStatus = 'booked';
          bookedDate = confirmRes.date ?? desiredDate;
          bookedCoeff = confirmRes.coefficient ?? cachedCoeff;
        } catch (bookErr: any) {
          // Booking failed — fall through to queue
          logger.warn({ err: bookErr.message, preorderID: supplyResult.preorderID }, 'confirmSupply failed → queue');
          await db.insert(supplyBookingQueue).values({
            workspaceId: wsId,
            preorderId: supplyResult.preorderID,
            warehouseId: args.warehouseID,
            desiredDate,
            maxCoefficient: String(maxCoefficient),
            status: 'waiting',
          });
          bookingStatus = 'queued';
        }
      } else {
        // No cache OR coeff too high → queue for cron retry
        await db.insert(supplyBookingQueue).values({
          workspaceId: wsId,
          preorderId: supplyResult.preorderID,
          warehouseId: args.warehouseID,
          desiredDate,
          maxCoefficient: String(maxCoefficient),
          status: 'waiting',
        });
        bookingStatus = 'queued';
      }
    }

    await db
      .update(agentActions)
      .set({
        status: 'executed',
        executedAt: new Date(),
        completedAt: new Date(),
        result: {
          preorderID: supplyResult.preorderID,
          bookingStatus,
          bookedDate,
          bookedCoeff,
        },
      })
      .where(eq(agentActions.actionId, action.actionId));

    const message =
      bookingStatus === 'booked'
        ? `✅ Поставка создана и забронирована: preorder ${supplyResult.preorderID}, дата ${bookedDate}, коэф ${bookedCoeff}×.`
        : bookingStatus === 'queued'
        ? `📋 Поставка создана (preorder ${supplyResult.preorderID}). Слот на ${desiredDate} занят или коэф > ${maxCoefficient}× — поставлено в очередь авто-бронирования. Уведомим когда забронируем.`
        : `Поставка создана (preorder ${supplyResult.preorderID}): ${args.goods.length} артикулов, ${totalItems} шт. Выбери дату через action_book_supply_slot или поставь в очередь автоброни.`;

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      preorderID: supplyResult.preorderID,
      bookingStatus,
      bookedDate,
      bookedCoeff,
      message,
    });
  } catch (err: any) {
    if (action?.actionId) {
      await db
        .update(agentActions)
        .set({ status: 'failed' })
        .where(eq(agentActions.actionId, action.actionId))
        .catch(() => {});
    }
    return JSON.stringify({ status: 'failed', error: err.message || 'Ошибка создания поставки' });
  }
}
