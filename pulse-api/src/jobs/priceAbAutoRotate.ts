import { db } from '../db/client.js';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { priceAbTests, priceAbPhases, wbOrdersSalesDailyProducts, wbFunnelDailyProducts, wbCogs, wbCards } from '../db/schema.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { uploadPriceToWb } from '../routes/priceAb.js';
import { logJobs as logger } from '../lib/logger.js';

async function resolveShopId(workspaceId: number, nmId: number, testShopId: number | null | undefined): Promise<number | undefined> {
  if (testShopId) return testShopId;
  const [row] = await db.select({ shopId: wbCards.shopId }).from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId))).limit(1);
  return row?.shopId ?? undefined;
}

/**
 * Аггрегируем метрики фазы из funnel + orders_sales за интервал
 * [startedAt, endedAt|now]. Маржа считается по wb_cogs (если задан).
 */
async function aggregatePhaseMetrics(phaseId: number, testId: number, nmId: number, workspaceId: number, priceKop: number): Promise<Record<string, number>> {
  const [phase] = await db.select().from(priceAbPhases).where(eq(priceAbPhases.phaseId, phaseId)).limit(1);
  if (!phase) return {};
  const startedAt = phase.startedAt!;
  const endedAt = phase.endedAt ?? new Date();
  const exposureHours = (endedAt.getTime() - startedAt.getTime()) / 3_600_000;
  const fromDate = startedAt.toISOString().slice(0, 10);
  const toDate = endedAt.toISOString().slice(0, 10);

  const [sales] = await db.execute<any>(sql`
    SELECT
      COALESCE(SUM(orders_count), 0)::int AS orders,
      COALESCE(SUM(orders_rub), 0)::bigint AS orders_rub,
      COALESCE(SUM(sales_count), 0)::int AS buyouts,
      COALESCE(SUM(sales_rub), 0)::bigint AS buyouts_rub
    FROM wb_orders_sales_daily_products
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
      AND date >= ${fromDate} AND date <= ${toDate}
  `) as unknown as any[];
  const s = (sales as any)?.rows?.[0] ?? sales?.[0] ?? {};

  const [funnel] = await db.execute<any>(sql`
    SELECT
      COALESCE(SUM(open_card_count), 0)::int AS views,
      COALESCE(SUM(add_to_cart_count), 0)::int AS add_to_cart
    FROM wb_funnel_daily_products
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
      AND date >= ${fromDate} AND date <= ${toDate}
  `) as unknown as any[];
  const f = (funnel as any)?.rows?.[0] ?? funnel?.[0] ?? {};

  const [cogsRow] = await db.select({ cogs: wbCogs.cogsKopecks }).from(wbCogs)
    .where(and(eq(wbCogs.workspaceId, workspaceId), eq(wbCogs.nmId, nmId))).limit(1);
  const cogsKop = cogsRow?.cogs ?? null;

  const orders = Number(s.orders ?? 0);
  const ordersRub = Number(s.orders_rub ?? 0);
  const buyouts = Number(s.buyouts ?? 0);
  const views = Number(f.views ?? 0);

  // Маржа = выручка - (COGS × кол-во выкупов). Это упрощённая модель.
  const marginRub = cogsKop != null ? Number(s.buyouts_rub ?? 0) - cogsKop * buyouts : 0;

  return {
    views,
    orders,
    ordersRub,
    buyouts,
    buyoutsRub: Number(s.buyouts_rub ?? 0),
    marginRub,
    exposureHours: Math.round(exposureHours * 100) / 100,
    priceKop,
  };
}

/**
 * Главная процедура: для каждого активного теста проверяем,
 * прошло ли rotation_minutes с last_rotated_at. Если да — закрываем текущую
 * фазу, открываем следующую (по циклу), отправляем цену в WB.
 *
 * Также автозавершает тест по period_days.
 */
