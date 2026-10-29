import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { abPhotoTests, abPhotoPhases, abPhotoMetrics, wbOrdersSalesDailyProducts, wbAdvDailyProducts, wbFunnelDailyProducts, wbCards } from '../db/schema.js';

/**
 * Если у теста shopId не задан (legacy-тесты до того как поле появилось),
 * пробуем определить владельца артикула через wb_cards. Это спасает auto-rotate
 * от 403 — иначе getWbApiKey возьмёт первый попавшийся магазин workspace, и
 * WB ответит «доступ к артикулу запрещён». Найдено 2026-05-31 на тесте #2
 * у operator (3 магазина, тест без shop_id, артикул в одном из них).
 */
async function resolveShopIdForCard(workspaceId: number, nmId: number, testShopId: number | null | undefined): Promise<number | undefined> {
  if (testShopId) return testShopId;
  const [row] = await db
    .select({ shopId: wbCards.shopId })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);
  return row?.shopId ?? undefined;
}
import { computeStatsByVariants, pickWinner, type VariantLabel } from '../services/abPhoto.js';

/**
 * Returns the canonical variant list for a test row, falling back to the
 * legacy {variantA, variantB} pair when the new `variants` column is empty.
 * Mirrors the helper in routes/abPhoto.ts — duplicated here to avoid a
 * circular import.
 */
function resolveTestVariants(test: { variants?: any; variantA?: any; variantB?: any }): Array<{ label: VariantLabel; photos: string[] }> {
  const v = test?.variants;
  if (Array.isArray(v) && v.length > 0) {
    return v.map((x: any) => ({
      label: (x?.label as VariantLabel) ?? 'A',
      photos: Array.isArray(x?.photos) ? x.photos.map((p: any) => String(p)).filter(Boolean) : [],
    }));
  }
  return [
    { label: 'A', photos: Array.isArray(test?.variantA?.photos) ? test.variantA.photos.map((p: any) => String(p)).filter(Boolean) : [] },
    { label: 'B', photos: Array.isArray(test?.variantB?.photos) ? test.variantB.photos.map((p: any) => String(p)).filter(Boolean) : [] },
  ];
}
import { isWbMediaSyncEnabled, updateWbCardSlot } from '../integrations/wb/media.js';
import { logJobs as logger } from '../lib/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Config = {
  enabled: boolean;
  intervalMinutes: number;
  minRotationMinutes: number;
};

export function getAbPhotoAutoRotateConfig(): Config {
  const enabled = (process.env.ENABLE_AB_PHOTO_AUTOROTATE ?? '') === '1';
  const intervalMinutes = Number.parseInt(process.env.AB_PHOTO_AUTOROTATE_INTERVAL_MINUTES || '10', 10); // check every 10 min
  const minRotationMinutes = Number.parseInt(process.env.AB_PHOTO_MIN_ROTATION_MINUTES || '20', 10);
  return { enabled, intervalMinutes, minRotationMinutes };
}

function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / (60 * 1000);
}

function getVariantPhotos(test: { variantA: any; variantB: any }, variant: 'A' | 'B'): string[] {
  const src = variant === 'B' ? test.variantB : test.variantA;
  if (!src || !Array.isArray(src.photos)) return [];
  return src.photos.map((x: any) => String(x)).filter(Boolean);
}

/**
 * Collect metrics for AB photo test from various sources
 */
