/**
 * Cron: supply-booking-queue-processor
 *
 * Каждые 10 минут берёт записи `supply_booking_queue` со статусом 'waiting'
 * и пытается забронировать слот через `confirmSupply`, если фактический
 * коэффициент приёмки (из supplySlotsCache, обновляется `acceptanceCoeffMonitor`)
 * упал ≤ max_coefficient.
 *
 * Retry policy:
 *  - При WB-ошибке: attempts++, next_attempt_at = now() + min(60, 5*attempts) min
 *  - При 10+ неудачных попытках: status='failed' + alert юзеру
 *  - Если коэф не устраивает: next_attempt_at = now() + 15 min (ждём кеш)
 *  - Soft TTL 14 дней: status='expired' + alert
 *
 * Concurrency: атомарный `UPDATE ... SET status='processing' WHERE queueId=X
 * AND status='waiting' RETURNING` чтобы два тика не обрабатывали одну запись.
 *
 * See workspace/PLAN-SUPPLIES-E2E-AGENT-2026-05-23.md Layer B.
 */

import { and, eq, lte, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supplyBookingQueue, supplySlotsCache, marketplaceShops } from '../db/schema.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { confirmSupply } from '../integrations/wb/supplies/client.js';
import { log } from '../lib/logger.js';

const logger = log.child({ module: 'supplyBookingQueueProcessor' });

const BATCH_LIMIT = 50;
const MAX_ATTEMPTS = 10;
const SOFT_TTL_DAYS = 14;

function minutesFromNow(min: number): Date {
  return new Date(Date.now() + min * 60_000);
}

async function pickWaitingEntries(): Promise<
  Array<{
    queueId: number;
    workspaceId: number;
    preorderId: number | null;
    warehouseId: number;
    desiredDate: string;
    maxCoefficient: string | null;
    attempts: number | null;
    createdAt: Date;
  }>
> {
  // Atomically move waiting → processing for up to BATCH_LIMIT rows whose
  // next_attempt_at <= now (or null). Returning ensures no other tick will
  // touch them while we're working.
  const res = await db.execute<{
    queue_id: string | number;
    workspace_id: string | number;
    preorder_id: string | number | null;
    warehouse_id: number;
    desired_date: string;
    max_coefficient: string | null;
    attempts: number | null;
    created_at: Date;
  }>(sql`
    UPDATE supply_booking_queue
    SET status = 'processing'
    WHERE queue_id IN (
      SELECT queue_id
      FROM supply_booking_queue
      WHERE status = 'waiting'
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY created_at ASC
      LIMIT ${BATCH_LIMIT}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING queue_id, workspace_id, preorder_id, warehouse_id,
              desired_date, max_coefficient, attempts, created_at
  `);

  const rows = ((res as any).rows ?? res) as Array<Record<string, any>>;
  return rows.map((r) => ({
    queueId: Number(r.queue_id),
    workspaceId: Number(r.workspace_id),
    preorderId: r.preorder_id != null ? Number(r.preorder_id) : null,
    warehouseId: Number(r.warehouse_id),
    desiredDate: String(r.desired_date),
    maxCoefficient: r.max_coefficient != null ? String(r.max_coefficient) : null,
    attempts: r.attempts != null ? Number(r.attempts) : 0,
    createdAt: new Date(r.created_at),
  }));
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
    .limit(1);
  if (!row || row.coefficient == null) return null;
  return Number(row.coefficient);
}

async function resolveShopId(workspaceId: number): Promise<number | undefined> {
  // Если в workspace ровно один активный shop — используем его. Иначе пусть
  // getWbApiKey работает по дефолту (workspace-default ключ).
  const shops = await db
    .select({ shopId: marketplaceShops.shopId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.workspaceId, workspaceId), eq(marketplaceShops.isActive, true)))
    .limit(2);
  return shops.length === 1 ? Number(shops[0].shopId) : undefined;
}