export async function runPriceAbAutoRotate(): Promise<void> {
  const tests = await db.select().from(priceAbTests).where(eq(priceAbTests.status, 'running'));
  if (tests.length === 0) return;

  const now = new Date();
  let rotated = 0;
  let completed = 0;

  for (const test of tests) {
    try {
      const startedAt = test.startedAt ?? test.createdAt;
      const ageDays = (now.getTime() - startedAt.getTime()) / 86_400_000;
      const lastRot = test.lastRotatedAt ?? startedAt;
      const minutesSince = (now.getTime() - lastRot.getTime()) / 60_000;

      // 1) Автозавершение по period_days
      if (ageDays >= test.periodDays) {
        // Закрываем активную фазу + сводим метрики
        const [activePhase] = await db.select().from(priceAbPhases)
          .where(and(eq(priceAbPhases.testId, test.testId), isNull(priceAbPhases.endedAt)))
          .limit(1);
        if (activePhase) {
          await db.update(priceAbPhases).set({ endedAt: now }).where(eq(priceAbPhases.phaseId, activePhase.phaseId));
          const summary = await aggregatePhaseMetrics(activePhase.phaseId, test.testId, test.nmId, test.workspaceId, activePhase.priceKop);
          await db.update(priceAbPhases).set({ metricsSummary: summary }).where(eq(priceAbPhases.phaseId, activePhase.phaseId));
        }
        await db.update(priceAbTests).set({ status: 'completed', completedAt: now, updatedAt: now })
          .where(eq(priceAbTests.testId, test.testId));
        completed++;
        continue;
      }

      // 2) Авторотация
      if (!test.autoRotate) continue;
      if (minutesSince < test.rotationMinutes) continue;

      const variants = (test.variants as Array<{ label: string; priceKop: number }>) ?? [];
      if (variants.length < 2) continue;
      const curIdx = Math.max(0, variants.findIndex((v) => v.label === test.currentVariant));
      const nextIdx = (curIdx + 1) % variants.length;
      const next = variants[nextIdx];

      // Закрываем текущую фазу и сводим метрики
      const [activePhase] = await db.select().from(priceAbPhases)
        .where(and(eq(priceAbPhases.testId, test.testId), isNull(priceAbPhases.endedAt)))
        .limit(1);
      if (activePhase) {
        await db.update(priceAbPhases).set({ endedAt: now }).where(eq(priceAbPhases.phaseId, activePhase.phaseId));
        const summary = await aggregatePhaseMetrics(activePhase.phaseId, test.testId, test.nmId, test.workspaceId, activePhase.priceKop);
        await db.update(priceAbPhases).set({ metricsSummary: summary }).where(eq(priceAbPhases.phaseId, activePhase.phaseId));
      }

      // Отправляем новую цену в WB
      const shopId = await resolveShopId(test.workspaceId, test.nmId, test.shopId);
      if (!shopId) {
        logger.error({ testId: test.testId, nmId: test.nmId }, 'cannot resolve shopId for rotation');
        continue;
      }
      let priceSynced = false;
      let syncError: string | null = null;
      try {
        const apiKey = await getWbApiKey(test.workspaceId, shopId);
        await uploadPriceToWb(apiKey, test.nmId, next.priceKop);
        priceSynced = true;
      } catch (err: any) {
        syncError = err?.message ?? String(err);
        logger.error({ err: syncError, testId: test.testId, nmId: test.nmId }, 'price upload failed during rotation');
      }

      // Целевое время — last_rotated + rotation_minutes (а не now), чтобы
      // дрифт не аккумулировался. См. комментарий в abPhotoAutoRotate.
      const target = new Date(lastRot.getTime() + test.rotationMinutes * 60_000);
      const driftMin = (now.getTime() - target.getTime()) / 60_000;
      const newLastRotated = driftMin > test.rotationMinutes ? now : target;

      await db.insert(priceAbPhases).values({
        testId: test.testId,
        variant: next.label,
        priceKop: next.priceKop,
        startedAt: newLastRotated,
        priceSynced,
        syncError,
      });

      await db.update(priceAbTests).set({
        currentVariant: next.label,
        lastRotatedAt: newLastRotated,
        lastSyncError: syncError,
        updatedAt: now,
      }).where(eq(priceAbTests.testId, test.testId));

      rotated++;
    } catch (err: any) {
      logger.error({ err: err?.message, testId: test.testId }, 'rotation iteration failed');
    }
  }

  if (rotated > 0 || completed > 0) {
    logger.info({ rotated, completed, running: tests.length }, 'price-ab auto-rotate run');
  }
}