async function collectMetricsForPhase(
  workspaceId: number,
  nmId: number,
  testId: number,
  phaseId: number,
  variant: string,
  startDate: string,
  endDate: string
): Promise<void> {
  // Collect orders/sales data
  const ordersData = await db
    .select({
      date: wbOrdersSalesDailyProducts.date,
      ordersCount: wbOrdersSalesDailyProducts.ordersCount,
      ordersRub: wbOrdersSalesDailyProducts.ordersRub,
      salesCount: wbOrdersSalesDailyProducts.salesCount,
      salesRub: wbOrdersSalesDailyProducts.salesRub,
    })
    .from(wbOrdersSalesDailyProducts)
    .where(
      and(
        eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
        eq(wbOrdersSalesDailyProducts.nmId, nmId),
        gte(wbOrdersSalesDailyProducts.date, startDate),
        lte(wbOrdersSalesDailyProducts.date, endDate)
      )
    );

  // Collect ad data
  const adsData = await db
    .select({
      date: wbAdvDailyProducts.date,
      views: wbAdvDailyProducts.viewsCount,
      clicks: wbAdvDailyProducts.clicksCount,
      orders: wbAdvDailyProducts.ordersCount,
      spend: wbAdvDailyProducts.spendKopecks,
      sumPrice: wbAdvDailyProducts.sumPriceKopecks,
    })
    .from(wbAdvDailyProducts)
    .where(
      and(
        eq(wbAdvDailyProducts.workspaceId, workspaceId),
        eq(wbAdvDailyProducts.nmId, nmId),
        gte(wbAdvDailyProducts.date, startDate),
        lte(wbAdvDailyProducts.date, endDate)
      )
    );

  // Collect funnel data (views, opens)
  const funnelData = await db
    .select({
      date: wbFunnelDailyProducts.date,
      views: wbFunnelDailyProducts.viewCount,
      opens: wbFunnelDailyProducts.openCardCount,
      addToCart: wbFunnelDailyProducts.addToCartCount,
    })
    .from(wbFunnelDailyProducts)
    .where(
      and(
        eq(wbFunnelDailyProducts.workspaceId, workspaceId),
        eq(wbFunnelDailyProducts.nmId, nmId),
        gte(wbFunnelDailyProducts.date, startDate),
        lte(wbFunnelDailyProducts.date, endDate)
      )
    );

  // Merge data by date
  const dateMap = new Map<string, any>();
  
  for (const row of ordersData) {
    dateMap.set(row.date, {
      ...dateMap.get(row.date),
      orders: row.ordersCount,
      ordersRub: row.ordersRub,
      buyouts: row.salesCount,
      buyoutsRub: row.salesRub,
    });
  }

  for (const row of adsData) {
    dateMap.set(row.date, {
      ...dateMap.get(row.date),
      adViews: row.views,
      adClicks: row.clicks,
      adOrders: row.orders,
      adSpend: row.spend,
      adOrdersRub: row.sumPrice,
    });
  }

  for (const row of funnelData) {
    dateMap.set(row.date, {
      ...dateMap.get(row.date),
      views: row.views,
      opens: row.opens,
      addToCart: row.addToCart,
    });
  }

  // Upsert metrics
  for (const [date, data] of dateMap) {
    // Защита от NaN: если по дате funnelData есть (views > 0), но ordersData
    // на этот день отсутствует — `data.orders` будет undefined, и
    // `undefined / N` даёт NaN, ломающий INSERT integer column.
    // Поэтому коэрсим все участвующие числа в Number с fallback 0.
    const adViews = Number(data.adViews ?? 0);
    const adClicks = Number(data.adClicks ?? 0);
    const views = Number(data.views ?? 0);
    const orders = Number(data.orders ?? 0);
    const ctrBp = adViews > 0 ? Math.round((adClicks / adViews) * 10000) : 0;
    const conversionBp = views > 0 ? Math.round((orders / views) * 10000) : 0;

    // Фикс 2026-06-08: hour=0 вместо null. Уникальный индекс ON CONFLICT
    // в Postgres не срабатывает на NULL-полях (NULL ≠ NULL), из-за чего
    // каждая фаза (~20 минут) создавала НОВУЮ строку с дневным заказом —
    // итог = orders_day × N_фаз_варианта_за_день. При hour=0 ON CONFLICT
    // работает корректно и одна запись на (test, variant, date) обновляется.
    // phaseId перезаписывается на последний — это ОК, в metrics_summary
    // фазы он не используется (aggregate по test_id+variant+date).
    await db
      .insert(abPhotoMetrics)
      .values({
        testId,
        phaseId,
        variant,
        date,
        hour: 0,
        views: data.views ?? 0,
        opens: data.opens ?? 0,
        addToCart: data.addToCart ?? 0,
        orders: data.orders ?? 0,
        ordersRub: data.ordersRub ?? 0,
        buyouts: data.buyouts ?? 0,
        buyoutsRub: data.buyoutsRub ?? 0,
        adViews: data.adViews ?? 0,
        adClicks: data.adClicks ?? 0,
        adOrders: data.adOrders ?? 0,
        adOrdersRub: data.adOrdersRub ?? 0,
        adSpend: data.adSpend ?? 0,
        ctrBp,
        conversionBp,
      } as any)
      .onConflictDoUpdate({
        target: [abPhotoMetrics.testId, abPhotoMetrics.variant, abPhotoMetrics.date, abPhotoMetrics.hour],
        set: {
          phaseId,
          views: data.views ?? 0,
          opens: data.opens ?? 0,
          addToCart: data.addToCart ?? 0,
          orders: data.orders ?? 0,
          ordersRub: data.ordersRub ?? 0,
          buyouts: data.buyouts ?? 0,
          buyoutsRub: data.buyoutsRub ?? 0,
          adViews: data.adViews ?? 0,
          adClicks: data.adClicks ?? 0,
          adOrders: data.adOrders ?? 0,
          adOrdersRub: data.adOrdersRub ?? 0,
          adSpend: data.adSpend ?? 0,
          ctrBp,
          conversionBp,
        } as any,
      });
  }

  // Агрегируем все per-day метрики этой фазы в phases.metrics_summary,
  // чтобы UI/AI агенту видел сводку фазы одной строкой без джойнов.
  await aggregatePhaseMetrics(phaseId);
}

