/**
 * F-13: Acceptance Coefficient Monitor («Ловец приёмки WB»).
 *
 * Берёт текущие коэффициенты приёмки только для тех складов, по которым у
 * пользователя есть РЕАЛЬНАЯ активная задача — запись в supply_booking_queue
 * со статусом waiting/processing (юзер хочет отгрузить поставку и ждёт слот).
 * Сравнивает с кешем, шлёт алёрт когда коэффициент упал до порога или ниже.
 *
 * Cost-cap 2026-06-18: ВБ берёт деньги за каждый запрос. Поэтому Ловец НЕ
 * дёргает WB вхолостую — без активной задачи в очереди бронирования он
 * выходит сразу (одним дешёвым SELECT), не делая ни одного WB-вызова. Когда
 * задача есть — крутится каждые 15 мин, чтобы поймать слот почти в реал-тайме.
 *
 * Building blocks:
 *   - supplyBookingQueue          — активные задачи пользователя (gate)
 *   - getAcceptanceCoefficients() — integrations/wb/tariffs.ts
 *   - supplySlotsCache            — история по (ws, warehouse, date); из него
 *                                   читает supplyBookingQueueProcessor
 *   - notifyAcceptanceCoeff()     — отправка алёрта
 *
 * Cron pattern: каждые 15 мин (5/20/35/50), но WB-вызовы только при задаче.
 */
import { db } from '../db/client.js';
import { supplyBookingQueue, supplySlotsCache, supplyBoxSettings, marketplaceShops } from '../db/schema.js';
import { eq, and, desc, isNull, inArray } from 'drizzle-orm';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { getAcceptanceCoefficients } from '../integrations/wb/tariffs.js';
import { notifyAcceptanceCoeff } from '../services/notifications/telegram.js';
import { logJobs as logger } from '../lib/logger.js';

// F-13 v2 (0131): per-workspace threshold берётся из supply_box_settings
// (row с nm_id IS NULL — общий ws-default). Если настройки нет — fallback на 1.0.
const DEFAULT_ALERT_THRESHOLD = 1;

async function loadPerWorkspaceThresholds(): Promise<Map<number, number>> {
  const rows = await db
    .select({
      workspaceId: supplyBoxSettings.workspaceId,
      threshold: supplyBoxSettings.alertCoeffThreshold,
    })
    .from(supplyBoxSettings)
    .where(isNull(supplyBoxSettings.nmId));
  const map = new Map<number, number>();
  for (const r of rows) {
    if (r.threshold != null) map.set(Number(r.workspaceId), Number(r.threshold));
  }
  return map;
}

/**
 * Активные задачи пользователя: записи очереди бронирования, по которым юзер
 * реально ждёт слот. Возвращаем set складов на каждый workspace. Пустая мапа =
 * нет ни одной реальной задачи → Ловцу нечего делать, WB не дёргаем.
 */
async function loadActiveHuntWarehouses(): Promise<Map<number, Set<number>>> {
  const rows = await db
    .select({
      workspaceId: supplyBookingQueue.workspaceId,
      warehouseId: supplyBookingQueue.warehouseId,
    })
    .from(supplyBookingQueue)
    .where(inArray(supplyBookingQueue.status, ['waiting', 'processing']));
  const map = new Map<number, Set<number>>();
  for (const r of rows) {
    const ws = Number(r.workspaceId);
    let set = map.get(ws);
    if (!set) {
      set = new Set<number>();
      map.set(ws, set);
    }
    set.add(Number(r.warehouseId));
  }
  return map;
}

/**
 * Очередь бронирования не хранит shopId. Берём тот же ключ, что использует
 * supplyBookingQueueProcessor при самом бронировании: единственный активный
 * shop workspace, иначе workspace-default ключ. Так кеш заполняется тем же
 * ключом, которым задача потом будет бронироваться.
 */
async function resolveShopId(workspaceId: number): Promise<number | undefined> {
  const shops = await db
    .select({ shopId: marketplaceShops.shopId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.workspaceId, workspaceId), eq(marketplaceShops.isActive, true)))
    .limit(2);
  return shops.length === 1 ? Number(shops[0].shopId) : undefined;
}