export async function runBookingQueueProcessor(): Promise<void> {
  const start = Date.now();
  const entries = await pickWaitingEntries();
  if (entries.length === 0) {
    return;
  }

  let booked = 0;
  let stillWaiting = 0;
  let failed = 0;
  let expired = 0;

  for (const e of entries) {
    // Soft TTL check
    const ageDays = (Date.now() - e.createdAt.getTime()) / 86400_000;
    if (ageDays > SOFT_TTL_DAYS) {
      await db
        .update(supplyBookingQueue)
        .set({ status: 'expired' })
        .where(eq(supplyBookingQueue.queueId, e.queueId));
      expired += 1;
      logger.warn({ queueId: e.queueId, ageDays }, 'queue entry expired (TTL exceeded)');
      continue;
    }

    if (!e.preorderId) {
      // Legacy entry without preorderId — UI flow does its own booking,
      // leave it for the UI worker (don't process here).
      await db
        .update(supplyBookingQueue)
        .set({ status: 'waiting', nextAttemptAt: minutesFromNow(60) })
        .where(eq(supplyBookingQueue.queueId, e.queueId));
      stillWaiting += 1;
      continue;
    }

    const coefThreshold = e.maxCoefficient != null ? Number(e.maxCoefficient) : 1.0;
    const cachedCoeff = await getCachedCoefficient(e.workspaceId, e.warehouseId, e.desiredDate);

    if (cachedCoeff == null) {
      // No cache yet — acceptanceCoeffMonitor will fill it. Wait 15 min.
      await db
        .update(supplyBookingQueue)
        .set({
          status: 'waiting',
          nextAttemptAt: minutesFromNow(15),
          lastAttemptAt: new Date(),
        })
        .where(eq(supplyBookingQueue.queueId, e.queueId));
      stillWaiting += 1;
      continue;
    }

    if (cachedCoeff < 0 || cachedCoeff > coefThreshold) {
      // Coeff still too high or slot unavailable. Re-check in 15 min.
      await db
        .update(supplyBookingQueue)
        .set({
          status: 'waiting',
          nextAttemptAt: minutesFromNow(15),
          lastAttemptAt: new Date(),
        })
        .where(eq(supplyBookingQueue.queueId, e.queueId));
      stillWaiting += 1;
      continue;
    }

    // Coeff acceptable → try to book
    try {
      const shopId = await resolveShopId(e.workspaceId);
      const apiKey = await getWbApiKey(e.workspaceId, shopId);
      if (!apiKey) {
        throw new Error('WB API key not found');
      }

      const result = await confirmSupply(apiKey, e.preorderId, {
        date: e.desiredDate,
        coefficient: cachedCoeff,
      });

      await db
        .update(supplyBookingQueue)
        .set({
          status: 'booked',
          bookedAt: new Date(),
          lastAttemptAt: new Date(),
          attempts: (e.attempts ?? 0) + 1,
        })
        .where(eq(supplyBookingQueue.queueId, e.queueId));

      booked += 1;
      logger.info(
        {
          queueId: e.queueId,
          preorderId: e.preorderId,
          date: e.desiredDate,
          coefficient: cachedCoeff,
        },
        'supply slot booked automatically',
      );
    } catch (bookErr: any) {
      const newAttempts = (e.attempts ?? 0) + 1;
      const isTerminal = newAttempts >= MAX_ATTEMPTS;
      const backoffMin = Math.min(60, 5 * newAttempts);

      await db
        .update(supplyBookingQueue)
        .set({
          status: isTerminal ? 'failed' : 'waiting',
          attempts: newAttempts,
          lastAttemptAt: new Date(),
          nextAttemptAt: isTerminal ? null : minutesFromNow(backoffMin),
        })
        .where(eq(supplyBookingQueue.queueId, e.queueId));

      if (isTerminal) {
        failed += 1;
        logger.warn(
          { queueId: e.queueId, preorderId: e.preorderId, err: bookErr.message, attempts: newAttempts },
          'queue entry failed after max attempts',
        );
      } else {
        stillWaiting += 1;
      }
    }
  }

  logger.info(
    {
      total: entries.length,
      booked,
      stillWaiting,
      failed,
      expired,
      durationMs: Date.now() - start,
    },
    'booking queue tick done',
  );
}