/**
 * Считаем agg по `ab_photo_metrics` за фазу и пишем в phases.metrics_summary.
 * Источник истины для просмотров/корзин/заказов — funnel; для выкупов и руб —
 * orders_sales (тот же расклад что в /finance и в AI-чате).
 */
export async function aggregatePhaseMetrics(phaseId: number): Promise<void> {
  // Время экспозиции фазы (= сколько часов фото было на карточке WB).
  // Нужно для нормализации: если A был активен 14 дней, а B — полдня,
  // абсолютные просмотры A будут в 26× больше — это не «лучшая картинка»,
  // это разное время. Перевод orders/views в per-hour делает сравнение честным.
  const phase: any = await db.execute(sql`
    SELECT started_at, COALESCE(ended_at, now()) AS ended_at
      FROM ab_photo_phases WHERE phase_id = ${phaseId}
  `);
  const pr = ((phase.rows ?? phase) as any[])[0] ?? {};
  const startedMs = pr.started_at ? new Date(pr.started_at).getTime() : null;
  const endedMs = pr.ended_at ? new Date(pr.ended_at).getTime() : null;
  const exposureHours = startedMs && endedMs && endedMs > startedMs
    ? (endedMs - startedMs) / (1000 * 60 * 60)
    : 0;

  const agg: any = await db.execute(sql`
    SELECT
      COALESCE(SUM(views), 0)         AS views,
      COALESCE(SUM(opens), 0)         AS opens,
      COALESCE(SUM(add_to_cart), 0)   AS add_to_cart,
      COALESCE(SUM(orders), 0)        AS orders,
      COALESCE(SUM(orders_rub), 0)    AS orders_rub,
      COALESCE(SUM(buyouts), 0)       AS buyouts,
      COALESCE(SUM(buyouts_rub), 0)   AS buyouts_rub,
      COALESCE(SUM(ad_views), 0)      AS ad_views,
      COALESCE(SUM(ad_clicks), 0)     AS ad_clicks,
      COALESCE(SUM(ad_orders), 0)     AS ad_orders,
      COALESCE(SUM(ad_spend), 0)      AS ad_spend,
      COUNT(*)                         AS days
    FROM ab_photo_metrics
    WHERE phase_id = ${phaseId}
  `);
  const r = ((agg.rows ?? agg) as any[])[0] ?? {};
  const views = Number(r.views ?? 0);
  const orders = Number(r.orders ?? 0);
  const buyouts = Number(r.buyouts ?? 0);
  const ordersRub = Number(r.orders_rub ?? 0);

  const summary = {
    views,
    opens:        Number(r.opens ?? 0),
    addToCart:    Number(r.add_to_cart ?? 0),
    orders,
    ordersRub,
    buyouts,
    buyoutsRub:   Number(r.buyouts_rub ?? 0),
    adViews:      Number(r.ad_views ?? 0),
    adClicks:     Number(r.ad_clicks ?? 0),
    adOrders:     Number(r.ad_orders ?? 0),
    adSpend:      Number(r.ad_spend ?? 0),
    days:         Number(r.days ?? 0),
    exposureHours: Math.round(exposureHours * 100) / 100,
    // Коэффициенты (относительные — не зависят от длительности фазы)
    ctr:          Number(r.ad_views ?? 0) > 0 ? Number(r.ad_clicks) / Number(r.ad_views) : 0,
    conversion:   views > 0 ? orders / views : 0,
    buyoutRate:   orders > 0 ? buyouts / orders : 0,
    // Per-hour нормализация (для честного сравнения)
    viewsPerHour:    exposureHours > 0 ? views / exposureHours : 0,
    ordersPerHour:   exposureHours > 0 ? orders / exposureHours : 0,
    revenuePerHour:  exposureHours > 0 ? ordersRub / exposureHours : 0,
  };
  await db
    .update(abPhotoPhases)
    .set({ metricsSummary: summary as any })
    .where(eq(abPhotoPhases.phaseId, phaseId));
}