export async function runAcceptanceCoeffMonitor(): Promise<void> {
  const t0 = Date.now();

  // Gate: без реальной задачи (waiting/processing в очереди бронирования)
  // Ловец вообще не работает — ни одного WB-вызова.
  const activeByWs = await loadActiveHuntWarehouses();
  if (activeByWs.size === 0) {
    logger.info('no active hunt tasks in booking queue — skip (no WB calls)');
    return;
  }

  logger.info({ workspaces: activeByWs.size }, 'starting acceptance coefficient monitor for active tasks');

  // Per-ws thresholds (F-13 v2 / 0131).
  const thresholds = await loadPerWorkspaceThresholds();

  // Группа = workspace с активными задачами. shopId резолвим как процессор.
  const groups = new Map<number, { workspaceId: number; shopId: number | null; warehouseIds: number[] }>();
  for (const [workspaceId, whSet] of activeByWs) {
    const shopId = (await resolveShopId(workspaceId)) ?? null;
    groups.set(workspaceId, { workspaceId, shopId, warehouseIds: [...whSet] });
  }

  let alertsFired = 0;
  let updates = 0;
  let groupsProcessed = 0;
  let groupsSkipped = 0;

  for (const [, group] of groups) {
    try {
      const apiKey = await getWbApiKey(group.workspaceId, group.shopId ?? undefined);
      if (!apiKey) {
        logger.warn({ ws: group.workspaceId, shop: group.shopId }, 'no API key for group — skip');
        groupsSkipped++;
        continue;
      }

      const warehouseIDs = group.warehouseIds;
      const rows = await getAcceptanceCoefficients(apiKey, warehouseIDs);

      const interestedSet = new Set(warehouseIDs);
      const relevant = rows.filter((r) => interestedSet.has(r.warehouseID));

      for (const row of relevant) {
        // Lookup previous coefficient for (workspace, warehouse, date).
        const [prev] = await db
          .select({ coefficient: supplySlotsCache.coefficient, fetchedAt: supplySlotsCache.fetchedAt })
          .from(supplySlotsCache)
          .where(and(
            eq(supplySlotsCache.workspaceId, group.workspaceId),
            eq(supplySlotsCache.warehouseId, row.warehouseID),
            eq(supplySlotsCache.date, row.date),
          ))
          .orderBy(desc(supplySlotsCache.fetchedAt))
          .limit(1);

        const prevCoeff = prev?.coefficient != null ? Number(prev.coefficient) : null;
        const newCoeff = Number(row.coefficient);
        const wsThreshold = thresholds.get(group.workspaceId) ?? DEFAULT_ALERT_THRESHOLD;

        // Alert: новый коэффициент ≤ порога И (предыдущего не было ИЛИ был выше порога).
        // Иначе спамили бы каждый час пока коэф остаётся низким.
        const crossedDown =
          newCoeff <= wsThreshold &&
          newCoeff >= 0 &&                       // -1 = недоступно, не алёртим
          (prevCoeff == null || prevCoeff > wsThreshold);

        if (crossedDown) {
          try {
            await notifyAcceptanceCoeff(
              group.workspaceId,
              row.warehouseName,
              prevCoeff ?? -999, // -999 = «не было предыдущего значения»
              newCoeff,
            );
            alertsFired++;
            logger.info(
              { ws: group.workspaceId, warehouse: row.warehouseName, date: row.date, prev: prevCoeff, now: newCoeff },
              'acceptance coeff alert fired',
            );
          } catch (notifyErr) {
            logger.warn({ err: (notifyErr as Error).message, ws: group.workspaceId, warehouse: row.warehouseName }, 'notify failed');
          }
        }

        // UPSERT кеш.
        await db.insert(supplySlotsCache).values({
          workspaceId: group.workspaceId,
          warehouseId: row.warehouseID,
          date: row.date,
          coefficient: String(newCoeff),
          available: row.allowUnload !== false,
        }).onConflictDoUpdate({
          target: [supplySlotsCache.workspaceId, supplySlotsCache.warehouseId, supplySlotsCache.date],
          set: {
            coefficient: String(newCoeff),
            available: row.allowUnload !== false,
            fetchedAt: new Date(),
          },
        });
        updates++;
      }
      groupsProcessed++;
    } catch (err: any) {
      logger.warn(
        { err: err?.message, ws: group.workspaceId, shop: group.shopId },
        'acceptance coeff fetch failed for group',
      );
      groupsSkipped++;
    }
  }

  const elapsed = Date.now() - t0;
  logger.info(
    { elapsedMs: elapsed, groupsProcessed, groupsSkipped, alertsFired, updates },
    'acceptance coefficient monitor done',
  );
}