export async function maybeRunAbPhotoAutoRotate(reason: string): Promise<{ ran: boolean; rotated: number; completed: number }> {
  const cfg = getAbPhotoAutoRotateConfig();
  if (!cfg.enabled) return { ran: false, rotated: 0, completed: 0 };

  const now = new Date();

  // Get all running tests with autoRotate enabled
  const tests = await db
    .select({
      testId: abPhotoTests.testId,
      workspaceId: abPhotoTests.workspaceId,
      shopId: abPhotoTests.shopId,
      nmId: abPhotoTests.nmId,
      periodDays: abPhotoTests.periodDays,
      rotationMinutes: abPhotoTests.rotationMinutes,
      goal: abPhotoTests.goal,
      autoRotate: abPhotoTests.autoRotate,
      currentVariant: abPhotoTests.currentVariant,
      lastRotatedAt: abPhotoTests.lastRotatedAt,
      variantA: abPhotoTests.variantA,
      variantB: abPhotoTests.variantB,
      variants: abPhotoTests.variants,
      startedAt: abPhotoTests.startedAt,
    })
    .from(abPhotoTests)
    .where(
      and(
        eq(abPhotoTests.status, 'running'),
        eq(abPhotoTests.autoRotate, true)
      )
    );

  let rotated = 0;
  let completed = 0;

  for (const test of tests) {
    const rotationMinutes = test.rotationMinutes ?? (test.periodDays * 24 * 60);
    const lastRotated = test.lastRotatedAt ? new Date(test.lastRotatedAt) : new Date(test.startedAt);
    const minutesSinceRotation = minutesBetween(lastRotated, now);

    // Check if it's time to rotate
    if (minutesSinceRotation < rotationMinutes) continue;

    // Get current phase
    const [currentPhase] = await db
      .select()
      .from(abPhotoPhases)
      .where(eq(abPhotoPhases.testId, test.testId))
      .orderBy(desc(abPhotoPhases.startedAt))
      .limit(1);

    if (!currentPhase) {
      // No phase yet, create first one
      await db.insert(abPhotoPhases).values({
        testId: test.testId,
        variant: 'A',
        startedAt: now,
      });
      await db
        .update(abPhotoTests)
        .set({ startedAt: now, lastRotatedAt: now, currentVariant: 'A', updatedAt: now } as any)
        .where(eq(abPhotoTests.testId, test.testId));
      continue;
    }

    // End current phase
    await db
      .update(abPhotoPhases)
      .set({ endedAt: now })
      .where(eq(abPhotoPhases.phaseId, currentPhase.phaseId));

    // Collect metrics for ended phase
    const phaseStart = new Date(currentPhase.startedAt).toISOString().slice(0, 10);
    const phaseEnd = now.toISOString().slice(0, 10);
    
    try {
      await collectMetricsForPhase(
        test.workspaceId,
        test.nmId,
        test.testId,
        currentPhase.phaseId,
        currentPhase.variant,
        phaseStart,
        phaseEnd
      );
    } catch (e) {
      logger.error({ err: e, testId: test.testId }, 'Failed to collect metrics for test');
    }

    // Decision: завершить тест если прошло >= periodDays дней с момента старта.
    // Раньше использовался `allHaveTwoCycles` (закрыть после 2 циклов A→B→A→B),
    // что давало 4 фазы вместо ≈periodDays*24*60/rotationMinutes. Это
    // приводило к перекосу: первая ротация могла залипнуть на десятки часов,
    // и тест закрывался уже с одной «гигантской» фазой у каждого варианта
    // вместо равномерных коротких чередований. оператор поймал 2026-06-02 на
    // test #1: A=345h vs B=13h при rotationMinutes=20 и periodDays=7.
    const variants = resolveTestVariants(test);
    const labels = variants.map((v) => v.label);
    const periodMs = (test.periodDays ?? 7) * 24 * 60 * 60 * 1000;
    const elapsedMs = now.getTime() - new Date(test.startedAt).getTime();
    const periodElapsed = elapsedMs >= periodMs;

    if (periodElapsed) {
      const allPhases = await db
        .select({ variant: abPhotoPhases.variant, startedAt: abPhotoPhases.startedAt, endedAt: abPhotoPhases.endedAt })
        .from(abPhotoPhases)
        .where(eq(abPhotoPhases.testId, test.testId));

      const statsByVariant = await computeStatsByVariants(test.workspaceId, test.nmId, allPhases, labels);
      const winner = pickWinner(test.goal, statsByVariant);

      if (winner && isWbMediaSyncEnabled()) {
        const urls = variants.find((v) => v.label === winner)?.photos ?? [];
        const origPhotos = (test as any).originalPhotos as string[] | null;
        const slot = ((test as any).testPhotoSlot as number | null) ?? 0;
        if (urls.length && origPhotos && origPhotos.length > 0) {
          const resolvedShopId = await resolveShopIdForCard(test.workspaceId, test.nmId, test.shopId);
          await updateWbCardSlot(test.workspaceId, test.nmId, slot, urls[0], origPhotos, resolvedShopId);
        }
      }

      await db
        .update(abPhotoTests)
        .set({
          status: 'completed',
          winnerVariant: winner,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(abPhotoTests.testId, test.testId));

      completed += 1;
      continue;
    }

    // Switch to next variant in round-robin order through the declared list.
    const curIdx = labels.indexOf(currentPhase.variant as VariantLabel);
    const nextVariant = labels[(curIdx + 1 + labels.length) % labels.length];

    // Целевое время следующей ротации (last + rotation_minutes), а не «now».
    // Иначе при cron-задержке (например 1-минутный cron + 20-минутная фаза в
    // лучшем случае даёт 20:30, а в худшем 21:00) дрифт аккумулируется и фазы
    // плывут на минуты вперёд. С target-времени фактическая длина = ровно
    // rotation_minutes, а cron влияет только на момент СРАБАТЫВАНИЯ записи.
    // Если фаза опоздала больше чем на 2× rotation_minutes — считаем что
    // система спала (deploy/перезапуск) и стартуем фазу от now.
    const target = new Date(lastRotated.getTime() + rotationMinutes * 60_000);
    const driftMin = (now.getTime() - target.getTime()) / 60_000;
    const newLastRotated = driftMin > rotationMinutes ? now : target;

    await db.insert(abPhotoPhases).values({
      testId: test.testId,
      variant: nextVariant,
      startedAt: newLastRotated,
    });

    await db
      .update(abPhotoTests)
      .set({
        currentVariant: nextVariant,
        lastRotatedAt: newLastRotated,
        updatedAt: now,
      } as any)
      .where(eq(abPhotoTests.testId, test.testId));

    // Sync photos to WB. ВАЖНО: передаём shop_id теста — иначе getWbApiKey
    // возьмёт первый попавшийся магазин workspace, и WB вернёт 403 потому что
    // токен «не того» магазина не видит артикул. Найдено 2026-05-31: у operator
    // 3 магазина в workspace, тесты создавались на «ИП Test», а WB-вызов
    // подбирал токен случайного.
    if (isWbMediaSyncEnabled()) {
      const urls = variants.find((v) => v.label === nextVariant)?.photos ?? [];
      const origPhotos = (test as any).originalPhotos as string[] | null;
      const slot = ((test as any).testPhotoSlot as number | null) ?? 0;
      if (urls.length && origPhotos && origPhotos.length > 0) {
        try {
          const resolvedShopId = await resolveShopIdForCard(test.workspaceId, test.nmId, test.shopId);
          await updateWbCardSlot(test.workspaceId, test.nmId, slot, urls[0], origPhotos, resolvedShopId);
          // Успех — снимаем прошлую ошибку, если была.
          await db
            .update(abPhotoTests)
            .set({ lastSyncError: null, lastSyncErrorAt: null } as any)
            .where(eq(abPhotoTests.testId, test.testId));
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          logger.error({ err: e, testId: test.testId }, 'Failed to sync photos for test');
          await db
            .update(abPhotoTests)
            .set({ lastSyncError: msg.slice(0, 500), lastSyncErrorAt: now } as any)
            .where(eq(abPhotoTests.testId, test.testId));
        }
      } else if (urls.length && (!origPhotos || origPhotos.length === 0)) {
        // Нет snapshot — НЕ отправляем в WB, иначе он сотрёт остальные фото.
        const msg = 'Original photos snapshot missing — refusing to rotate to avoid wiping non-test slots';
        logger.warn({ testId: test.testId }, msg);
        await db
          .update(abPhotoTests)
          .set({ lastSyncError: msg, lastSyncErrorAt: now } as any)
          .where(eq(abPhotoTests.testId, test.testId));
      }
    }

    rotated += 1;
  }

  logger.info({ reason, rotated, completed, running: tests.length }, 'AB photo auto-rotate run');
  return { ran: true, rotated, completed };
}

export function startAbPhotoAutoRotateLoop(): void {
  const cfg = getAbPhotoAutoRotateConfig();
  if (!cfg.enabled) return;

  const initialDelayMs = 30_000;
  const intervalMs = cfg.intervalMinutes * 60_000;

  logger.info({ intervalMinutes: cfg.intervalMinutes, minRotationMinutes: cfg.minRotationMinutes }, 'AB photo auto-rotate enabled');

  setTimeout(() => {
    maybeRunAbPhotoAutoRotate('boot').catch((e) => {
      logger.error({ err: e }, 'Boot run failed');
    });
  }, initialDelayMs);

  const jitterMs = Math.floor(Math.random() * 10_000);
  setTimeout(() => {
    setInterval(() => {
      maybeRunAbPhotoAutoRotate('scheduled').catch((e) => {
        logger.error({ err: e }, 'Scheduled run failed');
      });
    }, intervalMs);
  }, jitterMs);

  void sleep(0);
}

/** Simple wrapper for scheduler */
export async function runAbPhotoAutoRotate(): Promise<void> {
  await maybeRunAbPhotoAutoRotate('scheduler');
}

/** Collect metrics for all active tests (can be called separately) */
export async function collectAbPhotoMetrics(): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const tests = await db
    .select({
      testId: abPhotoTests.testId,
      workspaceId: abPhotoTests.workspaceId,
      nmId: abPhotoTests.nmId,
    })
    .from(abPhotoTests)
    .where(eq(abPhotoTests.status, 'running'));

  for (const test of tests) {
    const phases = await db
      .select()
      .from(abPhotoPhases)
      .where(eq(abPhotoPhases.testId, test.testId));

    for (const phase of phases) {
      const startDate = new Date(phase.startedAt).toISOString().slice(0, 10);
      const endDate = phase.endedAt
        ? new Date(phase.endedAt).toISOString().slice(0, 10)
        : today;

      try {
        await collectMetricsForPhase(
          test.workspaceId,
          test.nmId,
          test.testId,
          phase.phaseId,
          phase.variant,
          startDate,
          endDate
        );
      } catch (e) {
        logger.error({ err: e, testId: test.testId, phaseId: phase.phaseId }, 'Failed to collect metrics for phase');
      }
    }
  }

  logger.info({ testsCount: tests.length }, 'Collected metrics for tests');
}
